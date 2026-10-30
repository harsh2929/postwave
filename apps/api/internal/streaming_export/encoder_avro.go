// SPDX-License-Identifier: AGPL-3.0-only
//
// encoder_avro.go — self-contained Avro Object Container File (OCF)
// encoder for streaming-export event rows.
//
// No external Avro dependency is vendored in this repo, and Avro's
// binary encoding is small enough to implement directly:
//
//   - long  → zig-zag varint
//   - string/bytes → long(length) ++ raw bytes
//   - record → its fields, in declaration order
//
// The OCF wrapper is: magic ("Obj\x01") ++ a map header carrying
// avro.schema + avro.codec ("null"), then one or more data blocks, each
// = long(objectCount) ++ long(byteLen) ++ serialized objects ++ the
// 16-byte sync marker (also stored in the header).
//
// Output is readable by every conforming Avro reader (fastavro,
// hadoop, Snowflake/BigQuery Avro loaders) — round-tripped in
// encoder_avro_test.go against an independent decoder.
package streaming_export

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
)

// AvroContentType is the canonical content type for Avro OCF objects.
const AvroContentType = "avro/binary"

// avroSchema is the Avro record schema matching EventRow. Field order
// here MUST match the write order in encodeAvroRecord.
const avroSchema = `{"type":"record","name":"PostwaveStreamingEvent","namespace":"postwave.streaming","fields":[` +
	`{"name":"event_id","type":"long"},` +
	`{"name":"tenant_id","type":"string"},` +
	`{"name":"subscriber_email","type":"string"},` +
	`{"name":"event_type","type":"string"},` +
	`{"name":"campaign_id","type":"string"},` +
	`{"name":"link_url","type":"string"},` +
	`{"name":"at_unix_ms","type":"long"},` +
	`{"name":"subscriber_status","type":"string"},` +
	`{"name":"tags","type":"string"},` +
	`{"name":"custom_fields","type":"string"}` +
	`]}`

// AvroSchema returns the schema string embedded in the OCF header.
func AvroSchema() string { return avroSchema }

// avroMagic is the 4-byte OCF file marker.
var avroMagic = []byte{'O', 'b', 'j', 1}

// EncodeAvro encodes event rows as an Avro OCF file with the "null"
// codec (no block compression — block-level codec is independent of the
// connection's logical compression hint, which is recorded on the run).
func EncodeAvro(rows []EventRow) ([]byte, error) {
	var sync [16]byte
	if _, err := rand.Read(sync[:]); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	buf.Write(avroMagic)

	// Header is itself an Avro map<string,bytes> with 2 entries.
	writeAvroLong(&buf, 2) // block count
	writeAvroMapEntry(&buf, "avro.schema", []byte(avroSchema))
	writeAvroMapEntry(&buf, "avro.codec", []byte("null"))
	writeAvroLong(&buf, 0) // map terminator
	buf.Write(sync[:])

	if len(rows) > 0 {
		var block bytes.Buffer
		for i := range rows {
			encodeAvroRecord(&block, rows[i])
		}
		writeAvroLong(&buf, int64(len(rows)))   // object count
		writeAvroLong(&buf, int64(block.Len())) // serialized size
		buf.Write(block.Bytes())
		buf.Write(sync[:])
	}
	return buf.Bytes(), nil
}

// encodeAvroRecord writes one EventRow in field-declaration order. Order
// is load-bearing — it must match avroSchema exactly.
func encodeAvroRecord(buf *bytes.Buffer, r EventRow) {
	writeAvroLong(buf, r.EventID)
	writeAvroString(buf, r.TenantID)
	writeAvroString(buf, r.SubscriberEmail)
	writeAvroString(buf, r.EventType)
	writeAvroString(buf, r.CampaignID)
	writeAvroString(buf, r.LinkURL)
	writeAvroLong(buf, r.AtUnixMs)
	writeAvroString(buf, r.SubscriberStatus)
	writeAvroString(buf, r.Tags)
	writeAvroString(buf, r.CustomFields)
}

// writeAvroLong writes a zig-zag varint-encoded long.
func writeAvroLong(buf *bytes.Buffer, v int64) {
	var tmp [binary.MaxVarintLen64]byte
	zz := uint64(v<<1) ^ uint64(v>>63)
	n := binary.PutUvarint(tmp[:], zz)
	buf.Write(tmp[:n])
}

// writeAvroString writes a length-prefixed UTF-8 string.
func writeAvroString(buf *bytes.Buffer, s string) {
	writeAvroLong(buf, int64(len(s)))
	buf.WriteString(s)
}

// writeAvroMapEntry writes one key→bytes map entry (key is a string,
// value is length-prefixed bytes).
func writeAvroMapEntry(buf *bytes.Buffer, key string, val []byte) {
	writeAvroString(buf, key)
	writeAvroLong(buf, int64(len(val)))
	buf.Write(val)
}
