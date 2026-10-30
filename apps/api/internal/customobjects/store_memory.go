// SPDX-License-Identifier: AGPL-3.0-only
//
// store_memory.go — in-memory Store impl for unit tests. Honours the
// same (tenant, type, key) UNIQUE + (tenant, type, external_id) UNIQUE
// contracts as the Postgres impl so contract tests can target both
// without test-specific branches.

package customobjects

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// MemoryStore is goroutine-safe via a single mutex.
type MemoryStore struct {
	mu      sync.Mutex
	types   map[string]ObjectType        // id -> type
	records map[string]Record            // id -> record
	links   map[string]ProfileObjectLink // id -> profile link
	now     func() time.Time
}

// NewMemoryStore returns a fresh store. now is the clock seam.
func NewMemoryStore(now func() time.Time) *MemoryStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryStore{
		types:   map[string]ObjectType{},
		records: map[string]Record{},
		links:   map[string]ProfileObjectLink{},
		now:     now,
	}
}

func newID() string {
	return uuid.NewString()
}

func (s *MemoryStore) ListTypes(_ context.Context, tenantID string) ([]ObjectType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ObjectType{}
	for _, o := range s.types {
		if o.TenantID == tenantID {
			out = append(out, o)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) GetType(_ context.Context, tenantID, id string) (ObjectType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.types[id]
	if !ok || o.TenantID != tenantID {
		return ObjectType{}, ErrNotFound
	}
	return o, nil
}

func (s *MemoryStore) GetTypeByKey(_ context.Context, tenantID, key string) (ObjectType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, o := range s.types {
		if o.TenantID == tenantID && o.Key == key {
			return o, nil
		}
	}
	return ObjectType{}, ErrNotFound
}

func (s *MemoryStore) CreateType(_ context.Context, tenantID string, p CreateTypeParams) (ObjectType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateCreateTypeParams(&p); err != nil {
		return ObjectType{}, err
	}
	for _, o := range s.types {
		if o.TenantID == tenantID && o.Key == p.Key {
			return ObjectType{}, ErrConflict
		}
	}
	pk := p.PrimaryKey
	if pk == "" {
		pk = "external_id"
	}
	schema := p.Schema
	if len(schema) == 0 {
		schema = json.RawMessage("{}")
	}
	now := s.now().UTC()
	o := ObjectType{
		ID:         newID(),
		TenantID:   tenantID,
		Key:        p.Key,
		Label:      p.Label,
		PrimaryKey: pk,
		Schema:     schema,
		Status:     "active",
		Version:    1,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	s.types[o.ID] = o
	return o, nil
}

func (s *MemoryStore) UpdateType(_ context.Context, tenantID, id string, p UpdateTypeParams) (ObjectType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateUpdateTypeParams(p); err != nil {
		return ObjectType{}, err
	}
	o, ok := s.types[id]
	if !ok || o.TenantID != tenantID {
		return ObjectType{}, ErrNotFound
	}
	if o.Version != p.ExpectedVersion {
		return ObjectType{}, ErrStale
	}
	if err := validateUpdatedSchemaPrimaryKey(o.PrimaryKey, p.Schema); err != nil {
		return ObjectType{}, err
	}
	o.Label = p.Label
	o.Schema = p.Schema
	o.Status = p.Status
	o.Version++
	o.UpdatedAt = s.now().UTC()
	s.types[id] = o
	return o, nil
}

func (s *MemoryStore) DeleteType(_ context.Context, tenantID, id string, p DeleteTypeParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateDeleteTypeParams(p); err != nil {
		return err
	}
	o, ok := s.types[id]
	if !ok || o.TenantID != tenantID {
		return ErrNotFound
	}
	if o.Version != p.ExpectedVersion {
		return ErrStale
	}
	if o.Key != p.ConfirmationKey {
		return ErrConfirmationMismatch
	}
	delete(s.types, id)
	// Cascade — mirror the ON DELETE CASCADE in the migration.
	for rid, r := range s.records {
		if r.ObjectTypeID == id {
			delete(s.records, rid)
		}
	}
	for linkID, link := range s.links {
		if link.ObjectTypeID == id {
			delete(s.links, linkID)
		}
	}
	return nil
}

func (s *MemoryStore) ListRecords(_ context.Context, tenantID, typeID string, f ListRecordsFilter) (RecordPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	validated, err := validateListRecordsFilter(f)
	if err != nil {
		return RecordPage{}, err
	}
	typeRow, ok := s.types[typeID]
	if !ok || typeRow.TenantID != tenantID {
		return RecordPage{}, ErrNotFound
	}
	limit := validated.Limit
	out := []Record{}
	for _, r := range s.records {
		if r.TenantID != tenantID || r.ObjectTypeID != typeID {
			continue
		}
		if validated.PropertyKey != "" {
			if !propertyEquals(r.Properties, validated.PropertyKey, validated.PropertyValue) {
				continue
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return RecordPage{Items: out, Limit: limit, HasMore: hasMore}, nil
}

func (s *MemoryStore) GetRecord(_ context.Context, tenantID, recordID string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[recordID]
	if !ok || r.TenantID != tenantID {
		return Record{}, ErrNotFound
	}
	return r, nil
}

func (s *MemoryStore) UpsertRecord(_ context.Context, tenantID, typeID string, p UpsertRecordParams) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateUpsertRecordParams(p); err != nil {
		return Record{}, err
	}
	typeRow, ok := s.types[typeID]
	if !ok || typeRow.TenantID != tenantID {
		return Record{}, ErrNotFound
	}
	if typeRow.Status == "disabled" {
		return Record{}, ErrTypeDisabled
	}
	if validation := Validate(typeRow.Schema, p.Properties); validation.HasErrors() {
		return Record{}, validation
	}
	// Upsert keyed by (tenant, type, external_id).
	for id, r := range s.records {
		if r.TenantID == tenantID && r.ObjectTypeID == typeID && r.ExternalID == p.ExternalID {
			if p.ExpectedVersion == 0 || r.Version != p.ExpectedVersion {
				return Record{}, ErrStale
			}
			r.Properties = p.Properties
			r.Version++
			r.UpdatedAt = s.now().UTC()
			s.records[id] = r
			return r, nil
		}
	}
	if p.ExpectedVersion > 0 {
		return Record{}, ErrNotFound
	}
	now := s.now().UTC()
	props := p.Properties
	if len(props) == 0 {
		props = json.RawMessage("{}")
	}
	r := Record{
		ID:           newID(),
		TenantID:     tenantID,
		ObjectTypeID: typeID,
		ExternalID:   p.ExternalID,
		Properties:   props,
		Version:      1,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	s.records[r.ID] = r
	return r, nil
}

func (s *MemoryStore) DeleteRecord(_ context.Context, tenantID, recordID string, p DeleteRecordParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateDeleteRecordParams(p); err != nil {
		return err
	}
	r, ok := s.records[recordID]
	if !ok || r.TenantID != tenantID {
		return ErrNotFound
	}
	if r.Version != p.ExpectedVersion {
		return ErrStale
	}
	if r.ExternalID != p.ConfirmationExternalID {
		return ErrConfirmationMismatch
	}
	delete(s.records, recordID)
	for linkID, link := range s.links {
		if link.ObjectRecordID == recordID {
			delete(s.links, linkID)
		}
	}
	return nil
}

// --- Profile object links (SUB-011) ---

func (s *MemoryStore) ListProfileLinks(_ context.Context, tenantID, subscriberID string) ([]ProfileObjectLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ProfileObjectLink{}
	for _, l := range s.links {
		if l.TenantID != tenantID || l.SubscriberID != subscriberID {
			continue
		}
		// Hydrate the denormalized join fields the Postgres path returns
		// so contract tests see the same shape.
		if t, ok := s.types[l.ObjectTypeID]; ok {
			l.ObjectTypeKey = t.Key
			l.ObjectTypeLabel = t.Label
		}
		if r, ok := s.records[l.ObjectRecordID]; ok {
			l.ExternalID = r.ExternalID
			l.Properties = r.Properties
		}
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) CreateProfileLink(_ context.Context, tenantID, subscriberID string, p CreateProfileLinkParams) (ProfileObjectLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.records[p.ObjectRecordID]
	if !ok || rec.TenantID != tenantID {
		return ProfileObjectLink{}, ErrNotFound
	}
	rel := p.Relationship
	if rel == "" {
		rel = "related"
	}
	// Enforce the (tenant, record, subscriber, email, relationship) UNIQUE
	// the migration declares.
	for _, l := range s.links {
		if l.TenantID == tenantID && l.ObjectRecordID == p.ObjectRecordID &&
			l.SubscriberID == subscriberID && l.Relationship == rel {
			return ProfileObjectLink{}, ErrConflict
		}
	}
	meta := p.Metadata
	if len(meta) == 0 {
		meta = json.RawMessage("{}")
	}
	l := ProfileObjectLink{
		ID:             newID(),
		TenantID:       tenantID,
		ObjectTypeID:   rec.ObjectTypeID,
		ObjectRecordID: p.ObjectRecordID,
		SubscriberID:   subscriberID,
		Relationship:   rel,
		Metadata:       meta,
		CreatedAt:      s.now().UTC(),
	}
	s.links[l.ID] = l
	return l, nil
}

func (s *MemoryStore) UpdateProfileLink(_ context.Context, tenantID, linkID string, p UpdateProfileLinkParams) (ProfileObjectLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.links[linkID]
	if !ok || l.TenantID != tenantID {
		return ProfileObjectLink{}, ErrNotFound
	}
	if p.Relationship != nil {
		l.Relationship = *p.Relationship
	}
	if len(p.Metadata) > 0 {
		l.Metadata = p.Metadata
	}
	s.links[linkID] = l
	return l, nil
}

func (s *MemoryStore) DeleteProfileLink(_ context.Context, tenantID, linkID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.links[linkID]
	if !ok || l.TenantID != tenantID {
		return ErrNotFound
	}
	delete(s.links, linkID)
	return nil
}

// propertyEquals reports whether properties[key] equals value as a
// string. Used by the in-memory filter path; the Postgres path uses
// jsonb -> operator equivalents.
func propertyEquals(properties json.RawMessage, key, value string) bool {
	if len(properties) == 0 {
		return false
	}
	var doc map[string]any
	if err := json.Unmarshal(properties, &doc); err != nil {
		return false
	}
	got, ok := doc[key]
	if !ok {
		return false
	}
	return strings.EqualFold(toString(got), value)
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		// Render integers without a trailing .0 — matches how
		// jsonb_extract_path_text would serialise them.
		if x == float64(int64(x)) {
			return formatInt(int64(x))
		}
		return formatFloat(x)
	}
	return ""
}

func formatInt(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func formatFloat(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}
