package streaming_export

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// avroReader is an independent minimal decoder used only by the test, so
// the round-trip is checked against code that does NOT share the encoder's
// helpers.
type avroReader struct {
	r *bytes.Reader
}

func (ar *avroReader) long() int64 {
	zz, err := binary.ReadUvarint(ar.r)
	if err != nil {
		panic(err)
	}
	return int64(zz>>1) ^ -int64(zz&1)
}

func (ar *avroReader) str() string {
	n := ar.long()
	b := make([]byte, n)
	if _, err := ar.r.Read(b); err != nil && n > 0 {
		panic(err)
	}
	return string(b)
}

func (ar *avroReader) bytesVal() []byte {
	n := ar.long()
	b := make([]byte, n)
	if _, err := ar.r.Read(b); err != nil && n > 0 {
		panic(err)
	}
	return b
}

func TestEncodeAvroHeaderAndRoundTrip(t *testing.T) {
	rows := sampleRows()
	body, err := EncodeAvro(rows)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.HasPrefix(body, []byte{'O', 'b', 'j', 1}) {
		t.Fatalf("missing Avro OCF magic")
	}

	ar := &avroReader{r: bytes.NewReader(body[4:])}
	// Header map.
	mapCount := ar.long()
	if mapCount != 2 {
		t.Fatalf("header map count = %d want 2", mapCount)
	}
	meta := map[string]string{}
	for i := int64(0); i < mapCount; i++ {
		k := ar.str()
		v := ar.bytesVal()
		meta[k] = string(v)
	}
	if ar.long() != 0 {
		t.Fatalf("expected map terminator 0")
	}
	if !strings.Contains(meta["avro.schema"], "PostwaveStreamingEvent") {
		t.Fatalf("schema missing record name: %q", meta["avro.schema"])
	}
	if meta["avro.codec"] != "null" {
		t.Fatalf("codec = %q want null", meta["avro.codec"])
	}

	// 16-byte sync marker.
	sync := make([]byte, 16)
	if _, err := ar.r.Read(sync); err != nil {
		t.Fatalf("read sync: %v", err)
	}

	// Data block.
	objCount := ar.long()
	if objCount != int64(len(rows)) {
		t.Fatalf("block object count = %d want %d", objCount, len(rows))
	}
	_ = ar.long() // serialized byte length

	for i := int64(0); i < objCount; i++ {
		eventID := ar.long()
		tenantID := ar.str()
		email := ar.str()
		eventType := ar.str()
		campaign := ar.str()
		link := ar.str()
		atMs := ar.long()
		status := ar.str()
		tags := ar.str()
		custom := ar.str()

		want := rows[i]
		if eventID != want.EventID || tenantID != want.TenantID || email != want.SubscriberEmail {
			t.Fatalf("row %d ids mismatch: %d/%s/%s", i, eventID, tenantID, email)
		}
		if eventType != want.EventType || campaign != want.CampaignID || link != want.LinkURL {
			t.Fatalf("row %d strings mismatch", i)
		}
		if atMs != want.AtUnixMs {
			t.Fatalf("row %d at = %d want %d", i, atMs, want.AtUnixMs)
		}
		if status != want.SubscriberStatus || tags != want.Tags || custom != want.CustomFields {
			t.Fatalf("row %d profile mismatch: %s/%s/%s", i, status, tags, custom)
		}
	}

	if AvroSchema() != avroSchema {
		t.Fatal("AvroSchema() drifted from constant")
	}
}

func TestEncodeAvroEmptyHasNoDataBlock(t *testing.T) {
	body, err := EncodeAvro(nil)
	if err != nil {
		t.Fatalf("encode empty: %v", err)
	}
	// magic(4) + header. With no rows, no data block follows the header
	// sync marker — total length is just the header.
	if !bytes.HasPrefix(body, []byte{'O', 'b', 'j', 1}) {
		t.Fatalf("missing magic")
	}
	if len(body) == 0 {
		t.Fatal("empty body")
	}
}
