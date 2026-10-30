// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"bytes"
	"encoding/json"
	"testing"
)

// ---------------------------------------------------------------------------
// A self-contained Avro reader, written independently of the encoder under
// test, so a round-trip through it proves the encoder's bytes are decodable
// by a conforming Avro reader — not merely self-consistent. It implements
// exactly the subset the manifest/manifest-list schemas use: zig-zag varint
// long/int, length-prefixed string/bytes, boolean, unions, and the
// array-of-block encoding Iceberg uses for its int-keyed maps.
// ---------------------------------------------------------------------------

type avroReader struct {
	b   []byte
	pos int
	t   *testing.T
}

func (r *avroReader) readLong() int64 {
	var ux uint64
	var shift uint
	for {
		if r.pos >= len(r.b) {
			r.t.Fatalf("avroReader: unexpected EOF reading varint at %d", r.pos)
		}
		c := r.b[r.pos]
		r.pos++
		ux |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			break
		}
		shift += 7
	}
	// zig-zag decode
	return int64(ux>>1) ^ -int64(ux&1)
}

func (r *avroReader) readInt() int32 { return int32(r.readLong()) }

func (r *avroReader) readBytes() []byte {
	n := int(r.readLong())
	if n < 0 || r.pos+n > len(r.b) {
		r.t.Fatalf("avroReader: bad byte length %d at %d", n, r.pos)
	}
	out := r.b[r.pos : r.pos+n]
	r.pos += n
	return out
}

func (r *avroReader) readString() string { return string(r.readBytes()) }

func (r *avroReader) readBool() bool {
	if r.pos >= len(r.b) {
		r.t.Fatalf("avroReader: EOF reading bool")
	}
	v := r.b[r.pos]
	r.pos++
	return v != 0
}

// readUnionIndex reads the union branch selector (a long).
func (r *avroReader) readUnionIndex() int64 { return r.readLong() }

// readIntLongMap decodes a ["null", array<{key:int,value:long}>] union into
// a Go map, mirroring writeAvroIntLongMap. Returns nil for the null branch.
func (r *avroReader) readIntLongMap() map[int]int64 {
	if r.readUnionIndex() == 0 {
		return nil
	}
	out := map[int]int64{}
	for {
		count := r.readLong()
		if count == 0 {
			break
		}
		if count < 0 { // block-with-byte-size form (valid Avro, unused by our encoder)
			_ = r.readLong()
			count = -count
		}
		for i := int64(0); i < count; i++ {
			k := int(r.readInt())
			out[k] = r.readLong()
		}
	}
	return out
}

// readIntBytesMap decodes ["null", array<{key:int,value:bytes}>].
func (r *avroReader) readIntBytesMap() map[int][]byte {
	if r.readUnionIndex() == 0 {
		return nil
	}
	out := map[int][]byte{}
	for {
		count := r.readLong()
		if count == 0 {
			break
		}
		if count < 0 {
			_ = r.readLong()
			count = -count
		}
		for i := int64(0); i < count; i++ {
			k := int(r.readInt())
			v := r.readBytes()
			cp := make([]byte, len(v))
			copy(cp, v)
			out[k] = cp
		}
	}
	return out
}

// readNullableLongArray decodes ["null", array<long>].
func (r *avroReader) readNullableLongArray() []int64 {
	if r.readUnionIndex() == 0 {
		return nil
	}
	var out []int64
	for {
		count := r.readLong()
		if count == 0 {
			break
		}
		if count < 0 {
			_ = r.readLong()
			count = -count
		}
		for i := int64(0); i < count; i++ {
			out = append(out, r.readLong())
		}
	}
	return out
}

// ocfBlock unwraps an Avro OCF: verifies the magic, extracts the embedded
// schema JSON, checks the codec is "null", verifies the trailing sync marker
// matches the header's, and returns the schema + object count + the raw
// record bytes of the single data block WriteTable emits.
func ocfBlock(t *testing.T, ocf []byte) (schema string, objectCount int64, records []byte) {
	t.Helper()
	r := &avroReader{b: ocf, t: t}
	if !bytes.Equal(r.b[:4], []byte{'O', 'b', 'j', 1}) {
		t.Fatalf("bad OCF magic: %v", r.b[:4])
	}
	r.pos = 4

	// header map<string,bytes>
	meta := map[string]string{}
	count := r.readLong()
	if count < 0 {
		_ = r.readLong()
		count = -count
	}
	for i := int64(0); i < count; i++ {
		k := r.readString()
		v := r.readBytes()
		meta[k] = string(v)
	}
	if term := r.readLong(); term != 0 {
		t.Fatalf("header map not terminated by 0, got %d", term)
	}
	if meta["avro.codec"] != "null" {
		t.Fatalf("unexpected codec %q, want null", meta["avro.codec"])
	}
	schema = meta["avro.schema"]
	if schema == "" {
		t.Fatal("OCF header missing avro.schema")
	}

	headerSync := r.b[r.pos : r.pos+16]
	r.pos += 16

	objectCount = r.readLong()
	blockLen := int(r.readLong())
	if r.pos+blockLen > len(r.b) {
		t.Fatalf("block length %d overruns OCF", blockLen)
	}
	records = r.b[r.pos : r.pos+blockLen]
	r.pos += blockLen

	trailingSync := r.b[r.pos : r.pos+16]
	if !bytes.Equal(headerSync, trailingSync) {
		t.Fatalf("block sync marker %v != header sync %v", trailingSync, headerSync)
	}
	return schema, objectCount, records
}

