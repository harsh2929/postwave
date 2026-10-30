package sendingsettings

// Tests for the sending-settings endpoint. The concrete Repo is DB-backed;
// route tests use the narrow settingsStore seam so mutation metadata, cache
// invalidation, truthful status, and compatibility behavior remain testable
// without a database.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

func TestValidateHHMM_Good(t *testing.T) {
	good := []string{"00:00", "09:30", "23:59"}
	for _, s := range good {
		if err := validateHHMM(s); err != nil {
			t.Errorf("validateHHMM(%q) = %v, want nil", s, err)
		}
	}
}

func TestValidateHHMM_Bad(t *testing.T) {
	bad := []string{
		"24:00", "0900", "9:60", "abc", "", "-1:00",
		"9:30", "09:3", "09:30:00", "09:30junk", " 09:30", "09:30 ",
	}
	for _, s := range bad {
		if err := validateHHMM(s); err == nil {
			t.Errorf("validateHHMM(%q) = nil, want error", s)
		}
	}
}

func TestParseHHMM_IsStrictAndAnchored(t *testing.T) {
	h, m, ok := parseHHMM("09:30")
	if !ok || h != 9 || m != 30 {
		t.Fatalf("parseHHMM(09:30) = (%d, %d, %v)", h, m, ok)
	}
	for _, bad := range []string{"9:30", "09:30:00", "09:30x", "24:00"} {
		if _, _, ok := parseHHMM(bad); ok {
			t.Fatalf("parseHHMM(%q) accepted malformed input", bad)
		}
	}
}

func TestComputeQuietHoursWindow_UsesNextLocalDateAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	// The following day is the 2026 spring-forward transition. Adding a fixed
	// 24h to March 7 09:00 EST yields 10:00 EDT; the contract requires 09:00.
	now := time.Date(2026, time.March, 7, 18, 0, 0, 0, loc)
	inQuiet, next, ok := computeQuietHoursWindow("09:00", "17:00", loc.String(), now)
	if !ok || inQuiet {
		t.Fatalf("quiet result = (%v, %v), want outside/valid", inQuiet, ok)
	}
	want := time.Date(2026, time.March, 8, 9, 0, 0, 0, loc)
	if !next.Equal(want) || next.In(loc).Hour() != 9 {
		t.Fatalf("next change = %v, want next local 09:00 (%v)", next, want)
	}
}

func TestComputeQuietHoursWindow_SpringForwardUsesRuntimeWallClockSemantics(t *testing.T) {
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}

	// 02:30 never occurs on this date. The send runtime compares local clock
	// minutes, so the window becomes active at the first real minute after the
	// jump: 03:00 PDT, not at a normalized synthetic 02:30 instant.
	now := time.Date(2026, time.March, 8, 1, 59, 0, 0, loc)
	inQuiet, next, ok := computeQuietHoursWindow("02:30", "04:00", loc.String(), now)
	if !ok || inQuiet {
		t.Fatalf("quiet result = (%v, %v), want outside/valid", inQuiet, ok)
	}
	want := time.Date(2026, time.March, 8, 3, 0, 0, 0, loc)
	if !next.Equal(want) {
		t.Fatalf("next change = %v, want spring jump instant %v", next, want)
	}

	// A skipped end minute likewise remains quiet until the clock jumps beyond
	// the configured end, exactly matching the runtime minute predicate.
	now = time.Date(2026, time.March, 8, 1, 45, 0, 0, loc)
	inQuiet, next, ok = computeQuietHoursWindow("01:30", "02:30", loc.String(), now)
	if !ok || !inQuiet || !next.Equal(want) {
		t.Fatalf("skipped-end result = (%v, %v, %v), want quiet until %v", inQuiet, next, ok, want)
	}
}

func TestComputeQuietHoursWindow_FallBackFindsRepeatedTransition(t *testing.T) {
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}

	// 08:50Z is the first 01:50 (PDT). The first 01:15–01:45 window has
	// ended, but the clock soon folds to 01:00 PST and the runtime predicate
	// enters the same wall-clock window again at the second 01:15.
	now := time.Date(2026, time.November, 1, 8, 50, 0, 0, time.UTC)
	inQuiet, next, ok := computeQuietHoursWindow("01:15", "01:45", loc.String(), now)
	if !ok || inQuiet {
		t.Fatalf("quiet result = (%v, %v), want outside/valid", inQuiet, ok)
	}
	want := time.Date(2026, time.November, 1, 9, 15, 0, 0, time.UTC)
	if !next.Equal(want) || next.In(loc).Hour() != 1 || next.In(loc).Minute() != 15 {
		t.Fatalf("next change = %v (%v local), want repeated 01:15 at %v", next, next.In(loc), want)
	}

	// Once inside the repeated window, its second 01:45 is the next actual
	// transition rather than tomorrow's boundary.
	inQuiet, next, ok = computeQuietHoursWindow(
		"01:15", "01:45", loc.String(),
		time.Date(2026, time.November, 1, 9, 20, 0, 0, time.UTC),
	)
	want = time.Date(2026, time.November, 1, 9, 45, 0, 0, time.UTC)
	if !ok || !inQuiet || !next.Equal(want) {
		t.Fatalf("second-fold result = (%v, %v, %v), want quiet until %v", inQuiet, next, ok, want)
	}
}

func TestComputeQuietHoursWindow_PreservesNormalAndOvernightWindows(t *testing.T) {
	for _, tc := range []struct {
		name    string
		start   string
		end     string
		now     time.Time
		inQuiet bool
		next    time.Time
	}{
		{
			name:    "same-day inside",
			start:   "09:00",
			end:     "17:00",
			now:     time.Date(2026, time.January, 10, 10, 15, 0, 0, time.UTC),
			inQuiet: true,
			next:    time.Date(2026, time.January, 10, 17, 0, 0, 0, time.UTC),
		},
		{
			name:    "overnight before end",
			start:   "22:00",
			end:     "07:00",
			now:     time.Date(2026, time.January, 10, 6, 30, 0, 0, time.UTC),
			inQuiet: true,
			next:    time.Date(2026, time.January, 10, 7, 0, 0, 0, time.UTC),
		},
		{
			name:    "overnight daytime gap",
			start:   "22:00",
			end:     "07:00",
			now:     time.Date(2026, time.January, 10, 12, 0, 0, 0, time.UTC),
			inQuiet: false,
			next:    time.Date(2026, time.January, 10, 22, 0, 0, 0, time.UTC),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inQuiet, next, ok := computeQuietHoursWindow(tc.start, tc.end, "UTC", tc.now)
			if !ok || inQuiet != tc.inQuiet || !next.Equal(tc.next) {
				t.Fatalf("result = (%v, %v, %v), want (%v, %v, true)", inQuiet, next, ok, tc.inQuiet, tc.next)
			}
		})
	}
}

