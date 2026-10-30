package campaigns

// Tests for AudienceEmails segment-aware filtering and the
// renumberPlaceholders helper.
//
// The pure helpers (renumberPlaceholders) run unconditionally; the
// SQL-level cases require DATABASE_URL and skip silently otherwise to
// match the rest of this package's test suite.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// TestRenumberPlaceholders covers the offset rewrite that lets us splice
// a compiled segment fragment (which starts at $1) into a query that
// already binds tenant_id at $1.
func TestRenumberPlaceholders(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		offset int
		want   string
	}{
		{"no offset", "subscribers.email = $1", 0, "subscribers.email = $1"},
		{"single offset", "subscribers.email = $1", 1, "subscribers.email = $2"},
		{"multi placeholder", "a = $1 AND b = $2 OR c = $3", 2, "a = $3 AND b = $4 OR c = $5"},
		{"two-digit", "x IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", 5,
			"x IN ($6,$7,$8,$9,$10,$11,$12,$13,$14,$15)"},
		{"no placeholders", "TRUE", 3, "TRUE"},
	}
	for _, tc := range cases {
		got := renumberPlaceholders(tc.in, tc.offset)
		if got != tc.want {
			t.Errorf("%s: renumber(%q, %d) = %q, want %q", tc.name, tc.in, tc.offset, got, tc.want)
		}
	}
}

func TestFrequencyQueueFilterFailsClosed(t *testing.T) {
	sentinel := errors.New("frequency database unavailable")
	d := &Deps{Frequency: func(context.Context, string, string, []string) ([]string, int, []FrequencySkipBreakdown, error) {
		return nil, 0, nil, sentinel
	}}
	kept, skipped, breakdown, qerr := d.filterFrequencyAudience(
		context.Background(), "tenant-1", "email", []string{"a@example.test"},
	)
	if kept != nil || skipped != 0 || breakdown != nil {
		t.Fatalf("failed filter leaked result: kept=%v skipped=%d breakdown=%v", kept, skipped, breakdown)
	}
	if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" || !errors.Is(qerr.Err, sentinel) {
		t.Fatalf("queue error = %#v, want typed fail-closed 503", qerr)
	}
}

func TestControlGroupFilterFailsClosedOnUnavailableOrInvalidMembership(t *testing.T) {
	before := []string{"a@example.test", "b@example.test"}
	sentinel := errors.New("control group store unavailable")
	for _, tc := range []struct {
		name   string
		filter ControlGroupFilter
	}{
		{"store failure", func(context.Context, string, []string) ([]string, int, error) {
			return nil, 0, sentinel
		}},
		{"injected address", func(context.Context, string, []string) ([]string, int, error) {
			return []string{"c@example.test"}, 1, nil
		}},
		{"unaccounted exclusion", func(context.Context, string, []string) ([]string, int, error) {
			return []string{"a@example.test"}, 0, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{ControlGroups: tc.filter}
			kept, excluded, qerr := d.filterControlGroup(context.Background(), "tenant-1", before)
			if kept != nil || excluded != 0 || qerr == nil ||
				qerr.Status != http.StatusServiceUnavailable || qerr.Code != "control_group_unavailable" {
				t.Fatalf("filter result = (%v, %d, %#v), want fail-closed 503", kept, excluded, qerr)
			}
		})
	}
	d := &Deps{ControlGroups: func(context.Context, string, []string) ([]string, int, error) {
		return []string{"b@example.test"}, 1, nil
	}}
	kept, excluded, qerr := d.filterControlGroup(context.Background(), "tenant-1", before)
	if qerr != nil || excluded != 1 || len(kept) != 1 || kept[0] != "b@example.test" {
		t.Fatalf("valid holdout was rejected: (%v, %d, %#v)", kept, excluded, qerr)
	}
}

func TestFrequencyQueueFilterFailsClosedWhenUnconfigured(t *testing.T) {
	d := &Deps{}
	kept, skipped, breakdown, qerr := d.filterFrequencyAudience(
		context.Background(), "tenant-1", "email", []string{"a@example.test"},
	)
	if kept != nil || skipped != 0 || breakdown != nil {
		t.Fatalf("missing filter leaked result: kept=%v skipped=%d breakdown=%v", kept, skipped, breakdown)
	}
	if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" {
		t.Fatalf("queue error = %#v, want typed fail-closed 503", qerr)
	}
}

func TestFrequencyCapUnavailableIsPublicTypedPolicyError(t *testing.T) {
	if !isPublicQueuePolicyError("frequency_cap_unavailable") {
		t.Fatal("frequency_cap_unavailable must retain its typed HTTP 503 envelope")
	}
	if !isPublicQueuePolicyError("intelligent_retry_unavailable") {
		t.Fatal("intelligent_retry_unavailable must retain its typed post-commit HTTP 503 envelope")
	}
}

