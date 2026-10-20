package bptree

import (
	"errors"
	"testing"
)

// A scanner holding the left leaf must not make a failed deletion visible.
func TestDeleteRestartRestoresPair(t *testing.T) {
	tr, err := Open(t.TempDir() + "/restart.db")
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	for i := 0; i <= MaxLeafPairs; i++ {
		if err := tr.Put(int64(i), int64(i*7)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tr.Delete(MaxLeafPairs); err != nil {
		t.Fatal(err)
	}
	root, _ := tr.pool.fetch(tr.meta.rootPageID)
	left, _ := tr.pool.fetch(internalChild(root.data[:], 0))
	tr.pool.unpin(root, false)
	left.latch.RLock()
	removed, err := tr.delete(MaxLeafPairs - 1)
	left.latch.RUnlock()
	tr.pool.unpin(left, false)
	if removed || !errors.Is(err, errRestart) {
		t.Fatalf("attempt = %v, %v", removed, err)
	}
	value, ok, err := tr.Get(MaxLeafPairs - 1)
	if err != nil || !ok || value != (MaxLeafPairs-1)*7 {
		t.Fatalf("rolled back pair = %d, %v, %v", value, ok, err)
	}
	if removed, err := tr.Delete(MaxLeafPairs - 1); err != nil || !removed {
		t.Fatalf("retry = %v, %v", removed, err)
	}
	if tr.meta.height != 1 {
		t.Fatalf("merge did not shrink root: %d", tr.meta.height)
	}
}

// Synthetic maximum height avoids constructing 511^7 pages. A full root
// must still allow an overwrite and insertion into a child with spare room.
func TestHeightLimitAllowsSafeUpdates(t *testing.T) {
	tr, err := Open(t.TempDir() + "/height.db")
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	for i := 0; i < MaxLeafPairs; i++ {
		if err := tr.Put(int64(i), int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	tr.meta.height = MaxTreeHeight
	if err := tr.Put(0, 99); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	// This full leaf really is the root, so pretend its ancestor path has
	// the true height again before testing the split rejection separately.
	tr.meta.height = 1
	if err := tr.Put(MaxLeafPairs, MaxLeafPairs); err != nil {
		t.Fatal(err)
	}
	root, _ := tr.pool.fetch(tr.meta.rootPageID)
	// Fill root separators with unused higher ranges; key 1 still routes left.
	for i := int(nodeCount(root.data[:])); i < MaxInternalKeys; i++ {
		internalInsertKeyAt(root.data[:], i, int64(100000+i), internalChild(root.data[:], 1))
	}
	tr.pool.unpin(root, true)
	tr.meta.height = MaxTreeHeight
	if err := tr.Put(-1, 42); err != nil {
		t.Fatalf("safe subtree insertion: %v", err)
	}
	if v, ok, err := tr.Get(-1); err != nil || !ok || v != 42 {
		t.Fatalf("get: %d %v %v", v, ok, err)
	}
}
