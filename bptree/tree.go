package bptree

import (
	"errors"
	"math"
	"runtime"
	"sync"
)

// Tree is an on-disk concurrent B+ tree over int64 keys and values.
//
// Locking overview (design.md §4.3, §5.5):
//   - rootMu: guards meta.rootPageID and meta.height (the "which page is the
//     root" fact). Held briefly at op start; a writer keeps it only while the
//     root itself may split/shrink.
//   - metaMu: guards meta.freeListHead / meta.nextPageID. Leaf lock: its
//     critical sections never take page latches or rootMu.
//   - page latches: per-frame RWMutex, acquired top-down and left-to-right
//     (latch crabbing). Left-sibling acquisition uses TryLock + full retry.
//   - pool.mu: innermost leaf lock, never held while acquiring anything else.
type Tree struct {
	disk *diskManager
	pool *bufferPool

	meta   meta
	rootMu sync.RWMutex
	metaMu sync.Mutex

	opSlots chan struct{} // concurrency gate (maxConcurrentOps)

	closed bool // Close must not race with operations (caller responsibility)
}

// Open opens or creates the DB file at path. A zero-length file is
// initialized with a meta page and a single empty leaf root.
func Open(path string) (*Tree, error) {
	disk, err := openDisk(path)
	if err != nil {
		return nil, err
	}
	t := &Tree{
		disk:    disk,
		pool:    newBufferPool(disk),
		opSlots: make(chan struct{}, maxConcurrentOps),
	}

	size, err := disk.fileSize()
	if err != nil {
		disk.close()
		return nil, err
	}
	switch {
	case size == 0:
		if err := t.initEmpty(); err != nil {
			disk.close()
			return nil, err
		}
	case size%PageSize != 0:
		disk.close()
		return nil, ErrCorruptFile
	default:
		f, err := t.pool.fetch(metaPageID)
		if err != nil {
			disk.close()
			return nil, err
		}
		m, err := decodeMeta(f.data[:])
		t.pool.unpin(f, false)
		if err != nil {
			disk.close()
			return nil, err
		}
		t.meta = m
	}
	return t, nil
}

// initEmpty initializes a fresh file: meta page + one empty leaf as root.
func (t *Tree) initEmpty() error {
	t.meta = meta{
		rootPageID:   1,
		height:       1,
		freeListHead: nilPageID,
		nextPageID:   2,
	}
	leaf, err := t.pool.fetch(1)
	if err != nil {
		return err
	}
	setI64(leaf.data[:], 0, nodeTypeLeaf)
	setI64(leaf.data[:], 1, 0)                // nPairs
	setI64(leaf.data[:], 2, int64(nilPageID)) // nextLeafPID
	t.pool.unpin(leaf, true)
	return t.writeMeta()
}

// writeMeta persists the in-memory meta to page 0.
//
// Call contract: must be invoked with NEITHER rootMu nor metaMu held.
// It snapshots meta under rootMu.RLock -> metaMu.Lock (in that order).
func (t *Tree) writeMeta() error {
	t.rootMu.RLock()
	t.metaMu.Lock()
	m := t.meta
	t.metaMu.Unlock()
	t.rootMu.RUnlock()

	f, err := t.pool.fetch(metaPageID)
	if err != nil {
		return err
	}
	// Page 0 is never latched by tree operations, so taking the latch here
	// is uncontended; it only protects concurrent writeMeta calls.
	f.latch.Lock()
	encodeMeta(&m, f.data[:])
	f.latch.Unlock()
	t.pool.unpin(f, true)
	return nil
}

// Close flushes all dirty pages (and the meta page) to the file and closes
// it. Must not be called while operations are in flight.
func (t *Tree) Close() error {
	if t.closed {
		return nil
	}
	if err := t.writeMeta(); err != nil {
		return err
	}
	if err := t.pool.flushAll(); err != nil {
		return err
	}
	if err := t.disk.close(); err != nil {
		return err
	}
	t.closed = true
	return nil
}