func TestFrequencyQueueFilterRejectsInconsistentResults(t *testing.T) {
	candidates := []string{"a@example.test", "b@example.test"}
	for _, tc := range []struct {
		name    string
		kept    []string
		skipped int
	}{
		{name: "injected recipient", kept: []string{"attacker@example.test"}, skipped: 1},
		{name: "reordered recipients", kept: []string{"b@example.test", "a@example.test"}, skipped: 0},
		{name: "unaccounted removal", kept: []string{"a@example.test"}, skipped: 0},
		{name: "negative count", kept: candidates, skipped: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{Frequency: func(context.Context, string, string, []string) ([]string, int, []FrequencySkipBreakdown, error) {
				return tc.kept, tc.skipped, nil, nil
			}}
			_, _, _, qerr := d.filterFrequencyAudience(context.Background(), "tenant-1", "email", candidates)
			if qerr == nil || qerr.Status != http.StatusServiceUnavailable || qerr.Code != "frequency_cap_unavailable" {
				t.Fatalf("queue error = %#v, want invalid-result refusal", qerr)
			}
		})
	}
}

func TestFrequencyQueueFilterAcceptsOrderPreservingSubset(t *testing.T) {
	candidates := []string{"a@example.test", "b@example.test", "c@example.test"}
	want := []string{"a@example.test", "c@example.test"}
	wantBreakdown := []FrequencySkipBreakdown{{RuleID: "rule-1", RuleLabel: "Daily", Skipped: 1}}
	d := &Deps{Frequency: func(context.Context, string, string, []string) ([]string, int, []FrequencySkipBreakdown, error) {
		return want, 1, wantBreakdown, nil
	}}
	kept, skipped, breakdown, qerr := d.filterFrequencyAudience(context.Background(), "tenant-1", "email", candidates)
	if qerr != nil || !equalStringSlice(kept, want) || skipped != 1 || len(breakdown) != 1 || breakdown[0] != wantBreakdown[0] {
		t.Fatalf("filter result kept=%v skipped=%d breakdown=%v err=%v", kept, skipped, breakdown, qerr)
	}
}

// TestAudienceEmails_EmptyTenant verifies the early-rejection guard so
// callers don't accidentally fan out to the global subscriber set.
func TestAudienceEmails_EmptyTenant(t *testing.T) {
	repo := &Repo{Pool: nil}
	_, err := repo.AudienceEmails(context.Background(), "", "")
	if err == nil {
		t.Fatal("AudienceEmails(\"\"): want error, got nil")
	}
}

// --- DB-backed cases below --------------------------------------------

// TestAudienceEmails_NoSegmentReturnsAllEnabled inserts 3 enabled and 1
// disabled subscriber and asserts AudienceEmails returns the 3 enabled
// addresses when no segment is supplied.
func TestAudienceEmails_NoSegmentReturnsAllEnabled(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-noseg")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "alice@example.com", status: "enabled"},
		{email: "bob@example.com", status: "enabled"},
		{email: "carol@example.com", status: "enabled"},
		{email: "dan@example.com", status: "disabled"},
	})

	got, err := repo.AudienceEmails(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	sort.Strings(got)
	want := []string{"alice@example.com", "bob@example.com", "carol@example.com"}
	if !equalStringSlice(got, want) {
		t.Fatalf("AudienceEmails got %v, want %v", got, want)
	}
}

// Archived profiles are retained for auditability but are never activation
// candidates. This protects both live audience enumeration and the shared
// static-freeze builder from re-targeting a reversibly hidden person.
func TestAudienceEmails_ExcludesArchivedEnabledSubscriber(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-archived")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "active@example.test", status: "enabled"},
		{email: "archived@example.test", status: "enabled"},
	})
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("archive fixture scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET archived_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND email = 'archived@example.test'::citext`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("archive fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit archive fixture: %v", err)
	}

	got, err := repo.AudienceEmails(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	if want := []string{"active@example.test"}; !equalStringSlice(got, want) {
		t.Fatalf("AudienceEmails got %v, want %v", got, want)
	}
}

// TestAudienceEmails_ExcludesNonEmailConsent (SUB-051) inserts two
// enabled subscribers — one with email-marketing consent, one without —
// and asserts AudienceEmails returns ONLY the consented address. This is
// the activation-time channel-consent gate: a profile whose
// consent_email_marketing_at is NULL (never granted, or revoked via a
// GPC / opt-out consent_events row) must not be selected at send time,
// even with no segment filter.
func TestAudienceEmails_ExcludesNonEmailConsent(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-consent")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "consented@example.com", status: "enabled"},
		{email: "optedout@example.com", status: "enabled", noEmailConsent: true},
	})

	got, err := repo.AudienceEmails(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	sort.Strings(got)
	want := []string{"consented@example.com"}
	if !equalStringSlice(got, want) {
		t.Fatalf("AudienceEmails got %v, want %v (opted-out profile must be excluded)", got, want)
	}
}

