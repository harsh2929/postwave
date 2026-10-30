// SPDX-License-Identifier: AGPL-3.0-only
package pgcdc

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

// msg builds a pgoutput message body big-endian, transcribing the documented
// wire format. Used both to construct round-trip inputs and (below) checked
// against a hand-authored literal-byte fixture so the builder itself can't
// silently drift from the spec.
type msg struct{ b []byte }

func newMsg(t MessageType) *msg { return &msg{b: []byte{byte(t)}} }
func (m *msg) u8(v uint8) *msg  { m.b = append(m.b, v); return m }
func (m *msg) u16(v uint16) *msg {
	m.b = binary.BigEndian.AppendUint16(m.b, v)
	return m
}
func (m *msg) u32(v uint32) *msg {
	m.b = binary.BigEndian.AppendUint32(m.b, v)
	return m
}
func (m *msg) u64(v uint64) *msg {
	m.b = binary.BigEndian.AppendUint64(m.b, v)
	return m
}
func (m *msg) cstr(s string) *msg { m.b = append(append(m.b, s...), 0); return m }
func (m *msg) txt(s string) *msg { // a 't' tuple column
	m.b = append(m.b, 't')
	m.b = binary.BigEndian.AppendUint32(m.b, uint32(len(s)))
	m.b = append(m.b, s...)
	return m
}

func TestDecodeBeginAndCommit(t *testing.T) {
	// 2 000 000 000 µs after the pg epoch = 2000-01-01 + 2000s.
	const micros = 2_000_000_000
	begin, err := Decode(newMsg(MessageTypeBegin).u64(0x1234567).u64(micros).u32(4242).b)
	if err != nil {
		t.Fatalf("decode begin: %v", err)
	}
	b := begin.(BeginMessage)
	if b.FinalLSN != 0x1234567 || b.XID != 4242 {
		t.Fatalf("begin fields wrong: %+v", b)
	}
	wantTime := pgEpoch.Add(micros * time.Microsecond)
	if !b.CommitTime.Equal(wantTime) {
		t.Fatalf("begin time = %v, want %v", b.CommitTime, wantTime)
	}

	commit, err := Decode(newMsg(MessageTypeCommit).u8(0).u64(0x1234567).u64(0x1234599).u64(micros).b)
	if err != nil {
		t.Fatalf("decode commit: %v", err)
	}
	c := commit.(CommitMessage)
	if c.CommitLSN != 0x1234567 || c.EndLSN != 0x1234599 {
		t.Fatalf("commit LSNs wrong: %+v", c)
	}
}

func TestDecodeRelation(t *testing.T) {
	m := newMsg(MessageTypeRelation).
		u32(16385).cstr("public").cstr("users").u8('d').u16(2).
		u8(1).cstr("id").u32(23).u32(0xFFFFFFFF).   // key col, int4, atttypmod -1
		u8(0).cstr("email").u32(25).u32(0xFFFFFFFF) // non-key, text
	rel, err := Decode(m.b)
	if err != nil {
		t.Fatalf("decode relation: %v", err)
	}
	r := rel.(RelationMessage)
	if r.RelationID != 16385 || r.Namespace != "public" || r.RelationName != "users" {
		t.Fatalf("relation header wrong: %+v", r)
	}
	if len(r.Columns) != 2 {
		t.Fatalf("want 2 columns, got %d", len(r.Columns))
	}
	if !r.Columns[0].Key || r.Columns[0].Name != "id" || r.Columns[0].TypeOID != 23 {
		t.Errorf("col0 wrong: %+v", r.Columns[0])
	}
	if r.Columns[0].TypeModifier != -1 {
		t.Errorf("col0 atttypmod = %d, want -1", r.Columns[0].TypeModifier)
	}
	if r.Columns[1].Key || r.Columns[1].Name != "email" || r.Columns[1].TypeOID != 25 {
		t.Errorf("col1 wrong: %+v", r.Columns[1])
	}
}

// TestDecodeInsertLiteralFixture decodes a HAND-AUTHORED byte sequence written
// out per the spec (not via the msg builder), the independent anchor that
// guards against the builder and decoder sharing a mistake.
func TestDecodeInsertLiteralFixture(t *testing.T) {
	fixture := []byte{
		'I',                    // Insert
		0x00, 0x00, 0x40, 0x01, // relation OID 16385
		'N',        // new tuple
		0x00, 0x02, // 2 columns
		't',                    // column 0: text
		0x00, 0x00, 0x00, 0x02, // length 2
		'4', '2', // "42"
		't',                    // column 1: text
		0x00, 0x00, 0x00, 0x03, // length 3
		'a', 'b', 'c', // "abc"
	}
	m, err := Decode(fixture)
	if err != nil {
		t.Fatalf("decode literal insert: %v", err)
	}
	ins := m.(InsertMessage)
	if ins.RelationID != 16385 {
		t.Fatalf("relation OID = %d, want 16385", ins.RelationID)
	}
	if len(ins.New.Columns) != 2 {
		t.Fatalf("want 2 columns, got %d", len(ins.New.Columns))
	}
	if string(ins.New.Columns[0].Data) != "42" || string(ins.New.Columns[1].Data) != "abc" {
		t.Fatalf("values wrong: %q %q", ins.New.Columns[0].Data, ins.New.Columns[1].Data)
	}
}

func TestDecodeUpdateWithOldTuple(t *testing.T) {
	// Update carrying a full old tuple ('O') then the new tuple ('N').
	m := newMsg(MessageTypeUpdate).u32(16385).
		u8('O').u16(1).txt("old") // old tuple: 1 col "old"
	m.b = append(m.b, 'N')
	m = (&msg{b: m.b}).u16(1)
	m = (&msg{b: m.b}).txt("new")

	upd, err := Decode(m.b)
	if err != nil {
		t.Fatalf("decode update: %v", err)
	}
	u := upd.(UpdateMessage)
	if u.OldKind != 'O' || u.Old == nil || string(u.Old.Columns[0].Data) != "old" {
		t.Fatalf("old tuple wrong: %+v", u)
	}
	if string(u.New.Columns[0].Data) != "new" {
		t.Fatalf("new tuple wrong: %+v", u.New)
	}
}

