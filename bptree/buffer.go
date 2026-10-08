package bptree

import "sync"

// frame is one buffer pool frame: a cached page plus its logical latch.
//
// Invariants:
//   - latch is held by a caller only while pin > 0 (latch => pinned),
//     so an eviction victim is never a latched frame.
//   - release order is: latch Unlock first, then Unpin.
type frame struct {
	pageID   PageID       // invalidPageID when unused
	pin      int          // guarded by pool.mu
	dirty    bool         // guarded by pool.mu on unpin/flush
	lastUsed uint64       // LRU tick, guarded by pool.mu
	latch    sync.RWMutex // logical page latch
	data     [PageSize]byte
}

type bufferPool struct {
	mu     sync.Mutex
	disk   *diskManager
	frames [BufferPoolFrames]frame
	table  map[PageID]int // pageID -> frame index
	tick   uint64         // LRU clock
}

func newBufferPool(disk *diskManager) *bufferPool {
	bp := &bufferPool{disk: disk, table: make(map[PageID]int)}
	for i := range bp.frames {
		bp.frames[i].pageID = invalidPageID
	}
	return bp
}

// fetch pins and returns the frame holding page pid, reading it from disk on
// a miss (evicting an unpinned LRU frame if needed). The caller must then
// latch the frame before touching data, and Unpin after unlocking.
//
// fetch only takes pool.mu briefly; it never acquires page latches, so it is
// safe to call while holding page latches or metaMu.
func (bp *bufferPool) fetch(pid PageID) (*frame, error) {
	bp.mu.Lock()
	defer bp.mu.Unlock()

	if idx, ok := bp.table[pid]; ok {
		f := &bp.frames[idx]
		f.pin++
		f.touch(bp)
		return f, nil
	}

	victim := -1
	for i := range bp.frames {
		f := &bp.frames[i]
		if f.pin == 0 && (victim < 0 || f.lastUsed < bp.frames[victim].lastUsed) {
			victim = i
		}
	}
	if victim < 0 {
		return nil, ErrNoFreeFrame
	}
	f := &bp.frames[victim]
	if f.pageID != invalidPageID {
		if f.dirty {
			if err := bp.disk.writePage(f.pageID, &f.data); err != nil {
				return nil, err
			}
		}
		delete(bp.table, f.pageID)
	}
	if err := bp.disk.readPage(pid, &f.data); err != nil {
		// Keep the frame out of the table but free for reuse.
		f.pageID = invalidPageID
		f.dirty = false
		f.lastUsed = 0
		return nil, err
	}
	f.pageID = pid
	f.dirty = false
	f.pin = 1
	bp.table[pid] = victim
	f.touch(bp)
	return f, nil
}

// unpin releases the caller's pin. Pass dirty=true if the page was modified.
// Callers must unpin after releasing the page latch, never before.
func (bp *bufferPool) unpin(f *frame, dirty bool) {
	bp.mu.Lock()
	defer bp.mu.Unlock()
	if f.pin <= 0 {
		panic("bptree: unpin of unpinned frame")
	}
	f.pin--
	if dirty {
		f.dirty = true
	}
}

// flushAll writes every dirty resident page back to disk. Called from Close
// when no operation is in flight.
func (bp *bufferPool) flushAll() error {
	bp.mu.Lock()
	defer bp.mu.Unlock()
	for i := range bp.frames {
		f := &bp.frames[i]
		if f.pageID != invalidPageID && f.dirty {
			if err := bp.disk.writePage(f.pageID, &f.data); err != nil {
				return err
			}
			f.dirty = false
		}
	}
	return nil
}

func (f *frame) touch(bp *bufferPool) {
	bp.tick++
	f.lastUsed = bp.tick
}
