package bptree

import (
	"sort"
	"testing"
)

func newLeaf(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, PageSize)
	leafInit(b)
	return b
}

func leafPairs(b []byte) []Pair {
	n := int(nodeCount(b))
	out := make([]Pair, n)
	for i := 0; i < n; i++ {
		out[i] = Pair{leafKey(b, i), leafVal(b, i)}
	}
	return out
}

func TestLeafInsertFindRemove(t *testing.T) {
	b := newLeaf(t)
	keys := []int64{50, 10, 30, 20, 40}
	for _, k := range keys {
		pos, found := leafFindPos(b, k)
		if found {
			t.Fatalf("key %d unexpectedly found", k)
		}
		leafInsertAt(b, pos, k, k*10)
	}
	got := leafPairs(b)
	if !sort.SliceIsSorted(got, func(i, j int) bool { return got[i].Key < got[j].Key }) {
		t.Fatalf("pairs not sorted: %v", got)
	}
	for _, k := range keys {
		pos, found := leafFindPos(b, k)
		if !found || leafVal(b, pos) != k*10 {
			t.Fatalf("find %d failed", k)
		}
	}
	// Boundary positions.
	if pos, found := leafFindPos(b, 5); pos != 0 || found {
		t.Fatal("below-min pos wrong")
	}
	if pos, found := leafFindPos(b, 60); pos != len(keys) || found {
		t.Fatal("above-max pos wrong")
	}
	// Remove middle, first, last.
	for _, k := range []int64{30, 10, 50} {
		pos, _ := leafFindPos(b, k)
		leafRemoveAt(b, pos)
	}
	rem := leafPairs(b)
	if len(rem) != 2 || rem[0].Key != 20 || rem[1].Key != 40 {
		t.Fatalf("remaining: %v", rem)
	}
}

func TestLeafSplit(t *testing.T) {
	b := newLeaf(t)
	for i := 0; i < MaxLeafPairs; i++ {
		pos, _ := leafFindPos(b, int64(i*2))
		leafInsertAt(b, pos, int64(i*2), int64(i*2+1))
	}
	right := newLeaf(t)
	// Insert odd key 101 (between 100 and 102) into the full leaf.
	sep := leafInsertSplit(b, right, 101, 10101)

	lp, rp := leafPairs(b), leafPairs(right)
	if len(lp) != 255 || len(rp) != 256 {
		t.Fatalf("split counts: %d/%d", len(lp), len(rp))
	}
	if sep != rp[0].Key {
		t.Fatalf("sep=%d, want %d", sep, rp[0].Key)
	}
	all := append(append([]Pair{}, lp...), rp...)
	if len(all) != 511 {
		t.Fatalf("total %d", len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i].Key <= all[i-1].Key {
			t.Fatalf("not sorted at %d: %v", i, all)
		}
	}
	found101 := false
	for _, p := range all {
		if p.Key == 101 && p.Value == 10101 {
			found101 = true
		}
	}
	if !found101 {
		t.Fatal("inserted key missing after split")
	}
}

func TestLeafSplitBoundaries(t *testing.T) {
	for _, nk := range []int64{-1, 999999} { // insert smallest / largest
		b := newLeaf(t)
		for i := 0; i < MaxLeafPairs; i++ {
			leafInsertAt(b, i, int64(i*2), int64(i*2))
		}
		leafSetNext(b, PageID(777)) // must survive the split
		right := newLeaf(t)
		sep := leafInsertSplit(b, right, nk, nk)
		lp, rp := leafPairs(b), leafPairs(right)
		if len(lp) != 255 || len(rp) != 256 || sep != rp[0].Key {
			t.Fatal("boundary split shape wrong")
		}
		if leafNext(b) != 777 {
			t.Fatal("split clobbered nextLeafPID")
		}
		all := append(append([]Pair{}, lp...), rp...)
		for i := 1; i < len(all); i++ {
			if all[i].Key <= all[i-1].Key {
				t.Fatal("not sorted")
			}
		}
	}
}

func TestLeafMergeBoundary(t *testing.T) {
	l, r := newLeaf(t), newLeaf(t)
	for i := 0; i < 254; i++ {
		leafInsertAt(l, i, int64(i), 0)
	}
	for i := 0; i < 255; i++ {
		leafInsertAt(r, i, int64(1000+i), 0)
	}
	leafMergeInto(l, r)
	if nodeCount(l) != 509 {
		t.Fatalf("merged %d want 509", nodeCount(l))
	}
}