func TestDecodeUpdateWithoutOldTuple(t *testing.T) {
	// Default replica identity: no old tuple, the 'N' new tuple follows the
	// relation OID directly.
	m := newMsg(MessageTypeUpdate).u32(16385)
	m.b = append(m.b, 'N')
	m = (&msg{b: m.b}).u16(1)
	m = (&msg{b: m.b}).txt("x")
	upd, err := Decode(m.b)
	if err != nil {
		t.Fatalf("decode update: %v", err)
	}
	u := upd.(UpdateMessage)
	if u.Old != nil || u.OldKind != 0 {
		t.Fatalf("expected no old tuple, got %+v", u)
	}
	if string(u.New.Columns[0].Data) != "x" {
		t.Fatalf("new tuple wrong: %+v", u.New)
	}
}

func TestDecodeDeleteAndTupleKinds(t *testing.T) {
	// Delete with a key tuple mixing a null and an unchanged-TOAST column.
	m := newMsg(MessageTypeDelete).u32(16385).u8('K').u16(3)
	m.b = append(m.b, 'n')      // null
	m = (&msg{b: m.b}).txt("k") // text
	m.b = append(m.b, 'u')      // unchanged toast
	del, err := Decode(m.b)
	if err != nil {
		t.Fatalf("decode delete: %v", err)
	}
	d := del.(DeleteMessage)
	if d.OldKind != 'K' || len(d.Old.Columns) != 3 {
		t.Fatalf("delete wrong: %+v", d)
	}
	if d.Old.Columns[0].Kind != TupleNull || d.Old.Columns[0].Data != nil {
		t.Errorf("col0 should be null with no data: %+v", d.Old.Columns[0])
	}
	if d.Old.Columns[1].Kind != TupleText || string(d.Old.Columns[1].Data) != "k" {
		t.Errorf("col1 should be text 'k': %+v", d.Old.Columns[1])
	}
	if d.Old.Columns[2].Kind != TupleUnchanged || d.Old.Columns[2].Data != nil {
		t.Errorf("col2 should be unchanged with no data: %+v", d.Old.Columns[2])
	}
}

func TestDecodeErrors(t *testing.T) {
	if _, err := Decode(nil); err == nil {
		t.Error("empty message should error")
	}
	if _, err := Decode([]byte{'Z'}); err == nil {
		t.Error("unknown message type should error")
	}
	// Truncated Begin (needs 20 body bytes, give 4).
	if _, err := Decode([]byte{'B', 0, 0, 0, 0}); err == nil {
		t.Error("truncated begin should error")
	}
	// Insert with a text column whose declared length overruns the buffer.
	bad := []byte{'I', 0, 0, 0x40, 0x01, 'N', 0, 1, 't', 0, 0, 0, 0x10, 'a'}
	if _, err := Decode(bad); err == nil {
		t.Error("overrunning tuple length should error")
	}
}

func TestRelationCache_NamedColumns(t *testing.T) {
	cache := NewRelationCache()

	rel, _ := Decode(newMsg(MessageTypeRelation).
		u32(16385).cstr("public").cstr("users").u8('d').u16(2).
		u8(1).cstr("id").u32(23).u32(0xFFFFFFFF).
		u8(0).cstr("email").u32(25).u32(0xFFFFFFFF).b)
	cache.Observe(rel)

	ins, _ := Decode(func() []byte {
		m := newMsg(MessageTypeInsert).u32(16385)
		m.b = append(m.b, 'N')
		m = (&msg{b: m.b}).u16(2)
		m = (&msg{b: m.b}).txt("7")
		m.b = append(m.b, 'n') // email NULL
		return m.b
	}())

	cols, err := cache.NamedColumns(16385, ins.(InsertMessage).New)
	if err != nil {
		t.Fatalf("named columns: %v", err)
	}
	if cols[0].Name != "id" || cols[0].Value == nil || *cols[0].Value != "7" {
		t.Errorf("col0 wrong: %+v", cols[0])
	}
	if cols[1].Name != "email" || !cols[1].Null || cols[1].Value != nil {
		t.Errorf("col1 should be NULL: %+v", cols[1])
	}

	// Unknown relation OID and column-count mismatch are hard errors, never
	// field-shifted rows.
	if _, err := cache.NamedColumns(99999, ins.(InsertMessage).New); err == nil {
		t.Error("unknown relation OID should error")
	}
	mismatch := TupleData{Columns: []TupleColumn{{Kind: TupleText, Data: []byte("x")}}}
	if _, err := cache.NamedColumns(16385, mismatch); err == nil {
		t.Error("column-count mismatch should error")
	}
}

// TestDecodedValueDoesNotAliasInput guards the copy in reader.bytes: mutating
// the source buffer after decoding must not change the decoded value.
func TestDecodedValueDoesNotAliasInput(t *testing.T) {
	src := newMsg(MessageTypeInsert).u32(1)
	src.b = append(src.b, 'N')
	src = (&msg{b: src.b}).u16(1)
	src = (&msg{b: src.b}).txt("orig")
	buf := bytes.Clone(src.b)

	ins, err := Decode(buf)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	for i := range buf {
		buf[i] = 'X' // scribble over the whole input
	}
	if string(ins.(InsertMessage).New.Columns[0].Data) != "orig" {
		t.Fatal("decoded value aliased the input buffer")
	}
}
