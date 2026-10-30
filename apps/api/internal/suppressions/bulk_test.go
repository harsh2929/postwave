package suppressions

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestReversibilityFor pins the policy table that the DELETE +
// bulk-delete handlers depend on. Hard bounces + spam complaints need
// admin force; dsar_deletion and unknown future reasons fail closed as
// permanent; explicitly reviewed ordinary reasons are reversible.
func TestReversibilityFor(t *testing.T) {
	cases := []struct {
		reason Reason
		want   Reversibility
	}{
		{ReasonHardBounce, ReversibilityNeedsAdmin},
		{ReasonSpamComplaint, ReversibilityNeedsAdmin},
		{ReasonComplaint, ReversibilityNeedsAdmin},
		{ReasonDSARDeletion, ReversibilityPermanent},
		{ReasonManualUnsubscribe, ReversibilityReversible},
		{ReasonListManual, ReversibilityReversible},
		{ReasonGlobalUnsubscribe, ReversibilityReversible},
		{ReasonSoftBounceThreshold, ReversibilityReversible},
		{Reason("unknown"), ReversibilityPermanent},
	}
	for _, tc := range cases {
		got := ReversibilityFor(tc.reason)
		if got != tc.want {
			t.Errorf("ReversibilityFor(%q) = %v, want %v", tc.reason, got, tc.want)
		}
	}
}