func TestLeafMergeBorrow(t *testing.T) {
	l, r := newLeaf(t), newLeaf(t)
	for i := 0; i < 10; i++ {
		leafInsertAt(l, i, int64(i), int64(i))
	}
	for i := 0; i < 10; i++ {
		leafInsertAt(r, i, int64(100+i), int64(100+i))
	}
	leafBorrowFromRight(l, r)
	if nodeCount(l) != 11 || nodeCount(r) != 9 {
		t.Fatalf("counts %d/%d", nodeCount(l), nodeCount(r))
	}
	if leafKey(l, 10) != 100 || leafKey(r, 0) != 101 {
		t.Fatal("borrow-from-right wrong")
	}
	leafBorrowFromLeft(r, l)
	if leafKey(r, 0) != 100 || nodeCount(l) != 10 {
		t.Fatal("borrow-from-left wrong")
	}
	leafMergeInto(l, r)
	if nodeCount(l) != 20 {
		t.Fatalf("merged count %d", nodeCount(l))
	}
	for i := 0; i < 20; i++ {
		if leafKey(l, i) != leafVal(l, i) {
			t.Fatal("merged leaf out of order")
		}
	}
}

func newInternal(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, PageSize)
	internalInit(b)
	return b
}

func TestInternalFindChild(t *testing.T) {
	b := newInternal(t)
	internalInitRoot(b, 50, 10, 20)
	// keys: [50], children: [10,20]
	if internalFindChildIdx(b, 10) != 0 {
		t.Fatal("10 -> child0")
	}
	if internalFindChildIdx(b, 50) != 1 {
		t.Fatal("50 -> child1")
	}
	if internalFindChildIdx(b, 99) != 1 {
		t.Fatal("99 -> child1")
	}

	internalInsertKeyAt(b, 0, 20, 15) // keys [20,50], children [10,15,20]
	if internalFindChildIdx(b, 10) != 0 ||
		internalFindChildIdx(b, 25) != 1 ||
		internalFindChildIdx(b, 50) != 2 {
		t.Fatal("find child after insert wrong")
	}
	if internalChild(b, 0) != 10 || internalChild(b, 1) != 15 || internalChild(b, 2) != 20 {
		t.Fatal("children wrong")
	}

	internalRemoveKeyAt(b, 0) // remove key20 + child15 → keys [50], children [10,20]
	if nodeCount(b) != 1 || internalChild(b, 0) != 10 || internalChild(b, 1) != 20 {
		t.Fatalf("after remove: n=%d c0=%d c1=%d", nodeCount(b), internalChild(b, 0), internalChild(b, 1))
	}
}

func TestInternalSplit(t *testing.T) {
	b := newInternal(t)
	// Build a full internal node: keys 0..509*2 step 2, children pid = i.
	internalInit(b)
	internalSetChild(b, 0, PageID(0))
	for i := 0; i < MaxInternalKeys; i++ {
		internalInsertKeyAt(b, i, int64(i*2), PageID(i+1))
	}
	if nodeCount(b) != MaxInternalKeys {
		t.Fatalf("n=%d", nodeCount(b))
	}
	right := newInternal(t)
	// Insert separator key 1001 (odd) at pos of key1000's slot.
	pos := internalFindChildIdx(b, 1000) // child idx where a split of child would insert
	promote := internalInsertSplit(b, right, pos, 1001, PageID(9999))

	if nodeCount(b) != 255 || nodeCount(right) != 255 {
		t.Fatalf("split counts %d/%d", nodeCount(b), nodeCount(right))
	}
	if promote != 510 { // scratch keys[255] = original key index 255*2 = 510
		t.Fatalf("promoted %d", promote)
	}
	// Left: keys 0..508 even (255 keys), children 0..255 + check last
	if internalKey(b, 254) != 508 || internalChild(b, 255) != PageID(255) {
		t.Fatal("left side wrong")
	}
	// Right: first child should be scratch child[256]; scratch children:
	// pos was internalFindChildIdx(1000): 1000/2=500 → keys[500]=1000, child idx 501
	// (first i where 1000 < key[i] is i=501 since key[500]==1000 → lo moves past).
	if internalChild(right, 0) != PageID(256) {
		t.Fatalf("right first child = %d", internalChild(right, 0))
	}
	if internalKey(right, 0) != 512 {
		t.Fatalf("right first key = %d", internalKey(right, 0))
	}
	// Verify inserted pair landed correctly: search for 1001 within right.
	ri := internalFindChildIdx(right, 1001)
	if ri < 1 || internalKey(right, ri-1) != 1001 {
		t.Fatalf("1001 not found in right at %d", ri)
	}
	if internalChild(right, ri) != PageID(9999) {
		t.Fatalf("newRight child = %d", internalChild(right, ri))
	}
}

