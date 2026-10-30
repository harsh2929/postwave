// SPDX-License-Identifier: AGPL-3.0-only
//
// pgoutput.go — a decoder for Postgres logical-replication messages in the
// built-in `pgoutput` format (protocol version 1), the change-data-capture
// SOURCE that pairs with internal/iceberg's table WRITER (the sink) to make
// G-18 "warehouse-native" real: stream committed row changes out of Postgres
// via a logical replication slot, decode them here, and append them to an
// Iceberg table — no polling, no copy-into-Postgres.
//
// This package decodes the pgoutput message envelope only; establishing the
// replication connection (START_REPLICATION ... LOGICAL, standby status
// updates, LSN tracking) is a thin layer on top that a caller with a live
// wal_level=logical database provides. The message formats are specified by
// the Postgres protocol ("Logical Replication Message Formats"); the byte
// layouts below are transcribed from that spec so a real slot's output
// decodes without a mirror-encoder round-trip having to be trusted on its
// own — the tests anchor on spec-literal fixtures as well as round-trips.
//
// Integers are big-endian. Strings are null-terminated. Timestamps are
// microseconds since the Postgres epoch (2000-01-01 00:00:00 UTC). LSNs are
// uint64.
package pgcdc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

// pgEpoch is the Postgres timestamp epoch (2000-01-01 UTC); pgoutput commit
// timestamps are microseconds relative to it.
var pgEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

// MessageType is the 1-byte tag that opens every pgoutput message.
type MessageType byte

const (
	MessageTypeBegin    MessageType = 'B'
	MessageTypeCommit   MessageType = 'C'
	MessageTypeRelation MessageType = 'R'
	MessageTypeInsert   MessageType = 'I'
	MessageTypeUpdate   MessageType = 'U'
	MessageTypeDelete   MessageType = 'D'
)

// Message is the decoded form of one pgoutput message. Exactly one of the
// concrete types below is returned by Decode.
type Message interface{ Type() MessageType }

// BeginMessage opens a transaction: the LSN of its commit and its xid.
type BeginMessage struct {
	FinalLSN   uint64
	CommitTime time.Time
	XID        uint32
}

func (BeginMessage) Type() MessageType { return MessageTypeBegin }

// CommitMessage closes a transaction.
type CommitMessage struct {
	Flags      uint8
	CommitLSN  uint64
	EndLSN     uint64
	CommitTime time.Time
}

func (CommitMessage) Type() MessageType { return MessageTypeCommit }

// RelationColumn describes one column in a RelationMessage.
type RelationColumn struct {
	// Key reports whether the column is part of the replica-identity key
	// (pgoutput sets flag bit 1 for such columns).
	Key          bool
	Name         string
	TypeOID      uint32
	TypeModifier int32
}

// RelationMessage describes a table's shape. pgoutput emits one before the
// first change to a relation in a stream (and again if the shape changes);
// Insert/Update/Delete messages reference it by RelationID, so a decoder that
// materializes rows must cache these (see RelationCache).
type RelationMessage struct {
	RelationID      uint32
	Namespace       string
	RelationName    string
	ReplicaIdentity uint8
	Columns         []RelationColumn
}

func (RelationMessage) Type() MessageType { return MessageTypeRelation }

// TupleKind is the 1-byte marker preceding each column value in a TupleData.
type TupleKind byte

const (
	// TupleNull is a SQL NULL — no value bytes follow.
	TupleNull TupleKind = 'n'
	// TupleUnchanged is an unchanged TOASTed value not sent in this message
	// (only appears in the new-tuple of an Update) — no value bytes follow.
	TupleUnchanged TupleKind = 'u'
	// TupleText is a value in its text representation.
	TupleText TupleKind = 't'
	// TupleBinary is a value in its binary representation.
	TupleBinary TupleKind = 'b'
)

// TupleColumn is one column's value within a tuple.
type TupleColumn struct {
	Kind TupleKind
	// Data is the raw value bytes for Text/Binary kinds; nil for Null and
	// Unchanged. For TupleText it is the UTF-8 text representation.
	Data []byte
}

// TupleData is a row's worth of column values, positionally aligned with the
// referenced RelationMessage's Columns.
type TupleData struct {
	Columns []TupleColumn
}

// InsertMessage is a new row.
type InsertMessage struct {
	RelationID uint32
	New        TupleData
}

func (InsertMessage) Type() MessageType { return MessageTypeInsert }

// UpdateMessage is a changed row. Old is present only when the table's
// replica identity causes the previous row (or its key) to be sent — OldKind
// reports which ('K' = key only, 'O' = full old tuple, 0 = absent).
type UpdateMessage struct {
	RelationID uint32
	OldKind    byte
	Old        *TupleData
	New        TupleData
}