// TestAudienceEmails_RequiresExactCanonicalAddressConsent proves the queue
// gate is address-specific, not just profile-specific. A legacy subscriber
// projection is necessary for every fixture below, but only the exact
// canonical delivery address may enter the audience, and only while that
// address is independently subscribed and unsuppressed. CITEXT identity is
// intentionally case-insensitive; a genuinely different address is denied.
func TestAudienceEmails_RequiresExactCanonicalAddressConsent(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-address-consent")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "positive@example.test", status: "enabled"},
		{
			email:        "Case-Match@Example.Test",
			status:       "enabled",
			addressEmail: "case-match@example.test",
		},
		{
			email:                 "missing@example.test",
			status:                "enabled",
			omitAddressProjection: true,
		},
		{
			email:                "legacy-missing@example.test",
			status:               "enabled",
			noEmailConsent:       true,
			addressConsentStatus: "subscribed",
		},
		{
			email:        "mismatch@example.test",
			status:       "enabled",
			addressEmail: "different@example.test",
		},
		{
			email:                "never@example.test",
			status:               "enabled",
			addressConsentStatus: "never_subscribed",
		},
		{
			email:                "unsubscribed@example.test",
			status:               "enabled",
			addressConsentStatus: "unsubscribed",
		},
		{
			email:             "suppressed@example.test",
			status:            "enabled",
			addressSuppressed: true,
		},
	})

	got, err := repo.AudienceEmails(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	sort.Strings(got)
	want := []string{"Case-Match@Example.Test", "positive@example.test"}
	if !equalStringSlice(got, want) {
		t.Fatalf("AudienceEmails got %v, want exact-address eligible %v", got, want)
	}
}

// TestAudienceEmails_WithSegmentFilter inserts subscribers with mixed
// emails and asserts the segment predicate narrows the result.
func TestAudienceEmails_WithSegmentFilter(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-seg")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "alice@example.com", status: "enabled"},
		{email: "bob@example.com", status: "enabled"},
		{email: "carol@other.com", status: "enabled"},
	})

	// Segment: email contains "example.com"
	ast := `{"op":"condition","field":"email","comparator":"contains","value":"example.com"}`
	segID := insertSegmentQ(t, pool, ctx, tenantID, "example-only", ast)

	got, err := repo.AudienceEmails(ctx, tenantID, segID)
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	sort.Strings(got)
	want := []string{"alice@example.com", "bob@example.com"}
	if !equalStringSlice(got, want) {
		t.Fatalf("AudienceEmails got %v, want %v", got, want)
	}
}

// TestAudienceEmails_SegmentNotFound surfaces ErrSegmentNotFound (not a
// generic SQL error) when the segment id doesn't exist for the tenant.
// This protects the handler's 422 mapping in QueueCampaign.
func TestAudienceEmails_SegmentNotFound(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-missing")
	_, err := repo.AudienceEmails(ctx, tenantID, "00000000-0000-0000-0000-deadbeef0001")
	if !errors.Is(err, ErrSegmentNotFound) {
		t.Fatalf("AudienceEmails missing segment: want ErrSegmentNotFound, got %v", err)
	}
}

// TestAudienceEmails_SegmentTenantIsolation creates a segment in tenant
// A and asserts tenant B can't observe it. This guards against the
// segment lookup leaking across tenants.
func TestAudienceEmails_SegmentTenantIsolation(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantA := setupTenantQ(t, pool, ctx, "queue-iso-a")
	tenantB := setupTenantQ(t, pool, ctx, "queue-iso-b")
	ast := `{"op":"condition","field":"email","comparator":"contains","value":"example.com"}`
	segID := insertSegmentQ(t, pool, ctx, tenantA, "iso-test", ast)

	// Querying tenantB with tenantA's segmentID must not find it.
	_, err := repo.AudienceEmails(ctx, tenantB, segID)
	if !errors.Is(err, ErrSegmentNotFound) {
		t.Fatalf("cross-tenant segment lookup: want ErrSegmentNotFound, got %v", err)
	}
}

