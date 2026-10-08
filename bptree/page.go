package bptree

import "encoding/binary"

// Pages are arrays of int64 encoded little-endian (x64 Linux target).
// getI64/setI64 are the single point where the encoding is defined.

func getI64(b []byte, idx int) int64 {
	return int64(binary.LittleEndian.Uint64(b[idx*8:]))
}

func setI64(b []byte, idx int, v int64) {
	binary.LittleEndian.PutUint64(b[idx*8:], uint64(v))
}
