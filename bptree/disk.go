package bptree

import (
	"io"
	"os"
)

// diskManager owns the single DB file. ReadAt/WriteAt are safe for concurrent
// use; no fsync/fdatasync is performed (per requirements).
type diskManager struct {
	f *os.File
}

func openDisk(path string) (*diskManager, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	return &diskManager{f: f}, nil
}

func (d *diskManager) readPage(pid PageID, buf *[PageSize]byte) error {
	n, err := d.f.ReadAt(buf[:], int64(pid)*PageSize)
	switch {
	case err == nil:
		return nil
	case err == io.EOF && n == 0:
		// Reading a page beyond EOF: the file extends sparsely, so the
		// content is zeros. This covers freshly allocated (never written)
		// pages.
		clear(buf[:])
		return nil
	default:
		// Partial read of a real page is corruption.
		return ErrCorruptFile
	}
}

func (d *diskManager) writePage(pid PageID, buf *[PageSize]byte) error {
	_, err := d.f.WriteAt(buf[:], int64(pid)*PageSize)
	return err
}

func (d *diskManager) fileSize() (int64, error) {
	st, err := d.f.Stat()
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func (d *diskManager) close() error {
	return d.f.Close()
}