func TestOptionalNullableInt_DistinguishesOmittedAndNull(t *testing.T) {
	var omitted putInput
	if err := json.Unmarshal([]byte(`{}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.FallbackHourUTC.Present || omitted.FallbackHourUTC.Value != nil {
		t.Fatalf("omitted fallback = %+v", omitted.FallbackHourUTC)
	}

	var cleared putInput
	if err := json.Unmarshal([]byte(`{"fallback_hour_utc":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared.FallbackHourUTC.Present || cleared.FallbackHourUTC.Value != nil {
		t.Fatalf("explicit-null fallback = %+v", cleared.FallbackHourUTC)
	}

	var set putInput
	if err := json.Unmarshal([]byte(`{"fallback_hour_utc":17}`), &set); err != nil {
		t.Fatal(err)
	}
	if !set.FallbackHourUTC.Present || set.FallbackHourUTC.Value == nil ||
		*set.FallbackHourUTC.Value != 17 {
		t.Fatalf("set fallback = %+v", set.FallbackHourUTC)
	}
}

func TestSameSendingCapUsesExactCappedAndUncappedState(t *testing.T) {
	cap100 := 100
	other100 := 100
	cap101 := 101
	for _, test := range []struct {
		name      string
		before    *Settings
		candidate *int
		want      bool
	}{
		{name: "missing and uncapped", candidate: nil, want: true},
		{name: "uncapped unchanged", before: &Settings{}, candidate: nil, want: true},
		{name: "uncapped to capped", before: &Settings{}, candidate: &cap100},
		{name: "capped to uncapped", before: &Settings{MaxSendsPerHour: &cap100}},
		{name: "same cap", before: &Settings{MaxSendsPerHour: &cap100}, candidate: &other100, want: true},
		{name: "different cap", before: &Settings{MaxSendsPerHour: &cap100}, candidate: &cap101},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := sameSendingCap(test.before, test.candidate); got != test.want {
				t.Fatalf("sameSendingCap(%v, %v) = %v, want %v", test.before, test.candidate, got, test.want)
			}
		})
	}
}

func TestParseWritePrecondition(t *testing.T) {
	if got, err := parseWritePrecondition(nil); err != nil || got.Supplied {
		t.Fatalf("omitted = (%+v, %v)", got, err)
	}
	empty := ""
	if got, err := parseWritePrecondition(&empty); err != nil ||
		!got.Supplied || got.Expected != nil {
		t.Fatalf("empty = (%+v, %v), want must-not-exist", got, err)
	}
	raw := "2026-08-30T10:15:16.123456Z"
	got, err := parseWritePrecondition(&raw)
	if err != nil || !got.Supplied || got.Expected == nil ||
		got.Expected.Format(time.RFC3339Nano) != raw {
		t.Fatalf("timestamp = (%+v, %v)", got, err)
	}
	for _, invalid := range []string{"today", " ", "0001-01-01T00:00:00Z"} {
		if got, err := parseWritePrecondition(&invalid); err == nil || got.Supplied {
			t.Fatalf("invalid %q = (%+v, %v), want error", invalid, got, err)
		}
	}
}

func TestCheckWritePrecondition(t *testing.T) {
	revision := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	current := &Settings{UpdatedAt: revision}
	stale := revision.Add(-time.Second)
	for _, tc := range []struct {
		name   string
		before *Settings
		pre    writePrecondition
		want   error
	}{
		{"omitted remains backward compatible", current, writePrecondition{}, nil},
		{"first write succeeds when absent", nil, writePrecondition{Supplied: true}, nil},
		{"first write conflicts when present", current, writePrecondition{Supplied: true}, ErrRevisionConflict},
		{"exact revision succeeds", current, writePrecondition{Supplied: true, Expected: &revision}, nil},
		{"stale revision conflicts", current, writePrecondition{Supplied: true, Expected: &stale}, ErrRevisionConflict},
		{"expected row missing conflicts", nil, writePrecondition{Supplied: true, Expected: &revision}, ErrRevisionConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkWritePrecondition(tc.before, tc.pre); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestLegacyFallbackForWrite(t *testing.T) {
	legacy := 11
	replacement := 17
	before := &Settings{FallbackHourUTC: &legacy}
	if got := legacyFallbackForWrite(nil, before, false); got == nil || *got != legacy {
		t.Fatalf("omitted legacy fallback = %v, want %d", got, legacy)
	}
	if got := legacyFallbackForWrite(nil, before, true); got != nil {
		t.Fatalf("explicit null fallback = %v, want nil", got)
	}
	if got := legacyFallbackForWrite(&replacement, before, true); got == nil || *got != replacement {
		t.Fatalf("explicit replacement = %v, want %d", got, replacement)
	}
	if got := legacyFallbackForWrite(nil, nil, false); got != nil {
		t.Fatalf("omitted first-write fallback = %v, want nil", got)
	}
}

type fakeSettingsStore struct {
	getResult        *Settings
	getErr           error
	getCalls         int
	putResult        *Settings
	putErr           error
	putCalls         int
	settings         Settings
	opts             UpsertOptions
	receiptCommitted bool
	receiptErr       error
}

func (f *fakeSettingsStore) Get(context.Context, string) (*Settings, error) {
	f.getCalls++
	return f.getResult, f.getErr
}

func (f *fakeSettingsStore) Upsert(ctx context.Context, s Settings, opts UpsertOptions) (*Settings, sending.CapChangeLease, error) {
	if errors.Is(f.putErr, ErrRevisionConflict) || errors.Is(f.putErr, ErrDeliverabilityThrottleActive) {
		return nil, sending.CapChangeLease{}, f.putErr
	}
	if opts.CapCoordinator == nil {
		return nil, sending.CapChangeLease{}, sending.ErrCapCoordinationUnavailable
	}
	var durable *int
	if f.getResult != nil {
		durable = f.getResult.MaxSendsPerHour
	}
	lease, beginErr := opts.CapCoordinator.BeginCapChangeLocked(ctx, nil, s.TenantID, durable, s.MaxSendsPerHour)
	if beginErr != nil {
		return nil, sending.CapChangeLease{}, beginErr
	}
	f.putCalls++
	f.settings = s
	f.opts = opts
	return f.putResult, lease, f.putErr
}

func (f *fakeSettingsStore) CapMutationCommitted(context.Context, string, string) (bool, error) {
	return f.receiptCommitted, f.receiptErr
}

type fakeCapCache struct {
	beginTenantIDs   []string
	commitTenantIDs  []string
	abortTenantIDs   []string
	beginErr         error
	commitErr        error
	commitPanic      any
	abortErr         error
	inspectStatus    sending.CapCoordinationStatus
	inspectErr       error
	inspectTenantIDs []string
	lastTarget       *int
}

func (f *fakeCapCache) BeginCapChangeLocked(
	_ context.Context,
	_ pgx.Tx,
	tenantID string,
	durable, target *int,
) (sending.CapChangeLease, error) {
	f.beginTenantIDs = append(f.beginTenantIDs, tenantID)
	f.lastTarget = target
	if f.beginErr != nil {
		return sending.CapChangeLease{}, f.beginErr
	}
	return sending.CapChangeLease{
		TenantID:     tenantID,
		Token:        "lease-token",
		EffectiveCap: sendingCapTestStricter(durable, target),
	}, nil
}

func sendingCapTestStricter(a, b *int) int {
	if a == nil {
		if b == nil {
			return 0
		}
		return *b
	}
	if b == nil || *a < *b {
		return *a
	}
	return *b
}

func (f *fakeCapCache) CommitCapChange(_ context.Context, lease sending.CapChangeLease, _ *int) error {
	f.commitTenantIDs = append(f.commitTenantIDs, lease.TenantID)
	if f.commitPanic != nil {
		panic(f.commitPanic)
	}
	return f.commitErr
}

func (f *fakeCapCache) AbortCapChange(_ context.Context, lease sending.CapChangeLease) error {
	f.abortTenantIDs = append(f.abortTenantIDs, lease.TenantID)
	return f.abortErr
}

func (f *fakeCapCache) InspectCapCoordination(_ context.Context, tenantID string) (sending.CapCoordinationStatus, error) {
	f.inspectTenantIDs = append(f.inspectTenantIDs, tenantID)
	return f.inspectStatus, f.inspectErr
}

func sendingRequest(method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/v1/settings/sending", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:       "00000000-0000-0000-0000-000000000002",
		TenantID: "00000000-0000-0000-0000-000000000001",
	})
	return r.WithContext(ctx)
}

// recoverAsJSON500 is the package-local equivalent of the application's outer
// jsonRecoverer. It deliberately sits outside ProtectResponses so these tests
// exercise the production writer ordering without importing package main.
func recoverAsJSON500(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() == nil {
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"code":"internal_server_error"}}`))
		}()
		next.ServeHTTP(w, r)
	})
}

type panickingIPLister struct{}

func (panickingIPLister) ListActiveForTenant(context.Context, string) ([]sending.Assignment, error) {
	panic("ip projection panic after commit")
}

func TestPut_PropagatesCASAttributionPreservationAndInvalidatesCap(t *testing.T) {
	updated := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	store := &fakeSettingsStore{putResult: &Settings{
		TenantID:               "00000000-0000-0000-0000-000000000001",
		QuietHoursPerRecipient: true,
		UpdatedAt:              updated.Add(time.Second),
	}}
	cache := &fakeCapCache{}
	d := &Deps{
		Repo:     store,
		IPs:      &fakeIPLister{},
		CapCache: cache,
	}
	r := sendingRequest(http.MethodPut, `{
		"max_sends_per_hour":2500,
		"quiet_hours_start":"",
		"quiet_hours_end":"",
		"quiet_hours_tz":"",
		"quiet_hours_per_recipient":true,
		"expected_updated_at":"2026-08-30T10:15:16.123456Z"
	}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if store.putCalls != 1 || store.settings.MaxSendsPerHour == nil ||
		*store.settings.MaxSendsPerHour != 2500 {
		t.Fatalf("stored settings = %+v, calls=%d", store.settings, store.putCalls)
	}
	if store.opts.UpdatedByUserID != "00000000-0000-0000-0000-000000000002" {
		t.Fatalf("updated_by = %q", store.opts.UpdatedByUserID)
	}
	if store.opts.FallbackHourUTCPresent || store.settings.FallbackHourUTC != nil {
		t.Fatalf("omitted fallback was not preserved contractually: settings=%+v opts=%+v", store.settings, store.opts)
	}
	if !store.opts.Precondition.Supplied || store.opts.Precondition.Expected == nil ||
		!store.opts.Precondition.Expected.Equal(updated) {
		t.Fatalf("precondition = %+v", store.opts.Precondition)
	}
	if store.opts.AuditMeta == nil || store.opts.AuditMeta.TenantID == "" ||
		store.opts.AuditMeta.UserID == nil {
		t.Fatalf("audit meta = %+v", store.opts.AuditMeta)
	}
	if len(cache.beginTenantIDs) != 1 || len(cache.commitTenantIDs) != 1 ||
		cache.beginTenantIDs[0] != store.settings.TenantID ||
		cache.commitTenantIDs[0] != store.settings.TenantID {
		t.Fatalf("cap coordination begin=%v commit=%v", cache.beginTenantIDs, cache.commitTenantIDs)
	}
	if got := w.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != "committed" {
		t.Fatalf("cap outcome = %q, want committed", got)
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("Cache-Control = %q", w.Header().Get("Cache-Control"))
	}
	var response Settings
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.IPPool == nil || response.IPPool.Name != "shared" {
		t.Fatalf("PUT response ip_pool = %+v", response.IPPool)
	}
}

func TestPut_ExplicitNullClearsLegacyFallback(t *testing.T) {
	store := &fakeSettingsStore{putResult: &Settings{
		TenantID: "00000000-0000-0000-0000-000000000001",
	}}
	d := &Deps{Repo: store, CapCache: &fakeCapCache{}}
	r := sendingRequest(http.MethodPut, `{"fallback_hour_utc":null}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if !store.opts.FallbackHourUTCPresent || store.settings.FallbackHourUTC != nil {
		t.Fatalf("explicit-null contract lost: settings=%+v opts=%+v", store.settings, store.opts)
	}
}

func TestPut_RevisionConflictDoesNotInvalidate(t *testing.T) {
	store := &fakeSettingsStore{putErr: ErrRevisionConflict}
	cache := &fakeCapCache{}
	d := &Deps{Repo: store, CapCache: cache}
	r := sendingRequest(http.MethodPut, `{"expected_updated_at":""}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusConflict ||
		!strings.Contains(w.Body.String(), "settings_revision_conflict") {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if len(cache.beginTenantIDs) != 0 || len(cache.commitTenantIDs) != 0 || len(cache.abortTenantIDs) != 0 {
		t.Fatalf("revision conflict crossed cap fence begin=%v commit=%v abort=%v",
			cache.beginTenantIDs, cache.commitTenantIDs, cache.abortTenantIDs)
	}
	if got := w.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != "not-committed" {
		t.Fatalf("cap outcome = %q, want not-committed", got)
	}
}

func TestPut_ActiveDeliverabilityThrottleRejectsCapChangeBeforeFence(t *testing.T) {
	store := &fakeSettingsStore{putErr: ErrDeliverabilityThrottleActive}
	cache := &fakeCapCache{}
	d := &Deps{Repo: store, CapCache: cache}
	w := httptest.NewRecorder()
	d.Put(w, sendingRequest(http.MethodPut, `{"max_sends_per_hour":100}`))

	if w.Code != http.StatusConflict ||
		!strings.Contains(w.Body.String(), `"code":"deliverability_throttle_active"`) {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if store.putCalls != 0 || len(cache.beginTenantIDs) != 0 ||
		len(cache.commitTenantIDs) != 0 || len(cache.abortTenantIDs) != 0 {
		t.Fatalf("active repair crossed mutation boundary writes=%d begin=%v commit=%v abort=%v",
			store.putCalls, cache.beginTenantIDs, cache.commitTenantIDs, cache.abortTenantIDs)
	}
	if got := w.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != "not-committed" {
		t.Fatalf("cap outcome = %q, want not-committed", got)
	}
}

func TestPut_FailsBeforeRepositoryWhenCapCoordinationUnavailable(t *testing.T) {
	store := &fakeSettingsStore{putResult: &Settings{}}
	d := &Deps{Repo: store}
	r := sendingRequest(http.MethodPut, `{"max_sends_per_hour":100}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusServiceUnavailable ||
		!strings.Contains(w.Body.String(), "sending_cap_coordination_unavailable") ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if store.putCalls != 0 {
		t.Fatalf("uncoordinated cap write reached repository: %d", store.putCalls)
	}
	if w.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q", w.Header().Get("Retry-After"))
	}
}

func TestPut_ReportsCommittedButUnconfirmedCapConvergence(t *testing.T) {
	cap := 100
	store := &fakeSettingsStore{putResult: &Settings{
		TenantID:        "00000000-0000-0000-0000-000000000001",
		MaxSendsPerHour: &cap,
	}}
	coordinator := &fakeCapCache{commitErr: sending.ErrCapCoordinationUnavailable}
	d := &Deps{Repo: store, CapCache: coordinator}
	r := sendingRequest(http.MethodPut, `{"max_sends_per_hour":100}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusServiceUnavailable ||
		!strings.Contains(w.Body.String(), "sending_cap_convergence_pending") ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "committed-conservatively-fenced" {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if store.putCalls != 1 || len(coordinator.commitTenantIDs) != 1 || len(coordinator.abortTenantIDs) != 0 {
		t.Fatalf("write=%d commit=%v abort=%v", store.putCalls, coordinator.commitTenantIDs, coordinator.abortTenantIDs)
	}
}

func TestPut_PostCommitPanicsNeverClaimNotCommitted(t *testing.T) {
	committed := &Settings{
		TenantID:               "00000000-0000-0000-0000-000000000001",
		QuietHoursPerRecipient: true,
		UpdatedAt:              time.Date(2026, 9, 7, 8, 0, 0, 1, time.UTC),
	}
	tests := []struct {
		name        string
		coordinator *fakeCapCache
		ips         IPAssignmentLister
		wantOutcome string
	}{
		{
			name:        "cap convergence panic retains committed fenced receipt",
			coordinator: &fakeCapCache{commitPanic: "cap convergence panic"},
			wantOutcome: sendingCapOutcomeCommittedFenced,
		},
		{
			name:        "IP projection panic retains committed receipt",
			coordinator: &fakeCapCache{},
			ips:         panickingIPLister{},
			wantOutcome: sendingCapOutcomeCommitted,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler := recoverAsJSON500(ProtectResponses(http.HandlerFunc((&Deps{
				Repo:     &fakeSettingsStore{putResult: committed},
				CapCache: test.coordinator,
				IPs:      test.ips,
			}).Put)))
			handler.ServeHTTP(response, sendingRequest(http.MethodPut, `{}`))

			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500; body=%s", response.Code, response.Body.String())
			}
			if got := response.Header().Get(sendingCapOutcomeHeader); got != test.wantOutcome {
				t.Fatalf("outcome = %q, want %q; headers=%#v", got, test.wantOutcome, response.Header())
			}
			if got := response.Header().Get(sendingCapOutcomeHeader); got == sendingCapOutcomeNotCommitted {
				t.Fatal("post-commit panic produced a false not-committed receipt")
			}
		})
	}
}

func TestPut_ReconcilesAmbiguousDatabaseCommitFromExactReceipt(t *testing.T) {
	cap := 100
	candidate := &Settings{
		TenantID:        "00000000-0000-0000-0000-000000000001",
		MaxSendsPerHour: &cap,
		UpdatedAt:       time.Date(2026, 8, 30, 12, 0, 0, 1, time.UTC),
	}
	store := &fakeSettingsStore{
		putResult: candidate,
		putErr: &commitAmbiguousError{
			Candidate: candidate,
			Cause:     errors.New("connection lost after COMMIT"),
		},
		receiptCommitted: true,
	}
	coordinator := &fakeCapCache{}
	w := httptest.NewRecorder()
	(&Deps{Repo: store, CapCache: coordinator}).Put(
		w, sendingRequest(http.MethodPut, `{"max_sends_per_hour":100}`),
	)
	if w.Code != http.StatusOK ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "committed" {
		t.Fatalf("reconciled committed response = %d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	if len(coordinator.commitTenantIDs) != 1 || len(coordinator.abortTenantIDs) != 0 {
		t.Fatalf("commit reconciliation commit=%v abort=%v",
			coordinator.commitTenantIDs, coordinator.abortTenantIDs)
	}
}

func TestPut_ReconcilesAmbiguousDatabaseRollbackFromAbsentReceipt(t *testing.T) {
	candidate := &Settings{
		TenantID:  "00000000-0000-0000-0000-000000000001",
		UpdatedAt: time.Date(2026, 8, 30, 12, 0, 0, 1, time.UTC),
	}
	store := &fakeSettingsStore{
		putResult: candidate,
		putErr: &commitAmbiguousError{
			Candidate: candidate,
			Cause:     errors.New("commit rejected"),
		},
		receiptCommitted: false,
	}
	coordinator := &fakeCapCache{}
	w := httptest.NewRecorder()
	(&Deps{Repo: store, CapCache: coordinator}).Put(w, sendingRequest(http.MethodPut, `{}`))
	if w.Code != http.StatusInternalServerError ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" {
		t.Fatalf("reconciled rollback response = %d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	if len(coordinator.abortTenantIDs) != 1 || len(coordinator.commitTenantIDs) != 0 {
		t.Fatalf("rollback reconciliation commit=%v abort=%v",
			coordinator.commitTenantIDs, coordinator.abortTenantIDs)
	}
}

func TestPut_LeavesFenceAndReportsUnknownWhenCommitReceiptUnreadable(t *testing.T) {
	candidate := &Settings{
		TenantID:  "00000000-0000-0000-0000-000000000001",
		UpdatedAt: time.Date(2026, 8, 30, 12, 0, 0, 1, time.UTC),
	}
	store := &fakeSettingsStore{
		putResult: candidate,
		putErr: &commitAmbiguousError{
			Candidate: candidate,
			Cause:     errors.New("connection lost after COMMIT"),
		},
		receiptErr: errors.New("receipt database unavailable"),
	}
	coordinator := &fakeCapCache{}
	w := httptest.NewRecorder()
	(&Deps{Repo: store, CapCache: coordinator}).Put(w, sendingRequest(http.MethodPut, `{}`))
	if w.Code != http.StatusServiceUnavailable ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "commit-outcome-unknown-conservatively-fenced" ||
		!strings.Contains(w.Body.String(), "sending_cap_commit_outcome_unknown") {
		t.Fatalf("unknown commit response = %d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	if len(coordinator.abortTenantIDs) != 0 || len(coordinator.commitTenantIDs) != 0 {
		t.Fatalf("unknown commit changed fence commit=%v abort=%v",
			coordinator.commitTenantIDs, coordinator.abortTenantIDs)
	}
}

func TestPut_RejectsMaxAboveSupportedBound(t *testing.T) {
	store := &fakeSettingsStore{}
	d := &Deps{Repo: store}
	r := sendingRequest(http.MethodPut, `{"max_sends_per_hour":1000001}`)
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "bad_max_sends") {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if store.putCalls != 0 {
		t.Fatalf("invalid cap reached repository: %d calls", store.putCalls)
	}
}

func TestProtectionHeadersPrecedeAuthorizationResponse(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/api/v1/settings/sending", nil)
	ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	})).ServeHTTP(w, r)
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" ||
		w.Header().Get("Expires") != "0" ||
		w.Header().Get("X-Postwave-Sending-Cap-Outcome") != "" {
		t.Fatalf("protection headers = %#v", w.Header())
	}

	overrideW := httptest.NewRecorder()
	overrideR := httptest.NewRequest(http.MethodPut, "/api/v1/settings/sending", nil)
	ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Postwave-Sending-Cap-Outcome", "committed-conservatively-fenced")
		w.WriteHeader(http.StatusServiceUnavailable)
	})).ServeHTTP(overrideW, overrideR)
	if got := overrideW.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != "committed-conservatively-fenced" {
		t.Fatalf("write-time protection clobbered handler outcome: %q", got)
	}

	clobberedW := httptest.NewRecorder()
	clobberedR := httptest.NewRequest(http.MethodPut, "/api/v1/settings/sending", nil)
	ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Postwave-Sending-Cap-Outcome", "success-ish")
		w.WriteHeader(http.StatusForbidden)
	})).ServeHTTP(clobberedW, clobberedR)
	if got := clobberedW.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != "success-ish" {
		t.Fatalf("privacy-only protection unexpectedly rewrote downstream outcome: %q", got)
	}

	panicW := httptest.NewRecorder()
	panicR := httptest.NewRequest(http.MethodPut, "/api/v1/settings/sending", nil)
	recoverAsJSON500(ProtectResponses(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("failure before any mutation outcome is known")
	}))).ServeHTTP(panicW, panicR)
	if panicW.Code != http.StatusInternalServerError ||
		panicW.Header().Get("X-Postwave-Sending-Cap-Outcome") != "" {
		t.Fatalf("pre-outcome panic manufactured a mutation receipt: status=%d headers=%#v",
			panicW.Code, panicW.Header())
	}

	otherW := httptest.NewRecorder()
	otherR := httptest.NewRequest(http.MethodGet, "/api/v1/settings/workspace", nil)
	ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})).ServeHTTP(otherW, otherR)
	if otherW.Header().Get("Cache-Control") != "" {
		t.Fatalf("unrelated route received sending cache policy: %#v", otherW.Header())
	}
}

