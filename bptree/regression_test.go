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

// checkTreeStructure runs with no operations in flight. In addition to data
// correctness, concurrent rebalancing must preserve occupancy and leaf depth.
func checkTreeStructure(t *testing.T, tr *Tree) {
	t.Helper()
	seen := map[PageID]bool{}
	var leaves, nexts []PageID
	var walk func(PageID, int) (int64, int64)
	walk = func(pid PageID, depth int) (int64, int64) {
		if seen[pid] {
			t.Fatalf("duplicate/cyclic page %d", pid)
		}
		seen[pid] = true
		f, err := tr.pool.fetch(pid)
		if err != nil {
			t.Fatal(err)
		}
		data := f.data
		tr.pool.unpin(f, false)
		b := data[:]
		n := int(nodeCount(b))
		min, max := MinInternalKeys, MaxInternalKeys
		if isLeaf(b) {
			min, max = MinLeafPairs, MaxLeafPairs
		}
		if n > max || n < 0 || (depth > 1 && n < min) {
			t.Fatalf("page %d depth %d count %d outside bounds", pid, depth, n)
		}
		if isLeaf(b) {
			if int64(depth) != tr.meta.height {
				t.Fatalf("leaf %d depth %d != height %d", pid, depth, tr.meta.height)
			}
			leaves = append(leaves, pid)
			nexts = append(nexts, leafNext(b))
			for i := 1; i < n; i++ {
				if leafKey(b, i-1) >= leafKey(b, i) {
					t.Fatalf("leaf %d unsorted", pid)
				}
			}
			if n == 0 {
				return 0, 0
			}
			return leafKey(b, 0), leafKey(b, n-1)
		}
		if n == 0 {
			t.Fatalf("unshrunk internal root %d", pid)
		}
		lo, hi := walk(internalChild(b, 0), depth+1)
		for i := 0; i < n; i++ {
			childLo, childHi := walk(internalChild(b, i+1), depth+1)
			sep := internalKey(b, i)
			if hi >= sep || sep > childLo {
				t.Fatalf("page %d separator %d not between %d and %d", pid, sep, hi, childLo)
			}
			hi = childHi
		}
		return lo, hi
	}
	walk(tr.meta.rootPageID, 1)
	for i, pid := range leaves {
		want := nilPageID
		if i+1 < len(leaves) {
			want = leaves[i+1]
		}
		if nexts[i] != want {
			t.Fatalf("leaf %d next %d != %d", pid, nexts[i], want)
		}
	}
	for pid := tr.meta.freeListHead; pid != nilPageID; {
		if seen[pid] {
			t.Fatalf("live or duplicate free page %d", pid)
		}
		seen[pid] = true
		f, err := tr.pool.fetch(pid)
		if err != nil {
			t.Fatal(err)
		}
		pid = PageID(getI64(f.data[:], 0))
		tr.pool.unpin(f, false)
	}
}