// TestBulkDelete_RequiresTenant guards the unauthenticated path.
func TestBulkDelete_RequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-delete",
		strings.NewReader(`{"ids":["x"]}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.BulkDelete(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestBulkDelete_RejectsEmptyIDs covers the validation short-circuit.
func TestBulkDelete_RejectsEmptyIDs(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-delete",
		strings.NewReader(`{"ids":[]}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkDelete(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// TestBulkDelete_RejectsTooManyIDs covers the bulk-action ceiling.
func TestBulkDelete_RejectsTooManyIDs(t *testing.T) {
	ids := make([]string, bulkActionMaxIDs+1)
	for i := range ids {
		ids[i] = "deadbeef-dead-beef-dead-beefdeadbeef"
	}
	body := `{"ids":[`
	for i := range ids {
		if i > 0 {
			body += ","
		}
		body += `"deadbeef-dead-beef-dead-beefdeadbeef"`
	}
	body += `]}`
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-delete", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkDelete(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
}

// TestBulkAction_InvalidAction covers the action multiplexer's
// default branch.
func TestBulkAction_InvalidAction(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-action",
		strings.NewReader(`{"ids":["x"],"action":"nuke"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkAction(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid_action") {
		t.Errorf("body = %q, want invalid_action", w.Body.String())
	}
}

func TestBulkAction_RejectsDSARDeletionTargetWithoutTouchingStore(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-action",
		strings.NewReader(`{"ids":["x"],"action":"change_reason","reason":"dsar_deletion"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkAction(w, r)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "protected_reason") {
		t.Errorf("body = %q, want protected_reason", w.Body.String())
	}
}

func TestRejectPermanentReasonChangeUsesLockedCurrentReason(t *testing.T) {
	rows := []BulkReasonChangeEvidence{
		{ID: "ordinary", PreviousReason: ReasonManualUnsubscribe},
		{ID: "erasure", PreviousReason: ReasonDSARDeletion},
	}
	if err := rejectPermanentReasonChange(rows); !errors.Is(err, ErrPermanentSuppressionReclassification) {
		t.Fatalf("rejectPermanentReasonChange() error = %v, want permanent sentinel", err)
	}
	if err := rejectPermanentReasonChange(rows[:1]); err != nil {
		t.Fatalf("ordinary reviewed row rejected: %v", err)
	}
}

// TestPatchExpiresAt_RequiresTenant — symmetry with Add/Remove.
func TestPatchExpiresAt_RequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("PATCH", "/api/v1/suppressions/abc",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.PatchExpiresAt(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestMirror_ReturnsServiceUnavailableWhenClientsNotConfigured covers
// the nil-Mirrors short-circuit. Without wired clients the endpoint
// MUST surface a 503 rather than silently noop.
func TestMirror_ReturnsServiceUnavailableWhenClientsNotConfigured(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/mirror/ses", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.Mirror(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "not_configured") {
		t.Errorf("body = %q, want not_configured", w.Body.String())
	}
}

// --- SUB-050: bulk suppression import ---------------------------------

// TestBulkImport_RequiresTenant guards the unauthenticated path.
func TestBulkImport_RequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-import",
		strings.NewReader(`{"emails":["a@b.co"]}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.BulkImport(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestBulkImport_RejectsTooManyRows covers the 50k ceiling without
// touching the (nil) pool — the size guard fires before BulkImport.
func TestBulkImport_RejectsTooManyRows(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"emails":[`)
	for i := 0; i <= bulkImportMaxRows; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"x@y.co"`)
	}
	b.WriteString(`]}`)
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-import",
		strings.NewReader(b.String()))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkImport(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "too_many") {
		t.Errorf("body = %q, want too_many", w.Body.String())
	}
}

// TestBulkImport_EmptyBatch returns 200 with zero counts without
// dereferencing the (nil) pool — the empty-slice short-circuit lives in
// Store.BulkImport before db.WithTenant.
func TestBulkImport_EmptyBatch(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-import",
		strings.NewReader(`{"emails":[]}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkImport(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"imported":0`) {
		t.Errorf("body = %q, want imported:0", w.Body.String())
	}
}

// TestStore_BulkImportValidationRejectsBadReason exercises the pre-DB
// reason guard. An invalid reason errors WITHOUT touching the (nil) pool,
// so this runs even on machines without DATABASE_URL.
func TestStore_BulkImportValidationRejectsBadReason(t *testing.T) {
	s := &Store{Pool: nil}
	if _, err := s.BulkImport(context.Background(), "tid",
		[]string{"a@b.co"}, Reason("not_a_reason"), ChannelEmail, ScopeMarketing); err == nil {
		t.Errorf("expected error for invalid reason")
	}
}

// TestStore_BulkImportEmptyBatchNoPool — empty input short-circuits
// before the pool deref, so a nil-pool Store returns (zero, nil).
func TestStore_BulkImportEmptyBatchNoPool(t *testing.T) {
	s := &Store{Pool: nil}
	out, err := s.BulkImport(context.Background(), "tid", nil, "", "", "")
	if err != nil {
		t.Fatalf("BulkImport(empty): unexpected err %v", err)
	}
	if out == nil || out.Imported != 0 || out.Skipped != 0 {
		t.Errorf("BulkImport(empty) = %+v, want zero counts", out)
	}
}

// TestStore_BulkImportRoundtrip is the SUB-050 integration happy path.
// Verifies: import into the modern subscriber_suppressions table,
// idempotency on re-run (skipped, not re-inserted), channel/scope/source
// defaults, reason normalisation of a legacy label, and the audit trail.
// Skips when DATABASE_URL is unset to match the package's DB-test pattern.
func TestStore_BulkImportRoundtrip(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4(t)
	e1 := "bi1" + tag + "@example.com"
	e2 := "bi2" + tag + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() {
		_ = store.Remove(context.Background(), tenantID, e1)
		_ = store.Remove(context.Background(), tenantID, e2)
	})

	// First import: a legacy "manual" reason should normalise to
	// manual_unsubscribe; one duplicate-within-batch + one invalid row are
	// skipped. Pass the normalised reason as the handler does.
	emails := []string{e1, e2, e1, "no-at-sign", "  "}
	res, err := store.BulkImport(ctx, tenantID, emails,
		NormalizeReason("manual"), ChannelEmail, ScopeMarketing)
	if err != nil {
		t.Fatalf("BulkImport: %v", err)
	}
	if res.Imported != 2 {
		t.Errorf("Imported = %d, want 2", res.Imported)
	}
	if res.Skipped != 3 {
		t.Errorf("Skipped = %d, want 3 (1 dup + 2 invalid)", res.Skipped)
	}

	// Row landed with defaults + normalised reason.
	row, err := store.FetchByEmail(ctx, tenantID, e1)
	if err != nil || row == nil {
		t.Fatalf("FetchByEmail(%s) = %+v, err %v", e1, row, err)
	}
	if row.Reason != ReasonManualUnsubscribe {
		t.Errorf("reason = %q, want manual_unsubscribe", row.Reason)
	}
	if row.Source != SourceImport {
		t.Errorf("source = %q, want import", row.Source)
	}

	// The send-loop converger consults the modern table — Check must see it.
	suppressed, _, err := store.Check(ctx, tenantID, e1)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !suppressed {
		t.Errorf("Check(%s): not suppressed; want suppressed", e1)
	}

	// Re-import the same batch: idempotent — everything skipped, nothing
	// re-inserted (ON CONFLICT DO NOTHING).
	res2, err := store.BulkImport(ctx, tenantID, []string{e1, e2},
		ReasonManualUnsubscribe, "", "")
	if err != nil {
		t.Fatalf("BulkImport (idempotent): %v", err)
	}
	if res2.Imported != 0 {
		t.Errorf("idempotent Imported = %d, want 0", res2.Imported)
	}
	if res2.Skipped != 2 {
		t.Errorf("idempotent Skipped = %d, want 2", res2.Skipped)
	}
}

// TestBulkImport_HandlerAuditTrail drives the full handler path against a
// real pool and asserts each newly-imported address produced an audit
// row. Skips without DATABASE_URL.
func TestBulkImport_HandlerAuditTrail(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4(t)
	email := "biaud" + tag + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })

	h := &StoreHandlers{Store: store, Audit: &AuditLogger{Pool: pool}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-import",
		strings.NewReader(`{"emails":["`+email+`"],"reason":"manual"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
	w := httptest.NewRecorder()
	h.BulkImport(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"imported":1`) {
		t.Errorf("body = %q, want imported:1", w.Body.String())
	}

	audit, err := store.RecentAuditForEmail(ctx, tenantID, email, 10)
	if err != nil {
		t.Fatalf("RecentAuditForEmail: %v", err)
	}
	if len(audit) == 0 {
		t.Fatalf("no audit rows for %s; want >=1", email)
	}
	if audit[0].Action != AuditActionAdd {
		t.Errorf("audit action = %q, want add", audit[0].Action)
	}
}

// TestBulkChangeReasonAtomicAuditAndDSARGuard pins the compliance boundary at
// the store transaction: current reasons are locked, a DSAR row rejects the
// WHOLE reviewed scope, and a permitted update commits its exact prior/new
// evidence in suppression_audit with the reason change.
func TestBulkChangeReasonAtomicAuditAndDSARGuard(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4(t)
	ordinaryEmail := "reason" + tag + "@example.com"
	dsarEmail := "dsar" + tag + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() {
		_ = store.Remove(context.Background(), tenantID, ordinaryEmail)
		_ = store.Remove(context.Background(), tenantID, dsarEmail)
	})

	ordinary, err := store.Add(ctx, tenantID, ordinaryEmail,
		ReasonManualUnsubscribe, SourceAPI, "", nil, nil)
	if err != nil {
		t.Fatalf("add ordinary: %v", err)
	}
	dsar, err := store.Add(ctx, tenantID, dsarEmail,
		ReasonDSARDeletion, SourceAPI, "", nil, map[string]any{"gdpr_erasure": true})
	if err != nil {
		t.Fatalf("add DSAR: %v", err)
	}

	_, err = store.BulkChangeReason(ctx, tenantID,
		[]string{ordinary.ID, dsar.ID}, ReasonListManual, "", "")
	if !errors.Is(err, ErrPermanentSuppressionReclassification) {
		t.Fatalf("mixed DSAR scope error = %v, want permanent sentinel", err)
	}
	unchanged, err := store.FetchByID(ctx, tenantID, ordinary.ID)
	if err != nil || unchanged == nil {
		t.Fatalf("fetch ordinary after refused scope = %+v, %v", unchanged, err)
	}
	if unchanged.Reason != ReasonManualUnsubscribe {
		t.Fatalf("ordinary reason = %q after refused scope, want unchanged", unchanged.Reason)
	}

	if _, err := store.BulkChangeReason(ctx, tenantID,
		[]string{ordinary.ID}, ReasonDSARDeletion, "", ""); !errors.Is(err, ErrPermanentSuppressionReclassification) {
		t.Fatalf("DSAR target error = %v, want permanent sentinel", err)
	}

	evidence, err := store.BulkChangeReason(ctx, tenantID,
		[]string{ordinary.ID}, ReasonListManual, "", "")
	if err != nil {
		t.Fatalf("BulkChangeReason: %v", err)
	}
	if len(evidence) != 1 || evidence[0].ID != ordinary.ID ||
		evidence[0].PreviousReason != ReasonManualUnsubscribe ||
		evidence[0].NewReason != ReasonListManual {
		t.Fatalf("evidence = %+v, want exact prior/new row", evidence)
	}
	changed, err := store.FetchByID(ctx, tenantID, ordinary.ID)
	if err != nil || changed == nil || changed.Reason != ReasonListManual {
		t.Fatalf("changed row = %+v, err=%v", changed, err)
	}

	audit, err := store.RecentAuditForEmail(ctx, tenantID, ordinaryEmail, 10)
	if err != nil {
		t.Fatalf("RecentAuditForEmail: %v", err)
	}
	if len(audit) != 1 || audit[0].Action != AuditActionUpdate {
		t.Fatalf("audit = %+v, want one atomic update row", audit)
	}
	if audit[0].Reason != string(ReasonListManual) ||
		audit[0].Payload["previous_reason"] != string(ReasonManualUnsubscribe) ||
		audit[0].Payload["new_reason"] != string(ReasonListManual) ||
		audit[0].Payload["id"] != ordinary.ID {
		t.Fatalf("audit evidence = %+v, want exact prior/new/id", audit[0])
	}
}
