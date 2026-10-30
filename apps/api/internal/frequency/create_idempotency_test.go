// SPDX-License-Identifier: AGPL-3.0-only

package frequency

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
)

const createFrequencyReplayBody = `{"label":"Daily cap","max_sends":3,"window_hours":24}`

type createReplayStore struct {
	mu sync.Mutex

	records map[string]*idempotency.Record

	deleteCalls    int
	deleteStarted  chan struct{}
	releaseDelete  chan struct{}
	deleteStartOne sync.Once
}

func newCreateReplayStore() *createReplayStore {
	return &createReplayStore{records: make(map[string]*idempotency.Record)}
}

func createReplayRecordKey(tenantID, key string) string { return tenantID + "|" + key }

func cloneCreateReplayRecord(rec *idempotency.Record) *idempotency.Record {
	if rec == nil {
		return nil
	}
	clone := *rec
	clone.ResponseBody = append([]byte(nil), rec.ResponseBody...)
	clone.ResponseHeaders = rec.ResponseHeaders.Clone()
	return &clone
}

func (s *createReplayStore) Get(_ context.Context, tenantID, key string) (*idempotency.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.records[createReplayRecordKey(tenantID, key)]
	if rec == nil {
		return nil, idempotency.ErrNotFound
	}
	return cloneCreateReplayRecord(rec), nil
}

func (s *createReplayStore) Claim(_ context.Context, rec *idempotency.Record) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := createReplayRecordKey(rec.TenantID, rec.Key)
	if s.records[key] != nil {
		return false, nil
	}
	s.records[key] = cloneCreateReplayRecord(rec)
	return true, nil
}

func (s *createReplayStore) Complete(_ context.Context, rec *idempotency.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	stored := s.records[createReplayRecordKey(rec.TenantID, rec.Key)]
	if stored == nil {
		return idempotency.ErrNotFound
	}
	stored.ResponseStatus = rec.ResponseStatus
	stored.ResponseBody = append([]byte(nil), rec.ResponseBody...)
	stored.ResponseHeaders = rec.ResponseHeaders.Clone()
	return nil
}

func (s *createReplayStore) DeletePending(_ context.Context, tenantID, key string) error {
	s.mu.Lock()
	s.deleteCalls++
	started := s.deleteStarted
	release := s.releaseDelete
	s.mu.Unlock()
	if started != nil {
		s.deleteStartOne.Do(func() { close(started) })
		<-release
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	recordKey := createReplayRecordKey(tenantID, key)
	if rec := s.records[recordKey]; rec != nil && rec.ResponseStatus == 0 {
		delete(s.records, recordKey)
	}
	return nil
}

func (s *createReplayStore) applyPendingCompletion(args []any) error {
	if len(args) != 6 {
		return errors.New("frequency replay: unexpected idempotency completion args")
	}
	tenantID, tenantOK := args[0].(string)
	key, keyOK := args[1].(string)
	requestHash, hashOK := args[2].(string)
	status, statusOK := args[3].(int)
	body, bodyOK := args[4].([]byte)
	headersJSON, headersOK := args[5].([]byte)
	if !tenantOK || !keyOK || !hashOK || !statusOK || !bodyOK || !headersOK {
		return errors.New("frequency replay: malformed idempotency completion args")
	}
	var headers http.Header
	if len(headersJSON) > 0 {
		if err := json.Unmarshal(headersJSON, &headers); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.records[createReplayRecordKey(tenantID, key)]
	if rec == nil || rec.RequestHash != requestHash || rec.ResponseStatus != 0 {
		return idempotency.ErrNotFound
	}
	rec.ResponseStatus = status
	rec.ResponseBody = append([]byte(nil), body...)
	rec.ResponseHeaders = headers.Clone()
	return nil
}

func (s *createReplayStore) snapshot() []*idempotency.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*idempotency.Record, 0, len(s.records))
	for _, rec := range s.records {
		out = append(out, cloneCreateReplayRecord(rec))
	}
	return out
}

type createReplayTx struct {
	pgx.Tx

	store *createReplayStore
	rule  Rule

	queryErr       error
	commitErr      error
	applyOnCommit  bool
	onRuleApplied  func()
	completionSQL  string
	completionArgs []any
	applyErr       error
	applyOnce      sync.Once
	queryCalls     int
	commits        int
	rollbacks      int
}

