package bptree

import "sync"

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

	closed bool // Close must not race with operations (caller responsibility)
}

// Open opens or creates the DB file at path. A zero-length file is
// initialized with a meta page and a single empty leaf root.
func Open(path string) (*Tree, error) {
	disk, err := openDisk(path)
	if err != nil {
		return nil, err
	}
	t := &Tree{disk: disk, pool: newBufferPool(disk)}

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
