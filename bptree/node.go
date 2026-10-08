package bptree

// Node page layout — all functions operate on raw page bytes viewed as int64
// slots via getI64/setI64. See design.md §2.4/§2.5.
//
// Internal (type=1): [0]=type [1]=nKeys [2]=child0 then (key[i], child[i+1])
//   key[i]  at index 3+2i   (i = 0..n-1)
//   child[i] at index 2+2i   (i = 0..n)
//
// Leaf (type=2): [0]=type [1]=nPairs [2]=nextLeafPID then (key[i], val[i])
//   key[i] at index 3+2i, val[i] at index 4+2i   (i = 0..n-1)

// ---------- common ----------

func nodeTypeOf(b []byte) int64      { return getI64(b, 0) }
func nodeCount(b []byte) int64       { return getI64(b, 1) }
func setNodeCount(b []byte, n int64) { setI64(b, 1, n) }

func isLeaf(b []byte) bool { return nodeTypeOf(b) == nodeTypeLeaf }

// safeForInsert reports whether inserting one entry cannot trigger a split.
func safeForInsert(b []byte) bool {
	if isLeaf(b) {
		return nodeCount(b) < MaxLeafPairs
	}
	return nodeCount(b) < MaxInternalKeys
}

// safeForDelete reports whether removing one entry cannot cause underflow.
func safeForDelete(b []byte) bool {
	if isLeaf(b) {
		return nodeCount(b) > MinLeafPairs
	}
	return nodeCount(b) > MinInternalKeys
}

// ---------- leaf ----------

// leafInit/internalInit write only the header; the payload region keeps
// whatever bytes the page already had (e.g. a freelist-reused page). All
// reads are bounded by count, so stale bytes are never observed.
func leafInit(b []byte) {
	setI64(b, 0, nodeTypeLeaf)
	setI64(b, 1, 0)
	setI64(b, 2, int64(nilPageID))
}

func leafNext(b []byte) PageID       { return PageID(getI64(b, 2)) }
func leafSetNext(b []byte, p PageID) { setI64(b, 2, int64(p)) }

func leafKey(b []byte, i int) int64 { return getI64(b, 3+2*i) }
func leafVal(b []byte, i int) int64 { return getI64(b, 4+2*i) }

func leafSetPair(b []byte, i int, k, v int64) {
	setI64(b, 3+2*i, k)
	setI64(b, 4+2*i, v)
}

