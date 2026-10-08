package bptree

import (
	"math/rand"
	"sort"
	"sync"
	"testing"
)

// TestConcurrentMixed runs disjoint-range mixed workloads in parallel. Each
// worker owns a private key range, so its oracle is deterministic even while
// structural operations (splits/merges) contend on shared interior nodes.
// The preload keeps ~160k live keys (>300 leaves > 256 buffer frames), so
// eviction and dirty writeback run continuously during the mixed phase.
func TestConcurrentMixed(t *testing.T) {
	path := t.TempDir() + "/mixed.db"
	tr, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	const (
		workers   = 16
		span      = 16384 // keys owned per worker
		opsPerWkr = 6000
	)

	// Preload 60% of each worker's range so live pages exceed BufferPoolFrames.
	preloadPer := span * 6 / 10
	oracles := make([]map[int64]int64, workers)
	for w := 0; w < workers; w++ {
		oracles[w] = make(map[int64]int64, preloadPer)
	}
	for i := 0; i < workers*preloadPer; i++ {
		w := i % workers
		key := int64(w*span + i/workers)
		val := key*7 + 3
		if err := tr.Put(key, val); err != nil {
			t.Fatalf("preload %d: %v", key, err)
		}
		oracles[w][key] = val
	}

	var wg sync.WaitGroup
	errs := make([]error, workers)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			base := int64(w * span)
			rng := rand.New(rand.NewSource(int64(w) * 7919))
			oracle := oracles[w]

			for i := 0; i < opsPerWkr; i++ {
				key := base + int64(rng.Intn(span))
				switch x := rng.Intn(100); {
				case x < 45: // Put
					val := key*7 + 3
					if err := tr.Put(key, val); err != nil {
						errs[w] = err
						return
					}
					oracle[key] = val
				case x < 80: // Get
					got, found, err := tr.Get(key)
					if err != nil {
						errs[w] = err
						return
					}
					want, ok := oracle[key]
					if ok != found || (ok && got != want) {
						t.Errorf("w%d Get(%d) = (%d,%v), want (%v,%v)",
							w, key, got, found, want, ok)
						return
					}
				case x < 95: // Delete
					removed, err := tr.Delete(key)
					if err != nil {
						errs[w] = err
						return
					}
					_, ok := oracle[key]
					if removed != ok {
						t.Errorf("w%d Delete(%d) = %v, want %v", w, key, removed, ok)
						return
					}
					delete(oracle, key)
				default: // RangeScan within own range (cursor-consistent + deterministic)
					lo := rng.Intn(span)
					hi := lo + rng.Intn(200)
					if hi >= span {
						hi = span - 1 // keep scan inside the owned range
					}
					pairs, err := tr.RangeScan(base+int64(lo), base+int64(hi))
					if err != nil {
						errs[w] = err
						return
					}
					// Only this worker mutates [base, base+span), so the
					// result must equal the oracle exactly.
					var want []int64
					for k := range oracle {
						if k >= base+int64(lo) && k <= base+int64(hi) {
							want = append(want, k)
						}
					}
					sort.Slice(want, func(a, b int) bool { return want[a] < want[b] })
					if len(pairs) != len(want) {
						for _, p := range pairs {
							g, f, ge := tr.Get(p.Key)
							_, inOr := oracle[p.Key]
							t.Logf("w%d mismatch (%d,%d): Get=(%d,%v,%v) oracle=%v",
								w, p.Key, p.Value, g, f, ge, inOr)
						}
						t.Errorf("w%d scan [%d,%d]: got %v, want keys %v",
							w, lo, hi, pairs, want)
						return
					}
					for j, p := range pairs {
						if p.Key != want[j] || p.Value != oracle[p.Key] {
							t.Errorf("w%d scan pair %d = (%d,%d), want key %d",
								w, j, p.Key, p.Value, want[j])
							return
						}
					}
				}
			}
		}(w)
	}
	wg.Wait()

	for w, e := range errs {
		if e != nil {
			t.Fatalf("worker %d: %v", w, e)
		}
	}

	// Final verification against the merged oracle, then reopen for persistence.
	merged := make(map[int64]int64)
	for _, o := range oracles {
		for k, v := range o {
			merged[k] = v
		}
	}
	verifyAgainst := func(tr *Tree) {
		t.Helper()
		for k, want := range merged {
			got, found, err := tr.Get(k)
			if err != nil {
				t.Fatalf("final Get(%d): %v", k, err)
			}
			if !found || got != want {
				t.Fatalf("final Get(%d) = (%d,%v), want (%d,true)", k, got, found, want)
			}
		}
	}
	verifyAgainst(tr)

	if err := tr.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	tr2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer tr2.Close()
	verifyAgainst(tr2)

	// Spot-check a key that was never inserted.
	if _, found, _ := tr2.Get(int64(workers * span)); found {
		t.Fatal("phantom key found after reopen")
	}
}