func TestListAudienceEmails_MembersOnlyAndTenantIsolation(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	tenantA := setupTenantQ(t, pool, ctx, "queue-list-a")
	tenantB := setupTenantQ(t, pool, ctx, "queue-list-b")
	insertSubscribersQ(t, pool, ctx, tenantA, []subQ{
		{email: "member@example.test", status: "enabled"},
		{email: "outsider@example.test", status: "enabled"},
	})
	insertSubscribersQ(t, pool, ctx, tenantB, []subQ{
		{email: "tenant-b-workspace@example.test", status: "enabled"},
	})
	listUUID := insertListIdentityQ(t, pool, ctx, tenantA, 820001)
	addListMemberQ(t, pool, ctx, tenantA, listUUID, 820001, "member@example.test")

	for _, listID := range []string{"820001", listUUID} {
		got, err := repo.ListAudienceEmails(ctx, tenantA, listID)
		if err != nil {
			t.Fatalf("ListAudienceEmails(%q): %v", listID, err)
		}
		if want := []string{"member@example.test"}; !equalStringSlice(got, want) {
			t.Fatalf("ListAudienceEmails(%q) = %v, want %v", listID, got, want)
		}
	}

	if _, err := repo.ListAudienceEmails(ctx, tenantB, "820001"); !errors.Is(err, ErrAudienceListNotFound) {
		t.Fatalf("foreign list lookup: want ErrAudienceListNotFound, got %v", err)
	}
	if _, err := repo.ListAudienceEmails(ctx, tenantA, "999999999999"); !errors.Is(err, ErrAudienceListNotFound) {
		t.Fatalf("missing list lookup: want ErrAudienceListNotFound, got %v", err)
	}

	// Prove the live queue does not reinterpret tenant A's missing-in-B list
	// reference as tenant B's blank-segment workspace audience.
	foreignCampaignID := insertQueueableCampaignQ(t, pool, ctx, tenantB, "foreign list must fail closed")
	setCampaignAudienceQ(t, pool, ctx, tenantB, foreignCampaignID, "820001", "")
	enableEmailComplianceQ(t, pool, ctx, tenantB, foreignCampaignID, "sender@example.test")
	_, err := (&Deps{Repo: repo, LiveDispatch: dispatchcontrol.StaticGate{Enabled: true}}).
		queueCampaignCore(ctx, tenantB, foreignCampaignID, queueCampaignOptions{})
	var queueErr *queueError
	if !errors.As(err, &queueErr) || queueErr.Code != "list_not_found" {
		t.Fatalf("foreign-list queue error = %v, want list_not_found", err)
	}
	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantB, foreignCampaignID)
	if len(recipients) != 0 || status != StatusDraft {
		t.Fatalf("foreign-list fallback queued=%v status=%q, want none and draft", recipients, status)
	}
}

func TestListAudiencePreviewAndQueueUseSameContainedPopulation(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-list-preview-parity")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "member@example.test", status: "enabled"},
		{email: "suppressed-member@example.test", status: "enabled"},
		{email: "workspace-outsider@example.test", status: "enabled"},
	})
	listUUID := insertListIdentityQ(t, pool, ctx, tenantID, 820002)
	addListMemberQ(t, pool, ctx, tenantID, listUUID, 820002, "member@example.test")
	addListMemberQ(t, pool, ctx, tenantID, listUUID, 820002, "suppressed-member@example.test")
	insertUnifiedSuppressionQ(t, pool, ctx, tenantID, "suppressed-member@example.test")

	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "list preview queue parity")
	setCampaignAudienceQ(t, pool, ctx, tenantID, campaignID, "820002", "")
	enableEmailComplianceQ(t, pool, ctx, tenantID, campaignID, "sender@example.test")

	repo := &Repo{Pool: pool}
	suppressionStore := &suppressions.Store{Pool: pool}
	base := &Deps{
		Repo: repo, Suppressions: suppressionStore, LiveDispatch: dispatchcontrol.StaticGate{Enabled: true},
		Frequency: func(ctx context.Context, tenantID, channel string, candidates []string) ([]string, int, []FrequencySkipBreakdown, error) {
			result, err := frequency.FilterAudienceForChannel(ctx, pool, tenantID, channel, candidates)
			return result.Kept, result.Skipped, nil, err
		},
		SubscriberPreference: func(ctx context.Context, tenantID string, candidates []string) ([]string, int, error) {
			result, err := frequency.FilterBySubscriberPreference(ctx, pool, tenantID, candidates)
			return result.Kept, result.Skipped, err
		},
	}
	campaign, err := repo.Get(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("load campaign for checklist: %v", err)
	}
	check := repo.checkRecipients(ctx, tenantID, campaign)
	if check.Status != CheckPass || check.Detail != "2 eligible recipients" {
		t.Fatalf("checklist recipient gate = %+v, want pass with 2 activation-eligible recipients", check)
	}
	handler := &sendPreviewHandler{
		Base: base,
		Deps: &SendPreviewDeps{Repo: repo, Suppressions: suppressionStore},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/campaigns/"+campaignID+"/send-preview", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", campaignID)
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeCtx))
	request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: tenantID}))
	handler.handle(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("preview status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	var preview SendPreviewResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v; body=%s", err, recorder.Body.String())
	}
	if preview.AudienceKind != string(CampaignAudienceList) || preview.Recipients != 2 ||
		preview.SuppressedExcluded != 1 || preview.Deliverable != 1 {
		t.Fatalf("preview = %+v, want list recipients=2 suppressed=1 deliverable=1", preview)
	}

	out, err := base.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{})
	if err != nil {
		t.Fatalf("queueCampaignCore: %v", err)
	}
	if int64(out.Response.RecipientsQueued) != preview.Deliverable {
		t.Fatalf("queue recipients=%d preview deliverable=%d", out.Response.RecipientsQueued, preview.Deliverable)
	}
	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantID, campaignID)
	if want := []string{"member@example.test"}; !equalStringSlice(recipients, want) {
		t.Fatalf("queued recipients = %v, want %v (workspace outsider must be excluded)", recipients, want)
	}
	if status != StatusSending {
		t.Fatalf("campaign status = %q, want %q", status, StatusSending)
	}
}

