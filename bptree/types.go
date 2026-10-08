package bptree

// PageID identifies a page in the DB file. Page i starts at offset i*PageSize.
type PageID int64

// Pair is a key/value entry returned by RangeScan.
type Pair struct {
	Key   int64
	Value int64
}
