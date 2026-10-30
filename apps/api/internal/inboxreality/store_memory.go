// SPDX-License-Identifier: AGPL-3.0-only
//
// store_memory.go — in-memory Store impl for unit tests. Not used in
// production. Behaves like the Postgres impl for the contract bits
// (token-collision detection, RLS-equivalent tenant guards, status
// transitions) without the DB dependency.

package inboxreality

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"sync"
	"time"
)

// newMemoryID returns a 32-char hex id for the in-memory store. We
// don't depend on google/uuid here — apps/api convention is to avoid
// adding it (see apps/api/internal/forms/uploads.go for the same
// pattern). Production paths use Postgres gen_random_uuid().
func newMemoryID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// MemoryStore is goroutine-safe via a single mutex. The expected
// access pattern is one in-flight request at a time per test in tests,
// so contention is fine; if a hot-loop benchmark needs sharded access
// we can break this up later.
type MemoryStore struct {
	mu      sync.Mutex
	tests   map[string]Test     // id -> Test
	byToken map[string]string   // header_token -> test id
	results map[string][]Result // test id -> results (in insertion order)
	now     func() time.Time
}

// NewMemoryStore returns a fresh store. now is the clock seam — pass
// time.Now for production-equivalent behaviour or a fixed function
// from tests to pin timestamps.
func NewMemoryStore(now func() time.Time) *MemoryStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryStore{
		tests:   map[string]Test{},
		byToken: map[string]string{},
		results: map[string][]Result{},
		now:     now,
	}
}

func (s *MemoryStore) CreateTest(_ context.Context, p CreateTestParams) (Test, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byToken[p.HeaderToken]; exists {
		return Test{}, ErrTokenCollision
	}
	now := s.now().UTC()
	t := Test{
		ID:          newMemoryID(),
		TenantID:    p.TenantID,
		HeaderToken: p.HeaderToken,
		Kind:        p.Kind,
		Subject:     p.Subject,
		FromAddress: p.FromAddress,
		Status:      StatusAwaitingDelivery,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   p.ExpiresAt,
		Meta:        p.Meta,
	}
	s.tests[t.ID] = t
	s.byToken[t.HeaderToken] = t.ID
	return t, nil
}

func (s *MemoryStore) GetTest(_ context.Context, tenantID, testID string) (Test, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tests[testID]
	if !ok || t.TenantID != tenantID {
		return Test{}, ErrNotFound
	}
	return t, nil
}

func (s *MemoryStore) ListTests(_ context.Context, tenantID string, limit int) ([]Test, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	out := []Test{}
	for _, t := range s.tests {
		if t.TenantID == tenantID {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *MemoryStore) ListResults(_ context.Context, tenantID, testID string) ([]Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tests[testID]
	if !ok || t.TenantID != tenantID {
		return nil, ErrNotFound
	}
	rs := s.results[testID]
	// Copy so callers can't mutate our slice.
	out := make([]Result, len(rs))
	copy(out, rs)
	return out, nil
}

func (s *MemoryStore) RecordResult(_ context.Context, p RecordResultParams) (Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tests[p.TestID]; !ok {
		return Result{}, ErrNotFound
	}
	now := s.now().UTC()
	// Honour the (test_id, mailbox_id) UNIQUE — update in place.
	for i, existing := range s.results[p.TestID] {
		if existing.MailboxID == p.MailboxID {
			updated := Result{
				ID:            existing.ID,
				TestID:        p.TestID,
				MailboxID:     p.MailboxID,
				Provider:      p.Provider,
				ProviderLabel: p.Provider.DisplayName(),
				Placement:     p.Placement,
				FolderName:    p.FolderName,
				ClassifiedAt:  now,
				RawHeaders:    p.RawHeaders,
			}
			s.results[p.TestID][i] = updated
			return updated, nil
		}
	}
	r := Result{
		ID:            newMemoryID(),
		TestID:        p.TestID,
		MailboxID:     p.MailboxID,
		Provider:      p.Provider,
		ProviderLabel: p.Provider.DisplayName(),
		Placement:     p.Placement,
		FolderName:    p.FolderName,
		ClassifiedAt:  now,
		RawHeaders:    p.RawHeaders,
	}
	s.results[p.TestID] = append(s.results[p.TestID], r)
	return r, nil
}

func (s *MemoryStore) UpdateStatus(_ context.Context, tenantID, testID string, status TestStatus, completedAt *time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tests[testID]
	if !ok || t.TenantID != tenantID {
		return ErrNotFound
	}
	t.Status = status
	t.UpdatedAt = s.now().UTC()
	t.CompletedAt = completedAt
	s.tests[testID] = t
	return nil
}

func (s *MemoryStore) FindTestByToken(_ context.Context, token string) (Test, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byToken[token]
	if !ok {
		return Test{}, ErrNotFound
	}
	return s.tests[id], nil
}