// maxConcurrentOps bounds the number of operations in flight. Each op pins at
// most ~MaxTreeHeight+3 frames (descent path + split/merge siblings); 20 ops
// pin at most ~220 < BufferPoolFrames, so a running op can always make
// progress and starvation retries in fetchRetry/allocPageRetry terminate —
// ops waiting on the semaphore hold no pins or latches, so no deadlock cycle
// can form.
const maxConcurrentOps = 20

// errRestart is an internal sentinel: a left-sibling TryLock failed, so the
// operation released everything and retries from the root.
var errRestart = errors.New("bptree: restart operation")

// retryOp retries an op body on temporary failures: buffer pool starvation
// (ErrNoFreeFrame) or a left-sibling TryLock loss (errRestart). Waiters and
// retrying ops never hold pins while blocked, so progress is guaranteed.
const maxOpRetries = 1000

func retryOp(op func() error) error {
	var last error
	for i := 0; i < maxOpRetries; i++ {
		err := op()
		if err == ErrNoFreeFrame || err == errRestart {
			last = err
			runtime.Gosched()
			continue
		}
		return err
	}
	return last
}

// allocPageRetry/fetchRetry are used in the middle of structural propagation,
// where aborting on ErrNoFreeFrame would leave a half-installed split/merge.
// They retry pool starvation since other ops always make progress and release
// frames. Genuine I/O errors still propagate (and the caller unwinds normally).
func (t *Tree) allocPageRetry() (PageID, error) {
	for {
		pid, err := t.allocPage()
		if err == ErrNoFreeFrame {
			runtime.Gosched()
			continue
		}
		return pid, err
	}
}

func (t *Tree) fetchRetry(pid PageID) (*frame, error) {
	for {
		f, err := t.pool.fetch(pid)
		if err == ErrNoFreeFrame {
			runtime.Gosched()
			continue
		}
		return f, err
	}
}

// heldStack tracks W-latched ancestor frames during a write descent.
// heldIdx[i] is the child index under held[i] that the descent followed.
type heldStack struct {
	frames []*frame
	idxs   []int
}

func (t *Tree) releaseHeld(h *heldStack) {
	for i := len(h.frames) - 1; i >= 0; i-- {
		h.frames[i].latch.Unlock()
		t.pool.unpin(h.frames[i], false)
	}
	h.frames, h.idxs = nil, nil
}

// release releases a frame's latch then pin (order matters: never unpin while
// still latched — the frame could be evicted and reused under the stale latch).
func (t *Tree) release(f *frame, dirty bool) {
	f.latch.Unlock()
	t.pool.unpin(f, dirty)
}

// acquireOp takes a concurrency slot; callers must releaseOp when done.
func (t *Tree) acquireOp() {
	t.opSlots <- struct{}{}
}

func (t *Tree) releaseOp() {
	<-t.opSlots
}

// Get returns the value for key, or ok=false if absent.
func (t *Tree) Get(key int64) (int64, bool, error) {
	if t.closed {
		return 0, false, ErrClosed
	}
	t.acquireOp()
	defer t.releaseOp()
	var v int64
	var ok bool
	err := retryOp(func() error {
		var err error
		v, ok, err = t.get(key)
		return err
	})
	return v, ok, err
}

func (t *Tree) get(key int64) (int64, bool, error) {
	t.rootMu.RLock()
	f, err := t.pool.fetch(t.meta.rootPageID)
	if err != nil {
		t.rootMu.RUnlock()
		return 0, false, err
	}
	f.latch.RLock()
	t.rootMu.RUnlock()

	// Crab down: R-latch child before releasing the parent.
	for !isLeaf(f.data[:]) {
		ci := internalFindChildIdx(f.data[:], key)
		cf, err := t.pool.fetch(internalChild(f.data[:], ci))
		if err != nil {
			f.latch.RUnlock()
			t.pool.unpin(f, false)
			return 0, false, err
		}
		cf.latch.RLock()
		f.latch.RUnlock()
		t.pool.unpin(f, false)
		f = cf
	}

	pos, found := leafFindPos(f.data[:], key)
	var v int64
	if found {
		v = leafVal(f.data[:], pos)
	}
	f.latch.RUnlock()
	t.pool.unpin(f, false)
	return v, found, nil
}

