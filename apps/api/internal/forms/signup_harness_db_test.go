// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

// signupHarness drives the real public handlers and the real SignupAudience
// against a migrated database as the RLS-bound application role, with the
// real Listmonk client talking to a Listmonk v6.1.0 stand-in that answers
// with recorded bodies. The audience writer and the mailer are recording
// fakes: what reaches the subscriber store is proven end to end by the
// composition-root test in package main.
type signupHarness struct {
	t        *testing.T
	pool     *db.Pool
	tenantID string
	formID   string
	slug     string
	engine   *listmonkv6.Server
	outbox   *captureOutbox
	mailer   *recordingMailer
	guard    *staticRecipientGuard
	senders  *staticSenderVerifier
	audience *recordingAudience
	logs     *syncBuffer
	deps     *Deps
	handler  *SignupAudience
	router   chi.Router
	drained  int
}

type harnessForm struct {
	optIn     OptInMode
	settings  map[string]any
	structure map[string]any
	status    Status
}

func newSignupHarness(t *testing.T, form harnessForm) *signupHarness {
	t.Helper()
	pool := newFormsExpiryPool(t)
	h := &signupHarness{
		t:        t,
		pool:     pool,
		engine:   listmonkv6.NewServer(t),
		outbox:   &captureOutbox{},
		mailer:   &recordingMailer{},
		guard:    &staticRecipientGuard{},
		senders:  &staticSenderVerifier{},
		audience: &recordingAudience{},
		logs:     &syncBuffer{},
	}
	h.tenantID, h.formID = uuid.NewString(), uuid.NewString()
	h.slug = "signup-" + h.formID[:8]
	h.seedTenant()
	h.seedForm(form)

	logger := slog.New(slog.NewTextHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	repo := &Repo{Pool: pool}
	h.deps = &Deps{
		Repo:               repo,
		PublicHostBase:     "https://forms.example.test",
		ConfirmationMailer: h.mailer,
		ConfirmationFrom:   "Signups <signups@example.test>",
		SenderVerifier:     h.senders,
		RecipientGuard:     h.guard,
		Outbox:             h.outbox,
		Logger:             logger,
	}
	h.handler = &SignupAudience{
		Repo:     repo,
		Audience: h.audience,
		Outbox:   h.outbox,
		Engines:  soleTenantEngine{engine: listmonk.New(listmonk.Config{BaseURL: h.engine.URL})},
		Logger:   logger,
	}
	router := chi.NewRouter()
	router.Post("/api/public/forms/{slug}/submit", h.deps.PublicSubmit)
	router.Get("/api/public/forms/confirm/{token}", h.deps.PublicConfirm)
	router.Group(func(admin chi.Router) {
		admin.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: h.tenantID})))
			})
		})
		admin.Patch("/api/v1/forms/{id}", h.deps.Update)
		admin.Get("/api/v1/forms/{id}/submissions", h.deps.ListSubmissions)
		admin.Post("/api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation", h.deps.ResendConfirmation)
	})
	h.router = router
	return h
}

// soleTenantEngine is an EngineResolver for a deployment whose Listmonk
// belongs to the harness tenant alone. The composition-root tests prove the
// production resolver refuses a shared one.
type soleTenantEngine struct{ engine ListmonkEngine }

func (r soleTenantEngine) AcquireEngine(context.Context, string) (ListmonkEngine, func(), error) {
	return r.engine, func() {}, nil
}

func (h *signupHarness) seedTenant() {
	h.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, h.pool, h.tenantID)
	if err != nil {
		h.t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'form signups', 'studio')`,
		h.tenantID, "form-signups-"+h.tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		h.t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		h.t.Fatalf("commit tenant: %v", err)
	}
	h.t.Cleanup(func() { deleteFormsTestTenant(h.t, h.pool, h.tenantID) })
}

func (h *signupHarness) seedForm(form harnessForm) {
	h.t.Helper()
	if form.optIn == "" {
		form.optIn = OptInSingle
	}
	if form.structure == nil {
		form.structure = defaultStructure()
	}
	if form.status == "" {
		form.status = StatusPublished
	}
	if form.settings == nil {
		form.settings = map[string]any{}
	}
	structure, _ := json.Marshal(form.structure)
	settings, _ := json.Marshal(form.settings)
	h.exec(`INSERT INTO forms (id, tenant_id, name, slug, status, opt_in_mode, structure, settings)
		VALUES ($1::uuid, $2::uuid, 'Weekly letter', $3, $4, $5, $6::jsonb, $7::jsonb)`,
		h.formID, h.tenantID, h.slug, string(form.status), string(form.optIn), string(structure), string(settings))
}

// mapList registers a Listmonk list as one of the tenant's lists and returns
// its Moosewave list UUID.
func (h *signupHarness) mapList(engineID int64) string {
	h.t.Helper()
	return mapListForTenant(h.t, h.pool, h.tenantID, engineID)
}

func mapListForTenant(t *testing.T, pool *db.Pool, tenantID string, engineID int64) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var listID string
	if err := tx.QueryRow(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES (gen_random_uuid(), $1, $2::uuid)
RETURNING postwave_uuid::text`, engineID, tenantID).Scan(&listID); err != nil {
		t.Fatalf("map list %d: %v", engineID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list map: %v", err)
	}
	return listID
}

func (h *signupHarness) exec(sql string, args ...any) {
	h.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, h.pool, h.tenantID)
	if err != nil {
		h.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		h.t.Fatalf("exec %q: %v", sql, err)
	}
	if tag.RowsAffected() == 0 {
		h.t.Fatalf("exec %q touched no rows; the seed would be vacuous", sql)
	}
	if err := tx.Commit(ctx); err != nil {
		h.t.Fatalf("commit: %v", err)
	}
}

