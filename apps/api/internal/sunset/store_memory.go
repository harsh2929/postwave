// SPDX-License-Identifier: AGPL-3.0-only
//
// store_memory.go — in-memory PolicyStore + SubscriberStore for tests
// and local-dev demos. The Postgres impls live in store_pg.go (added
// in a follow-up commit — the schema + RLS contract are pinned by the
// migration and the interfaces).

package sunset

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"time"
)

// ErrNotFound is returned by stores when a lookup misses.
var ErrNotFound = errors.New("sunset: not found")

func newMemoryID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// MemoryPolicyStore implements PolicyStore in process. Goroutine-safe
// via a single mutex.
type MemoryPolicyStore struct {
	mu         sync.Mutex
	policies   map[string]Policy
	executions map[string][]Execution // keyed by policy ID
	now        func() time.Time
}

// NewMemoryPolicyStore returns a fresh store. now is the clock seam.
func NewMemoryPolicyStore(now func() time.Time) *MemoryPolicyStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryPolicyStore{
		policies:   map[string]Policy{},
		executions: map[string][]Execution{},
		now:        now,
	}
}

func (s *MemoryPolicyStore) GetPolicy(_ context.Context, tenantID, policyID string) (Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.policies[policyID]
	if !ok || p.TenantID != tenantID {
		return Policy{}, ErrNotFound
	}
	return p, nil
}

func (s *MemoryPolicyStore) ListPolicies(_ context.Context, tenantID string, enabledOnly bool) ([]Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Policy{}
	for _, p := range s.policies {
		if p.TenantID != tenantID {
			continue
		}
		if enabledOnly && !p.Enabled {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryPolicyStore) CreatePolicy(_ context.Context, tenantID string, p Policy) (Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	p.ID = newMemoryID()
	p.TenantID = tenantID
	p.CreatedAt = now
	p.UpdatedAt = now
	s.policies[p.ID] = p
	return p, nil
}

func (s *MemoryPolicyStore) UpdatePolicy(_ context.Context, tenantID string, in Policy) (Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.policies[in.ID]
	if !ok || cur.TenantID != tenantID {
		return Policy{}, ErrNotFound
	}
	in.TenantID = tenantID
	in.CreatedAt = cur.CreatedAt
	in.UpdatedAt = s.now().UTC()
	s.policies[in.ID] = in
	return in, nil
}

func (s *MemoryPolicyStore) DeletePolicy(_ context.Context, tenantID, policyID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.policies[policyID]
	if !ok || p.TenantID != tenantID {
		return ErrNotFound
	}
	delete(s.policies, policyID)
	delete(s.executions, policyID)
	return nil
}

func (s *MemoryPolicyStore) RecordExecution(_ context.Context, e Execution) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Honour the (policy_id, subscriber_id) UNIQUE — skip if exists.
	for _, existing := range s.executions[e.PolicyID] {
		if existing.SubscriberID == e.SubscriberID {
			return nil
		}
	}
	e.ID = newMemoryID()
	if e.ExecutedAt.IsZero() {
		e.ExecutedAt = s.now().UTC()
	}
	s.executions[e.PolicyID] = append(s.executions[e.PolicyID], e)
	return nil
}

func (s *MemoryPolicyStore) ListExecutions(_ context.Context, tenantID, policyID string, limit int) ([]Execution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rs := s.executions[policyID]
	out := make([]Execution, 0, len(rs))
	for _, r := range rs {
		if r.TenantID != tenantID {
			continue
		}
		out = append(out, r)
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// MemorySubscriberStore is the test fake for the engine. Tests
// populate Candidates directly; AddSuppression/AddTag/EnqueueWinback
// record into in-memory slices the test can assert against.
type MemorySubscriberStore struct {
	mu                 sync.Mutex
	CandidatesByPolicy map[string][]Candidate
	Suppressions       []string            // emails
	Tags               map[string][]string // subscriberID -> tags
	WinbackEnqueued    []string            // subscriberIDs
}

// NewMemorySubscriberStore returns a fresh fake.
func NewMemorySubscriberStore() *MemorySubscriberStore {
	return &MemorySubscriberStore{
		CandidatesByPolicy: map[string][]Candidate{},
		Tags:               map[string][]string{},
	}
}

func (s *MemorySubscriberStore) Candidates(_ context.Context, _ string, policy Policy, _ int) ([]Candidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cs := s.CandidatesByPolicy[policy.ID]
	out := make([]Candidate, len(cs))
	copy(out, cs)
	return out, nil
}

func (s *MemorySubscriberStore) AddSuppression(_ context.Context, _, email, _ string, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Suppressions = append(s.Suppressions, email)
	return nil
}

func (s *MemorySubscriberStore) AddTag(_ context.Context, _, subscriberID, tag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Tags[subscriberID] = append(s.Tags[subscriberID], tag)
	return nil
}

func (s *MemorySubscriberStore) EnqueueWinback(_ context.Context, _, _, subscriberID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.WinbackEnqueued = append(s.WinbackEnqueued, subscriberID)
	return nil
}