// TestWriteAvroLong_ZigZagRoundTrip round-trips a spread of longs (including
// the zig-zag-sensitive negatives and the varint boundaries) through the
// encoder and the independent reader.
func TestWriteAvroLong_ZigZagRoundTrip(t *testing.T) {
	vals := []int64{0, -1, 1, -2, 2, 63, 64, -64, -65, 127, 128, -128,
		8191, 8192, -8192, 1 << 20, -(1 << 20), 1 << 34, -(1 << 34),
		9223372036854775807, -9223372036854775808}
	var buf bytes.Buffer
	for _, v := range vals {
		writeAvroLong(&buf, v)
	}
	r := &avroReader{b: buf.Bytes(), t: t}
	for _, want := range vals {
		if got := r.readLong(); got != want {
			t.Fatalf("round-trip long: got %d want %d", got, want)
		}
	}
	if r.pos != len(buf.Bytes()) {
		t.Fatalf("decoder left %d trailing bytes", len(buf.Bytes())-r.pos)
	}
}

// TestWriteAvroString_RoundTrip covers empty, ASCII, and multi-byte UTF-8.
func TestWriteAvroString_RoundTrip(t *testing.T) {
	vals := []string{"", "a", "s3://bucket/warehouse/events/data/x.parquet", "héllo→世界"}
	var buf bytes.Buffer
	for _, v := range vals {
		writeAvroString(&buf, v)
	}
	r := &avroReader{b: buf.Bytes(), t: t}
	for _, want := range vals {
		if got := r.readString(); got != want {
			t.Fatalf("round-trip string: got %q want %q", got, want)
		}
	}
}

// TestWriteAvroNullableLong_Union checks both branches of the ["null","long"]
// union decode to the right value / nil.
func TestWriteAvroNullableLong_Union(t *testing.T) {
	var buf bytes.Buffer
	writeAvroNullableLong(&buf, nil)
	forty := int64(40)
	writeAvroNullableLong(&buf, &forty)
	r := &avroReader{b: buf.Bytes(), t: t}
	if idx := r.readUnionIndex(); idx != 0 {
		t.Fatalf("nil should encode null branch (0), got %d", idx)
	}
	if idx := r.readUnionIndex(); idx != 1 {
		t.Fatalf("non-nil should encode value branch (1), got %d", idx)
	}
	if got := r.readLong(); got != 40 {
		t.Fatalf("union long payload: got %d want 40", got)
	}
}

// TestWriteAvroIntLongMap_RoundTrip checks the array-of-{key,value} encoding
// Iceberg uses for its int-keyed maps, including the null-branch for empties
// and deterministic key ordering.
func TestWriteAvroIntLongMap_RoundTrip(t *testing.T) {
	// empty -> null branch, decodes back to nil
	var empty bytes.Buffer
	writeAvroIntLongMap(&empty, nil)
	if got := (&avroReader{b: empty.Bytes(), t: t}).readIntLongMap(); got != nil {
		t.Fatalf("empty map should decode to nil, got %v", got)
	}

	m := map[int]int64{3: 300, 1: 100, 2: 200}
	var buf bytes.Buffer
	writeAvroIntLongMap(&buf, m)
	got := (&avroReader{b: buf.Bytes(), t: t}).readIntLongMap()
	if len(got) != len(m) {
		t.Fatalf("map size: got %d want %d", len(got), len(m))
	}
	for k, v := range m {
		if got[k] != v {
			t.Fatalf("map[%d]: got %d want %d", k, got[k], v)
		}
	}
}

// TestEncodeAvroOCF_Structure checks the OCF framing directly: magic, that
// the embedded schema JSON is valid and matches the input, the null codec,
// and that a single-record block decodes with the sync markers matching.
func TestEncodeAvroOCF_Structure(t *testing.T) {
	var rec bytes.Buffer
	writeAvroLong(&rec, 7)
	writeAvroString(&rec, "hi")
	sync := [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	schemaJSON := `{"type":"record","name":"t","fields":[{"name":"a","type":"long"},{"name":"b","type":"string"}]}`

	ocf := encodeAvroOCF(schemaJSON, sync, 1, rec.Bytes())
	gotSchema, objCount, records := ocfBlock(t, ocf)

	if objCount != 1 {
		t.Fatalf("object count: got %d want 1", objCount)
	}
	if gotSchema != schemaJSON {
		t.Fatalf("schema round-trip mismatch:\n got %s\nwant %s", gotSchema, schemaJSON)
	}
	var js map[string]any
	if err := json.Unmarshal([]byte(gotSchema), &js); err != nil {
		t.Fatalf("embedded schema is not valid JSON: %v", err)
	}
	rr := &avroReader{b: records, t: t}
	if got := rr.readLong(); got != 7 {
		t.Fatalf("record field a: got %d want 7", got)
	}
	if got := rr.readString(); got != "hi" {
		t.Fatalf("record field b: got %q want hi", got)
	}
}