// leafFindPos returns the index of the first key >= target, and whether that
// key equals target.
func leafFindPos(b []byte, target int64) (int, bool) {
	n := int(nodeCount(b))
	lo, hi := 0, n
	for lo < hi {
		mid := (lo + hi) / 2
		if leafKey(b, mid) < target {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo, lo < n && leafKey(b, lo) == target
}

// leafInsertAt inserts (k,v) at position pos, shifting existing pairs right.
// Caller must ensure n < MaxLeafPairs.
func leafInsertAt(b []byte, pos int, k, v int64) {
	n := int(nodeCount(b))
	for i := n; i > pos; i-- {
		leafSetPair(b, i, leafKey(b, i-1), leafVal(b, i-1))
	}
	leafSetPair(b, pos, k, v)
	setNodeCount(b, int64(n+1))
}

// leafRemoveAt removes the pair at pos, shifting left. Caller ensures pos < n.
func leafRemoveAt(b []byte, pos int) {
	n := int(nodeCount(b))
	for i := pos; i < n-1; i++ {
		leafSetPair(b, i, leafKey(b, i+1), leafVal(b, i+1))
	}
	setNodeCount(b, int64(n-1))
}

// leafInsertSplit handles a leaf that is already full (MaxLeafPairs pairs):
// the 511 sorted (k,v) pairs are built in scratch, then split 255/256 —
// left keeps the lower 255 in b, the upper 256 go to right (assumed fresh).
// Returns the copy-up separator key = smallest key in right.
//
// Preconditions: n == MaxLeafPairs; k must NOT already exist in b (Put's
// upsert path guarantees this).
// Postcondition: this function does NOT touch the sibling links — the caller
// must wire right.next = b.next; b.next = rightPID (b's next is preserved).
func leafInsertSplit(b, right []byte, k, v int64) int64 {
	n := int(nodeCount(b)) // == MaxLeafPairs
	pos, _ := leafFindPos(b, k)

	var keys [MaxLeafPairs + 1]int64
	var vals [MaxLeafPairs + 1]int64
	for i := 0; i < pos; i++ {
		keys[i], vals[i] = leafKey(b, i), leafVal(b, i)
	}
	keys[pos], vals[pos] = k, v
	for i := pos; i < n; i++ {
		keys[i+1], vals[i+1] = leafKey(b, i), leafVal(b, i)
	}

	const leftN = MinLeafPairs // 255 left, 256 right
	for i := 0; i < leftN; i++ {
		leafSetPair(b, i, keys[i], vals[i])
	}
	setNodeCount(b, leftN)

	leafInit(right)
	for i := leftN; i <= n; i++ {
		leafSetPair(right, i-leftN, keys[i], vals[i])
	}
	setNodeCount(right, int64(n+1-leftN))
	return keys[leftN]
}

// leafMergeInto appends all pairs of src to the end of dst. Returns new count.
// Callers fix up nextLeafPID and the parent separator themselves.
// Precondition: count(dst)+count(src) <= MaxLeafPairs.
func leafMergeInto(dst, src []byte) {
	dn, sn := int(nodeCount(dst)), int(nodeCount(src))
	for i := 0; i < sn; i++ {
		leafSetPair(dst, dn+i, leafKey(src, i), leafVal(src, i))
	}
	setNodeCount(dst, int64(dn+sn))
}

// leafBorrowFromRight moves right's first pair to the end of b.
// Caller must update the parent separator to right's new first key.
// Precondition: count(right) > MinLeafPairs (donor stays >= Min).
func leafBorrowFromRight(b, right []byte) {
	pos := int(nodeCount(b))
	leafSetPair(b, pos, leafKey(right, 0), leafVal(right, 0))
	setNodeCount(b, int64(pos+1))
	leafRemoveAt(right, 0)
}

// leafBorrowFromLeft moves left's last pair to the front of b.
// Caller must update the parent separator to b's new first key.
// Precondition: count(left) > MinLeafPairs (donor stays >= Min).
func leafBorrowFromLeft(b, left []byte) {
	ln := int(nodeCount(left))
	k, v := leafKey(left, ln-1), leafVal(left, ln-1)
	leafRemoveAt(left, ln-1)
	leafInsertAt(b, 0, k, v)
}

// ---------- internal ----------

func internalInit(b []byte) {
	setI64(b, 0, nodeTypeInternal)
	setI64(b, 1, 0)
	setI64(b, 2, int64(nilPageID))
}

func internalKey(b []byte, i int) int64          { return getI64(b, 3+2*i) }
func internalChild(b []byte, i int) PageID       { return PageID(getI64(b, 2+2*i)) }
func internalSetKey(b []byte, i int, k int64)    { setI64(b, 3+2*i, k) }
func internalSetChild(b []byte, i int, p PageID) { setI64(b, 2+2*i, int64(p)) }

// internalFindChildIdx returns the index of the child subtree that may
// contain target: the first i where target < key[i], else nKeys.
func internalFindChildIdx(b []byte, target int64) int {
	n := int(nodeCount(b))
	lo, hi := 0, n
	for lo < hi {
		mid := (lo + hi) / 2
		if target < internalKey(b, mid) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo
}

// internalInitRoot initializes an internal node with exactly two children and
// one separator key — the shape of a freshly grown root.
func internalInitRoot(b []byte, sep int64, left, right PageID) {
	internalInit(b)
	internalSetChild(b, 0, left)
	internalSetKey(b, 0, sep)
	internalSetChild(b, 1, right)
	setNodeCount(b, 1)
}

// internalInsertKeyAt inserts separator k at key position pos and child
// newRight at child position pos+1, shifting right. Caller ensures n < Max.
func internalInsertKeyAt(b []byte, pos int, k int64, newRight PageID) {
	n := int(nodeCount(b))
	for i := n; i > pos; i-- {
		internalSetKey(b, i, internalKey(b, i-1))
		internalSetChild(b, i+1, internalChild(b, i))
	}
	internalSetKey(b, pos, k)
	internalSetChild(b, pos+1, newRight)
	setNodeCount(b, int64(n+1))
}

// internalRemoveKeyAt removes key[pos] and the child pointer at pos+1.
func internalRemoveKeyAt(b []byte, pos int) {
	n := int(nodeCount(b))
	for i := pos; i < n-1; i++ {
		internalSetKey(b, i, internalKey(b, i+1))
		internalSetChild(b, i+1, internalChild(b, i+2))
	}
	setNodeCount(b, int64(n-1))
}

// internalInsertSplit handles a full internal node (MaxInternalKeys keys)
// receiving (k, newRight) at key position pos. The 511 keys + 512 children
// are built in scratch; key[255] is promoted to the parent (returned);
// left keeps keys[0..254]/children[0..255], right gets
// keys[256..510]/children[256..511].
func internalInsertSplit(b, right []byte, pos int, k int64, newRight PageID) int64 {
	n := int(nodeCount(b)) // == MaxInternalKeys

	var keys [MaxInternalKeys + 1]int64
	var children [MaxInternalKeys + 2]PageID
	for i := 0; i < pos; i++ {
		keys[i] = internalKey(b, i)
	}
	keys[pos] = k
	for i := pos; i < n; i++ {
		keys[i+1] = internalKey(b, i)
	}
	for i := 0; i <= pos; i++ {
		children[i] = internalChild(b, i)
	}
	children[pos+1] = newRight
	for i := pos + 1; i <= n; i++ {
		children[i+1] = internalChild(b, i)
	}

	const mid = MinInternalKeys // promote keys[255]
	internalInit(b)
	setNodeCount(b, mid)
	for i := 0; i < mid; i++ {
		internalSetKey(b, i, keys[i])
	}
	for i := 0; i <= mid; i++ {
		internalSetChild(b, i, children[i])
	}

	internalInit(right)
	rn := n + 1 - mid - 1 // 255
	for i := 0; i < rn; i++ {
		internalSetKey(right, i, keys[mid+1+i])
	}
	for i := 0; i <= rn; i++ {
		internalSetChild(right, i, children[mid+1+i])
	}
	setNodeCount(right, int64(rn))
	return keys[mid]
}

// internalMergeInto appends the pulled-down separator sep then all of src's
// keys/children to dst (internal nodes only).
// Precondition: count(dst)+1+count(src) <= MaxInternalKeys.
func internalMergeInto(dst, src []byte, sep int64) {
	dn, sn := int(nodeCount(dst)), int(nodeCount(src))
	internalSetKey(dst, dn, sep)
	for i := 0; i < sn; i++ {
		internalSetKey(dst, dn+1+i, internalKey(src, i))
	}
	for i := 0; i <= sn; i++ {
		internalSetChild(dst, dn+1+i, internalChild(src, i))
	}
	setNodeCount(dst, int64(dn+1+sn))
}

// internalBorrowFromRight moves right's first child into b under the pulled-
// down parent separator sep; right's first key is promoted as new separator
// (returned). Precondition: count(right) > MinInternalKeys (donor stays >= Min).
func internalBorrowFromRight(b, right []byte, sep int64) int64 {
	n := int(nodeCount(b))
	internalSetKey(b, n, sep)
	internalSetChild(b, n+1, internalChild(right, 0))
	setNodeCount(b, int64(n+1))

	newSep := internalKey(right, 0)
	rn := int(nodeCount(right))
	for i := 0; i < rn-1; i++ {
		internalSetKey(right, i, internalKey(right, i+1))
	}
	for i := 0; i < rn; i++ {
		internalSetChild(right, i, internalChild(right, i+1))
	}
	setNodeCount(right, int64(rn-1))
	return newSep
}

// internalBorrowFromLeft moves left's last child into b as new first child
// under the pulled-down separator sep; left's last key is promoted (returned).
// Precondition: count(left) > MinInternalKeys (donor stays >= Min).
func internalBorrowFromLeft(b, left []byte, sep int64) int64 {
	ln := int(nodeCount(left))
	lastChild := internalChild(left, ln)
	lastKey := internalKey(left, ln-1)
	setNodeCount(left, int64(ln-1))

	n := int(nodeCount(b))
	for i := n; i > 0; i-- {
		internalSetKey(b, i, internalKey(b, i-1))
	}
	for i := n + 1; i > 0; i-- {
		internalSetChild(b, i, internalChild(b, i-1))
	}
	internalSetKey(b, 0, sep)
	internalSetChild(b, 0, lastChild)
	setNodeCount(b, int64(n+1))
	return lastKey
}