func TestInternalSplitBoundaries(t *testing.T) {
	// pos=0: inserted key smaller than all; pos=510: larger than all —
	// matching what a real promoted separator would look like.
	cases := []struct {
		pos    int
		newKey int64
	}{{0, -7}, {510, 2000}}
	for _, tc := range cases {
		pos := tc.pos
		b := newInternal(t)
		internalSetChild(b, 0, PageID(0))
		for i := 0; i < MaxInternalKeys; i++ {
			internalInsertKeyAt(b, i, int64(i*2), PageID(i+1))
		}
		right := newInternal(t)
		promote := internalInsertSplit(b, right, pos, tc.newKey, PageID(9999))
		if nodeCount(b) != 255 || nodeCount(right) != 255 {
			t.Fatalf("pos=%d counts %d/%d", pos, nodeCount(b), nodeCount(right))
		}
		// Concatenate left keys + promote + right keys; must be strictly sorted.
		var seq []int64
		for i := 0; i < 255; i++ {
			seq = append(seq, internalKey(b, i))
		}
		seq = append(seq, promote)
		for i := 0; i < 255; i++ {
			seq = append(seq, internalKey(right, i))
		}
		if len(seq) != 511 {
			t.Fatalf("pos=%d total keys %d", pos, len(seq))
		}
		for i := 1; i < len(seq); i++ {
			if seq[i] <= seq[i-1] {
				t.Fatalf("pos=%d not sorted at %d: %v", pos, i, seq)
			}
		}
	}
}

func TestInternalMergeBorrow(t *testing.T) {
	l, r := newInternal(t), newInternal(t)
	// l: keys [10], children [100,101]; r: keys [20,30], children [200,201,202]
	internalInitRoot(l, 10, 100, 101)
	internalInit(r)
	internalSetChild(r, 0, 200)
	internalInsertKeyAt(r, 0, 20, 201)
	internalInsertKeyAt(r, 1, 30, 202)

	// Borrow r's first child into l with parent sep 15.
	newSep := internalBorrowFromRight(l, r, 15)
	if newSep != 20 {
		t.Fatalf("newSep=%d want 20", newSep)
	}
	if nodeCount(l) != 2 || nodeCount(r) != 1 {
		t.Fatalf("counts %d/%d", nodeCount(l), nodeCount(r))
	}
	// l now: keys[10,15] children[100,101,200]
	if internalKey(l, 0) != 10 || internalKey(l, 1) != 15 ||
		internalChild(l, 2) != 200 {
		t.Fatal("borrow-from-right structure wrong")
	}
	// r now: keys[30] children[201,202]
	if internalChild(r, 0) != 201 || internalKey(r, 0) != 30 {
		t.Fatal("right after borrow wrong")
	}

	// Borrow back from left: r gets l's last child (200) as first child,
	// sep 15 down, l's last key (15) becomes new sep.
	newSep2 := internalBorrowFromLeft(r, l, 15)
	if newSep2 != 15 {
		t.Fatalf("newSep2=%d want 15", newSep2)
	}
	// r: keys[15,30] children[200,201,202]
	if internalKey(r, 0) != 15 || internalChild(r, 0) != 200 || nodeCount(r) != 2 {
		t.Fatal("borrow-from-left structure wrong")
	}
	if nodeCount(l) != 1 || internalChild(l, 0) != 100 || internalChild(l, 1) != 101 {
		t.Fatal("left after borrow wrong")
	}

	// Merge r into l with sep 15 → l: keys[10? wait l keys=[10] no...
	// l currently keys[10], children[100,101]. merge r (keys[15,30], children[200,201,202]) with sep 15:
	// l -> keys [10, 15, 15?]. Hmm sep should be whatever parent had: use 12.
	internalMergeInto(l, r, 12)
	// l: keys [10,12,15,30], children [100,101,200,201,202]
	if nodeCount(l) != 4 {
		t.Fatalf("merged keys %d", nodeCount(l))
	}
	wantK := []int64{10, 12, 15, 30}
	wantC := []PageID{100, 101, 200, 201, 202}
	for i, k := range wantK {
		if internalKey(l, i) != k {
			t.Fatalf("key[%d]=%d", i, internalKey(l, i))
		}
	}
	for i, c := range wantC {
		if internalChild(l, i) != c {
			t.Fatalf("child[%d]=%d", i, internalChild(l, i))
		}
	}
}