// Put inserts or overwrites (key, value).
func (t *Tree) Put(key, value int64) error {
	if t.closed {
		return ErrClosed
	}
	t.acquireOp()
	defer t.releaseOp()
	err := retryOp(func() error { return t.put(key, value) })
	// Persist meta on every Put/Delete so freelist/root changes reach the
	// meta page eagerly (Close flushes regardless). Note writeMeta can fail
	// after put committed; upsert is idempotent so reporting it is safe.
	if werr := t.writeMeta(); werr != nil && err == nil {
		err = werr
	}
	return err
}

func (t *Tree) put(key, value int64) (err error) {
	var held heldStack
	var cur, rightF, parent *frame
	rootHeld := true

	// Deferred cleanup releases every latch/pin still tracked. Success paths
	// release frames explicitly and nil these vars, so this only does work on
	// error returns. dirty=true is the safe choice (extra writeback, never a
	// lost update).
	defer func() {
		if parent != nil {
			t.release(parent, true)
		}
		if cur != nil {
			t.release(cur, true)
		}
		if rightF != nil {
			t.release(rightF, true)
		}
		for i := len(held.frames) - 1; i >= 0; i-- {
			t.release(held.frames[i], true)
		}
		if rootHeld {
			t.rootMu.Unlock()
		}
	}()

	t.rootMu.Lock()
	rootF, err := t.pool.fetch(t.meta.rootPageID)
	if err != nil {
		return err
	}
	cur = rootF
	cur.latch.Lock()

	// If the root cannot split, rootPageID cannot change — release rootMu
	// early so other ops can start. If it can split and the tree is already
	// at max height, bail before any mutation.
	if safeForInsert(cur.data[:]) {
		t.rootMu.Unlock()
		rootHeld = false
	} else if t.meta.height >= MaxTreeHeight {
		return ErrMaxTreeHeight
	}

	// Descend, W-latching. An ancestor stays latched iff the child below it
	// is unsafe (may still push a split up to it); a safe child lets us drop
	// everything above it — including cur itself once the child is latched.
	for !isLeaf(cur.data[:]) {
		ci := internalFindChildIdx(cur.data[:], key)
		cf, err := t.pool.fetch(internalChild(cur.data[:], ci))
		if err != nil {
			return err
		}
		cf.latch.Lock()
		if safeForInsert(cf.data[:]) {
			t.releaseHeld(&held)
			t.release(cur, false)
		} else {
			if safeForInsert(cur.data[:]) {
				// cur can't split further, so ancestors above it are
				// unreachable by this propagation — drop them early.
				t.releaseHeld(&held)
			}
			held.frames = append(held.frames, cur)
			held.idxs = append(held.idxs, ci)
		}
		cur = cf
	}

	// cur is the W-latched leaf.
	pos, found := leafFindPos(cur.data[:], key)
	if found {
		leafSetPair(cur.data[:], pos, key, value) // overwrite in place
		t.release(cur, true)
		cur = nil
		t.releaseHeld(&held)
		if rootHeld {
			t.rootMu.Unlock()
			rootHeld = false
		}
		return nil
	}
	if nodeCount(cur.data[:]) < MaxLeafPairs {
		leafInsertAt(cur.data[:], pos, key, value)
		t.release(cur, true)
		cur = nil
		t.releaseHeld(&held)
		if rootHeld {
			t.rootMu.Unlock()
			rootHeld = false
		}
		return nil
	}

	// Leaf split: build 511 pairs in scratch, 255 stay / 256 go right.
	rightPID, err := t.allocPageRetry()
	if err != nil {
		return err
	}
	rightF, err = t.fetchRetry(rightPID)
	if err != nil {
		return err
	}
	rightF.latch.Lock()
	sep := leafInsertSplit(cur.data[:], rightF.data[:], key, value)
	leafSetNext(rightF.data[:], leafNext(cur.data[:]))
	leafSetNext(cur.data[:], rightPID)

	// Propagate the separator up through the latched ancestors.
	leftPID := cur.pageID
	pending := true
	for pending && len(held.frames) > 0 {
		top := len(held.frames) - 1
		parent = held.frames[top]
		ci := held.idxs[top]
		held.frames, held.idxs = held.frames[:top], held.idxs[:top]
		if nodeCount(parent.data[:]) < MaxInternalKeys {
			internalInsertKeyAt(parent.data[:], ci, sep, rightPID)
			t.release(parent, true)
			parent = nil
			pending = false
		} else {
			// Parent splits too; keep propagating its promoted key.
			p2, err := t.allocPageRetry()
			if err != nil {
				return err
			}
			rf2, err := t.fetchRetry(p2)
			if err != nil {
				return err
			}
			rf2.latch.Lock()
			// No-fail zone: rf2 is latched but untracked until the next line;
			// keep it that way — do not insert a fallible call here.
			sep = internalInsertSplit(parent.data[:], rf2.data[:], ci, sep, rightPID)
			leftPID = parent.pageID
			t.release(parent, true)
			parent = nil
			t.release(rightF, true)
			rightPID, rightF = p2, rf2
		}
	}
	if pending {
		// The split reached the top: grow a new root (rootMu still held).
		newRoot, err := t.allocPageRetry()
		if err != nil {
			return err
		}
		nrf, err := t.fetchRetry(newRoot)
		if err != nil {
			return err
		}
		nrf.latch.Lock()
		// No-fail zone: nrf is latched but untracked until released below.
		internalInitRoot(nrf.data[:], sep, leftPID, rightPID)
		t.meta.rootPageID = newRoot
		t.meta.height++
		t.release(nrf, true)
	}

	t.release(cur, true)
	cur = nil
	t.release(rightF, true)
	rightF = nil
	t.releaseHeld(&held)
	if rootHeld {
		t.rootMu.Unlock()
		rootHeld = false
	}
	return nil
}