func (tx *createReplayTx) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	tx.queryCalls++
	if tx.queryErr != nil {
		return &fakeRuleRow{err: tx.queryErr}
	}
	return &fakeRuleRow{rule: tx.rule}
}

func (tx *createReplayTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.completionSQL = query
	tx.completionArgs = append([]any(nil), args...)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (tx *createReplayTx) apply() {
	tx.applyOnce.Do(func() {
		if tx.store == nil || len(tx.completionArgs) == 0 {
			tx.applyErr = errors.New("frequency replay: committed without an atomic replay receipt")
			return
		}
		if err := tx.store.applyPendingCompletion(tx.completionArgs); err != nil {
			tx.applyErr = err
			return
		}
		if tx.onRuleApplied != nil {
			tx.onRuleApplied()
		}
	})
}

func (tx *createReplayTx) Commit(context.Context) error {
	tx.commits++
	if tx.applyOnCommit {
		tx.apply()
	}
	if tx.applyErr != nil {
		return tx.applyErr
	}
	return tx.commitErr
}

func (tx *createReplayTx) Rollback(context.Context) error {
	tx.rollbacks++
	return nil
}

func createReplayDeps(txs ...*createReplayTx) (*Deps, *int) {
	beginCalls := 0
	discardLogger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Deps{
		Logger: discardLogger,
		beginTenant: func(_ context.Context, tenantID string) (pgx.Tx, error) {
			if tenantID != frequencyTestTenantID {
				return nil, errors.New("frequency replay: wrong tenant")
			}
			if beginCalls >= len(txs) {
				return nil, errors.New("frequency replay: unexpected transaction")
			}
			tx := txs[beginCalls]
			beginCalls++
			return tx, nil
		},
		auditMutation: func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error {
			return nil
		},
	}, &beginCalls
}

func createReplayRequest(key string) *http.Request {
	request := frequencyRequest(
		http.MethodPost,
		"/api/v1/sending/frequency-caps",
		createFrequencyReplayBody,
		"admin",
	)
	request.Header.Set(idempotency.HeaderName, key)
	return request
}

func serveCreateReplay(t *testing.T, store *createReplayStore, deps *Deps, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	chiRouter := newFrequencyReplayRouter(deps)
	handler := idempotency.Process(store, func(*http.Request) (string, bool) {
		return frequencyTestTenantID, true
	})(chiRouter)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func newFrequencyReplayRouter(deps *Deps) http.Handler {
	router := chi.NewRouter()
	MountRoutes(router, deps)
	return router
}

func waitCreateReplaySignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func TestFrequencyCapCreateDelayedCommitResolutionReplaysOneAppliedRule(t *testing.T) {
	store := newCreateReplayStore()
	store.deleteStarted = make(chan struct{})
	store.releaseDelete = make(chan struct{})
	durableRules := 0
	revision := time.Date(2026, 8, 30, 10, 15, 16, 123000000, time.UTC)
	tx := &createReplayTx{
		store:     store,
		rule:      frequencyRuleAt(revision),
		commitErr: errors.New("commit acknowledgement lost"),
		onRuleApplied: func() {
			durableRules++
		},
	}
	deps, beginCalls := createReplayDeps(tx)

	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstDone <- serveCreateReplay(t, store, deps, createReplayRequest("frequency-create-ambiguous"))
	}()
	waitCreateReplaySignal(t, store.deleteStarted, "pending-claim cleanup")

	// Model PostgreSQL resolving the in-flight COMMIT after the client-side
	// acknowledgement failed. DeletePending is blocked by the row lock until
	// this atomic rule+receipt state becomes visible, then its pending predicate
	// must leave the completed claim intact.
	tx.apply()
	close(store.releaseDelete)

	var first *httptest.ResponseRecorder
	select {
	case first = <-firstDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ambiguous create response")
	}
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("ambiguous response=%d %s", first.Code, first.Body.String())
	}
	if tx.applyErr != nil || durableRules != 1 {
		t.Fatalf("resolved commit apply_err=%v durable_rules=%d", tx.applyErr, durableRules)
	}
	records := store.snapshot()
	if len(records) != 1 || records[0].ResponseStatus != http.StatusCreated {
		t.Fatalf("resolved replay records=%#v", records)
	}
	if !strings.Contains(tx.completionSQL, "request_hash = $3") ||
		!strings.Contains(tx.completionSQL, "response_status IS NULL") ||
		!strings.Contains(tx.completionSQL, "expires_at > now()") {
		t.Fatalf("atomic completion is not exact/pending/expiry guarded: %s", tx.completionSQL)
	}

	replay := serveCreateReplay(t, store, deps, createReplayRequest("frequency-create-ambiguous"))
	if replay.Code != http.StatusCreated || replay.Header().Get(idempotency.ReplayedHeaderName) != "true" {
		t.Fatalf("replay response=%d replay=%q body=%s", replay.Code, replay.Header().Get(idempotency.ReplayedHeaderName), replay.Body.String())
	}
	if !bytes.Equal(replay.Body.Bytes(), records[0].ResponseBody) {
		t.Fatalf("replay body=%q, want exact stored bytes %q", replay.Body.Bytes(), records[0].ResponseBody)
	}
	if *beginCalls != 1 || tx.queryCalls != 1 || durableRules != 1 || len(store.snapshot()) != 1 || store.deleteCalls != 1 {
		t.Fatalf("replay re-executed create: begins=%d queries=%d durable_rules=%d records=%d deletes=%d",
			*beginCalls, tx.queryCalls, durableRules, len(store.snapshot()), store.deleteCalls)
	}
	if records[0].ResponseHeaders.Get("Cache-Control") != "private, no-store" ||
		records[0].ResponseHeaders.Get("Content-Type") != "application/json" {
		t.Fatalf("stored response headers=%v", records[0].ResponseHeaders)
	}
}