func TestMutationReplayBypassIsPathExactAndBodyIndependent(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		want bool
	}{
		{name: "canonical", path: "/api/v1/settings/sending", want: true},
		{name: "trailing slash", path: "/api/v1/settings/sending/", want: false},
		{name: "status", path: "/api/v1/settings/sending/status", want: false},
		{name: "nearby", path: "/api/v1/settings/workspace", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPut, test.path, strings.NewReader(`{"ignored":true}`))
			if got := MutationGlobalReplayBypass(request, nil); got != test.want {
				t.Fatalf("nil-body bypass = %v, want %v", got, test.want)
			}
			if got := MutationGlobalReplayBypass(request, []byte(`different`)); got != test.want {
				t.Fatalf("body-bearing bypass = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPutForbidsEveryIdempotencyKeyBeforeTenantOrMutation(t *testing.T) {
	for _, values := range [][]string{{"sdk-auto-key"}, {""}, {"one", "two"}} {
		store := &fakeSettingsStore{}
		coordinator := &fakeCapCache{}
		request := httptest.NewRequest(http.MethodPut, "/api/v1/settings/sending", strings.NewReader(`{}`))
		for _, value := range values {
			request.Header.Add("Idempotency-Key", value)
		}
		response := httptest.NewRecorder()
		ProtectResponses(http.HandlerFunc((&Deps{
			Repo: store, CapCache: coordinator,
		}).Put)).ServeHTTP(response, request)

		if response.Code != http.StatusBadRequest ||
			!strings.Contains(response.Body.String(), `"code":"idempotency_forbidden"`) {
			t.Fatalf("values=%q response=%d %s", values, response.Code, response.Body.String())
		}
		if response.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" ||
			response.Header().Get("Cache-Control") != "private, no-store" ||
			response.Header().Get("Expires") != "0" {
			t.Fatalf("values=%q headers=%#v", values, response.Header())
		}
		if store.getCalls != 0 || store.putCalls != 0 ||
			len(coordinator.beginTenantIDs) != 0 || len(coordinator.commitTenantIDs) != 0 {
			t.Fatalf("values=%q reached mutation: get=%d put=%d begin=%v commit=%v",
				values, store.getCalls, store.putCalls,
				coordinator.beginTenantIDs, coordinator.commitTenantIDs)
		}
	}
}

func TestPutRejectsExplicitNullForEveryNonNullableInput(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantCode string
	}{
		{name: "expected revision", body: `{"expected_updated_at":null}`, wantCode: "bad_expected_updated_at"},
		{name: "quiet start", body: `{"quiet_hours_start":null}`, wantCode: "bad_start"},
		{name: "quiet end", body: `{"quiet_hours_end":null}`, wantCode: "bad_end"},
		{name: "quiet timezone", body: `{"quiet_hours_tz":null}`, wantCode: "bad_tz"},
		{name: "per-recipient flag", body: `{"quiet_hours_per_recipient":null}`, wantCode: "bad_json"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeSettingsStore{}
			coordinator := &fakeCapCache{}
			response := httptest.NewRecorder()
			(&Deps{Repo: store, CapCache: coordinator}).Put(
				response, sendingRequest(http.MethodPut, test.body),
			)

			if response.Code != http.StatusBadRequest ||
				!strings.Contains(response.Body.String(), `"code":"`+test.wantCode+`"`) {
				t.Fatalf("response=%d body=%s, want %s", response.Code, response.Body.String(), test.wantCode)
			}
			if got := response.Header().Get(sendingCapOutcomeHeader); got != sendingCapOutcomeNotCommitted {
				t.Fatalf("outcome=%q, want exact not-committed", got)
			}
			if store.putCalls != 0 || len(coordinator.beginTenantIDs) != 0 {
				t.Fatalf("explicit null crossed mutation boundary: writes=%d begin=%v",
					store.putCalls, coordinator.beginTenantIDs)
			}
		})
	}
}

