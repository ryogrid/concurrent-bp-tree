package bptree

// Free list: freed pages form a singly linked list. A free page stores the
// next free pageID in slot 0; the list head lives in the meta page.
//
// All functions here run under Tree.metaMu. Free pages are exclusively owned
// by the metaMu holder and are never latched, so plain fetch/pin suffices.
// Free-page content is always read/written through the buffer pool so the
// cached copy (if resident) stays consistent.

// allocPageLocked returns a page to reuse from the free list, or extends the
// file by one page when the list is empty.
func (t *Tree) allocPageLocked() (PageID, error) {
	if head := t.meta.freeListHead; head != nilPageID {
		f, err := t.pool.fetch(head)
		if err != nil {
			return nilPageID, err
		}
		next := PageID(getI64(f.data[:], 0))
		t.pool.unpin(f, false)
		t.meta.freeListHead = next
		return head, nil
	}
	pid := t.meta.nextPageID
	t.meta.nextPageID++
	return pid, nil
}

// freePageLocked pushes a page onto the free list. The caller must have
// already released the page's latch and pin before calling.
func (t *Tree) freePageLocked(pid PageID) error {
	f, err := t.pool.fetch(pid)
	if err != nil {
		return err
	}
	setI64(f.data[:], 0, int64(t.meta.freeListHead))
	t.pool.unpin(f, true)
	t.meta.freeListHead = pid
	return nil
}

// allocPage takes metaMu, allocates a page, and releases metaMu.
func (t *Tree) allocPage() (PageID, error) {
	t.metaMu.Lock()
	defer t.metaMu.Unlock()
	return t.allocPageLocked()
}

// freePage takes metaMu, frees a page, and releases metaMu.
func (t *Tree) freePage(pid PageID) error {
	t.metaMu.Lock()
	defer t.metaMu.Unlock()
	return t.freePageLocked(pid)
}
