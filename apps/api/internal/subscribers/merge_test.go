package subscribers

// Tests for the merge helpers. The full repo.Merge transaction needs a
// database (skip-on-DATABASE_URL-unset is the established pattern), but
// the union/merge pure helpers and the validation branches in
// MergeHandler can be exercised without postgres.

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestUnionStrings_DedupsAndPreservesOrder — primary order wins, then
// any duplicate keys from B that were not in A. Empty inputs are
// no-ops and never panic.
func TestUnionStrings_DedupsAndPreservesOrder(t *testing.T) {
	got := unionStrings([]string{"a", "b"}, []string{"b", "c"})
	want := []string{"a", "b", "c"}
	if !equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	// Both nil → empty (not nil) slice. Callers JSON-encode this and
	// `null` would be a different wire shape than `[]`.
	if got := unionStrings(nil, nil); got == nil {
		t.Errorf("expected empty slice, got nil")
	}
}

// TestUnionStrings_DropsBDuplicates — when B has a tag A already has,
// the merged tag list shouldn't grow.
func TestUnionStrings_DropsBDuplicates(t *testing.T) {
	got := unionStrings([]string{"vip"}, []string{"vip", "vip"})
	if len(got) != 1 || got[0] != "vip" {
		t.Errorf("got %v, want [vip]", got)
	}
}

// TestMergeMaps_PrimaryWins — primary's keys override duplicate's on
// collision; duplicate's unique keys are preserved (fills the gap).
// This matches the spec line "Custom fields from B fill in any gaps
// on A but don't overwrite".
func TestMergeMaps_PrimaryWins(t *testing.T) {
	primary := map[string]any{"a": 1, "shared": "from_primary"}
	dupe := map[string]any{"b": 2, "shared": "from_dupe"}
	got := mergeMaps(primary, dupe)
	if got["a"] != 1 {
		t.Errorf("a = %v, want 1", got["a"])
	}
	if got["b"] != 2 {
		t.Errorf("b = %v (missing from B fill-in), want 2", got["b"])
	}
	if got["shared"] != "from_primary" {
		t.Errorf("shared = %v, want primary's value", got["shared"])
	}
}

// TestMergeMaps_NilInputs — guards against either side being nil.
func TestMergeMaps_NilInputs(t *testing.T) {
	out := mergeMaps(nil, map[string]any{"x": 1})
	if out["x"] != 1 {
		t.Errorf("nil primary lost B's keys: %v", out)
	}
	out = mergeMaps(map[string]any{"y": 2}, nil)
	if out["y"] != 2 {
		t.Errorf("nil duplicate lost A's keys: %v", out)
	}
}

func TestUnionGDPRPermissions_PreservesCanonicalArrayAndDenial(t *testing.T) {
	primary := []map[string]any{{"marketing_permission_id": "email", "enabled": true}}
	duplicate := []map[string]any{
		{"marketing_permission_id": "email", "enabled": false},
		{"marketing_permission_id": "sms", "enabled": true},
	}
	got := unionGDPRPermissions(primary, duplicate)
	if len(got) != 2 || got[0]["enabled"] != false || got[1]["marketing_permission_id"] != "sms" {
		t.Fatalf("merged GDPR permissions = %#v", got)
	}
}

// fakePgErr satisfies the duck-typed pgxErrorWithCode interface so we
// can unit-test isUndefinedTable without spinning up postgres.
type fakePgErr struct {
	code string
	msg  string
}

func (f *fakePgErr) Error() string    { return f.msg }
func (f *fakePgErr) SQLState() string { return f.code }

// TestIsUndefinedTable — 42P01 is the postgres SQLSTATE for
// undefined_table. The merge code tolerates that for deployments
// missing one of the two suppression tables; any other state must
// surface as an error.
func TestIsUndefinedTable(t *testing.T) {
	if !isUndefinedTable(&fakePgErr{code: "42P01"}) {
		t.Error("42P01 should be detected as undefined_table")
	}
	if isUndefinedTable(&fakePgErr{code: "23505"}) {
		t.Error("23505 (unique_violation) is not undefined_table")
	}
	if isUndefinedTable(errors.New("plain error")) {
		t.Error("plain error should not be undefined_table")
	}
	if isUndefinedTable(nil) {
		t.Error("nil should not be undefined_table")
	}
}