func TestPutRejectsDuplicateMembersBeforeMutation(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "max cap", body: `{"max_sends_per_hour":100,"max_sends_per_hour":200}`},
		{name: "quiet start", body: `{"quiet_hours_start":"22:00","quiet_hours_start":"23:00"}`},
		{name: "quiet end", body: `{"quiet_hours_end":"06:00","quiet_hours_end":"07:00"}`},
		{name: "quiet timezone", body: `{"quiet_hours_tz":"UTC","quiet_hours_tz":"Etc/UTC"}`},
		{name: "per-recipient flag", body: `{"quiet_hours_per_recipient":true,"quiet_hours_per_recipient":false}`},
		{name: "legacy fallback", body: `{"fallback_hour_utc":9,"fallback_hour_utc":10}`},
		{name: "expected revision", body: `{"expected_updated_at":"","expected_updated_at":"2026-09-07T08:00:00Z"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeSettingsStore{}
			coordinator := &fakeCapCache{}
			response := httptest.NewRecorder()
			(&Deps{Repo: store, CapCache: coordinator}).Put(
				response, sendingRequest(http.MethodPut, test.body),
			)

			if response.Code != http.StatusBadRequest ||
				!strings.Contains(response.Body.String(), `"code":"bad_json"`) ||
				!strings.Contains(response.Body.String(), "duplicate fields") {
				t.Fatalf("response=%d body=%s, want duplicate-field bad_json", response.Code, response.Body.String())
			}
			if got := response.Header().Get(sendingCapOutcomeHeader); got != sendingCapOutcomeNotCommitted {
				t.Fatalf("outcome=%q, want exact not-committed", got)
			}
			if store.putCalls != 0 || len(coordinator.beginTenantIDs) != 0 {
				t.Fatalf("duplicate field crossed mutation boundary: writes=%d begin=%v",
					store.putCalls, coordinator.beginTenantIDs)
			}
		})
	}
}

func TestMountedPutRejectsIdempotencyKeyWithCanonicalPrivateContract(t *testing.T) {
	store := &fakeSettingsStore{}
	router := chi.NewRouter()
	(&Deps{Repo: store, CapCache: &fakeCapCache{}}).MountRoutes(router)
	request := sendingRequest(http.MethodPut, `{}`)
	request.Header.Set("Idempotency-Key", "sdk-auto-key")
	user, _ := middleware.UserFromContext(request.Context())
	user.Role = "admin"
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), `"code":"idempotency_forbidden"`) ||
		response.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" ||
		response.Header().Get("Cache-Control") != "private, no-store" ||
		response.Header().Get("Expires") != "0" {
		t.Fatalf("response=%d headers=%#v body=%s", response.Code, response.Header(), response.Body.String())
	}
	if store.putCalls != 0 {
		t.Fatalf("forbidden keyed request reached repository: %d calls", store.putCalls)
	}
}

func TestMountRoutesRequiresAdminForSendingSettingsReads(t *testing.T) {
	paths := []string{
		"/api/v1/settings/sending",
		"/api/v1/settings/sending/status",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			store := &fakeSettingsStore{getResult: &Settings{
				TenantID:               "00000000-0000-0000-0000-000000000001",
				QuietHoursPerRecipient: true,
			}}
			router := chi.NewRouter()
			(&Deps{Repo: store}).MountRoutes(router)

			r := httptest.NewRequest(http.MethodGet, path, nil)
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
				ID: "00000000-0000-0000-0000-000000000001",
			})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID:            "00000000-0000-0000-0000-000000000002",
				TenantID:      "00000000-0000-0000-0000-000000000001",
				Role:          "viewer",
				EffectiveRole: "viewer",
			})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r.WithContext(ctx))

			if w.Code != http.StatusForbidden ||
				!strings.Contains(w.Body.String(), "insufficient_role") {
				t.Fatalf("response = %d %s", w.Code, w.Body.String())
			}
			if store.getCalls != 0 {
				t.Fatalf("viewer denial reached settings store: %d reads", store.getCalls)
			}
			if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") ||
				w.Header().Get("Pragma") != "no-cache" ||
				w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("protected denial headers = %#v", w.Header())
			}
		})
	}
}

func TestMountRoutesAllowsAdminSendingSettingsReads(t *testing.T) {
	paths := []string{
		"/api/v1/settings/sending",
		"/api/v1/settings/sending/status",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			store := &fakeSettingsStore{getResult: &Settings{
				TenantID:               "00000000-0000-0000-0000-000000000001",
				QuietHoursPerRecipient: true,
			}}
			router := chi.NewRouter()
			(&Deps{Repo: store}).MountRoutes(router)

			r := httptest.NewRequest(http.MethodGet, path, nil)
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
				ID: "00000000-0000-0000-0000-000000000001",
			})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID:       "00000000-0000-0000-0000-000000000002",
				TenantID: "00000000-0000-0000-0000-000000000001",
				Role:     "admin",
			})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r.WithContext(ctx))

			if w.Code != http.StatusOK {
				t.Fatalf("response = %d %s", w.Code, w.Body.String())
			}
			if store.getCalls != 1 {
				t.Fatalf("admin read reached settings store %d times, want 1", store.getCalls)
			}
			if w.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("Cache-Control = %q", w.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestMountRoutesRejectsDelegatedSendingSettingsAdminAuthority(t *testing.T) {
	previousResolver := apikeys.StoredScopeResolver
	apikeys.StoredScopeResolver = func(context.Context, string, string) ([]apikeys.Scope, error) {
		return []apikeys.Scope{apikeys.ScopeAdmin}, nil
	}
	t.Cleanup(func() { apikeys.StoredScopeResolver = previousResolver })

	routes := []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/settings/sending"},
		{method: http.MethodGet, path: "/api/v1/settings/sending/status"},
		{method: http.MethodPut, path: "/api/v1/settings/sending"},
	}
	principals := []struct {
		name string
		bind func(context.Context) context.Context
	}{
		{
			name: "custom role with stored admin grant",
			bind: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{
					ID:            "00000000-0000-0000-0000-000000000002",
					TenantID:      "00000000-0000-0000-0000-000000000001",
					Role:          "custom-operator",
					EffectiveRole: "custom-operator",
				})
			},
		},
		{
			name: "admin viewing as custom role",
			bind: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{
					ID:            "00000000-0000-0000-0000-000000000002",
					TenantID:      "00000000-0000-0000-0000-000000000001",
					Role:          "admin",
					EffectiveRole: "custom-operator",
				})
			},
		},
		{
			name: "non-admin API key",
			bind: func(ctx context.Context) context.Context {
				ctx = middleware.WithAPIKeyAuth(ctx)
				return apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
			},
		},
	}

	for _, route := range routes {
		for _, principal := range principals {
			t.Run(principal.name+" "+route.method+" "+route.path, func(t *testing.T) {
				store := &fakeSettingsStore{}
				router := chi.NewRouter()
				(&Deps{Repo: store}).MountRoutes(router)
				request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
				ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{
					ID: "00000000-0000-0000-0000-000000000001",
				})
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request.WithContext(principal.bind(ctx)))

				if response.Code != http.StatusForbidden {
					t.Fatalf("response = %d %s", response.Code, response.Body.String())
				}
				if store.getCalls != 0 || store.putCalls != 0 {
					t.Fatalf("delegated denial reached store: get=%d put=%d", store.getCalls, store.putCalls)
				}
				if response.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
				}
			})
		}
	}
}

func TestMountRoutesAllowsAdminScopedAPIKeyForSendingSettings(t *testing.T) {
	store := &fakeSettingsStore{getResult: &Settings{
		TenantID: "00000000-0000-0000-0000-000000000001", QuietHoursPerRecipient: true,
	}}
	router := chi.NewRouter()
	(&Deps{Repo: store}).MountRoutes(router)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/settings/sending", nil)
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000001",
	})
	ctx = middleware.WithAPIKeyAuth(ctx)
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))

	if response.Code != http.StatusOK || store.getCalls != 1 {
		t.Fatalf("response=%d body=%s get=%d", response.Code, response.Body.String(), store.getCalls)
	}
}

func TestStatus_ExplicitlyMarksCounterUnavailable(t *testing.T) {
	cap := 2500
	store := &fakeSettingsStore{getResult: &Settings{
		TenantID:               "00000000-0000-0000-0000-000000000001",
		MaxSendsPerHour:        &cap,
		QuietHoursPerRecipient: true,
	}}
	d := &Deps{Repo: store}
	r := sendingRequest(http.MethodGet, "")
	w := httptest.NewRecorder()
	d.Status(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["counter_authoritative"] != false || body["counter_source"] != "unavailable" ||
		body["counter_scope"] != "unavailable" {
		t.Fatalf("counter authority = %#v", body)
	}
	if body["tenant_id"] != "00000000-0000-0000-0000-000000000001" ||
		body["cap_coordination_state"] != sending.CapCoordinationStateDown ||
		body["cap_coordination_ready"] != false ||
		body["cap_coordination_matches_settings"] != false {
		t.Fatalf("cap authority ownership/status = %#v", body)
	}
	for _, forbidden := range []string{"bucket_count", "window_start", "window_resets_at"} {
		if _, ok := body[forbidden]; ok {
			t.Fatalf("non-authoritative status exposed %q: %#v", forbidden, body)
		}
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("Cache-Control = %q", w.Header().Get("Cache-Control"))
	}
}

func TestStatus_BindsTenantAndReturnsAuthoritativeReadyCap(t *testing.T) {
	cap := 2500
	store := &fakeSettingsStore{getResult: &Settings{
		TenantID:        "00000000-0000-0000-0000-000000000099",
		MaxSendsPerHour: &cap,
	}}
	cache := &fakeCapCache{inspectStatus: sending.CapCoordinationStatus{
		State: sending.CapCoordinationStateReady, HasCap: true, Cap: cap,
	}}
	d := &Deps{Repo: store, CapCache: cache}
	r := sendingRequest(http.MethodGet, "")
	w := httptest.NewRecorder()
	d.Status(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var body Status
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	requestTenant := "00000000-0000-0000-0000-000000000001"
	if body.TenantID != requestTenant || body.CapCoordinationState != sending.CapCoordinationStateReady ||
		!body.CapCoordinationReady || !body.CapCoordinationMatchesSettings ||
		body.CapCoordinationCap == nil || *body.CapCoordinationCap != cap {
		t.Fatalf("authoritative status = %+v", body)
	}
	if len(cache.inspectTenantIDs) != 1 || cache.inspectTenantIDs[0] != requestTenant {
		t.Fatalf("inspection tenants = %#v", cache.inspectTenantIDs)
	}
}

func TestApplyCapCoordinationStatusRequiresExplicitReadyMatchingValue(t *testing.T) {
	capFive := 5
	capSix := 6
	started := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		durable     *int
		shared      sending.CapCoordinationStatus
		wantState   string
		wantReady   bool
		wantMatch   bool
		wantCap     *int
		wantStarted bool
	}{
		{
			name: "capped ready match", durable: &capFive,
			shared:    sending.CapCoordinationStatus{State: sending.CapCoordinationStateReady, HasCap: true, Cap: 5},
			wantState: sending.CapCoordinationStateReady,
			wantReady: true, wantMatch: true, wantCap: &capFive,
		},
		{
			name: "explicit uncapped ready match", durable: nil,
			shared:    sending.CapCoordinationStatus{State: sending.CapCoordinationStateReady},
			wantState: sending.CapCoordinationStateReady,
			wantReady: true, wantMatch: true,
		},
		{
			name: "ready mismatch", durable: &capFive,
			shared:    sending.CapCoordinationStatus{State: sending.CapCoordinationStateReady, HasCap: true, Cap: 6},
			wantState: sending.CapCoordinationStateReady,
			wantReady: true, wantMatch: false, wantCap: &capSix,
		},
		{
			name: "fence never proves recovery", durable: &capFive,
			shared: sending.CapCoordinationStatus{
				State: sending.CapCoordinationStateFenced, HasCap: true, Cap: 5, FenceStartedAt: &started,
			},
			wantState: sending.CapCoordinationStateFenced,
			wantReady: false, wantMatch: false, wantCap: &capFive, wantStarted: true,
		},
		{
			name: "unavailable never proves recovery", durable: nil,
			shared:    sending.CapCoordinationStatus{State: sending.CapCoordinationStateDown},
			wantState: sending.CapCoordinationStateDown,
			wantReady: false, wantMatch: false,
		},
		{
			name: "unknown state fails closed", durable: &capFive,
			shared:    sending.CapCoordinationStatus{State: "backend_bug", HasCap: true, Cap: 5},
			wantState: sending.CapCoordinationStateDown,
			wantReady: false, wantMatch: false,
		},
		{
			name: "invalid ready cap shape fails closed", durable: &capFive,
			shared:    sending.CapCoordinationStatus{State: sending.CapCoordinationStateReady, Cap: 5},
			wantState: sending.CapCoordinationStateDown,
			wantReady: false, wantMatch: false,
		},
		{
			name: "ready state cannot carry a fence", durable: nil,
			shared: sending.CapCoordinationStatus{
				State: sending.CapCoordinationStateReady, FenceStartedAt: &started,
			},
			wantState: sending.CapCoordinationStateDown,
			wantReady: false, wantMatch: false,
		},
		{
			name: "fenced state requires start time", durable: &capFive,
			shared: sending.CapCoordinationStatus{
				State: sending.CapCoordinationStateFenced, HasCap: true, Cap: 5,
			},
			wantState: sending.CapCoordinationStateDown,
			wantReady: false, wantMatch: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			out := Status{}
			applyCapCoordinationStatus(&out, test.durable, test.shared)
			if out.CapCoordinationState != test.wantState ||
				out.CapCoordinationReady != test.wantReady ||
				out.CapCoordinationMatchesSettings != test.wantMatch ||
				(out.CapCoordinationFenceStartedAt != nil) != test.wantStarted {
				t.Fatalf("status = %+v", out)
			}
			if test.wantCap == nil {
				if out.CapCoordinationCap != nil {
					t.Fatalf("cap = %v, want absent", *out.CapCoordinationCap)
				}
			} else if out.CapCoordinationCap == nil || *out.CapCoordinationCap != *test.wantCap {
				t.Fatalf("cap = %v, want %d", out.CapCoordinationCap, *test.wantCap)
			}
		})
	}
}

func TestRepoUpsert_RejectsOutOfRangeBeforeDatabase(t *testing.T) {
	tooHigh := MaxSendsPerHour + 1
	_, _, err := (&Repo{}).Upsert(context.Background(), Settings{
		TenantID:        "00000000-0000-0000-0000-000000000001",
		MaxSendsPerHour: &tooHigh,
	}, UpsertOptions{})
	if !errors.Is(err, ErrInvalidMaxSends) {
		t.Fatalf("err = %v, want ErrInvalidMaxSends", err)
	}
}

func TestPut_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestPut_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending", strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestPut_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending",
		strings.NewReader(`{"quiet_hours_tz":"`+strings.Repeat("x", int(sendingSettingsJSONMaxBodyBytes))+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Errorf("body = %q, want payload_too_large", w.Body.String())
	}
}

