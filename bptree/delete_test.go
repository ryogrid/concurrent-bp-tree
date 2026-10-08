package bptree

import (
	"math/rand"
	"path/filepath"
	"sort"
	"testing"
)

func TestDeleteBasic(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	if ok, err := tr.Delete(1); err != nil || ok {
		t.Fatalf("delete on empty: ok=%v err=%v", ok, err)
	}
	tr.Put(1, 10)
	tr.Put(2, 20)
	if ok, err := tr.Delete(1); err != nil || !ok {
		t.Fatalf("delete: ok=%v err=%v", ok, err)
	}
	if _, ok, _ := tr.Get(1); ok {
		t.Fatal("deleted key still present")
	}
	if ok, _ := tr.Delete(1); ok {
		t.Fatal("double delete reported ok")
	}
	if v, ok, _ := tr.Get(2); !ok || v != 20 {
		t.Fatal("surviving key lost")
	}
}

// TestDeleteRandom deletes half the keys in random order and checks the
// survivors against a map oracle — exercises borrows and leaf merges.
func TestDeleteRandom(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 8000
	rnd := rand.New(rand.NewSource(2))
	order := rnd.Perm(N)
	want := make(map[int64]int64, N)
	for _, k := range order {
		if err := tr.Put(int64(k), int64(k+1)); err != nil {
			t.Fatal(err)
		}
		want[int64(k)] = int64(k + 1)
	}
	del := rnd.Perm(N)[:N/2]
	for _, k := range del {
		ok, err := tr.Delete(int64(k))
		if err != nil || !ok {
			t.Fatalf("delete %d: ok=%v err=%v", k, ok, err)
		}
		delete(want, int64(k))
	}
	for key, val := range want {
		v, ok, err := tr.Get(key)
		if err != nil || !ok || v != val {
			t.Fatalf("get %d: v=%d ok=%v err=%v", key, v, ok, err)
		}
	}
	for _, k := range del {
		if _, ok, _ := tr.Get(int64(k)); ok {
			t.Fatalf("deleted key %d found", k)
		}
	}
}

// TestDeleteAll removes every key and then reinserts — exercises root shrink
// and heavy merge propagation.
func TestDeleteAll(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 6000
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i), int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < N; i++ {
		ok, err := tr.Delete(int64(i))
		if err != nil || !ok {
			t.Fatalf("delete %d: ok=%v err=%v", i, ok, err)
		}
	}
	if tr.meta.height != 1 {
		t.Fatalf("height=%d after deleting all, want 1", tr.meta.height)
	}
	// Reinsert — the shrunken tree must be usable.
	for i := 0; i < 1000; i++ {
		if err := tr.Put(int64(i), int64(i*5)); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 1000; i++ {
		v, ok, _ := tr.Get(int64(i))
		if !ok || v != int64(i*5) {
			t.Fatalf("reinserted key %d missing", i)
		}
	}
}

// TestRangeScan covers boundary inclusivity, empty ranges, and multi-leaf spans.
func TestRangeScan(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 3000 // multiple leaves
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i*2), int64(i)); err != nil { // even keys only
			t.Fatal(err)
		}
	}

	check := func(start, end int64, wantFirst, wantLast int64, wantN int) {
		t.Helper()
		ps, err := tr.RangeScan(start, end)
		if err != nil {
			t.Fatal(err)
		}
		if len(ps) != wantN {
			t.Fatalf("scan(%d,%d): got %d pairs want %d", start, end, len(ps), wantN)
		}
		for i := 1; i < len(ps); i++ {
			if ps[i].Key <= ps[i-1].Key {
				t.Fatal("scan not ascending")
			}
		}
		if wantN > 0 && (ps[0].Key != wantFirst || ps[len(ps)-1].Key != wantLast) {
			t.Fatalf("bounds: first=%d last=%d", ps[0].Key, ps[len(ps)-1].Key)
		}
	}

	check(0, 10, 0, 10, 6)                    // 0,2,4,6,8,10
	check(1, 9, 2, 8, 4)                      // odd bounds snap inward
	check(-100, 5, 0, 4, 3)                   // below-min start
	check(2*(N-1), N*10, 2*(N-1), 2*(N-1), 1) // tail
	check(2*N+1, 2*N+100, 0, 0, 0)            // beyond max → empty
	check(10, 5, 0, 0, 0)                     // start > end → empty

	// Full scan returns all pairs in order.
	all, err := tr.RangeScan(-1<<62, 1<<62)
	if err != nil || len(all) != N {
		t.Fatalf("full scan: n=%d err=%v", len(all), err)
	}
	for i, p := range all {
		if p.Key != int64(i*2) || p.Value != int64(i) {
			t.Fatalf("full scan [%d] = %+v", i, p)
		}
	}
}

// TestRangeScanAfterDelete verifies merged leaves keep the sibling chain
// consistent.
func TestRangeScanAfterDelete(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 5000
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i), int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	// Delete every other key → heavy leaf merge/borrow.
	for i := 0; i < N; i += 2 {
		if _, err := tr.Delete(int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	ps, err := tr.RangeScan(0, N)
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != N/2 {
		t.Fatalf("scan n=%d want %d", len(ps), N/2)
	}
	for i, p := range ps {
		if p.Key != int64(2*i+1) {
			t.Fatalf("scan[%d]=%d want %d", i, p.Key, 2*i+1)
		}
	}
}

// TestSortedOrder verifies a full scan yields the sorted oracle.
func TestSortedOrder(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	rnd := rand.New(rand.NewSource(3))
	const N = 4000
	var want []int64
	for _, k := range rnd.Perm(N) {
		key := int64(k) - 2000 // include negatives
		if err := tr.Put(key, key); err != nil {
			t.Fatal(err)
		}
		want = append(want, key)
	}
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })

	ps, err := tr.RangeScan(want[0], want[len(want)-1])
	if err != nil || len(ps) != len(want) {
		t.Fatalf("n=%d err=%v", len(ps), err)
	}
	for i, p := range ps {
		if p.Key != want[i] {
			t.Fatalf("[%d]=%d want %d", i, p.Key, want[i])
		}
	}
}