// TestConcurrentScanChurn pounds the tree with writers inserting/deleting at
// random positions while scanners repeatedly traverse the whole leaf chain.
// This specifically exercises the left-sibling TryLock / errRestart path:
// merges must grab a left sibling while scans hold read latches on it.
func TestConcurrentScanChurn(t *testing.T) {
	path := t.TempDir() + "/churn.db"
	tr, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer tr.Close()

	const preload = 20000
	for i := 0; i < preload; i++ {
		if err := tr.Put(int64(i*2), int64(i)); err != nil {
			t.Fatalf("preload %d: %v", i, err)
		}
	}

	var wg sync.WaitGroup
	errs := make(chan error, 16)

	// Scanners: full-tree scans; every result must be strictly increasing
	// (sorted, no duplicates), regardless of concurrent churn.
	for s := 0; s < 2; s++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				pairs, err := tr.RangeScan(-(1 << 62), 1<<62)
				if err != nil {
					errs <- err
					return
				}
				for j := 1; j < len(pairs); j++ {
					if pairs[j].Key <= pairs[j-1].Key {
						t.Errorf("scan out of order at %d: %d then %d",
							j, pairs[j-1].Key, pairs[j].Key)
						return
					}
				}
			}
		}()
	}

	// Writers: delete random old keys and append new ones, provoking merges
	// and splits all over the leaf chain.
	for w := 0; w < 6; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(w) * 104729))
			next := preload + w*100000
			for i := 0; i < 3000; i++ {
				if rng.Intn(2) == 0 {
					if _, err := tr.Delete(int64(rng.Intn(preload * 2))); err != nil {
						errs <- err
						return
					}
				} else {
					next++
					if err := tr.Put(int64(next), int64(next)); err != nil {
						errs <- err
						return
					}
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatalf("concurrent op: %v", e)
	}

	// Tree must remain structurally readable: full scan is sorted and every
	// returned pair verifies through Get.
	pairs, err := tr.RangeScan(-(1 << 62), 1<<62)
	if err != nil {
		t.Fatalf("final scan: %v", err)
	}
	for j := 1; j < len(pairs); j++ {
		if pairs[j].Key <= pairs[j-1].Key {
			t.Fatalf("final scan out of order at %d", j)
		}
	}
	for _, p := range pairs {
		got, found, err := tr.Get(p.Key)
		if err != nil || !found || got != p.Value {
			t.Fatalf("Get(%d) = (%d,%v,%v)", p.Key, got, found, err)
		}
	}
}

// TestConcurrentHeight3Churn covers what the other tests cannot: internal-node
// merge/borrow and root shrink under concurrency. A height-3 tree (~280k keys
// ≈ 550 leaves > 511 root children) has its middle bands deleted while
// scanners traverse, collapsing level-1 internal nodes so the level-2 root
// must merge/shrink.
func TestConcurrentHeight3Churn(t *testing.T) {
	path := t.TempDir() + "/h3.db"
	tr, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	const preload = 280000
	for i := 0; i < preload; i++ {
		if err := tr.Put(int64(i), int64(i)); err != nil {
			t.Fatalf("preload %d: %v", i, err)
		}
	}
	tr.rootMu.RLock()
	h := tr.meta.height
	tr.rootMu.RUnlock()
	if h < 3 {
		t.Fatalf("preload produced height %d, want >= 3", h)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 8)

	// Scanners assert the strictly-increasing invariant throughout the churn.
	for s := 0; s < 2; s++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 15; i++ {
				pairs, err := tr.RangeScan(-(1 << 62), 1<<62)
				if err != nil {
					errs <- err
					return
				}
				for j := 1; j < len(pairs); j++ {
					if pairs[j].Key <= pairs[j-1].Key {
						t.Errorf("scan out of order at %d", j)
						return
					}
				}
			}
		}()
	}

	// Two deleters erase large contiguous bands, collapsing whole level-1
	// internal subtrees (>255 children each) so internal merges and root
	// shrink fire while scans hold leaf R-latches.
	bands := [][2]int64{{60000, 150000}, {160000, 240000}}
	for b := range bands {
		wg.Add(1)
		go func(lo, hi int64) {
			defer wg.Done()
			for k := lo; k < hi; k++ {
				if _, err := tr.Delete(k); err != nil {
					errs <- err
					return
				}
			}
		}(bands[b][0], bands[b][1])
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatalf("concurrent op: %v", e)
	}

	// Remaining keys are exactly [0,60000) ∪ [150000,160000) ∪ [240000,280000).
	const want = 60000 + 10000 + 40000
	pairs, err := tr.RangeScan(-(1 << 62), 1<<62)
	if err != nil {
		t.Fatalf("final scan: %v", err)
	}
	if len(pairs) != want {
		t.Fatalf("final scan = %d pairs, want %d", len(pairs), want)
	}
	for j := 1; j < len(pairs); j++ {
		if pairs[j].Key <= pairs[j-1].Key {
			t.Fatalf("final scan out of order at %d", j)
		}
	}
	for _, p := range pairs[:1000] {
		got, found, err := tr.Get(p.Key)
		if err != nil || !found || got != p.Value {
			t.Fatalf("Get(%d) = (%d,%v,%v)", p.Key, got, found, err)
		}
	}

	// Persistence: reopen and verify the live set survives.
	if err := tr.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	tr2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer tr2.Close()
	pairs2, err := tr2.RangeScan(-(1 << 62), 1<<62)
	if err != nil {
		t.Fatalf("reopen scan: %v", err)
	}
	if len(pairs2) != want {
		t.Fatalf("reopen scan = %d pairs, want %d", len(pairs2), want)
	}
}