func (UpdateMessage) Type() MessageType { return MessageTypeUpdate }

// DeleteMessage is a removed row, carrying the old row or its key depending
// on replica identity (OldKind is 'K' or 'O').
type DeleteMessage struct {
	RelationID uint32
	OldKind    byte
	Old        TupleData
}

func (DeleteMessage) Type() MessageType { return MessageTypeDelete }

// ErrShortBuffer is returned when a message is truncated mid-field.
var ErrShortBuffer = errors.New("pgcdc: message truncated")

// Decode parses a single pgoutput message. It returns an error for an empty
// buffer, an unknown/unsupported message type, or a truncated message; it
// never partially applies a message.
func Decode(data []byte) (Message, error) {
	if len(data) == 0 {
		return nil, errors.New("pgcdc: empty message")
	}
	r := &reader{buf: data[1:]}
	switch MessageType(data[0]) {
	case MessageTypeBegin:
		lsn := r.uint64()
		ts := r.uint64()
		xid := r.uint32()
		if r.err != nil {
			return nil, r.err
		}
		return BeginMessage{FinalLSN: lsn, CommitTime: pgTime(ts), XID: xid}, nil

	case MessageTypeCommit:
		flags := r.uint8()
		commitLSN := r.uint64()
		endLSN := r.uint64()
		ts := r.uint64()
		if r.err != nil {
			return nil, r.err
		}
		return CommitMessage{Flags: flags, CommitLSN: commitLSN, EndLSN: endLSN, CommitTime: pgTime(ts)}, nil

	case MessageTypeRelation:
		return decodeRelation(r)

	case MessageTypeInsert:
		relID := r.uint32()
		if kind := r.uint8(); kind != 'N' {
			if r.err != nil {
				return nil, r.err
			}
			return nil, fmt.Errorf("pgcdc: insert expected 'N' tuple, got %q", rune(kind))
		}
		tup, err := decodeTuple(r)
		if err != nil {
			return nil, err
		}
		return InsertMessage{RelationID: relID, New: tup}, nil

	case MessageTypeUpdate:
		return decodeUpdate(r)

	case MessageTypeDelete:
		relID := r.uint32()
		kind := r.uint8()
		if kind != 'K' && kind != 'O' {
			if r.err != nil {
				return nil, r.err
			}
			return nil, fmt.Errorf("pgcdc: delete expected 'K' or 'O', got %q", rune(kind))
		}
		tup, err := decodeTuple(r)
		if err != nil {
			return nil, err
		}
		return DeleteMessage{RelationID: relID, OldKind: kind, Old: tup}, nil

	default:
		return nil, fmt.Errorf("pgcdc: unsupported message type %q", rune(data[0]))
	}
}

func decodeRelation(r *reader) (Message, error) {
	m := RelationMessage{
		RelationID:   r.uint32(),
		Namespace:    r.cstring(),
		RelationName: r.cstring(),
	}
	m.ReplicaIdentity = r.uint8()
	ncols := r.uint16()
	if r.err != nil {
		return nil, r.err
	}
	m.Columns = make([]RelationColumn, 0, ncols)
	for i := 0; i < int(ncols); i++ {
		col := RelationColumn{
			Key:          r.uint8()&1 == 1,
			Name:         r.cstring(),
			TypeOID:      r.uint32(),
			TypeModifier: int32(r.uint32()),
		}
		if r.err != nil {
			return nil, r.err
		}
		m.Columns = append(m.Columns, col)
	}
	return m, nil
}

func decodeUpdate(r *reader) (Message, error) {
	m := UpdateMessage{RelationID: r.uint32()}
	if r.err != nil {
		return nil, r.err
	}
	// Peek the next kind byte: 'K'/'O' introduce an old tuple, 'N' is the
	// new tuple directly (no old tuple sent for this replica identity).
	kind := r.uint8()
	if r.err != nil {
		return nil, r.err
	}
	if kind == 'K' || kind == 'O' {
		old, err := decodeTuple(r)
		if err != nil {
			return nil, err
		}
		m.OldKind = kind
		m.Old = &old
		kind = r.uint8() // the following 'N'
		if r.err != nil {
			return nil, r.err
		}
	}
	if kind != 'N' {
		return nil, fmt.Errorf("pgcdc: update expected 'N' new tuple, got %q", rune(kind))
	}
	newTup, err := decodeTuple(r)
	if err != nil {
		return nil, err
	}
	m.New = newTup
	return m, nil
}