// Delete removes key. Returns ok=false when the key is absent.
func (t *Tree) Delete(key int64) (bool, error) {
	if t.closed {
		return false, ErrClosed
	}
	t.acquireOp()
	defer t.releaseOp()
	var ok bool
	err := retryOp(func() error {
		var e error
		var removed bool
		removed, e = t.delete(key)
		ok = ok || removed // a key removed by a previous retry stays removed
		return e
	})
	if werr := t.writeMeta(); werr != nil && err == nil {
		err = werr
	}
	return ok, err
}

func (t *Tree) delete(key int64) (bool, error) {
	var held heldStack
	var cur, sib, parent *frame
	rootHeld := true

	// Deferred cleanup: see put() for the tracking contract.
	defer func() {
		if sib != nil {
			t.release(sib, true)
		}
		if parent != nil {
			t.release(parent, true)
		}
		if cur != nil {
			t.release(cur, true)
		}
		for i := len(held.frames) - 1; i >= 0; i-- {
			t.release(held.frames[i], true)
		}
		if rootHeld {
			t.rootMu.Unlock()
		}
	}()

	t.rootMu.Lock()
	rootF, err := t.pool.fetch(t.meta.rootPageID)
	if err != nil {
		return false, err
	}
	cur = rootF
	cur.latch.Lock()
	if safeForDelete(cur.data[:]) {
		// A safe root cannot shrink to empty this op — release rootMu early.
		t.rootMu.Unlock()
		rootHeld = false
	}

	// Same W-crabbing as put, with the delete safety criterion.
	for !isLeaf(cur.data[:]) {
		ci := internalFindChildIdx(cur.data[:], key)
		cf, err := t.pool.fetch(internalChild(cur.data[:], ci))
		if err != nil {
			return false, err
		}
		cf.latch.Lock()
		if safeForDelete(cf.data[:]) {
			t.releaseHeld(&held)
			t.release(cur, false)
		} else {
			if safeForDelete(cur.data[:]) {
				t.releaseHeld(&held)
			}
			held.frames = append(held.frames, cur)
			held.idxs = append(held.idxs, ci)
		}
		cur = cf
	}

	// cur is the W-latched leaf.
	pos, found := leafFindPos(cur.data[:], key)
	if found {
		leafRemoveAt(cur.data[:], pos)
	}
	if int(nodeCount(cur.data[:])) >= MinLeafPairs {
		// Key removed (or absent) and no underflow — done.
		t.release(cur, found)
		cur = nil
		t.releaseHeld(&held)
		if rootHeld {
			t.rootMu.Unlock()
			rootHeld = false
		}
		return found, nil
	}

	// cur underflowed — propagate merges/borrows upward. `cur` keeps
	// pointing at the node currently being fixed (leaf first, then parents).
	//
	// Note: an errRestart can abandon an already-committed lower merge,
	// leaving interior nodes residually under Min. That is a balance
	// violation only — reads/scans/inserts stay correct, and a later delete
	// on the same path rebalances lazily.
	for cur != nil {
		leaf := isLeaf(cur.data[:])
		minKeys := MinLeafPairs
		if !leaf {
			minKeys = MinInternalKeys
		}
		if len(held.frames) == 0 {
			// held empty ⇒ cur is the root (the only node that may be under
			// Min with no parent). An internal root reduced to one child
			// shrinks; a leaf root may stay empty.
			if !leaf && nodeCount(cur.data[:]) == 0 {
				newRoot := internalChild(cur.data[:], 0)
				oldPID := cur.pageID
				t.meta.rootPageID = newRoot
				t.meta.height--
				t.release(cur, true)
				cur = nil
				if err := t.freePage(oldPID); err != nil {
					return found, err
				}
			} else {
				t.release(cur, true)
				cur = nil
			}
			break
		}
		// cur is no longer underflowed (e.g. post-merge parent that stayed
		// >= Min): nothing left to fix.
		if int(nodeCount(cur.data[:])) >= minKeys {
			t.release(cur, true)
			cur = nil
			break
		}

		top := len(held.frames) - 1
		parent = held.frames[top]
		ci := held.idxs[top]
		held.frames, held.idxs = held.frames[:top], held.idxs[:top]
		pn := int(nodeCount(parent.data[:]))

		if pn == 0 {
			// Degenerate single-child parent (possible via residually
			// underfull interior nodes): no sibling exists to borrow from
			// or merge into — release cur and keep climbing with the
			// parent as the node to fix.
			t.release(cur, true)
			cur = parent
			parent = nil
			continue
		}

		if ci < pn {
			// Right sibling exists: latch order left→right is respected.
			rPID := internalChild(parent.data[:], ci+1)
			sib, err = t.fetchRetry(rPID)
			if err != nil {
				return found, err
			}
			sib.latch.Lock()
			if int(nodeCount(sib.data[:])) > minKeys {
				// Borrow one entry from the right sibling.
				if leaf {
					leafBorrowFromRight(cur.data[:], sib.data[:])
					internalSetKey(parent.data[:], ci, leafKey(sib.data[:], 0))
				} else {
					sep := internalKey(parent.data[:], ci)
					newSep := internalBorrowFromRight(cur.data[:], sib.data[:], sep)
					internalSetKey(parent.data[:], ci, newSep)
				}
				t.release(sib, true)
				sib = nil
				t.release(cur, true)
				cur = nil
				t.release(parent, true)
				parent = nil
				break
			}
			// Merge right into cur.
			if leaf {
				leafMergeInto(cur.data[:], sib.data[:])
				leafSetNext(cur.data[:], leafNext(sib.data[:]))
			} else {
				internalMergeInto(cur.data[:], sib.data[:], internalKey(parent.data[:], ci))
			}
			internalRemoveKeyAt(parent.data[:], ci)
			sibPID := sib.pageID
			t.release(sib, true)
			sib = nil
			t.release(cur, true)
			cur = nil
			if err := t.freePage(sibPID); err != nil {
				return found, err
			}
			// Parent lost a child — it may underflow; continue upward.
			cur = parent
			parent = nil
			continue
		}

		// ci == pn: cur is the rightmost child — only the left sibling exists.
		lPID := internalChild(parent.data[:], ci-1)
		sib, err = t.fetchRetry(lPID)
		if err != nil {
			return found, err
		}
		if !sib.latch.TryLock() {
			// Latching a left sibling while holding nodes to its right can
			// deadlock against a scan's left→right coupling — restart.
			// CRITICAL: sib is pinned but NOT latched here — unpin only,
			// never Unlock (that would steal another holder's latch or panic).
			t.pool.unpin(sib, false)
			sib = nil
			return found, errRestart
		}
		if int(nodeCount(sib.data[:])) > minKeys {
			// Borrow one entry from the left sibling.
			if leaf {
				leafBorrowFromLeft(cur.data[:], sib.data[:])
				internalSetKey(parent.data[:], ci-1, leafKey(cur.data[:], 0))
			} else {
				sep := internalKey(parent.data[:], ci-1)
				newSep := internalBorrowFromLeft(cur.data[:], sib.data[:], sep)
				internalSetKey(parent.data[:], ci-1, newSep)
			}
			t.release(sib, true)
			sib = nil
			t.release(cur, true)
			cur = nil
			t.release(parent, true)
			parent = nil
			break
		}
		// Merge cur into the left sibling.
		if leaf {
			leafMergeInto(sib.data[:], cur.data[:])
			leafSetNext(sib.data[:], leafNext(cur.data[:]))
		} else {
			internalMergeInto(sib.data[:], cur.data[:], internalKey(parent.data[:], ci-1))
		}
		internalRemoveKeyAt(parent.data[:], ci-1)
		curPID := cur.pageID
		t.release(sib, true)
		sib = nil
		t.release(cur, true)
		cur = nil
		if err := t.freePage(curPID); err != nil {
			return found, err
		}
		cur = parent
		parent = nil
	}

	// Success tail: any frames still tracked are unmodified ancestors.
	t.releaseHeld(&held)
	if rootHeld {
		t.rootMu.Unlock()
		rootHeld = false
	}
	return found, nil
}