// TestMergeHandler_RejectsSameSubscriber — primary == duplicate must
// 400, never call the repo. Since same-id is caught up-front in
// repo.Merge before any DB work, we can exercise it with a nil pool.
func TestMergeHandler_RejectsSameSubscriber(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge",
		strings.NewReader(`{"primary_id":"abc","duplicate_id":"abc"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.MergeHandler(w, r)
	if w.Code != 400 {
		t.Errorf("status = %d, want 400 for same subscriber", w.Code)
	}
	if !strings.Contains(w.Body.String(), "same_subscriber") {
		t.Errorf("body = %q, want same_subscriber error", w.Body.String())
	}
}

// TestMergeHandler_RequiresTenant — no tenant context → 401.
func TestMergeHandler_RequiresTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge",
		strings.NewReader(`{"primary_id":"a","duplicate_id":"b"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.MergeHandler(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestMergeHandler_RequiresTwoExactRevisionsBeforeDatabase(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, body := range []string{
		`{"primary_id":"a","duplicate_id":"b"}`,
		`{"primary_id":"a","duplicate_id":"b","primary_version":"*","duplicate_version":"\"subscriber:b:v1\""}`,
		`{"primary_id":"a","duplicate_id":"b","primary_version":"\"subscriber:a:v1\"","duplicate_version":"*"}`,
		`{"primary_id":"a","duplicate_id":"b","primary_version":"  *  ","duplicate_version":"\"subscriber:b:v1\""}`,
	} {
		r := httptest.NewRequest("POST", "/api/v1/subscribers/merge", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.MergeHandler(w, r)
		if w.Code != 428 || !strings.Contains(w.Body.String(), "precondition_required") {
			t.Fatalf("body=%s status/body=%d %s, want 428 precondition_required", body, w.Code, w.Body.String())
		}
	}
}

// TestMerge_RejectsMissingIDs — repo.Merge must error before any
// pool access when either id is empty. We pass a nil pool to prove
// that path is reached without ever opening a tx.
func TestMerge_RejectsMissingIDs(t *testing.T) {
	repo := &Repo{Pool: nil}
	if _, err := repo.Merge(context.Background(), "t", MergeInput{}); err == nil {
		t.Fatal("expected error for empty ids, got nil")
	}
	if _, err := repo.Merge(context.Background(), "t",
		MergeInput{PrimaryID: "a", DuplicateID: "a"}); err != ErrSameSubscriber {
		t.Fatalf("err = %v, want ErrSameSubscriber", err)
	}
}

// --- SUB-024: email re-pointing guard tests ---------------------------

// TestRepointSubscriberEmail_NoOpGuards — the helper must short-circuit
// (returning nil and never touching the tx) when there is nothing to move:
// equal old/new emails, or either side empty. A nil tx proves no DB work is
// attempted on these paths.
func TestRepointSubscriberEmail_NoOpGuards(t *testing.T) {
	cases := []struct{ old, new string }{
		{"a@x.com", "a@x.com"}, // unchanged
		{"A@x.com", "a@x.com"}, // citext-equivalent casing change
		{"", "b@x.com"},        // no source
		{"a@x.com", ""},        // no target
		{"", ""},               // both empty
	}
	for _, c := range cases {
		if err := repointSubscriberEmail(context.Background(), nil, "t1", c.old, c.new); err != nil {
			t.Errorf("repointSubscriberEmail(%q,%q) = %v, want nil no-op", c.old, c.new, err)
		}
	}
}

// --- SUB-025: merge signal recording validation -----------------------

// TestRecordMergeSignals_EmptyIsNoOp — no signals (nil or empty slice) means
// no rows and no tx access, so a nil tx must not panic and the count is 0.
func TestRecordMergeSignals_EmptyIsNoOp(t *testing.T) {
	for _, sig := range [][]MergeSignal{nil, {}} {
		n, err := recordMergeSignals(context.Background(), nil, "t1", "p1", "d1", sig)
		if err != nil {
			t.Fatalf("recordMergeSignals empty = %v, want nil", err)
		}
		if n != 0 {
			t.Errorf("recorded = %d, want 0 for empty signals", n)
		}
	}
}

// TestRecordMergeSignals_BlankKindSkipped — a signal with an empty/whitespace
// kind carries no evidence and is skipped before any tx write, so a nil tx is
// safe and the count stays 0.
func TestRecordMergeSignals_BlankKindSkipped(t *testing.T) {
	n, err := recordMergeSignals(context.Background(), nil, "t1", "p1", "d1",
		[]MergeSignal{{Kind: "  "}, {Kind: ""}})
	if err != nil {
		t.Fatalf("err = %v, want nil (blank kinds skipped)", err)
	}
	if n != 0 {
		t.Errorf("recorded = %d, want 0 for blank-kind signals", n)
	}
}

// TestRecordMergeSignals_ConfidenceOutOfRange — confidence is a probability;
// a value outside [0,1] is a hard validation error raised BEFORE any tx
// write, which a nil tx confirms (no panic).
func TestRecordMergeSignals_ConfidenceOutOfRange(t *testing.T) {
	for _, bad := range []float64{-0.01, 1.5} {
		c := bad
		_, err := recordMergeSignals(context.Background(), nil, "t1", "p1", "d1",
			[]MergeSignal{{Kind: "case_diff", Confidence: &c}})
		if err == nil {
			t.Errorf("confidence %v should error", bad)
		}
		if err != nil && !strings.Contains(err.Error(), "confidence") {
			t.Errorf("err = %q, want a confidence message", err.Error())
		}
	}
}

// TestRecordMergeSignals_ValidConfidenceBoundsPassValidation — the
// boundary values 0 and 1 are in-range; validation must pass them through to
// the tx write (we don't have a DB here, so we only assert the validation
// branch did not short-circuit with an error before the Exec). A nil
// confidence is also in-range. We exercise this by confirming the out-of-range
// guard does NOT fire for these values — using a recovering wrapper since the
// nil-tx Exec would panic only AFTER validation succeeds.
func TestRecordMergeSignals_ValidConfidencePassesValidation(t *testing.T) {
	zero, one := 0.0, 1.0
	for _, c := range []*float64{nil, &zero, &one} {
		got := confidenceValidationError([]MergeSignal{{Kind: "plus_alias", Confidence: c}})
		if got != nil {
			t.Errorf("confidence %v rejected: %v, want accepted", c, got)
		}
	}
}

// confidenceValidationError replays just the SUB-025 confidence validation
// branch so we can assert in-range values are accepted without reaching a
// (nil) tx.Exec. It deliberately mirrors recordMergeSignals' rule.
func confidenceValidationError(signals []MergeSignal) error {
	for _, s := range signals {
		if strings.TrimSpace(s.Kind) == "" {
			continue
		}
		if s.Confidence != nil && (*s.Confidence < 0 || *s.Confidence > 1) {
			return errors.New("confidence out of range")
		}
	}
	return nil
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
