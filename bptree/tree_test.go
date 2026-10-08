package bptree

import (
	"math/rand"
	"path/filepath"
	"testing"
)

func TestPutGetBasic(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	if _, ok, err := tr.Get(42); err != nil || ok {
		t.Fatalf("get on empty: ok=%v err=%v", ok, err)
	}
	if err := tr.Put(42, 420); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := tr.Get(42); err != nil || !ok || v != 420 {
		t.Fatalf("get: v=%d ok=%v err=%v", v, ok, err)
	}
	// Overwrite.
	if err := tr.Put(42, 421); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := tr.Get(42); err != nil || !ok || v != 421 {
		t.Fatalf("overwrite: v=%d ok=%v", v, ok)
	}
}

func TestPutGetRandom(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 5000
	want := make(map[int64]int64)
	rnd := rand.New(rand.NewSource(1))
	keys := rnd.Perm(N)
	for _, k := range keys {
		key := int64(k)
		val := key*3 + 7
		if err := tr.Put(key, val); err != nil {
			t.Fatalf("put %d: %v", key, err)
		}
		want[key] = val
	}
	for key, val := range want {
		v, ok, err := tr.Get(key)
		if err != nil || !ok || v != val {
			t.Fatalf("get %d: v=%d ok=%v err=%v", key, v, ok, err)
		}
	}
	if _, ok, _ := tr.Get(int64(N + 999)); ok {
		t.Fatal("phantom key")
	}
}

func TestPutSplitMany(t *testing.T) {
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	// Enough keys to force leaf and internal splits and height > 1.
	const N = MaxLeafPairs * 6
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i), int64(i*2)); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}
	if tr.meta.height < 2 {
		t.Fatalf("height=%d, want >=2", tr.meta.height)
	}
	for i := 0; i < N; i++ {
		v, ok, err := tr.Get(int64(i))
		if err != nil || !ok || v != int64(i*2) {
			t.Fatalf("get %d: v=%d ok=%v err=%v", i, v, ok, err)
		}
	}
}

// TestPutHeight3 inserts enough sequential keys to force internal-node splits
// and a third tree level (~512 leaf pages), exercising internalInsertSplit and
// multi-level propagation. Skipped in -short mode.
func TestPutHeight3(t *testing.T) {
	if testing.Short() {
		t.Skip("height-3 test needs ~140k inserts")
	}
	tr, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()

	const N = 140_000
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i), int64(i)); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}
	if tr.meta.height < 3 {
		t.Fatalf("height=%d, want >=3", tr.meta.height)
	}
	// Spot-check a strided sample plus boundaries.
	for i := 0; i < N; i += 997 {
		v, ok, err := tr.Get(int64(i))
		if err != nil || !ok || v != int64(i) {
			t.Fatalf("get %d: v=%d ok=%v err=%v", i, v, ok, err)
		}
	}
	for _, i := range []int{0, N - 1} {
		v, ok, _ := tr.Get(int64(i))
		if !ok || v != int64(i) {
			t.Fatalf("boundary get %d failed", i)
		}
	}
}

func TestPersistenceReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	tr, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	const N = 3000
	for i := 0; i < N; i++ {
		if err := tr.Put(int64(i*10), int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}

	tr2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer tr2.Close()
	for i := 0; i < N; i++ {
		v, ok, err := tr2.Get(int64(i * 10))
		if err != nil || !ok || v != int64(i) {
			t.Fatalf("reopen get %d: v=%d ok=%v err=%v", i*10, v, ok, err)
		}
	}
}
