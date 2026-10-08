package bptree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMetaRoundTrip(t *testing.T) {
	var buf [PageSize]byte
	m := meta{rootPageID: 7, height: 3, freeListHead: 42, nextPageID: 100}
	encodeMeta(&m, buf[:])
	got, err := decodeMeta(buf[:])
	if err != nil {
		t.Fatalf("decodeMeta: %v", err)
	}
	if got != m {
		t.Fatalf("roundtrip mismatch: got %+v want %+v", got, m)
	}
}

func TestMetaBadMagic(t *testing.T) {
	var buf [PageSize]byte
	if _, err := decodeMeta(buf[:]); err != ErrCorruptFile {
		t.Fatalf("want ErrCorruptFile, got %v", err)
	}
}

func TestDiskReadWrite(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()

	var w [PageSize]byte
	setI64(w[:], 0, 12345)
	setI64(w[:], 100, -42)
	if err := d.writePage(3, &w); err != nil {
		t.Fatal(err)
	}
	var r [PageSize]byte
	if err := d.readPage(3, &r); err != nil {
		t.Fatal(err)
	}
	if r != w {
		t.Fatal("read/write mismatch")
	}

	// Beyond-EOF page reads back as zeros.
	var z [PageSize]byte
	if err := d.readPage(99, &z); err != nil {
		t.Fatalf("read beyond EOF: %v", err)
	}
	if z != ([PageSize]byte{}) {
		t.Fatal("beyond-EOF page should be zeros")
	}

	// File must have grown to include page 3.
	sz, err := d.fileSize()
	if err != nil {
		t.Fatal(err)
	}
	if sz != 4*PageSize {
		t.Fatalf("fileSize = %d, want %d", sz, 4*PageSize)
	}
}

func TestBufferPoolBasic(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	f, err := bp.fetch(1)
	if err != nil {
		t.Fatal(err)
	}
	if f.pin != 1 {
		t.Fatalf("pin=%d", f.pin)
	}
	f.latch.Lock()
	setI64(f.data[:], 0, 777)
	f.latch.Unlock()
	bp.unpin(f, true)

	// Refetch same page: same frame, content preserved.
	f2, err := bp.fetch(1)
	if err != nil {
		t.Fatal(err)
	}
	if f2 != f {
		t.Fatal("expected same frame")
	}
	if getI64(f2.data[:], 0) != 777 {
		t.Fatal("dirty data not preserved")
	}
	bp.unpin(f2, false)
}

func TestBufferPoolEviction(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	// Touch more than BufferPoolFrames distinct pages.
	for pid := PageID(0); pid < BufferPoolFrames+10; pid++ {
		f, err := bp.fetch(pid)
		if err != nil {
			t.Fatalf("fetch %d: %v", pid, err)
		}
		setI64(f.data[:], 0, int64(pid)*7+1)
		bp.unpin(f, true)
	}
	if len(bp.table) > BufferPoolFrames {
		t.Fatalf("table size %d exceeds frames", len(bp.table))
	}
	// Early pages were evicted and written back; refetch must show them.
	for pid := PageID(0); pid < 4; pid++ {
		f, err := bp.fetch(pid)
		if err != nil {
			t.Fatal(err)
		}
		if got := getI64(f.data[:], 0); got != int64(pid)*7+1 {
			t.Fatalf("evicted page %d data: got %d", pid, got)
		}
		bp.unpin(f, false)
	}
}

func TestBufferPoolLRURecency(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	// Fill the pool with pages 0..255.
	for pid := PageID(0); pid < BufferPoolFrames; pid++ {
		f, err := bp.fetch(pid)
		if err != nil {
			t.Fatal(err)
		}
		bp.unpin(f, false)
	}
	// Re-fetch page 0 to make it most-recently-used.
	f, err := bp.fetch(0)
	if err != nil {
		t.Fatal(err)
	}
	bp.unpin(f, false)

	// Fetch a new page: LRU victim must be page 1 (oldest untouched), not 0.
	if _, err := bp.fetch(999); err != nil {
		t.Fatal(err)
	}
	f2 := &bp.frames[bp.table[999]]
	bp.unpin(f2, false)
	if _, ok := bp.table[0]; !ok {
		t.Fatal("MRU page 0 must not be evicted")
	}
	if _, ok := bp.table[1]; ok {
		t.Fatal("LRU page 1 should have been evicted")
	}
}