func TestQueueDoesNotProceedWhenSandboxAuthorityPersistenceFails(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-sandbox-authority-failure")
	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "sandbox authority failure")
	probe := &sandboxAuthorityProbe{setErr: errors.New("authority store unavailable")}
	deps := &Deps{
		Repo:             &Repo{Pool: pool},
		Sandbox:          testSandboxLifecycle{},
		SandboxAuthority: probe,
	}

	_, err := deps.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{Sandbox: true})
	var queueErr *queueError
	if !errors.As(err, &queueErr) || queueErr.Status != http.StatusServiceUnavailable ||
		queueErr.Code != "sandbox_authority_unavailable" {
		t.Fatalf("queue error=%v, want stable fatal sandbox authority error", err)
	}
	if probe.setCalls != 1 || !probe.lastValue {
		t.Fatalf("authority writes=%d value=%v, want one sandbox write", probe.setCalls, probe.lastValue)
	}
	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantID, campaignID)
	if len(recipients) != 0 || status != StatusDraft {
		t.Fatalf("failed authority write queued=%v status=%q, want no recipients and draft", recipients, status)
	}
}

func TestQueueAndStartCampaign_DecidesHoldoutInQueueTransaction(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-holdout")
	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "holdout queue")
	audience := []string{
		"alice@example.com",
		"bob@example.com",
		"carol@example.com",
		"dana@example.com",
		"ellis@example.com",
		"finn@example.com",
	}
	subs := make([]subQ, 0, len(audience))
	for _, email := range audience {
		subs = append(subs, subQ{email: email, status: "enabled"})
	}
	insertSubscribersQ(t, pool, ctx, tenantID, subs)

	// Assignment v2 hashes the durable subscriber UUID, not mutable email text.
	// Choose a deterministic test seed only after those IDs exist so the fixture
	// is guaranteed to exercise both arms instead of depending on probability.
	txIDs, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subscriber-id read: %v", err)
	}
	rowsIDs, err := txIDs.Query(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = ANY($2::text[])
 ORDER BY id`, tenantID, audience)
	if err != nil {
		t.Fatalf("read subscriber ids: %v", err)
	}
	var subscriberIDs []string
	for rowsIDs.Next() {
		var id string
		if err := rowsIDs.Scan(&id); err != nil {
			t.Fatalf("scan subscriber id: %v", err)
		}
		subscriberIDs = append(subscriberIDs, id)
	}
	rowsIDs.Close()
	if err := txIDs.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber-id read: %v", err)
	}
	seed := ""
	for candidate := 0; candidate < 1000 && seed == ""; candidate++ {
		probe := fmt.Sprintf("queue-holdout-seed-%d", candidate)
		control := 0
		for _, id := range subscriberIDs {
			if holdout.IsHeldOut(probe, id, 50) {
				control++
			}
		}
		if control > 0 && control < len(subscriberIDs) {
			seed = probe
		}
	}
	if seed == "" {
		t.Fatal("could not construct a two-arm deterministic holdout fixture")
	}
	insertHoldoutQ(t, pool, ctx, tenantID, campaignID, seed, 50)
	plan, err := holdout.PlanAudience(ctx, pool, tenantID, campaignID, audience)
	if err != nil {
		t.Fatalf("PlanAudience: %v", err)
	}
	if plan == nil || plan.TreatmentCount() == 0 || plan.ControlCount() == 0 {
		t.Fatalf("plan=%+v; need both treatment and control", plan)
	}

	queued, queueErr := repo.QueueAndStartCampaign(ctx, tenantID, campaignID, "email", plan.Treatment,
		plan, nil, nil)
	if queueErr != nil {
		t.Fatalf("QueueAndStartCampaign: %v", queueErr)
	}
	if queued != plan.TreatmentCount() {
		t.Fatalf("queued = %d, want %d", queued, plan.TreatmentCount())
	}

	tx, queueErr := db.WithTenant(ctx, pool, tenantID)
	if queueErr != nil {
		t.Fatalf("WithTenant: %v", queueErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var decided bool
	var heldOutCount, sentCount int
	if err := tx.QueryRow(ctx, `
SELECT decided_at IS NOT NULL, held_out_count, sent_count
  FROM campaign_holdouts
 WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid`,
		campaignID, tenantID).Scan(&decided, &heldOutCount, &sentCount); err != nil {
		t.Fatalf("read holdout: %v", err)
	}
	if !decided {
		t.Fatal("holdout decided_at is still NULL")
	}
	if heldOutCount != plan.ControlCount() || sentCount != queued {
		t.Fatalf("holdout counts = held:%d sent:%d, want held:%d sent:%d",
			heldOutCount, sentCount, plan.ControlCount(), queued)
	}
	rows, queueErr := tx.Query(ctx, `
SELECT subscriber_email::text
  FROM campaign_recipients
 WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid`,
		campaignID, tenantID)
	if queueErr != nil {
		t.Fatalf("read recipients: %v", queueErr)
	}
	defer rows.Close()
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			t.Fatalf("scan recipient: %v", err)
		}
		for _, heldOutEmail := range plan.Control {
			if strings.EqualFold(heldOutEmail, email) {
				t.Fatalf("held-out recipient %s was queued", email)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("recipient rows: %v", err)
	}
	var ledgerCount int
	var ledgerChannels []string
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int, COALESCE(array_agg(DISTINCT channel ORDER BY channel), ARRAY[]::text[])
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(&ledgerCount, &ledgerChannels); err != nil {
		t.Fatalf("read transactional frequency ledger: %v", err)
	}
	if ledgerCount != queued || !equalStringSlice(ledgerChannels, []string{"email"}) {
		t.Fatalf("frequency ledger count=%d channels=%v, want count=%d channels=[email]",
			ledgerCount, ledgerChannels, queued)
	}
}

func TestQueueAndStartCampaignConcurrentFrequencyAdmissionAllowsOnlyOne(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "queue-frequency-linearizable")
	campaigns := []string{
		insertQueueableCampaignQ(t, pool, ctx, tenantID, "frequency contender one"),
		insertQueueableCampaignQ(t, pool, ctx, tenantID, "frequency contender two"),
	}
	email := "frequency-linearizable@example.test"
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{{email: email, status: "enabled"}})
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin frequency rule fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active, channels)
VALUES ($1::uuid, 'one email', 1, 24, true, ARRAY['email']::text[])`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert frequency rule: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit frequency rule: %v", err)
	}

	type outcome struct {
		queued int
		err    error
	}
	start := make(chan struct{})
	results := make(chan outcome, len(campaigns))
	for _, campaignID := range campaigns {
		campaignID := campaignID
		go func() {
			<-start
			queued, queueErr := (&Repo{Pool: pool}).QueueAndStartCampaign(
				ctx, tenantID, campaignID, "email", []string{email}, nil, nil, nil,
			)
			results <- outcome{queued: queued, err: queueErr}
		}()
	}
	close(start)
	successes, fenced := 0, 0
	for range campaigns {
		result := <-results
		switch {
		case result.err == nil && result.queued == 1:
			successes++
		case errors.Is(result.err, errFrequencyCapAuthorityChanged) && result.queued == 0:
			fenced++
		default:
			t.Fatalf("unexpected concurrent queue outcome: queued=%d err=%v", result.queued, result.err)
		}
	}
	if successes != 1 || fenced != 1 {
		t.Fatalf("concurrent queue outcomes: success=%d fenced=%d, want 1/1", successes, fenced)
	}
	proof, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin concurrent queue proof: %v", err)
	}
	defer func() { _ = proof.Rollback(ctx) }()
	var recipients, reservations int
	if err := proof.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_recipients WHERE tenant_id = $1::uuid AND subscriber_email = $2::citext),
       (SELECT count(*) FROM subscriber_send_log WHERE tenant_id = $1::uuid AND subscriber_email = $2::citext)`,
		tenantID, email).Scan(&recipients, &reservations); err != nil {
		t.Fatalf("read concurrent queue proof: %v", err)
	}
	if recipients != 1 || reservations != 1 {
		t.Fatalf("concurrent queue recipients=%d reservations=%d, want exactly 1/1", recipients, reservations)
	}
	if err := proof.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent queue proof: %v", err)
	}
}

func TestQueueAndStartCampaignRollsBackWhenRetryAdmissionFails(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-retry-admission-rollback")
	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "retry admission rollback")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{{
		email: "admitted@example.test", status: "enabled",
	}})
	sentinel := errors.New("retry receipt insert failed")
	hookCalls := 0
	queued, err := repo.QueueAndStartCampaign(
		ctx, tenantID, campaignID, "email", []string{"admitted@example.test"},
		nil, nil,
		func(_ context.Context, tx pgx.Tx) error {
			hookCalls++
			if tx == nil {
				t.Fatal("retry admission hook received a nil transaction")
			}
			return sentinel
		},
	)
	if queued != 0 || !errors.Is(err, errIntelligentRetryAdmission) || !errors.Is(err, sentinel) || hookCalls != 1 {
		t.Fatalf("queue result=%d error=%v hooks=%d, want atomic retry failure", queued, err, hookCalls)
	}
	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantID, campaignID)
	if len(recipients) != 0 || status != StatusDraft {
		t.Fatalf("failed retry receipt left recipients=%v status=%q, want none/draft", recipients, status)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read retry rollback evidence: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var retryEvents int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM intelligent_retry_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&retryEvents); err != nil {
		t.Fatalf("count retry rollback evidence: %v", err)
	}
	if retryEvents != 0 {
		t.Fatalf("failed admission claimed %d retry events, want zero", retryEvents)
	}
}

func TestQueueAllFrequencyCappedEmailCreatesNoAdmissionOrRetry(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "queue-all-frequency-capped")
	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "all frequency capped")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{{
		email: "capped@example.test", status: "enabled",
	}})
	enableEmailComplianceQ(t, pool, ctx, tenantID, campaignID, "sender@example.test")
	retryQueue := &recordingFrequencyRetryQueue{}
	deps := &Deps{
		Repo:         &Repo{Pool: pool},
		LiveDispatch: dispatchcontrol.StaticGate{Enabled: true},
		Frequency: func(_ context.Context, _ string, _ string, candidates []string) ([]string, int, []FrequencySkipBreakdown, error) {
			return nil, len(candidates), []FrequencySkipBreakdown{{
				RuleID: "cap-1", RuleLabel: "Daily", Skipped: len(candidates),
			}}, nil
		},
		SubscriberPreference: func(context.Context, string, []string) ([]string, int, error) {
			t.Fatal("all-frequency-capped email audience reached subscriber preference filtering")
			return nil, 0, nil
		},
		RetryQueue: retryQueue,
	}
	_, err := deps.queueCampaignCore(ctx, tenantID, campaignID, queueCampaignOptions{})
	var queueErr *queueError
	if !errors.As(err, &queueErr) || queueErr.Status != http.StatusUnprocessableEntity || queueErr.Code != "frequency_cap_all_deferred" {
		t.Fatalf("all-capped queue error=%v, want stable frequency_cap_all_deferred 422", err)
	}
	if retryQueue.calls != 0 {
		t.Fatalf("all-capped campaign claimed %d retry insertions, want zero", retryQueue.calls)
	}
	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantID, campaignID)
	if len(recipients) != 0 || status != StatusDraft {
		t.Fatalf("all-capped campaign recipients=%v status=%q, want none/draft", recipients, status)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read all-capped retry evidence: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var retryEvents int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM intelligent_retry_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&retryEvents); err != nil {
		t.Fatalf("count all-capped retry evidence: %v", err)
	}
	if retryEvents != 0 {
		t.Fatalf("all-capped campaign persisted %d retry events, want zero", retryEvents)
	}
}

// --- shared test helpers ----------------------------------------------

type subQ struct {
	email  string
	status string
	// noEmailConsent, when true, leaves consent_email_marketing_at NULL
	// so the SUB-051 activation-time channel-consent gate excludes the
	// row. Default (false) stamps consent so the historic
	// "all enabled subscribers are deliverable" expectation holds.
	noEmailConsent bool
	// Exact-address projection overrides for the per-address eligibility gate.
	// The zero value creates a subscribed, unsuppressed row for the canonical
	// email (or never_subscribed when noEmailConsent is true).
	omitAddressProjection bool
	addressEmail          string
	addressConsentStatus  string
	addressSuppressed     bool
}

// setupTenantQ creates a fresh tenant row and registers cleanup. Returns
// the tenant id as text. The slug carries the test-name hint so a
// failed cleanup is at least diagnosable in the DB.
func setupTenantQ(t *testing.T, pool *db.Pool, ctx context.Context, hint string) string {
	t.Helper()
	tname := fmt.Sprintf("%s-%d-%s", hint, time.Now().UnixNano(), randHex4QF(t))
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')
RETURNING id::text`, tenantID, tname).Scan(&tenantID); err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	// deleteCampaignsTestTenant deletes the campaigns first and then the
	// tenant, and reports a failure. This teardown used to cascade from the
	// tenant alone and discard the error, but the segment delete guard refuses
	// that cascade whenever an unsent campaign still targets a segment, so the
	// schedule and population tests leaked their tenants on every run.
	t.Cleanup(func() { deleteCampaignsTestTenant(t, pool, tenantID) })
	return tenantID
}

