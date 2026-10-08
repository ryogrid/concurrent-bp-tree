package bptree

// Meta page (pageID 0) slot layout — see design.md §2.3.
const (
	metaIdxMagic   = 0
	metaIdxVersion = 1
	metaIdxRoot    = 2
	metaIdxHeight  = 3
	metaIdxFree    = 4
	metaIdxNext    = 5
)

// meta is the in-memory copy of the meta page. rootPageID/height are guarded
// by Tree.rootMu; freeListHead/nextPageID are guarded by Tree.metaMu.
type meta struct {
	rootPageID   PageID
	height       int64
	freeListHead PageID
	nextPageID   PageID
}

func encodeMeta(m *meta, buf []byte) {
	setI64(buf, metaIdxMagic, metaMagic)
	setI64(buf, metaIdxVersion, metaVersion)
	setI64(buf, metaIdxRoot, int64(m.rootPageID))
	setI64(buf, metaIdxHeight, m.height)
	setI64(buf, metaIdxFree, int64(m.freeListHead))
	setI64(buf, metaIdxNext, int64(m.nextPageID))
}

func decodeMeta(buf []byte) (meta, error) {
	if getI64(buf, metaIdxMagic) != metaMagic ||
		getI64(buf, metaIdxVersion) != metaVersion {
		return meta{}, ErrCorruptFile
	}
	m := meta{
		rootPageID:   PageID(getI64(buf, metaIdxRoot)),
		height:       getI64(buf, metaIdxHeight),
		freeListHead: PageID(getI64(buf, metaIdxFree)),
		nextPageID:   PageID(getI64(buf, metaIdxNext)),
	}
	// Sanity-range validation (review hardening): catches partial writes or
	// files written by another format version that happen to share the magic.
	if m.rootPageID < 1 || m.rootPageID >= m.nextPageID ||
		m.height < 1 || m.height > MaxTreeHeight ||
		m.nextPageID < 2 ||
		m.freeListHead < 0 || m.freeListHead >= m.nextPageID {
		return meta{}, ErrCorruptFile
	}
	return m, nil
}