func TestBufferPoolNoFreeFrameRecovery(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	fs := make([]*frame, 0, BufferPoolFrames)
	for pid := PageID(0); pid < BufferPoolFrames; pid++ {
		f, err := bp.fetch(pid)
		if err != nil {
			t.Fatal(err)
		}
		fs = append(fs, f)
	}
	if _, err := bp.fetch(BufferPoolFrames); err != ErrNoFreeFrame {
		t.Fatalf("want ErrNoFreeFrame, got %v", err)
	}
	bp.unpin(fs[0], false)
	if _, err := bp.fetch(BufferPoolFrames); err != nil {
		t.Fatalf("fetch after unpin: %v", err)
	}
}

func TestBufferPoolNoFreeFrame(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	for pid := PageID(0); pid < BufferPoolFrames; pid++ {
		if _, err := bp.fetch(pid); err != nil {
			t.Fatalf("fetch %d: %v", pid, err)
		}
	}
	if _, err := bp.fetch(BufferPoolFrames); err != ErrNoFreeFrame {
		t.Fatalf("want ErrNoFreeFrame, got %v", err)
	}
}

func TestOpenInitAndReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.db")

	tr, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if tr.meta.rootPageID != 1 || tr.meta.height != 1 || tr.meta.nextPageID != 2 {
		t.Fatalf("bad initial meta: %+v", tr.meta)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() != 2*PageSize {
		t.Fatalf("size=%d, want %d", st.Size(), 2*PageSize)
	}

	tr2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tr2.Close()
	if tr2.meta.rootPageID != 1 || tr2.meta.height != 1 {
		t.Fatalf("reopened meta mismatch: %+v", tr2.meta)
	}
}

func TestFreeList(t *testing.T) {
	dir := t.TempDir()
	tr, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	// Allocate two fresh pages: file extends.
	p1, err := tr.allocPage()
	if err != nil {
		t.Fatal(err)
	}
	p2, err := tr.allocPage()
	if err != nil {
		t.Fatal(err)
	}
	if p1 != 2 || p2 != 3 || tr.meta.nextPageID != 4 {
		t.Fatalf("alloc: p1=%d p2=%d next=%d", p1, p2, tr.meta.nextPageID)
	}

	// Free p1, then alloc must reuse it.
	if err := tr.freePage(p1); err != nil {
		t.Fatal(err)
	}
	p3, err := tr.allocPage()
	if err != nil {
		t.Fatal(err)
	}
	if p3 != p1 {
		t.Fatalf("expected reuse of %d, got %d", p1, p3)
	}
	if tr.meta.freeListHead != nilPageID {
		t.Fatalf("freelist should be empty, head=%d", tr.meta.freeListHead)
	}

	// Free two pages: LIFO chain p2 -> p3(=p1).
	if err := tr.freePage(p2); err != nil {
		t.Fatal(err)
	}
	if err := tr.freePage(p3); err != nil {
		t.Fatal(err)
	}
	a, _ := tr.allocPage()
	b, _ := tr.allocPage()
	if a != p3 || b != p2 {
		t.Fatalf("chain broken: a=%d b=%d", a, b)
	}
}

func TestFreeListPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.db")

	tr, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	p, err := tr.allocPage()
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.freePage(p); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}

	tr2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tr2.Close()
	if tr2.meta.freeListHead != p {
		t.Fatalf("freelist head after reopen = %d, want %d", tr2.meta.freeListHead, p)
	}
	got, err := tr2.allocPage()
	if err != nil {
		t.Fatal(err)
	}
	if got != p {
		t.Fatalf("reopened alloc = %d, want reused %d", got, p)
	}
}

func TestUnpinDirtyOr(t *testing.T) {
	dir := t.TempDir()
	d, err := openDisk(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	bp := newBufferPool(d)

	f, err := bp.fetch(1)
	if err != nil {
		t.Fatal(err)
	}
	setI64(f.data[:], 0, 4242)
	bp.unpin(f, true) // mark dirty
	// A later clean unpin must not clear the dirty flag.
	f2, err := bp.fetch(1)
	if err != nil {
		t.Fatal(err)
	}
	bp.unpin(f2, false)
	if !f.dirty {
		t.Fatal("clean unpin cleared dirty flag")
	}
}

func TestOpenCorrupt(t *testing.T) {
	dir := t.TempDir()

	// Non-page-multiple size.
	p1 := filepath.Join(dir, "bad1.db")
	if err := os.WriteFile(p1, make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(p1); err != ErrCorruptFile {
		t.Fatalf("want ErrCorruptFile, got %v", err)
	}

	// Page-aligned but bad magic.
	p2 := filepath.Join(dir, "bad2.db")
	if err := os.WriteFile(p2, make([]byte, 2*PageSize), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(p2); err != ErrCorruptFile {
		t.Fatalf("want ErrCorruptFile, got %v", err)
	}
}