// insertSubscribersQ inserts subscribers under a tenant and seeds positive
// email permission through the canonical exact-address event/proof pair.
// Migration 1766 deliberately rejects fabricated positive projection fields,
// so this fixture exercises the same terminal evidence fold as production.
func insertSubscribersQ(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, subs []subQ) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, s := range subs {
		var subscriberID string
		if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::citext, $3, 'api')
RETURNING id::text`, tenantID, s.email, s.status).Scan(&subscriberID); err != nil {
			t.Fatalf("insert subscriber %s: %v", s.email, err)
		}
		if s.omitAddressProjection {
			continue
		}
		addressEmail := s.addressEmail
		if addressEmail == "" {
			addressEmail = s.email
		}
		consentStatus := s.addressConsentStatus
		if consentStatus == "" {
			consentStatus = "subscribed"
			if s.noEmailConsent {
				consentStatus = "never_subscribed"
			}
		}
		initialStatus := consentStatus
		if consentStatus == "subscribed" {
			initialStatus = "never_subscribed"
		}
		var addressID string
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3::citext,
        lower($3::text) = lower($4::text), $5, $6)
RETURNING id::text`,
			tenantID, subscriberID, addressEmail, s.email, initialStatus, s.addressSuppressed).Scan(&addressID); err != nil {
			t.Fatalf("insert subscriber email %s: %v", addressEmail, err)
		}
		if consentStatus == "subscribed" {
			grantExactEmailConsentQ(t, ctx, tx, tenantID, subscriberID, addressID, addressEmail)
		}
		// Grant evidence can project the legacy subscriber vector. Preserve the
		// helper's explicit noEmailConsent contract for deliberately inconsistent
		// fixtures that prove both projections are independently necessary.
		if s.noEmailConsent {
			if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET consent_email_marketing_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
				t.Fatalf("reset subscriber consent projection %s: %v", s.email, err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscribers: %v", err)
	}
}