func decodeTuple(r *reader) (TupleData, error) {
	ncols := r.uint16()
	if r.err != nil {
		return TupleData{}, r.err
	}
	cols := make([]TupleColumn, 0, ncols)
	for i := 0; i < int(ncols); i++ {
		kind := TupleKind(r.uint8())
		if r.err != nil {
			return TupleData{}, r.err
		}
		switch kind {
		case TupleNull, TupleUnchanged:
			cols = append(cols, TupleColumn{Kind: kind})
		case TupleText, TupleBinary:
			n := r.uint32()
			data := r.bytes(int(n))
			if r.err != nil {
				return TupleData{}, r.err
			}
			cols = append(cols, TupleColumn{Kind: kind, Data: data})
		default:
			return TupleData{}, fmt.Errorf("pgcdc: unknown tuple column kind %q", rune(kind))
		}
	}
	return TupleData{Columns: cols}, nil
}

func pgTime(micros uint64) time.Time {
	return pgEpoch.Add(time.Duration(micros) * time.Microsecond)
}

// NamedColumn is one column of a change resolved against its relation: the
// column's name plus its tuple value. Text values decode to a *string;
// NULLs and unchanged-TOAST values decode to a nil pointer with the
// respective flag set so a consumer can tell "set to NULL" from "not sent".
type NamedColumn struct {
	Name      string
	Value     *string
	Null      bool
	Unchanged bool
}

// RelationCache remembers the RelationMessages seen in a stream so later
// Insert/Update/Delete messages (which reference a relation only by OID) can
// be resolved to named columns. A single stream sends a relation's shape
// before the first change to it, so feed every decoded message through
// Observe and then call NamedColumns for the change tuples.
type RelationCache struct {
	relations map[uint32]RelationMessage
}

// NewRelationCache returns an empty cache ready to Observe messages.
func NewRelationCache() *RelationCache {
	return &RelationCache{relations: map[uint32]RelationMessage{}}
}

// Observe records a RelationMessage; other message types are ignored. It is
// safe to pass every decoded message straight through.
func (c *RelationCache) Observe(m Message) {
	if rel, ok := m.(RelationMessage); ok {
		c.relations[rel.RelationID] = rel
	}
}

// Relation returns the cached relation for an OID.
func (c *RelationCache) Relation(oid uint32) (RelationMessage, bool) {
	rel, ok := c.relations[oid]
	return rel, ok
}

// NamedColumns aligns a change tuple with its relation's column definitions,
// returning name+value pairs a sink (e.g. the Iceberg writer) can consume. It
// errors if the relation OID hasn't been Observed yet or the tuple's column
// count doesn't match the relation — either indicates a stream decoded out of
// order, which must not silently produce field-shifted rows.
func (c *RelationCache) NamedColumns(relationID uint32, tuple TupleData) ([]NamedColumn, error) {
	rel, ok := c.relations[relationID]
	if !ok {
		return nil, fmt.Errorf("pgcdc: no relation cached for OID %d (missing Relation message?)", relationID)
	}
	if len(tuple.Columns) != len(rel.Columns) {
		return nil, fmt.Errorf("pgcdc: tuple has %d columns, relation %s has %d",
			len(tuple.Columns), rel.RelationName, len(rel.Columns))
	}
	out := make([]NamedColumn, len(rel.Columns))
	for i, def := range rel.Columns {
		col := tuple.Columns[i]
		nc := NamedColumn{Name: def.Name}
		switch col.Kind {
		case TupleNull:
			nc.Null = true
		case TupleUnchanged:
			nc.Unchanged = true
		default:
			v := string(col.Data)
			nc.Value = &v
		}
		out[i] = nc
	}
	return out, nil
}

// reader is a big-endian cursor over a message body that latches the first
// short-read into err, so callers can decode a whole message and check once.
type reader struct {
	buf []byte
	pos int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if r.pos+n > len(r.buf) {
		r.err = ErrShortBuffer
		return nil
	}
	b := r.buf[r.pos : r.pos+n]
	r.pos += n
	return b
}

func (r *reader) uint8() uint8 {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (r *reader) uint16() uint16 {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint16(b)
}

func (r *reader) uint32() uint32 {
	b := r.take(4)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint32(b)
}

func (r *reader) uint64() uint64 {
	b := r.take(8)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint64(b)
}

// bytes returns a copy of the next n bytes, so the decoded value doesn't
// alias the caller's input buffer.
func (r *reader) bytes(n int) []byte {
	b := r.take(n)
	if b == nil {
		return nil
	}
	out := make([]byte, n)
	copy(out, b)
	return out
}

// cstring reads a null-terminated string.
func (r *reader) cstring() string {
	if r.err != nil {
		return ""
	}
	for i := r.pos; i < len(r.buf); i++ {
		if r.buf[i] == 0 {
			s := string(r.buf[r.pos:i])
			r.pos = i + 1
			return s
		}
	}
	r.err = ErrShortBuffer
	return ""
}
