// SPDX-License-Identifier: AGPL-3.0-only
//
// avro_decode.go — the reader half of the package's self-contained Avro: it
// decodes the manifest-list OCF this package writes (avro.go/manifest_list.go)
// back into ManifestListEntry values. RecoverTableAppender needs it to resume
// an existing table's snapshot history after a restart (a table's live
// manifests are only recorded inside its current snapshot's manifest-list, not
// in the metadata JSON), and a package that writes a format ought to be able
// to read it back.
//
// Only the manifest-list schema is decoded here (the one incremental commits
// need to resume); the primitives (zig-zag varint long/int, length-prefixed
// string/bytes, the null-union sentinel) generalize if the manifest reader is
// ever needed too.
package iceberg

import (
	"errors"
	"fmt"
)

// avroDecoder is a big-endian... (Avro is little-endian varint) cursor over an
// OCF body that latches the first short-read into err.
type avroDecoder struct {
	b   []byte
	pos int
	err error
}

func (d *avroDecoder) long() int64 {
	if d.err != nil {
		return 0
	}
	var ux uint64
	var shift uint
	for {
		if d.pos >= len(d.b) {
			d.err = errors.New("iceberg: truncated Avro varint")
			return 0
		}
		c := d.b[d.pos]
		d.pos++
		ux |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			break
		}
		shift += 7
	}
	return int64(ux>>1) ^ -int64(ux&1) // zig-zag
}

func (d *avroDecoder) int32() int32 { return int32(d.long()) }

func (d *avroDecoder) bytes() []byte {
	n := d.long()
	if d.err != nil {
		return nil
	}
	if n < 0 || d.pos+int(n) > len(d.b) {
		d.err = errors.New("iceberg: bad Avro byte length")
		return nil
	}
	b := d.b[d.pos : d.pos+int(n)]
	d.pos += int(n)
	return b
}

func (d *avroDecoder) str() string { return string(d.bytes()) }

func (d *avroDecoder) skip(n int) {
	if d.err != nil {
		return
	}
	if d.pos+n > len(d.b) {
		d.err = errors.New("iceberg: truncated OCF")
		return
	}
	d.pos += n
}

// DecodeManifestList parses a manifest-list OCF (as written by
// EncodeManifestList) back into its entries.
func DecodeManifestList(ocf []byte) ([]ManifestListEntry, error) {
	if len(ocf) < 4 || string(ocf[:4]) != "Obj\x01" {
		return nil, errors.New("iceberg: not an Avro OCF (bad magic)")
	}
	d := &avroDecoder{b: ocf, pos: 4}

	// Header map<string,bytes>: one or more blocks of (count, entries…),
	// terminated by count 0.
	for {
		n := d.long()
		if d.err != nil {
			return nil, d.err
		}
		if n == 0 {
			break
		}
		if n < 0 { // block-with-byte-size form
			d.long()
			n = -n
		}
		for i := int64(0); i < n; i++ {
			d.str()   // key
			d.bytes() // value
		}
	}
	d.skip(16) // sync marker

	objectCount := d.long()
	d.long() // block byte length (unused; we decode by object count)
	if d.err != nil {
		return nil, d.err
	}

	out := make([]ManifestListEntry, 0, objectCount)
	for i := int64(0); i < objectCount; i++ {
		e := d.manifestFile()
		if d.err != nil {
			return nil, fmt.Errorf("iceberg: decode manifest_file %d: %w", i, d.err)
		}
		out = append(out, e)
	}
	return out, nil
}

// manifestFile decodes one manifest_file record in the field order
// encodeManifestListEntry writes.
func (d *avroDecoder) manifestFile() ManifestListEntry {
	e := ManifestListEntry{
		ManifestPath:    d.str(),
		ManifestLength:  d.long(),
		PartitionSpecID: d.int32(),
	}
	d.int32() // content
	e.SequenceNumber = d.long()
	e.MinSequenceNumber = d.long()
	e.AddedSnapshotID = d.long()
	e.AddedFilesCount = d.int32()
	e.ExistingFilesCount = d.int32()
	e.DeletedFilesCount = d.int32()
	e.AddedRowsCount = d.long()
	e.ExistingRowsCount = d.long()
	e.DeletedRowsCount = d.long()
	d.long() // partitions: null-union sentinel
	d.long() // key_metadata: null-union sentinel
	return e
}
