// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type vanityFixture struct {
	TenantID     string
	CampaignID   string
	SubscriberID string
	Email        string
	Slug         string
	Host         string
	Path         string
	PathID       string
}

// seedVanityPath creates a workspace that sent one campaign to exactly ONE
// subscriber, verified one domain, and published one vanity path on it.
//
// The single subscriber is deliberate: it is the most tempting possible case
// for a wrong inference ("only one person got this campaign, so the visit must
// be theirs"), and the attribution still may not make it — the URL is public
// and anyone who was forwarded it can walk through the same door.
//
// No click event is recorded for anyone. That is the premise of the whole
// feature: last-touch attribution cannot see this visit at all.
func seedVanityPath(t *testing.T, pool *db.Pool) vanityFixture {
	t.Helper()
	ctx := context.Background()
	suffix := strings.ToLower(uuid.NewString()[:8])
	f := vanityFixture{
		TenantID: uuid.NewString(),
		Email:    "reader-" + suffix + "@example.test",
		Slug:     "spring-sale-" + suffix,
		Host:     "shop-" + suffix + ".example.test",
		Path:     "/collections/spring",
	}

	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	fail := func(step string, err error) {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed %s: %v", step, err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'vanity-attr-test', $2, 'studio')`,
		f.TenantID, "vanity-"+f.TenantID[:8]); err != nil {
		fail("tenant", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, campaign_type, status)
VALUES ($1::uuid, 'Spring sale', 'Spring sale', 'regular', 'sent')
RETURNING id::text`, f.TenantID).Scan(&f.CampaignID); err != nil {
		fail("campaign", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		f.TenantID, f.Email).Scan(&f.SubscriberID); err != nil {
		fail("subscriber", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO custom_domains (tenant_id, domain, purpose, verified, verified_at)
VALUES ($1::uuid, $2::citext, 'web', true, now())`, f.TenantID, f.Host); err != nil {
		fail("custom domain", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	t.Cleanup(func() {
		admin, err := db.WithTenant(context.Background(), pool, f.TenantID)
		if err != nil {
			return
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, f.TenantID)
		_ = admin.Commit(context.Background())
	})

	record, err := (&VanityRepo{Pool: pool}).CreatePath(ctx, f.TenantID, NewPath{
		Slug: f.Slug, CampaignID: f.CampaignID,
		DestinationHost: f.Host, DestinationPath: f.Path,
	})
	if err != nil {
		t.Fatalf("seed vanity path: %v", err)
	}
	f.PathID = record.ID
	return f
}

func vanityRouter(pool *db.Pool) chi.Router {
	router := chi.NewRouter()
	MountPublicVanityRoutes(router, &VanityDeps{Repo: &VanityRepo{Pool: pool}})
	return router
}

func assertNoClicksAnywhere(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var clicks int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id = $1::uuid AND event_type = 'clicked'`, tenantID).Scan(&clicks); err != nil {
		t.Fatalf("count clicks: %v", err)
	}
	if clicks != 0 {
		t.Fatalf("fixture has %d click events; the test would not prove the criterion", clicks)
	}
}

// THE acceptance criterion, second half: a visit through a campaign's vanity
// path attributes to that campaign with no click anywhere.
func TestAVanityVisitWithNoClickAttributesToTheCampaign(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	assertNoClicksAnywhere(t, pool, f.TenantID)

	repo := &VanityRepo{Pool: pool}
	result, err := repo.RecordVisit(ctx, f.Slug, VisitRequest{})
	if err != nil {
		t.Fatalf("RecordVisit: %v", err)
	}
	if result.CampaignID != f.CampaignID {
		t.Fatalf("campaign = %q, want %q — a direct navigation did not attribute to "+
			"the campaign that published the path", result.CampaignID, f.CampaignID)
	}
	if result.AttributedVia != AttributedViaVanityPath {
		t.Errorf("attributed_via = %q, want %q", result.AttributedVia, AttributedViaVanityPath)
	}
	if result.Reference == "" {
		t.Error("no visit reference was minted, so a later conversion cannot be tied back")
	}

	// The visit is readable as campaign-level attribution, with a real count
	// rather than a zero that any broken query would also produce.
	totals, err := repo.CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 1 {
		t.Errorf("campaign has %d attributed vanity visits, want 1", totals.Visits)
	}

	// Case-folded: a recipient typing the URL off a printed page will not
	// preserve case, and a broken campaign is worse than a strict slug.
	if _, err := repo.RecordVisit(ctx, strings.ToUpper(f.Slug), VisitRequest{}); err != nil {
		t.Errorf("an upper-cased slug did not resolve: %v", err)
	}
}

// A vanity visit must NOT claim per-subscriber certainty.
//
// This is the trap in the feature. A per-recipient code names one person
// because nothing else ever issued them that string. A vanity path is public
// and shared: every recipient gets the same URL and anyone can repost it, so a
// visit through it is evidence about the CAMPAIGN and about nobody in
// particular. Attributing it to a subscriber would be indistinguishable, in
// every report that reads `attributed_via` and `subscriber_email`, from
// evidence that actually identifies a person.
func TestAVanityVisitDoesNotClaimPerSubscriberCertainty(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	// The request even carries a subscriber identifier. It is a claim by whoever
	// sent the request, not evidence, and it must change nothing.
	result, err := repo.RecordVisit(ctx, f.Slug, VisitRequest{SubscriberHint: f.SubscriberID})
	if err != nil {
		t.Fatalf("RecordVisit: %v", err)
	}
	if result.AttributionScope != AttributionScopeCampaign {
		t.Fatalf("attribution scope = %q, want %q — a shared URL cannot say WHICH "+
			"person walked through it", result.AttributionScope, AttributionScopeCampaign)
	}
	// The contrast is the point: the code half names one allocation receipt,
	// while neither path claims to identify a reader.
	if AttributionScopeCampaign == AttributionScopeCampaignAssignment {
		t.Fatal("the two attribution scopes are the same value, so nothing distinguishes " +
			"assignment-linked evidence from per-campaign evidence")
	}

	conversion, err := repo.AttributeConversion(ctx, f.TenantID, result.Reference, VanityConversion{
		AmountCents: 7900, Currency: "usd",
		// The commerce system knows who bought. That still does not establish
		// that THIS campaign reached THAT person through a URL anyone could hold.
		CustomerEmail: f.Email,
	})
	if err != nil {
		t.Fatalf("AttributeConversion: %v", err)
	}

	read, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()

	var via, campaign string
	var email, hash, external, referrer *string
	var cents int64
	if err := read.QueryRow(ctx, `
SELECT attributed_via, campaign_id::text, amount_cents,
       subscriber_email::text, email_sha256, external_id, referrer_subscriber_id
  FROM conversions WHERE tenant_id = $1::uuid AND id = $2`,
		f.TenantID, conversion.ConversionID).Scan(
		&via, &campaign, &cents, &email, &hash, &external, &referrer); err != nil {
		t.Fatalf("read conversion: %v", err)
	}
	if via != AttributedViaVanityPath {
		t.Errorf("attributed_via = %q, want %q — merging this into the code-redemption "+
			"provenance would make weak evidence unrecoverable", via, AttributedViaVanityPath)
	}
	if campaign != f.CampaignID || cents != 7900 {
		t.Errorf("conversion = campaign %q / %d cents, want %q / 7900", campaign, cents, f.CampaignID)
	}
	for label, value := range map[string]*string{
		"subscriber_email": email, "email_sha256": hash,
		"external_id": external, "referrer_subscriber_id": referrer,
	} {
		if value != nil {
			t.Errorf("conversion carries %s = %q; a vanity path cannot establish who "+
				"visited, so a per-subscriber report would count a guess as proof",
				label, *value)
		}
	}

	// And nothing anywhere else ties this campaign to a person off the back of
	// the visit.
	var perPerson int
	if err := read.QueryRow(ctx, `
SELECT count(*) FROM conversions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND subscriber_email IS NOT NULL`,
		f.TenantID, f.CampaignID).Scan(&perPerson); err != nil {
		t.Fatalf("count per-person conversions: %v", err)
	}
	if perPerson != 0 {
		t.Errorf("%d per-subscriber conversions exist for this campaign; the only "+
			"evidence was a shared URL", perPerson)
	}
	var events int
	if err := read.QueryRow(ctx, `
SELECT count(*) FROM subscriber_events WHERE tenant_id = $1::uuid`, f.TenantID).Scan(&events); err != nil {
		t.Fatalf("count subscriber events: %v", err)
	}
	if events != 0 {
		t.Errorf("the visit wrote %d per-subscriber events; a shared URL is not a click "+
			"by any named recipient", events)
	}
}

// The visit row has nowhere to put a person, and the database refuses one on
// the conversion.
//
// A Go-side rule can be edited away in a line. These two cannot: the column
// does not exist, and the CHECK is evaluated by PostgreSQL on every writer,
// including one that has never read this package.
func TestTheSchemaItselfRefusesPerSubscriberVanityAttribution(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)

	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var identityColumns int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'campaign_vanity_visits'
   AND (column_name LIKE '%subscriber%' OR column_name LIKE '%email%'
        OR column_name LIKE '%recipient%')`).Scan(&identityColumns); err != nil {
		t.Fatalf("inspect columns: %v", err)
	}
	if identityColumns != 0 {
		t.Errorf("campaign_vanity_visits has %d identity column(s); a visit through a "+
			"shared URL must have nowhere to record who made it", identityColumns)
	}

	// Prove the fixture can write a conversion at all, so the rejection below is
	// the CHECK and not a broken insert.
	var allowed int64
	if err := tx.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, amount_cents, currency, campaign_id, attributed_via)
VALUES ($1::uuid, 'vanity_path_visit', 100, 'USD', $2::uuid, $3) RETURNING id`,
		f.TenantID, f.CampaignID, AttributedViaVanityPath).Scan(&allowed); err != nil {
		t.Fatalf("a vanity conversion with no identity was rejected: %v", err)
	}
	if allowed == 0 {
		t.Fatal("no conversion id returned")
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO conversions
    (tenant_id, subscriber_email, event_name, amount_cents, currency, campaign_id, attributed_via)
VALUES ($1::uuid, $2, 'vanity_path_visit', 100, 'USD', $3::uuid, $4)`,
		f.TenantID, f.Email, f.CampaignID, AttributedViaVanityPath); err == nil {
		t.Error("the database accepted a vanity-path conversion naming a subscriber; " +
			"the evidence distinction is advisory rather than enforced")
	}
}

