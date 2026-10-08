package bptree

import "errors"

// PageSize is the fixed on-disk page size in bytes.
const PageSize = 8192

// pageSlots is the number of int64 slots that fit in a page.
// Every page is treated as an array of pageSlots int64 values.
const pageSlots = PageSize / 8

// BufferPoolFrames is the number of buffer pool frames (hardcoded).
const BufferPoolFrames = 256

// MaxTreeHeight bounds the descent path length for latch crabbing.
// With fanout ~511, height 8 already covers ~10^18 keys.
const MaxTreeHeight = 8

const (
	nodeTypeInternal int64 = 1
	nodeTypeLeaf     int64 = 2
)

// Node capacity constants derived from the page layout (design.md §2).
//
// Internal: type@0, nKeys@1, child[i]@2+2i, key[i]@3+2i.
// For n=MaxInternalKeys the last used index is child[n]@2+2n = 1022.
// Leaf: type@0, nPairs@1, nextLeafPID@2, key[i]@3+2i, val[i]@4+2i.
const (
	MaxInternalKeys = (pageSlots - 4) / 2 // 510 keys => 511 children
	MinInternalKeys = MaxInternalKeys / 2 // 255
	MaxLeafPairs    = (pageSlots - 3) / 2 // 510 pairs
	MinLeafPairs    = MaxLeafPairs / 2    // 255
)

const (
	metaMagic   int64 = 0xC0B17EEE
	metaVersion int64 = 1
)

// metaPageID is always page 0. Page 0 is never a tree node and never freed,
// so the value 0 doubles as the "none" sentinel for link fields
// (nextLeafPID, freeListHead).
const metaPageID PageID = 0

// nilPageID is the explicit "none" sentinel name used for link fields.
const nilPageID PageID = 0

// invalidPageID marks a buffer frame that currently holds no page.
const invalidPageID PageID = -1

var (
	// ErrNoFreeFrame is returned when every buffer pool frame is pinned.
	ErrNoFreeFrame = errors.New("bptree: buffer pool exhausted")
	// ErrMaxTreeHeight is returned if a split would exceed MaxTreeHeight.
	ErrMaxTreeHeight = errors.New("bptree: tree height exceeds MaxTreeHeight")
	// ErrCorruptFile is returned for a bad magic/version/truncated DB file.
	ErrCorruptFile = errors.New("bptree: corrupt or unsupported file")
	// ErrClosed is returned when operating on a closed Tree.
	ErrClosed = errors.New("bptree: tree is closed")
)