func grantExactEmailConsentQ(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, addressID, email string,
) {
	t.Helper()
	occurredAt := time.Now().UTC().Truncate(time.Microsecond)
	const (
		jurisdiction = "US"
		reason       = "Canonical campaign audience database fixture"
		operation    = "campaign_audience_fixture"
		policy       = "campaign-audience-test-v1"
		proof        = "Reviewed exact-address grant for campaign audience testing."
	)
	eventID, err := consent.RecordEventInTx(ctx, tx, consent.EventInput{
		TenantID:      tenantID,
		SubjectType:   "subscriber",
		SubjectID:     addressID,
		SubjectEmail:  email,
		Channel:       "email",
		Category:      "email_marketing",
		Action:        "granted",
		Source:        "double_optin",
		PolicyVersion: policy,
		ProofText:     proof,
		Preferences: map[string]any{
			"legal_basis":    "consent",
			"jurisdiction":   jurisdiction,
			"reason":         reason,
			"operation":      operation,
			"subscriber_id":  subscriberID,
			"address_id":     addressID,
			"consent_status": "subscribed",
		},
		OccurredAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("insert consent event %s: %v", email, err)
	}
	evidence, err := json.Marshal(map[string]any{
		"event_id":       eventID,
		"address_id":     addressID,
		"operation":      operation,
		"legal_basis":    "consent",
		"jurisdiction":   jurisdiction,
		"reason":         reason,
		"policy_version": policy,
		"evidence":       proof,
	})
	if err != nil {
		t.Fatalf("encode consent proof %s: %v", email, err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
        captured_at, evidence)
VALUES ($1::uuid, $2::uuid, $3::citext, 'email', 'granted', 'double_optin',
        $4::timestamptz, $5::jsonb)`,
		tenantID, subscriberID, email, occurredAt, string(evidence)); err != nil {
		t.Fatalf("insert consent record %s: %v", email, err)
	}
}

// insertSegmentQ inserts a segment row with the given AST. Returns id.
func insertSegmentQ(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, ast string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, $3::jsonb)
RETURNING id::text`, tenantID, name, ast).Scan(&id); err != nil {
		t.Fatalf("insert segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit segment: %v", err)
	}
	return id
}

func insertListIdentityQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	listmonkID int64,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var listUUID string
	if err := tx.QueryRow(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES (gen_random_uuid(), $2, $1::uuid)
RETURNING postwave_uuid::text`, tenantID, listmonkID).Scan(&listUUID); err != nil {
		t.Fatalf("insert list identity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list identity: %v", err)
	}
	return listUUID
}

func addListMemberQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, listUUID string,
	listmonkID int64,
	email string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := tx.Exec(ctx, `
INSERT INTO list_subscribers
       (tenant_id, list_id, subscriber_id, listmonk_list_id, email, source)
SELECT $1::uuid, $2::uuid, id, $3, email, 'admin'
  FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $4::citext`,
		tenantID, listUUID, listmonkID, email)
	if err != nil {
		t.Fatalf("insert list member %s: %v", email, err)
	}
	if result.RowsAffected() != 1 {
		t.Fatalf("insert list member %s affected %d rows, want 1", email, result.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list member: %v", err)
	}
}

func setCampaignAudienceQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, campaignID, listID, segmentID string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET audience_list_id = NULLIF($3, '')::bigint,
       segment_id = NULLIF($4, '')::uuid
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, campaignID, listID, segmentID); err != nil {
		t.Fatalf("set campaign audience: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign audience: %v", err)
	}
}

func insertQueueableCampaignQ(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html)
VALUES ($1::uuid, $2, 'subject', 'draft', '<p>hello {{ unsubscribe_url }}</p>')
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		t.Fatalf("insert campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func insertHoldoutQ(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, seed string, percent float64) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed)
VALUES ($1::uuid, $2::uuid, $3, $4)`, campaignID, tenantID, percent, seed); err != nil {
		t.Fatalf("insert holdout: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit holdout: %v", err)
	}
}

func equalStringSlice(a, b []string) bool {
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