func (h *signupHarness) count(sql string, args ...any) int {
	h.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, h.pool, h.tenantID)
	if err != nil {
		h.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		h.t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// submission reads the one submission for email.
func (h *signupHarness) submission(email string) storedSubmission {
	h.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, h.pool, h.tenantID)
	if err != nil {
		h.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s storedSubmission
	if err := tx.QueryRow(ctx, `
SELECT id::text, status, COALESCE(confirmation_token, ''), COALESCE(name, ''),
       COALESCE(signup_source, ''), target_list_ids::text[], COALESCE(confirmation_email_state, '')
  FROM form_submissions
 WHERE form_id = $1::uuid AND email = $2`, h.formID, email).Scan(
		&s.ID, &s.Status, &s.Token, &s.Name, &s.SignupSource, &s.TargetListIDs, &s.EmailState); err != nil {
		h.t.Fatalf("read submission for %s: %v", email, err)
	}
	return s
}

// eachRow runs a one-column text query under the harness tenant.
func (h *signupHarness) eachRow(sql string, arg any, fn func(string)) {
	h.t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, h.pool, h.tenantID)
	if err != nil {
		h.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, sql, arg)
	if err != nil {
		h.t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			h.t.Fatalf("scan: %v", err)
		}
		fn(value)
	}
	if err := rows.Err(); err != nil {
		h.t.Fatalf("rows: %v", err)
	}
}

type storedSubmission struct {
	ID            string
	Status        string
	Token         string
	Name          string
	SignupSource  string
	TargetListIDs []string
	EmailState    string
}

// post sends a public submission the way the hosted page's fetch does.
func (h *signupHarness) post(body string, header ...string) *httptest.ResponseRecorder {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/public/forms/"+h.slug+"/submit", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.10:41000"
	req.Header.Set("User-Agent", "signup-harness")
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

func (h *signupHarness) serve(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// drain runs every audience intent appended since the last drain through the
// real handler, exactly as the outbox worker would, and fails on an error.
func (h *signupHarness) drain() {
	h.t.Helper()
	if err := h.tryDrain(); err != nil {
		h.t.Fatalf("signup handler: %v", err)
	}
}

// tryDrain delivers events in order, including those a handler appends,
// until none are left; it stops at the first handler error, which the outbox
// would retry.
func (h *signupHarness) tryDrain() error {
	for {
		h.outbox.mu.Lock()
		if h.drained >= len(h.outbox.appends) {
			h.outbox.mu.Unlock()
			return nil
		}
		event := h.outbox.appends[h.drained]
		h.outbox.mu.Unlock()
		raw, err := json.Marshal(event.Payload)
		if err != nil {
			return err
		}
		switch event.Kind {
		case OutboxKindRecordSignup:
			err = h.handler.RecordSubmitted(context.Background(), event.TenantID, raw)
		case OutboxKindEnableListmonk:
			err = h.handler.RecordConfirmed(context.Background(), event.TenantID, raw)
		case OutboxKindSendConfirmation:
			err = h.deps.DeliverConfirmation(context.Background(), event.TenantID, raw, DeliveryAttempt{Number: 1, Max: 10})
		}
		if err != nil {
			return err
		}
		h.drained++
	}
}

func (h *signupHarness) appendsOf(kind string) []OutboxAppendInput {
	h.outbox.mu.Lock()
	defer h.outbox.mu.Unlock()
	var out []OutboxAppendInput
	for _, event := range h.outbox.appends {
		if event.Kind == kind {
			out = append(out, event)
		}
	}
	return out
}

// recordingAudience records every audience write. subscribed decides the
// result; by default a step that grants consent leaves the subscriber enabled.
type recordingAudience struct {
	mu         sync.Mutex
	signups    []AudienceSignup
	subscribed func(AudienceSignup) bool
	// optedOut names addresses that had unsubscribed: an unverified grant
	// leaves them unsubscribed and needing mailbox proof.
	optedOut map[string]bool
	err      error
}

func (a *recordingAudience) RecordSignup(_ context.Context, signup AudienceSignup) (AudienceResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.signups = append(a.signups, signup)
	if a.err != nil {
		return AudienceResult{}, a.err
	}
	if a.optedOut[signup.Email] && (signup.Consent == nil || !signup.Consent.MailboxVerified) {
		return AudienceResult{NeedsMailboxProof: signup.Consent != nil}, nil
	}
	if a.subscribed != nil {
		return AudienceResult{Subscribed: a.subscribed(signup)}, nil
	}
	return AudienceResult{Subscribed: signup.Consent != nil}, nil
}

// staticRecipientGuard refuses the addresses in blocked.
type staticRecipientGuard struct {
	mu      sync.Mutex
	blocked map[string]bool
}

func (g *staticRecipientGuard) MayMailConfirmation(_ context.Context, _, email string) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.blocked[email], nil
}

// staticSenderVerifier reports the domains in verified as verified.
type staticSenderVerifier struct {
	mu       sync.Mutex
	verified map[string]bool
	asked    []string
}

func (v *staticSenderVerifier) IsFromDomainVerified(_ context.Context, _, domain string) (bool, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.asked = append(v.asked, domain)
	return v.verified[domain], nil
}

func (a *recordingAudience) recorded() []AudienceSignup {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]AudienceSignup(nil), a.signups...)
}

type recordingMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	err  error
}

func (m *recordingMailer) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := msg.Validate(); err != nil {
		return err
	}
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) messages() []mailer.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mailer.Message(nil), m.sent...)
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
