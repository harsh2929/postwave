// SPDX-License-Identifier: AGPL-3.0-only
//
// avro.go — self-contained Avro Object Container File (OCF) primitives,
// generalized from internal/streaming_export/encoder_avro.go's pattern
// (that encoder only ever writes a flat record of longs/strings; the
// Iceberg manifest and manifest-list schemas additionally need unions,
// nested records, and Iceberg's array-of-{key,value} map encoding, so
// those primitives live here rather than being imported from
// streaming_export).
//
// No external Avro dependency is vendored in this repo; the encoding is:
//   - int/long  → zig-zag varint (Avro uses the same varint scheme for
//     both; "int" is just documentation that the value fits int32)
//   - string/bytes → long(length) ++ raw bytes
//   - record → its fields, in schema-declaration order
//   - union → long(branch index, 0-based) ++ the branch's encoding
//     ("null" branches write nothing beyond the index)
//   - array → one or more blocks of long(itemCount) ++ items, terminated
//     by long(0); an empty/absent array is encoded as just long(0)
//
// Iceberg's manifest Avro schemas encode "map<K,V>" fields as
// array<record{key,value}> (Avro has no int-keyed native map), which is
// what writeAvroIntLongMap / writeAvroIntBytesMap below produce.
package iceberg

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"sort"
)

// avroMagic is the 4-byte OCF file marker, shared by every OCF this
// package writes (manifest + manifest-list).
var avroMagic = []byte{'O', 'b', 'j', 1}

// encodeAvroOCF wraps encodedRecords (already-serialized Avro records,
// one after another) in a full OCF file: magic, header (schema + "null"
// codec), sync marker, then a single data block. sync is passed in
// rather than generated internally so callers/tests can supply a
// deterministic marker; WriteTable's public entry points generate one
// via crypto/rand when the caller doesn't care.
func encodeAvroOCF(schemaJSON string, sync [16]byte, objectCount int, encodedRecords []byte) []byte {
	var buf bytes.Buffer
	buf.Write(avroMagic)

	writeAvroLong(&buf, 2) // header map has 2 entries
	writeAvroMapEntry(&buf, "avro.schema", []byte(schemaJSON))
	writeAvroMapEntry(&buf, "avro.codec", []byte("null"))
	writeAvroLong(&buf, 0) // map terminator
	buf.Write(sync[:])

	if objectCount > 0 {
		writeAvroLong(&buf, int64(objectCount))
		writeAvroLong(&buf, int64(len(encodedRecords)))
		buf.Write(encodedRecords)
		buf.Write(sync[:])
	}
	return buf.Bytes()
}

// newAvroSync generates a random 16-byte OCF sync marker.
func newAvroSync() ([16]byte, error) {
	var sync [16]byte
	_, err := rand.Read(sync[:])
	return sync, err
}

// writeAvroLong writes a zig-zag varint-encoded long (also used for
// Avro "int" — same varint scheme, narrower documented range).
func writeAvroLong(buf *bytes.Buffer, v int64) {
	var tmp [binary.MaxVarintLen64]byte
	zz := uint64(v<<1) ^ uint64(v>>63)
	n := binary.PutUvarint(tmp[:], zz)
	buf.Write(tmp[:n])
}

// writeAvroInt writes an Avro "int" (same varint encoding as long).
func writeAvroInt(buf *bytes.Buffer, v int32) { writeAvroLong(buf, int64(v)) }

// writeAvroString writes a length-prefixed UTF-8 string.
func writeAvroString(buf *bytes.Buffer, s string) {
	writeAvroLong(buf, int64(len(s)))
	buf.WriteString(s)
}

// writeAvroBytes writes a length-prefixed raw byte string.
func writeAvroBytes(buf *bytes.Buffer, b []byte) {
	writeAvroLong(buf, int64(len(b)))
	buf.Write(b)
}

// writeAvroMapEntry writes one key→bytes OCF-header map entry (key is a
// string, value is length-prefixed bytes). Only used for the two fixed
// header entries (avro.schema, avro.codec) — not Iceberg's int-keyed
// maps, which use writeAvroIntLongMap/writeAvroIntBytesMap below.
func writeAvroMapEntry(buf *bytes.Buffer, key string, val []byte) {
	writeAvroString(buf, key)
	writeAvroLong(buf, int64(len(val)))
	buf.Write(val)
}

// writeAvroNullableLong writes a ["null","long"] union: nil → branch 0
// (nothing further); non-nil → branch 1 followed by the long.
func writeAvroNullableLong(buf *bytes.Buffer, v *int64) {
	if v == nil {
		writeAvroLong(buf, 0)
		return
	}
	writeAvroLong(buf, 1)
	writeAvroLong(buf, *v)
}

// writeAvroNullableInt writes a ["null","int"] union.
func writeAvroNullableInt(buf *bytes.Buffer, v *int32) {
	if v == nil {
		writeAvroLong(buf, 0)
		return
	}
	writeAvroLong(buf, 1)
	writeAvroInt(buf, *v)
}

// writeAvroIntLongMap writes Iceberg's ["null", array<{key:int,value:long}>]
// encoding for an int-keyed long-valued map (column_sizes, value_counts,
// null_value_counts). A nil/empty map is written as the null branch —
// Iceberg readers treat "absent" and "empty" as equivalent for these
// optional per-column stat maps. Keys are sorted for deterministic output.
func writeAvroIntLongMap(buf *bytes.Buffer, m map[int]int64) {
	if len(m) == 0 {
		writeAvroLong(buf, 0) // null branch
		return
	}
	writeAvroLong(buf, 1) // array branch
	keys := sortedIntKeys(m)
	writeAvroLong(buf, int64(len(keys))) // one block holding every entry
	for _, k := range keys {
		writeAvroInt(buf, int32(k))
		writeAvroLong(buf, m[k])
	}
	writeAvroLong(buf, 0) // block terminator
}

// writeAvroIntBytesMap is writeAvroIntLongMap's sibling for the
// int-keyed bytes-valued maps (lower_bounds, upper_bounds).
func writeAvroIntBytesMap(buf *bytes.Buffer, m map[int][]byte) {
	if len(m) == 0 {
		writeAvroLong(buf, 0)
		return
	}
	writeAvroLong(buf, 1)
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	writeAvroLong(buf, int64(len(keys)))
	for _, k := range keys {
		writeAvroInt(buf, int32(k))
		writeAvroBytes(buf, m[k])
	}
	writeAvroLong(buf, 0)
}

// writeAvroNullableLongArray writes a ["null", array<long>] union: a
// nil/empty slice is the null branch (matches Iceberg's treatment of
// split_offsets as fully optional).
func writeAvroNullableLongArray(buf *bytes.Buffer, vals []int64) {
	if len(vals) == 0 {
		writeAvroLong(buf, 0)
		return
	}
	writeAvroLong(buf, 1)
	writeAvroLong(buf, int64(len(vals)))
	for _, v := range vals {
		writeAvroLong(buf, v)
	}
	writeAvroLong(buf, 0)
}

func sortedIntKeys(m map[int]int64) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}