// RangeScan returns all pairs with start <= key <= end, in ascending key
// order. An empty range (start > end) returns an empty slice.
func (t *Tree) RangeScan(start, end int64) ([]Pair, error) {
	if t.closed {
		return nil, ErrClosed
	}
	if start > end {
		return []Pair{}, nil
	}
	t.acquireOp()
	defer t.releaseOp()
	var out []Pair
	err := retryOp(func() error {
		var e error
		out, e = t.rangeScan(start, end)
		return e
	})
	return out, err
}

func (t *Tree) rangeScan(start, end int64) ([]Pair, error) {
	t.rootMu.RLock()
	f, err := t.pool.fetch(t.meta.rootPageID)
	if err != nil {
		t.rootMu.RUnlock()
		return nil, err
	}
	f.latch.RLock()
	t.rootMu.RUnlock()

	for !isLeaf(f.data[:]) {
		ci := internalFindChildIdx(f.data[:], start)
		cf, err := t.pool.fetch(internalChild(f.data[:], ci))
		if err != nil {
			f.latch.RUnlock()
			t.pool.unpin(f, false)
			return nil, err
		}
		cf.latch.RLock()
		f.latch.RUnlock()
		t.pool.unpin(f, false)
		f = cf
	}

	var out []Pair
	for {
		n := int(nodeCount(f.data[:]))
		pos, _ := leafFindPos(f.data[:], start)
		done := false
		for i := pos; i < n; i++ {
			k := leafKey(f.data[:], i)
			if k > end {
				done = true
				break
			}
			out = append(out, Pair{k, leafVal(f.data[:], i)})
		}
		if done {
			break
		}
		next := leafNext(f.data[:])
		if next == nilPageID {
			break
		}
		// Horizontal crab: latch the next leaf before releasing this one so
		// a concurrent split can never make us skip a moved key.
		nf, err := t.pool.fetch(next)
		if err != nil {
			f.latch.RUnlock()
			t.pool.unpin(f, false)
			return out, err
		}
		nf.latch.RLock()
		f.latch.RUnlock()
		t.pool.unpin(f, false)
		f = nf
		start = math.MinInt64 // subsequent leaves: take everything
	}
	f.latch.RUnlock()
	t.pool.unpin(f, false)
	return out, nil
}