func TestPut_RejectsBadTZ(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending",
		strings.NewReader(`{"quiet_hours_tz":"Mars/Olympus"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_tz") {
		t.Errorf("body = %q, want bad_tz", w.Body.String())
	}
}

func TestPut_RejectsBrowserIncompatibleTimeZonesBeforeStore(t *testing.T) {
	tests := []struct {
		name     string
		timezone string
	}{
		{name: "process-local alias", timezone: "Local"},
		{name: "over desktop decoder bound", timezone: strings.Repeat("A", maxSendingTimeZoneLength+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeSettingsStore{}
			d := &Deps{Repo: store, CapCache: &fakeCapCache{}}
			r := sendingRequest(http.MethodPut,
				`{"quiet_hours_tz":`+strconv.Quote(test.timezone)+`}`)
			w := httptest.NewRecorder()
			d.Put(w, r)

			if w.Code != http.StatusBadRequest ||
				!strings.Contains(w.Body.String(), "bad_tz") {
				t.Fatalf("response = %d %s", w.Code, w.Body.String())
			}
			if store.putCalls != 0 {
				t.Fatalf("invalid timezone reached store: %d writes", store.putCalls)
			}
		})
	}
}

func TestPut_AcceptsPortableTimeZones(t *testing.T) {
	for _, timezone := range []string{"UTC", "America/New_York"} {
		t.Run(timezone, func(t *testing.T) {
			store := &fakeSettingsStore{putResult: &Settings{
				TenantID:               "00000000-0000-0000-0000-000000000001",
				QuietHoursStart:        "22:00",
				QuietHoursEnd:          "07:00",
				QuietHoursTZ:           timezone,
				QuietHoursPerRecipient: true,
			}}
			d := &Deps{Repo: store, CapCache: &fakeCapCache{}}
			r := sendingRequest(http.MethodPut,
				`{"quiet_hours_start":"22:00","quiet_hours_end":"07:00","quiet_hours_tz":`+
					strconv.Quote(timezone)+`}`)
			w := httptest.NewRecorder()
			d.Put(w, r)

			if w.Code != http.StatusOK {
				t.Fatalf("response = %d %s", w.Code, w.Body.String())
			}
			if store.putCalls != 1 || store.settings.QuietHoursTZ != timezone {
				t.Fatalf("stored timezone = %q, writes = %d", store.settings.QuietHoursTZ, store.putCalls)
			}
		})
	}
}

func TestPut_RejectsBadStart(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending",
		strings.NewReader(`{"quiet_hours_start":"99:00"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_start") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestPut_RejectsBadEnd(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/sending",
		strings.NewReader(`{"quiet_hours_end":"25:99"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Put(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_end") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestGet_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/settings/sending", nil)
	w := httptest.NewRecorder()
	d.Get(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}