// Every miss looks the same.
//
// An unknown slug, a retired path and a path whose destination host lost
// verification are three different facts. Answering them differently hands an
// anonymous caller a way to ask "is this workspace running a spring sale?" and
// get a truthful answer. internal/polls collapses its token misses to one 404
// for exactly this reason.
func TestEveryVanityMissIsIndistinguishable(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	router := vanityRouter(pool)

	// Control: a live path really does redirect, so a fixture that silently
	// broke cannot make every case below "match" at 404.
	live := seedVanityPath(t, pool)
	control := httptest.NewRecorder()
	router.ServeHTTP(control, httptest.NewRequest(http.MethodGet, "/go/"+live.Slug, nil))
	if control.Code != http.StatusFound {
		t.Fatalf("a live vanity path returned %d, want 302; the misses below would "+
			"prove nothing", control.Code)
	}

	retired := seedVanityPath(t, pool)
	if err := (&VanityRepo{Pool: pool}).SetPathStatus(
		ctx, retired.TenantID, retired.PathID, "disabled"); err != nil {
		t.Fatalf("SetPathStatus: %v", err)
	}

	unverified := seedVanityPath(t, pool)
	revoke, err := db.WithTenant(ctx, pool, unverified.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := revoke.Exec(ctx, `
UPDATE custom_domains SET verified = false, verified_at = NULL
 WHERE tenant_id = $1::uuid AND domain = $2::citext`,
		unverified.TenantID, unverified.Host); err != nil {
		t.Fatalf("revoke verification: %v", err)
	}
	if err := revoke.Commit(ctx); err != nil {
		t.Fatalf("commit revoke: %v", err)
	}

	cases := map[string]string{
		"an unknown slug":                     "/go/no-such-campaign-" + strings.ToLower(uuid.NewString()[:8]),
		"a retired path":                      "/go/" + retired.Slug,
		"a path whose host lost verification": "/go/" + unverified.Slug,
		"a malformed slug":                    "/go/Not.A.Slug",
	}

	type response struct {
		code  int
		body  string
		cache string
	}
	var first *response
	var firstName string
	for name, path := range cases {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		got := response{
			code: rec.Code, body: rec.Body.String(),
			cache: rec.Header().Get("Cache-Control"),
		}
		if got.code != http.StatusNotFound {
			t.Errorf("%s returned %d, want 404", name, got.code)
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("%s returned a Location header", name)
		}
		if first == nil {
			first, firstName = &got, name
			continue
		}
		if got != *first {
			t.Errorf("%s answered %+v but %s answered %+v — the difference tells an "+
				"anonymous caller which campaigns exist", name, got, firstName, *first)
		}
	}
}

// A vanity path cannot be made into an open redirect.
//
// /go/{slug} is served from our own domain. A stored destination that could
// name an arbitrary host would turn a trustworthy-looking URL into a working
// phishing redirector, and it would be OUR domain in the address bar of the
// message that carried it.
func TestAVanityPathCannotBecomeAnOpenRedirect(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	hostile := map[string]NewPath{
		"a protocol-relative path": {
			DestinationHost: f.Host, DestinationPath: "//evil.example/login"},
		"a backslash-prefixed path": {
			DestinationHost: f.Host, DestinationPath: `/\evil.example/login`},
		"an absolute URL in the path": {
			DestinationHost: f.Host, DestinationPath: "https://evil.example/login"},
		"a host this workspace never verified": {
			DestinationHost: "evil.example", DestinationPath: "/login"},
		"userinfo smuggled into the host": {
			DestinationHost: f.Host + "@evil.example", DestinationPath: "/login"},
		"a port smuggled into the host": {
			DestinationHost: f.Host + ":8443", DestinationPath: "/login"},
	}
	for name, attempt := range hostile {
		attempt.Slug = "hostile-" + strings.ToLower(uuid.NewString()[:8])
		attempt.CampaignID = f.CampaignID
		_, err := repo.CreatePath(ctx, f.TenantID, attempt)
		if !errors.Is(err, ErrUnsafeDestination) {
			t.Errorf("%s: err = %v, want ErrUnsafeDestination — /go/{slug} would "+
				"redirect a recipient off this workspace's own hosts", name, err)
		}
	}

	// The same rule below the application. A writer that never read this package
	// is refused by PostgreSQL.
	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_vanity_paths
    (tenant_id, slug, campaign_id, destination_host, destination_path)
VALUES ($1::uuid, $2::citext, $3::uuid, $4::citext, '//evil.example/login')`,
		f.TenantID, "raw-"+strings.ToLower(uuid.NewString()[:8]), f.CampaignID, f.Host); err == nil {
		t.Error("the database stored a protocol-relative destination path")
	}
}

// Nothing in the request influences where the redirect goes.
func TestTheRedirectIgnoresACallerSuppliedDestination(t *testing.T) {
	pool := codesDB(t)
	f := seedVanityPath(t, pool)
	router := vanityRouter(pool)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/go/"+f.Slug+
			"?next=https://evil.example/login"+
			"&url=//evil.example"+
			"&redirect_uri=https%3A%2F%2Fevil.example"+
			"&s="+f.SubscriberID, nil))

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	location := rec.Header().Get("Location")
	wantPrefix := "https://" + f.Host + f.Path + "?" + VisitReferenceParam + "="
	if !strings.HasPrefix(location, wantPrefix) {
		t.Fatalf("Location = %q, want prefix %q — a query parameter reached the "+
			"redirect target", location, wantPrefix)
	}
	if strings.Contains(location, "evil.example") {
		t.Fatalf("Location = %q names a host the caller supplied", location)
	}
	reference := strings.TrimPrefix(location, wantPrefix)
	if _, err := uuid.Parse(reference); err != nil {
		t.Errorf("visit reference %q is not an opaque id: %v", reference, err)
	}
	if reference == f.SubscriberID {
		t.Error("the visit reference is the subscriber identifier from the request")
	}
}

// A slug belongs to one workspace, globally and permanently.
//
// /go/{slug} carries no tenant. Two workspaces holding one slug would make
// attribution depend on which row PostgreSQL returned first — the defect
// migration 1951 was written to remove for signing key ids.
func TestAVanitySlugIsGloballyUniqueAndNeverReassigned(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	owner := seedVanityPath(t, pool)
	rival := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	_, err := repo.CreatePath(ctx, rival.TenantID, NewPath{
		Slug: owner.Slug, CampaignID: rival.CampaignID,
		DestinationHost: rival.Host, DestinationPath: "/",
	})
	if !errors.Is(err, ErrSlugUnavailable) {
		t.Fatalf("err = %v, want ErrSlugUnavailable — two workspaces would share one "+
			"public path and attribution would depend on row order", err)
	}

	resolved, ok := repo.ResolveTenant(ctx, owner.Slug)
	if !ok || resolved != owner.TenantID {
		t.Fatalf("slug resolved to %q (ok=%v), want %q", resolved, ok, owner.TenantID)
	}

	// Retiring a path does not free the slug: the URL is printed in messages
	// that have already been delivered, and the next claimant would inherit
	// their traffic.
	if err := repo.SetPathStatus(ctx, owner.TenantID, owner.PathID, "disabled"); err != nil {
		t.Fatalf("SetPathStatus: %v", err)
	}
	if _, err := repo.CreatePath(ctx, rival.TenantID, NewPath{
		Slug: owner.Slug, CampaignID: rival.CampaignID,
		DestinationHost: rival.Host, DestinationPath: "/",
	}); !errors.Is(err, ErrSlugUnavailable) {
		t.Fatalf("err = %v, want ErrSlugUnavailable — a retired slug was reassigned "+
			"and already-delivered links now credit a different campaign", err)
	}
}

// One workspace cannot retire another workspace's path.
//
// RLS FILTERS, IT DOES NOT REFUSE: a cross-tenant UPDATE matches zero rows and
// reports success, so the row count is the only thing that can tell the caller
// nothing happened.
func TestOneWorkspaceCannotRetireAnothersVanityPath(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	owner := seedVanityPath(t, pool)
	rival := seedVanityPath(t, pool)
	repo := &VanityRepo{Pool: pool}

	err := repo.SetPathStatus(ctx, rival.TenantID, owner.PathID, "disabled")
	if !errors.Is(err, ErrUnknownPath) {
		t.Fatalf("err = %v, want ErrUnknownPath — a cross-tenant update reported "+
			"success while changing nothing", err)
	}

	// And the path really is still live, so the assertion above is not just
	// about an error value.
	result, err := repo.RecordVisit(ctx, owner.Slug, VisitRequest{})
	if err != nil {
		t.Fatalf("the owner's path stopped working after a cross-tenant retire: %v", err)
	}
	if result.CampaignID != owner.CampaignID {
		t.Errorf("campaign = %q, want %q", result.CampaignID, owner.CampaignID)
	}
}

// A conversion reported against a visit credits the campaign once.
func TestAVanityConversionCreditsTheCampaignExactlyOnce(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedVanityPath(t, pool)
	assertNoClicksAnywhere(t, pool, f.TenantID)
	repo := &VanityRepo{Pool: pool}

	visit, err := repo.RecordVisit(ctx, f.Slug, VisitRequest{OccurredAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("RecordVisit: %v", err)
	}
	if _, err := repo.AttributeConversion(ctx, f.TenantID, visit.Reference,
		VanityConversion{AmountCents: 12500, Currency: "eur"}); err != nil {
		t.Fatalf("AttributeConversion: %v", err)
	}
	if _, err := repo.AttributeConversion(ctx, f.TenantID, visit.Reference,
		VanityConversion{AmountCents: 12500, Currency: "eur"}); !errors.Is(err, ErrVisitAlreadyConverted) {
		t.Fatalf("err = %v, want ErrVisitAlreadyConverted — one visit credited the "+
			"campaign twice", err)
	}

	totals, err := repo.CampaignAttribution(ctx, f.TenantID, f.CampaignID)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	if totals.Visits != 1 || totals.Conversions != 1 || totals.RevenueCents != 12500 {
		t.Errorf("attribution = %+v, want 1 visit / 1 conversion / 12500 cents", *totals)
	}

	// An unknown reference is refused rather than credited to whatever it hits.
	if _, err := repo.AttributeConversion(ctx, f.TenantID, uuid.NewString(),
		VanityConversion{AmountCents: 100}); !errors.Is(err, ErrUnknownVisit) {
		t.Errorf("an unknown visit reference: err = %v, want ErrUnknownVisit", err)
	}
	// A visit belonging to another workspace is equally unknown.
	other := seedVanityPath(t, pool)
	if _, err := repo.AttributeConversion(ctx, other.TenantID, visit.Reference,
		VanityConversion{AmountCents: 100}); !errors.Is(err, ErrUnknownVisit) {
		t.Errorf("a cross-tenant visit reference: err = %v, want ErrUnknownVisit", err)
	}
}

// The slug resolver runs before any tenant is known, so it must not be a
// capability any application session can invoke against any workspace.
//
// A policy keyed on a caller-settable GUC would be exactly that: every
// postwave_app session can SET a custom GUC. This asserts the migration-1951
// shape actually landed, because the application tests above would pass just as
// happily on top of the unsafe version.
func TestTheVanityResolverIsAFixedQueryDefinerNotASettableGUC(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var canLogin, bypassRLS, inherit bool
	if err := tx.QueryRow(ctx, `
SELECT rolcanlogin, rolbypassrls, rolinherit FROM pg_roles
 WHERE rolname = 'postwave_vanity_path_resolver'`).Scan(&canLogin, &bypassRLS, &inherit); err != nil {
		t.Fatalf("the vanity resolver role does not exist: %v", err)
	}
	if canLogin || bypassRLS || inherit {
		t.Errorf("resolver role attributes: login=%v bypassrls=%v inherit=%v; all must be false",
			canLogin, bypassRLS, inherit)
	}

	// The definer may read the tenant and nothing else. Content columns stay
	// behind RLS, read back only once a tenant is bound.
	for _, column := range []string{"destination_host", "destination_path", "campaign_id"} {
		var granted bool
		if err := tx.QueryRow(ctx, `
SELECT has_column_privilege('postwave_vanity_path_resolver',
       'public.campaign_vanity_paths', $1, 'SELECT')`, column).Scan(&granted); err != nil {
			t.Fatalf("has_column_privilege(%s): %v", column, err)
		}
		if granted {
			t.Errorf("the resolver can read %s; it is supposed to return a tenant id "+
				"and nothing else", column)
		}
	}

	var owner, searchPath string
	if err := tx.QueryRow(ctx, `
SELECT pg_get_userbyid(p.proowner),
       COALESCE(array_to_string(p.proconfig, ','), '')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'resolve_campaign_vanity_path'`).Scan(
		&owner, &searchPath); err != nil {
		t.Fatalf("the resolver function does not exist: %v", err)
	}
	if owner != "postwave_vanity_path_resolver" {
		t.Errorf("resolver function owner = %q, want postwave_vanity_path_resolver", owner)
	}
	// pg_temp LAST: a definer whose search_path omits it can be hijacked by a
	// temp-schema object shadowing a referenced name.
	if !strings.HasSuffix(searchPath, "pg_temp") {
		t.Errorf("resolver search_path = %q, want pg_temp last", searchPath)
	}

	var publicExecute bool
	if err := tx.QueryRow(ctx, `
SELECT has_function_privilege('public',
       'public.resolve_campaign_vanity_path(text)', 'EXECUTE')`).Scan(&publicExecute); err != nil {
		t.Fatalf("has_function_privilege: %v", err)
	}
	if publicExecute {
		t.Error("EXECUTE on the vanity resolver is granted to PUBLIC")
	}
}

// The authoring surface refuses a slug that would read as a hostname.
//
// /go/paypal.com is a phishing affordance we would be hosting, and a leading or
// trailing dash is trimmed out of a linkified URL by several mail clients.
func TestAVanitySlugMustNotReadAsAHostname(t *testing.T) {
	for _, raw := range []string{
		"paypal.com", "-spring", "spring-", "spring sale", "spring/sale",
		"spring%2fsale", "", strings.Repeat("a", 65),
	} {
		if _, err := NormalizeSlug(raw); !errors.Is(err, ErrInvalidSlug) {
			t.Errorf("NormalizeSlug(%q) = %v, want ErrInvalidSlug", raw, err)
		}
	}
	for _, raw := range []string{"spring-sale", "SPRING-SALE", "  spring-sale  ", "bf2026"} {
		if got, err := NormalizeSlug(raw); err != nil || got != strings.ToLower(strings.TrimSpace(raw)) {
			t.Errorf("NormalizeSlug(%q) = %q, %v; want the folded slug", raw, got, err)
		}
	}
}

// The authoring route reports the limit of the claim it just created.
func TestTheAuthoringResponseStatesTheAttributionScope(t *testing.T) {
	pool := codesDB(t)
	f := seedVanityPath(t, pool)

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(
				middleware.WithTenant(r.Context(), &middleware.Tenant{ID: f.TenantID})))
		})
	})
	MountVanityAdminRoutes(router, &VanityDeps{Repo: &VanityRepo{Pool: pool}})

	slug := "autumn-" + strings.ToLower(uuid.NewString()[:8])
	body := `{"slug":"` + slug + `","destination_host":"` + f.Host + `","destination_path":"/autumn"}`
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/"+f.CampaignID+"/vanity-paths", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d body=%s, want 201", rec.Code, rec.Body.String())
	}
	for _, want := range []string{
		`"public_path":"/go/` + slug + `"`,
		`"attribution_scope":"` + AttributionScopeCampaign + `"`,
		`"attributed_via":"` + AttributedViaVanityPath + `"`,
	} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("create response %s does not contain %s", rec.Body.String(), want)
		}
	}

	// A hostile destination is a 400 with a named code, not a 500.
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/"+f.CampaignID+"/vanity-paths",
		strings.NewReader(`{"slug":"x-`+strings.ToLower(uuid.NewString()[:8])+
			`","destination_host":"`+f.Host+`","destination_path":"//evil.example"}`)))
	if rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "unsafe_destination") {
		t.Errorf("hostile destination = %d body=%s, want 400 unsafe_destination",
			rec.Code, rec.Body.String())
	}
}