func TestFrequencyCapCreatePrecommitFailureReleasesClaimForExactRetry(t *testing.T) {
	store := newCreateReplayStore()
	durableRules := 0
	revision := time.Date(2026, 8, 30, 10, 15, 16, 123000000, time.UTC)
	failedTx := &createReplayTx{
		store:    store,
		queryErr: errors.New("insert failed before commit"),
	}
	successTx := &createReplayTx{
		store:         store,
		rule:          frequencyRuleAt(revision),
		applyOnCommit: true,
		onRuleApplied: func() {
			durableRules++
		},
	}
	deps, beginCalls := createReplayDeps(failedTx, successTx)

	first := serveCreateReplay(t, store, deps, createReplayRequest("frequency-create-precommit"))
	if first.Code != http.StatusInternalServerError || len(store.snapshot()) != 0 {
		t.Fatalf("precommit response=%d body=%s records=%d", first.Code, first.Body.String(), len(store.snapshot()))
	}
	if failedTx.commits != 0 || failedTx.rollbacks != 1 || store.deleteCalls != 1 || durableRules != 0 {
		t.Fatalf("precommit state commits=%d rollbacks=%d deletes=%d durable_rules=%d",
			failedTx.commits, failedTx.rollbacks, store.deleteCalls, durableRules)
	}

	retry := serveCreateReplay(t, store, deps, createReplayRequest("frequency-create-precommit"))
	if retry.Code != http.StatusCreated || retry.Header().Get(idempotency.ReplayedHeaderName) != "" {
		t.Fatalf("safe retry response=%d replay=%q body=%s", retry.Code, retry.Header().Get(idempotency.ReplayedHeaderName), retry.Body.String())
	}
	if successTx.applyErr != nil || durableRules != 1 || len(store.snapshot()) != 1 || *beginCalls != 2 {
		t.Fatalf("safe retry apply_err=%v durable_rules=%d records=%d begins=%d",
			successTx.applyErr, durableRules, len(store.snapshot()), *beginCalls)
	}

	replay := serveCreateReplay(t, store, deps, createReplayRequest("frequency-create-precommit"))
	if replay.Code != http.StatusCreated || replay.Header().Get(idempotency.ReplayedHeaderName) != "true" {
		t.Fatalf("settled replay response=%d replay=%q body=%s", replay.Code, replay.Header().Get(idempotency.ReplayedHeaderName), replay.Body.String())
	}
	if *beginCalls != 2 || durableRules != 1 {
		t.Fatalf("settled replay re-executed create: begins=%d durable_rules=%d", *beginCalls, durableRules)
	}
}
