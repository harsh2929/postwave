// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// DB-backed tests for signed-ingest identity resolution + all-touches storage
// (PRD F03, migration 1960). Reuse the fixtures in attribution_db_test.go and
// signed_ingest_handlers_db_test.go under the same throwaway-tenant cleanup.

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

func seedIdentitySubscriber(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email, externalID string,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, external_id)
VALUES ($1::uuid, $2, 'enabled', 'api', NULLIF($3, ''))
RETURNING id::text`, tenantID, email, externalID).Scan(&id); err != nil {
		t.Fatalf("insert subscriber %q: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	drainEmailHMACProjection(t, pool)
	return id
}

// seedClickIdentity binds a click id through the exported writer the
// tracked-link redirect is meant to call, so the test exercises the real
// producer contract rather than a test-only INSERT that could drift from it.
func seedClickIdentity(
	t *testing.T, pool *db.Pool, ctx context.Context,
	tenantID, clickID, subscriberID, campaignID string, at time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := RecordClickIdentity(ctx, tx, tenantID, ClickIdentity{
		ClickID: clickID, SubscriberID: subscriberID,
		CampaignID: campaignID, ClickedAt: at,
	}); err != nil {
		t.Fatalf("RecordClickIdentity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit click identity: %v", err)
	}
}

// storedConversion is the persisted row, read back the way a report would.
type storedConversion struct {
	ID             int64
	Email          string
	CampaignID     string
	AttributedVia  string
	EmailHMAC      string
	EmailHMACKeyID string
	ClickID        string
	ExternalID     string
	AmountCents    *int64
	Currency       string
	FlowID         string
}

func readConversion(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, id int64,
) storedConversion {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out storedConversion
	out.ID = id
	if err := tx.QueryRow(ctx, `
	SELECT COALESCE(subscriber_email::text, ''), COALESCE(campaign_id::text, ''),
	       COALESCE(attributed_via, ''), COALESCE(email_hmac_sha256, ''),
	       COALESCE(email_hmac_key_id, ''),
	       COALESCE(click_id, ''), COALESCE(external_id, ''),
       amount_cents, COALESCE(currency, ''), COALESCE(flow_id::text, '')
  FROM conversions
 WHERE tenant_id = $1::uuid AND id = $2`, tenantID, id).
		Scan(&out.Email, &out.CampaignID, &out.AttributedVia, &out.EmailHMAC,
			&out.EmailHMACKeyID,
			&out.ClickID, &out.ExternalID, &out.AmountCents, &out.Currency, &out.FlowID); err != nil {
		t.Fatalf("read conversion %d: %v", id, err)
	}
	return out
}

// storedTouch is one row of conversion_attribution_touches.
type storedTouch struct {
	TouchKind      string
	IdentityKind   string
	IdentityValue  string
	IdentityKeyID  string
	ResolutionRank int
	SubscriberID   string
	CampaignID     string
	TouchedAt      time.Time
	IsWinner       bool
}

func readTouches(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID string, conversionID int64,
) []storedTouch {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
	SELECT touch_kind, COALESCE(identity_kind, ''), COALESCE(identity_value, ''),
	       COALESCE(identity_key_id, ''), COALESCE(resolution_rank, 0),
	       COALESCE(subscriber_id::text, ''),
       COALESCE(campaign_id::text, ''), touched_at,
       is_winner
  FROM conversion_attribution_touches
 WHERE tenant_id = $1::uuid AND conversion_id = $2
 ORDER BY touch_kind, resolution_rank NULLS LAST, touched_at DESC`,
		tenantID, conversionID)
	if err != nil {
		t.Fatalf("query touches: %v", err)
	}
	defer rows.Close()
	out := []storedTouch{}
	for rows.Next() {
		var touch storedTouch
		var touchedAt *time.Time
		if err := rows.Scan(&touch.TouchKind, &touch.IdentityKind, &touch.IdentityValue,
			&touch.IdentityKeyID, &touch.ResolutionRank, &touch.SubscriberID, &touch.CampaignID,
			&touchedAt, &touch.IsWinner); err != nil {
			t.Fatalf("scan touch: %v", err)
		}
		if touchedAt != nil {
			touch.TouchedAt = *touchedAt
		}
		out = append(out, touch)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("touch rows: %v", err)
	}
	return out
}

// ingestSigned posts one signed conversion and returns the ids it created.
func ingestSigned(
	t *testing.T, router http.Handler, secret, keyID string, body []byte, now time.Time,
) []int64 {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
		secret, keyID, "idem-"+uuid.NewString(), body, now))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("ingest = %d, body %s", rec.Code, rec.Body.String())
	}
	var receipt struct {
		Accepted      int     `json:"accepted"`
		ConversionIDs []int64 `json:"conversion_ids"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatalf("decode receipt %s: %v", rec.Body.String(), err)
	}
	if receipt.Accepted != len(receipt.ConversionIDs) {
		t.Fatalf("receipt claims %d accepted but names %d ids",
			receipt.Accepted, len(receipt.ConversionIDs))
	}
	return receipt.ConversionIDs
}

func countTenantConversions(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID string,
) int64 {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int64
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM conversions WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		t.Fatalf("count conversions: %v", err)
	}
	return n
}

// ---------------------------------------------------------------------------
// 1. The resolution ORDER
// ---------------------------------------------------------------------------

// A payload carrying BOTH a click id and an email digest resolves to the person
// the DIGEST names, not the person the click id names.
//
// This is the whole point of having a stated order. A click id names a device or
// a link touch: a shared laptop, a forwarded message and a household all detach
// it from the recipient. A digest names a person. Resolving the click id first
// would credit the purchase to whoever happened to click, which is a different
// human being — and the row would look completely healthy either way.
func TestSignedIngestResolvesTheDigestBeforeTheClickID(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	hashOwner := "digest-owner@example.test"
	clickOwner := "click-owner@example.test"
	seedIdentitySubscriber(t, pool, ctx, tenantID, hashOwner, "")
	clickOwnerID := seedIdentitySubscriber(t, pool, ctx, tenantID, clickOwner, "")

	campaign := createAttributionCampaign(t, pool, ctx, tenantID, "Spring")
	clickID := "clk-" + uuid.NewString()
	seedClickIdentity(t, pool, ctx, tenantID, clickID, clickOwnerID, campaign,
		now.Add(-3*time.Hour))

	occurred := now.Add(-time.Minute)
	body := []byte(`{"event_name":"purchase","value":19.99,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(hashOwner) + `",` +
		`"click_id":"` + clickID + `"}}`)

	ids := ingestSigned(t, router, secret, keyID, body, now)
	if len(ids) != 1 {
		t.Fatalf("ids = %v, want exactly one conversion", ids)
	}
	stored := readConversion(t, pool, ctx, tenantID, ids[0])

	if stored.Email != hashOwner {
		t.Fatalf("subscriber_email = %q, want %q — the digest names a PERSON and the "+
			"click id names a device; resolving the click id first credits the "+
			"purchase to a different human being", stored.Email, hashOwner)
	}
	// Guard the guard: the click id must genuinely resolve to somebody ELSE, or
	// the assertion above would pass for a resolver that ignored click ids
	// entirely.
	if clickOwner == hashOwner {
		t.Fatal("fixture is vacuous: both identifiers name the same subscriber")
	}
	onlyClick := []byte(`{"event_name":"purchase","value":5.00,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"click_id":"` + clickID + `"}}`)
	clickIDs := ingestSigned(t, router, secret, keyID, onlyClick, now)
	clickStored := readConversion(t, pool, ctx, tenantID, clickIDs[0])
	if clickStored.Email != clickOwner {
		t.Fatalf("a click-id-only payload resolved to %q, want %q — the fixture "+
			"cannot prove an ORDER if the lower-priority identifier never resolves "+
			"at all", clickStored.Email, clickOwner)
	}

	// The campaign still comes from the click, because that is the touch the
	// caller's own server captured on the way to this purchase.
	if stored.CampaignID != campaign {
		t.Errorf("campaign_id = %q, want %q — the digest names the person, the click "+
			"names the touch, and a payload carrying both should get one from each",
			stored.CampaignID, campaign)
	}
	if stored.AttributedVia != AttributedViaLastTouch {
		t.Errorf("attributed_via = %q, want %q — the evidence is a click",
			stored.AttributedVia, AttributedViaLastTouch)
	}
	if stored.AmountCents == nil || *stored.AmountCents != 1999 {
		t.Errorf("amount_cents = %v, want 1999 — an assertion over a zero-value row "+
			"proves nothing", stored.AmountCents)
	}
}

// signedIdentityResolutionOrder IS the PRD's stated contract, so it is pinned.
func TestSignedIdentityResolutionOrderMatchesThePRD(t *testing.T) {
	t.Parallel()
	want := []string{identityKindEmailHMACSHA256, identityKindClickID, identityKindExternalID}
	if len(signedIdentityResolutionOrder) != len(want) {
		t.Fatalf("order = %v, want %v", signedIdentityResolutionOrder, want)
	}
	for i := range want {
		if signedIdentityResolutionOrder[i] != want[i] {
			t.Fatalf("order = %v, want %v (email_hmac_sha256 then click_id then external_id)",
				signedIdentityResolutionOrder, want)
		}
	}
}

// The digest is computed over the LOWERCASED address, matching the PRD's
// client-side contract. subscribers.email is citext — compared
// case-insensitively but stored with whatever case it arrived in — so without
// lower() a customer whose address was imported as "Buyer@Example.test" would
// silently never resolve.
func TestSignedIngestResolvesAStoredMixedCaseAddress(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	stored := "Mixed.Case@Example.Test"
	seedIdentitySubscriber(t, pool, ctx, tenantID, stored, "")

	body := []byte(`{"event_name":"purchase","value":7.50,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC("mixed.case@example.test") + `"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)
	got := readConversion(t, pool, ctx, tenantID, ids[0])
	if got.Email != "mixed.case@example.test" {
		t.Fatalf("subscriber_email = %q, want the lowercased address — the digest "+
			"contract is over lower(email)", got.Email)
	}
}

// ---------------------------------------------------------------------------
// 2. An unresolved identity is STORED
// ---------------------------------------------------------------------------

// A conversion whose identity resolves to nobody is recorded anyway.
//
// Dropping it would discard money that actually moved. The buyer exists and
// paid; the only thing missing is our ability to name them, and turning a gap in
// our identity graph into a gap in the customer's revenue is the worst possible
// trade. It lands attributed_via='none' with every identifier it presented still
// on the row, so a later pass can revisit it.
func TestSignedIngestStoresConversionsWhoseIdentityResolvesToNothing(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	if before := countTenantConversions(t, pool, ctx, tenantID); before != 0 {
		t.Fatalf("fixture tenant already holds %d conversions", before)
	}

	unknownHash := emailHMAC("nobody-here@example.test")
	body := []byte(`{"event_name":"purchase","value":42.50,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + unknownHash + `",` +
		`"external_id":"never-seen-before"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)
	if len(ids) != 1 {
		t.Fatalf("ids = %v, want one conversion id even though the identity resolved "+
			"to nobody", ids)
	}
	if total := countTenantConversions(t, pool, ctx, tenantID); total != 1 {
		t.Fatalf("tenant holds %d conversions, want 1 — an unresolved identity must "+
			"never cost the revenue row", total)
	}

	stored := readConversion(t, pool, ctx, tenantID, ids[0])
	if stored.AmountCents == nil || *stored.AmountCents != 4250 {
		t.Fatalf("amount_cents = %v, want 4250 — the money is the fact this "+
			"endpoint exists to record", stored.AmountCents)
	}
	if stored.Currency != "USD" {
		t.Errorf("currency = %q, want USD", stored.Currency)
	}
	if stored.Email != "" {
		t.Errorf("subscriber_email = %q, want empty — nothing resolved", stored.Email)
	}
	if stored.CampaignID != "" {
		t.Errorf("campaign_id = %q, want empty", stored.CampaignID)
	}
	if stored.AttributedVia != AttributedViaNone {
		t.Errorf("attributed_via = %q, want %q — the honest description of a "+
			"conversion with no evidence behind it", stored.AttributedVia, AttributedViaNone)
	}
	// The identifiers survive, so a later resolution pass has something to work
	// with when the subscriber finally appears.
	if stored.EmailHMAC != unknownHash {
		t.Errorf("email_hmac_sha256 = %q, want the presented digest preserved", stored.EmailHMAC)
	}
	if stored.EmailHMACKeyID != keyID {
		t.Errorf("email_hmac_key_id = %q, want authenticated key %q", stored.EmailHMACKeyID, keyID)
	}
	if stored.ExternalID != "never-seen-before" {
		t.Errorf("external_id = %q, want the presented value preserved", stored.ExternalID)
	}
}

// ---------------------------------------------------------------------------
// 3. ALL touches, not only the winner
// ---------------------------------------------------------------------------

// Every in-window click is recorded, not just the one last-touch credited.
//
// Last-touch keeps one click and discards the rest. first-touch, linear and
// time-decay need exactly the ones it discards, and after ingest they are
// unrecoverable — the customer's commerce system will not still hold a purchase
// from three months ago. Storing them is what makes a different attribution
// model computable later without re-ingesting anything.
func TestSignedIngestRecordsEveryTouchNotOnlyTheWinningOne(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	buyer := "multi-touch@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")

	oldest := createAttributionCampaign(t, pool, ctx, tenantID, "Oldest")
	middle := createAttributionCampaign(t, pool, ctx, tenantID, "Middle")
	newest := createAttributionCampaign(t, pool, ctx, tenantID, "Newest")
	expired := createAttributionCampaign(t, pool, ctx, tenantID, "Expired")

	occurred := now.Add(-time.Minute)
	seedClickEvent(t, pool, ctx, tenantID, expired, buyer, occurred.Add(-30*24*time.Hour))
	seedClickEvent(t, pool, ctx, tenantID, oldest, buyer, occurred.Add(-96*time.Hour))
	seedClickEvent(t, pool, ctx, tenantID, middle, buyer, occurred.Add(-48*time.Hour))
	seedClickEvent(t, pool, ctx, tenantID, newest, buyer, occurred.Add(-2*time.Hour))

	body := []byte(`{"event_name":"purchase","value":88.00,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)
	stored := readConversion(t, pool, ctx, tenantID, ids[0])

	if stored.CampaignID != newest {
		t.Fatalf("campaign_id = %q, want the most recent in-window click %q",
			stored.CampaignID, newest)
	}

	touches := readTouches(t, pool, ctx, tenantID, ids[0])
	clicks := map[string]storedTouch{}
	identities := []storedTouch{}
	for _, touch := range touches {
		switch touch.TouchKind {
		case touchKindCampaignClick:
			clicks[touch.CampaignID] = touch
		case touchKindIdentity:
			identities = append(identities, touch)
		}
	}

	if len(clicks) != 3 {
		t.Fatalf("recorded %d campaign touches (%v), want 3 — the two clicks "+
			"last-touch discarded are precisely what a first-touch or linear model "+
			"needs, and they cannot be recovered after ingest",
			len(clicks), touches)
	}
	for _, want := range []string{oldest, middle, newest} {
		if _, ok := clicks[want]; !ok {
			t.Errorf("campaign %q has no recorded touch", want)
		}
	}
	if _, leaked := clicks[expired]; leaked {
		t.Errorf("a click 30 days before the conversion was recorded as a touch; "+
			"the touch ledger must use the same %v window as attribution, or two "+
			"reports over one conversion will disagree about what counted",
			lastTouchAttributionWindow)
	}

	winners := 0
	for campaignID, touch := range clicks {
		if touch.IsWinner {
			winners++
			if campaignID != newest {
				t.Errorf("is_winner marks %q, want %q — the winner must name the "+
					"touch that produced the STORED attribution or a recomputation "+
					"cannot be diffed against it", campaignID, newest)
			}
		}
		if touch.SubscriberID != buyerID {
			t.Errorf("touch for %q has subscriber_id %q, want %q",
				campaignID, touch.SubscriberID, buyerID)
		}
	}
	if winners != 1 {
		t.Errorf("%d touches marked is_winner, want exactly 1", winners)
	}

	if len(identities) != 1 {
		t.Fatalf("recorded %d identity touches, want 1", len(identities))
	}
	if identities[0].IdentityKind != identityKindEmailHMACSHA256 ||
		!identities[0].IsWinner || identities[0].SubscriberID != buyerID {
		t.Errorf("identity touch = %+v, want the winning email_hmac_sha256 row resolving "+
			"to %q", identities[0], buyerID)
	}
	if identities[0].ResolutionRank != 1 {
		t.Errorf("resolution_rank = %d, want 1 — the rank is what lets a later model "+
			"replay a DIFFERENT priority order", identities[0].ResolutionRank)
	}
	if identities[0].IdentityKeyID != keyID {
		t.Errorf("identity_key_id = %q, want authenticated key %q",
			identities[0].IdentityKeyID, keyID)
	}
}

// The identifiers that LOST resolution are recorded too, with what they would
// have resolved to.
//
// Without them a different resolution order is not recomputable: the payload is
// gone, and "external_id cust-9 would have named subscriber B" is a fact that
// exists nowhere else. Recording only the winner would make the touch table a
// prettier copy of the conversion row.
func TestSignedIngestRecordsLosingIdentityCandidates(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	winner := "wins@example.test"
	loser := "loses@example.test"
	winnerID := seedIdentitySubscriber(t, pool, ctx, tenantID, winner, "")
	loserID := seedIdentitySubscriber(t, pool, ctx, tenantID, loser, "cust-9")

	body := []byte(`{"event_name":"purchase","value":10.00,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(winner) + `",` +
		`"external_id":"cust-9"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)

	stored := readConversion(t, pool, ctx, tenantID, ids[0])
	if stored.Email != winner {
		t.Fatalf("subscriber_email = %q, want %q", stored.Email, winner)
	}

	byKind := map[string]storedTouch{}
	for _, touch := range readTouches(t, pool, ctx, tenantID, ids[0]) {
		if touch.TouchKind == touchKindIdentity {
			byKind[touch.IdentityKind] = touch
		}
	}
	if len(byKind) != 2 {
		t.Fatalf("recorded %d identity candidates (%v), want 2", len(byKind), byKind)
	}

	hashTouch := byKind[identityKindEmailHMACSHA256]
	if !hashTouch.IsWinner || hashTouch.SubscriberID != winnerID || hashTouch.ResolutionRank != 1 {
		t.Errorf("email_hmac_sha256 touch = %+v, want winner rank 1 resolving to %q",
			hashTouch, winnerID)
	}
	if hashTouch.IdentityKeyID != keyID {
		t.Errorf("email HMAC evidence key = %q, want %q", hashTouch.IdentityKeyID, keyID)
	}
	externalTouch := byKind[identityKindExternalID]
	if externalTouch.IsWinner {
		t.Errorf("external_id touch is marked winner; email_hmac_sha256 outranks it")
	}
	if externalTouch.SubscriberID != loserID {
		t.Errorf("external_id touch resolved to %q, want %q — the LOSING candidate's "+
			"resolution is the whole input a different priority order would need",
			externalTouch.SubscriberID, loserID)
	}
	if externalTouch.ResolutionRank != 3 {
		t.Errorf("external_id rank = %d, want 3", externalTouch.ResolutionRank)
	}
	if externalTouch.IdentityValue != "cust-9" {
		t.Errorf("external_id touch value = %q, want cust-9", externalTouch.IdentityValue)
	}
}

// ---------------------------------------------------------------------------
// 4. The click-identity ledger
// ---------------------------------------------------------------------------

// A click id whose owner a STRONGER identifier revealed becomes resolvable on
// its own afterwards.
//
// This is what stops the click-id path from being permanently dead for
// customers whose click ids we never issued: the first conversion that carries
// both a digest and a click id teaches us the binding, and the next conversion
// carrying only that click id resolves instead of landing anonymous forever.
func TestSignedIngestLearnsAClickIdentityFromAStrongerIdentifier(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	buyer := "teaches-us@example.test"
	seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")
	clickID := "clk-" + uuid.NewString()

	// Before: the click id names nobody.
	cold := []byte(`{"event_name":"purchase","value":1.00,"currency":"USD",` +
		`"identity":{"click_id":"` + clickID + `"}}`)
	coldIDs := ingestSigned(t, router, secret, keyID, cold, now)
	if got := readConversion(t, pool, ctx, tenantID, coldIDs[0]); got.Email != "" {
		t.Fatalf("an unknown click id resolved to %q before anything taught us the "+
			"binding; the test cannot prove learning", got.Email)
	}

	// The payload that teaches us.
	both := []byte(`{"event_name":"purchase","value":2.00,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `",` +
		`"click_id":"` + clickID + `"}}`)
	ingestSigned(t, router, secret, keyID, both, now)

	// After: the same click id, alone, now names the buyer.
	warm := []byte(`{"event_name":"purchase","value":3.00,"currency":"USD",` +
		`"identity":{"click_id":"` + clickID + `"}}`)
	warmIDs := ingestSigned(t, router, secret, keyID, warm, now)
	got := readConversion(t, pool, ctx, tenantID, warmIDs[0])
	if got.Email != buyer {
		t.Fatalf("subscriber_email = %q, want %q — a click id seen alongside a "+
			"resolving digest must become resolvable on its own", got.Email, buyer)
	}
}

// An inferred binding must never overwrite the authoritative one.
//
// The tracked-link redirect knows the campaign as well as the person; the
// signed-feed inference knows only the person. Letting the weaker write win
// would quietly delete the campaign, and the deletion would look like a
// conversion that simply had no campaign to attribute to.
func TestAnObservedClickBindingNeverOverwritesTheAuthoritativeOne(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	recipient := "recipient@example.test"
	other := "other-buyer@example.test"
	recipientID := seedIdentitySubscriber(t, pool, ctx, tenantID, recipient, "")
	seedIdentitySubscriber(t, pool, ctx, tenantID, other, "")

	campaign := createAttributionCampaign(t, pool, ctx, tenantID, "Authoritative")
	clickID := "clk-" + uuid.NewString()
	seedClickIdentity(t, pool, ctx, tenantID, clickID, recipientID, campaign,
		now.Add(-time.Hour))

	// A conversion whose digest names somebody ELSE, carrying the same click id.
	body := []byte(`{"event_name":"purchase","value":4.00,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(other) + `",` +
		`"click_id":"` + clickID + `"}}`)
	ingestSigned(t, router, secret, keyID, body, now)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID, campaignID, source string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(subscriber_id::text, ''), COALESCE(campaign_id::text, ''), source
  FROM conversion_click_identities
 WHERE tenant_id = $1::uuid AND click_id = $2`, tenantID, clickID).
		Scan(&subscriberID, &campaignID, &source); err != nil {
		t.Fatalf("read click identity: %v", err)
	}
	if subscriberID != recipientID {
		t.Errorf("subscriber_id = %q, want the authoritative %q", subscriberID, recipientID)
	}
	if campaignID != campaign {
		t.Errorf("campaign_id = %q, want %q preserved — the weaker inference knows "+
			"no campaign and must not erase one", campaignID, campaign)
	}
	if source != clickIdentitySourceLinkClick {
		t.Errorf("source = %q, want %q", source, clickIdentitySourceLinkClick)
	}
}

// The resolved person also carries the non-campaign edges, through the SAME
// machinery the browser ingest uses.
//
// A second attribution implementation would eventually disagree with the first
// about the same conversion, and the disagreement surfaces as a customer asking
// why two reports show different revenue for one flow.
func TestSignedIngestResolvesStructuralEdgesForTheResolvedPerson(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	buyer := "flow-member@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")

	occurred := now.Add(-time.Minute)
	flowID := seedIdentityFlowRun(t, pool, ctx, tenantID, buyerID, occurred.Add(-2*time.Hour))

	body := []byte(`{"event_name":"purchase","value":15.00,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)
	stored := readConversion(t, pool, ctx, tenantID, ids[0])
	if stored.FlowID != flowID {
		t.Fatalf("flow_id = %q, want %q — an identity that resolved must pick up the "+
			"same structural edges the browser ingest would give it",
			stored.FlowID, flowID)
	}
}

// unfencedClickPartitionStart finds a campaign_report_events partition that has
// NO foreign key to campaigns, and returns a timestamp that routes into it.
//
// campaign_report_events is partitioned by `at`. The campaign foreign key was
// only ever attached to the legacy partition; the monthly partitions the
// rotator creates do not carry it, so a click stored in one of them can outlive
// the campaign it names. That is the state this fixture reproduces.
func unfencedClickPartitionStart(
	t *testing.T, pool *db.Pool, ctx context.Context,
) (time.Time, bool) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, randUUID(t))
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var start time.Time
	err = tx.QueryRow(ctx, `
SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\)'))[1]::timestamptz
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
 WHERE i.inhparent = 'campaign_report_events'::regclass
   AND pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES FROM%'
   AND NOT EXISTS (
       SELECT 1 FROM pg_constraint fk
        WHERE fk.conrelid = c.oid
          AND fk.contype = 'f'
          AND fk.confrelid = 'campaigns'::regclass)
 ORDER BY 1 DESC
 LIMIT 1`).Scan(&start)
	if err != nil {
		return time.Time{}, false
	}
	return start.UTC(), true
}

// A click naming a DELETED campaign costs the attribution, never the money.
//
// The campaign foreign key on campaign_report_events lives only on the legacy
// partition, so a click in any monthly partition can outlive the campaign it
// points at. conversions.campaign_id DOES have that foreign key. Writing the id
// straight through would raise a constraint violation that fails the entire
// signed batch — up to 500 conversions of real revenue lost because somebody
// tidied up one campaign — and the caller would get a 500 explaining nothing.
func TestAClickNamingADeletedCampaignStillStoresTheRevenue(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	partitionStart, ok := unfencedClickPartitionStart(t, pool, ctx)
	if !ok {
		t.Skip("every campaign_report_events partition now fences campaign_id with a " +
			"foreign key, so a click can no longer outlive its campaign")
	}

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	// The clock is moved into the unfenced partition so the click routes there.
	// Signature freshness is evaluated against this same injected clock, so the
	// request is still perfectly valid.
	now := partitionStart.Add(2 * time.Hour)
	router := signedRouter(pool, now)

	buyer := "orphan-click@example.test"
	seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")

	// A click pointing at a campaign id that does not exist — the exact state
	// left behind by deleting a campaign whose clicks live in this partition.
	ghost := randUUID(t)
	occurred := now
	seedClickEvent(t, pool, ctx, tenantID, ghost, buyer, partitionStart.Add(time.Hour))

	body := []byte(`{"event_name":"purchase","value":250.00,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)

	stored := readConversion(t, pool, ctx, tenantID, ids[0])
	if stored.AmountCents == nil || *stored.AmountCents != 25000 {
		t.Fatalf("amount_cents = %v, want 25000 — a deleted campaign must cost the "+
			"attribution, never the revenue", stored.AmountCents)
	}
	if stored.CampaignID != "" {
		t.Errorf("campaign_id = %q, want empty for a campaign that no longer exists",
			stored.CampaignID)
	}
	if stored.AttributedVia != AttributedViaNone {
		t.Errorf("attributed_via = %q, want %q", stored.AttributedVia, AttributedViaNone)
	}
	if stored.Email != buyer {
		t.Errorf("subscriber_email = %q, want %q — the PERSON still resolved",
			stored.Email, buyer)
	}
	// And the touch ledger skips the orphan rather than aborting on it, which
	// would have taken the valid touches down with it.
	for _, touch := range readTouches(t, pool, ctx, tenantID, ids[0]) {
		if touch.TouchKind == touchKindCampaignClick {
			t.Errorf("recorded a touch for the deleted campaign %q", touch.CampaignID)
		}
	}
}

// ---------------------------------------------------------------------------
// 5. Tenant isolation on the two new tables
// ---------------------------------------------------------------------------

// A second tenant can neither read nor mutate the first tenant's touch ledger.
//
// Worth asserting rather than assuming, because RLS FILTERS, it does not
// REFUSE: a table with a SELECT-only policy lets a cross-tenant UPDATE match
// zero rows and report success, and the attacker's correction looks like it
// worked while the victim's data is untouched. The interesting half of this
// test is therefore the WRITES, not the read.
func TestTheIdentityLedgersAreTenantIsolated(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	ownerTenant, keyID, secret := signedIngestFixture(t, pool)
	intruderTenant := createAttributionTenant(t, pool, ctx)

	buyer := "isolated@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, ownerTenant, buyer, "")
	clickID := "clk-" + uuid.NewString()
	seedClickIdentity(t, pool, ctx, ownerTenant, clickID, buyerID, "", time.Now().UTC())

	now := time.Now().UTC()
	router := signedRouter(pool, now)
	body := []byte(`{"event_name":"purchase","value":33.00,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)

	// The owner sees its own evidence — otherwise the isolation assertions below
	// would hold trivially for a ledger that is simply empty.
	if own := readTouches(t, pool, ctx, ownerTenant, ids[0]); len(own) == 0 {
		t.Fatal("the owning tenant sees no touches; the isolation check would be vacuous")
	}

	tx, err := db.WithTenant(ctx, pool, intruderTenant)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var visible int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM conversion_attribution_touches WHERE conversion_id = $1`,
		ids[0]).Scan(&visible); err != nil {
		t.Fatalf("cross-tenant select: %v", err)
	}
	if visible != 0 {
		t.Errorf("a second tenant sees %d of another tenant's attribution touches", visible)
	}

	var clicksVisible int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM conversion_click_identities WHERE click_id = $1`,
		clickID).Scan(&clicksVisible); err != nil {
		t.Fatalf("cross-tenant click select: %v", err)
	}
	if clicksVisible != 0 {
		t.Errorf("a second tenant sees %d of another tenant's click bindings", clicksVisible)
	}

	// The write half. A missing UPDATE/DELETE policy would make both of these
	// silently affect zero rows AND report success, so the row count is the
	// assertion.
	tag, err := tx.Exec(ctx, `
UPDATE conversion_attribution_touches SET is_winner = NOT is_winner
 WHERE conversion_id = $1`, ids[0])
	if err != nil {
		t.Fatalf("cross-tenant update: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Errorf("a second tenant rewrote %d attribution touches", tag.RowsAffected())
	}

	tag, err = tx.Exec(ctx, `
DELETE FROM conversion_click_identities WHERE click_id = $1`, clickID)
	if err != nil {
		t.Fatalf("cross-tenant delete: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Errorf("a second tenant deleted %d click bindings", tag.RowsAffected())
	}

	// And an insert that claims the victim's tenant_id must be REFUSED by
	// WITH CHECK, not silently accepted under the intruder's own scope.
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_click_identities (tenant_id, click_id, subscriber_id)
VALUES ($1::uuid, $2, $3::uuid)`,
		ownerTenant, "forged-"+uuid.NewString(), buyerID); err == nil {
		t.Error("a second tenant inserted a click binding into another tenant's ledger")
	}
	_ = tx.Rollback(ctx)

	// The owner's rows are untouched.
	after := readTouches(t, pool, ctx, ownerTenant, ids[0])
	winners := 0
	for _, touch := range after {
		if touch.IsWinner {
			winners++
		}
	}
	if winners != 1 {
		t.Errorf("%d winning touches after the cross-tenant write attempt, want 1", winners)
	}
}

// seedIdentityFlowRun creates a flow and enrols the subscriber in it.
func seedIdentityFlowRun(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID, subscriberID string, at time.Time,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var flowID string
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_journeys (tenant_id, name, status)
VALUES ($1::uuid, 'Signed ingest edge', 'active')
RETURNING id::text`, tenantID).Scan(&flowID); err != nil {
		t.Fatalf("insert journey: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO flow_runs (tenant_id, flow_id, subscriber_id, status, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', $4)`,
		tenantID, flowID, subscriberID, at); err != nil {
		t.Fatalf("insert flow run: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit flow run: %v", err)
	}
	return flowID
}

// ---------------------------------------------------------------------------
// 6. A refused touch must not take the rest of the ledger with it
// ---------------------------------------------------------------------------

// A click naming a DELETED campaign leaves every OTHER piece of evidence intact.
//
// The sibling test above proves the deleted campaign does not cost the money.
// This one proves it does not cost the EVIDENCE, which is a different and
// strictly harder claim, and the one the campaigns JOIN in
// insertCampaignClickTouches actually exists to make.
//
// Without that JOIN the orphan raises a foreign-key violation, and PostgreSQL's
// ROLLBACK TO SAVEPOINT undoes everything since the savepoint rather than the
// one statement that failed. The identity rows — the only surviving record of
// what each presented identifier resolved to, unreconstructible once the
// payload is gone — are erased by a click id the buyer never even sent. The
// caller still receives its 202, so nothing anywhere reports the loss.
//
// Asserting only "no touch for the ghost campaign" cannot see any of that: it
// is equally true of a ledger that was written correctly and of a ledger that
// was wiped. So this test asserts what SURVIVED.
func TestAnOrphanClickLeavesTheRestOfTheEvidenceIntact(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	partitionStart, ok := unfencedClickPartitionStart(t, pool, ctx)
	if !ok {
		t.Skip("every campaign_report_events partition now fences campaign_id with a " +
			"foreign key, so a click can no longer outlive its campaign")
	}

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := partitionStart.Add(2 * time.Hour)
	router := signedRouter(pool, now)

	buyer := "orphan-survivor@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "cust-survivor")

	// Two clicks in the same unfenced partition: one on a campaign that still
	// exists, one on a campaign id that does not. The live click is the more
	// recent, so last-touch credits it and the orphan is a losing touch — the
	// ordinary shape of a tenant who deleted one old campaign.
	live := createAttributionCampaign(t, pool, ctx, tenantID, "Still here")
	ghost := randUUID(t)
	seedClickEvent(t, pool, ctx, tenantID, ghost, buyer, partitionStart.Add(30*time.Minute))
	seedClickEvent(t, pool, ctx, tenantID, live, buyer, partitionStart.Add(time.Hour))

	occurred := now
	body := []byte(`{"event_name":"purchase","value":410.00,"currency":"USD",` +
		`"occurred_at":"` + occurred.Format(time.RFC3339Nano) + `",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC(buyer) + `",` +
		`"external_id":"cust-survivor"}}`)
	ids := ingestSigned(t, router, secret, keyID, body, now)

	stored := readConversion(t, pool, ctx, tenantID, ids[0])
	if stored.AmountCents == nil || *stored.AmountCents != 41000 {
		t.Fatalf("amount_cents = %v, want 41000", stored.AmountCents)
	}
	// The live campaign winning is what makes the rest of this test meaningful:
	// it proves the orphan really was one of several touches rather than the
	// only one, so "the ledger kept the others" is a claim with content.
	if stored.CampaignID != live {
		t.Fatalf("campaign_id = %q, want the still-existing campaign %q — the "+
			"fixture must produce a MIX of valid and orphaned touches or this "+
			"test proves nothing", stored.CampaignID, live)
	}

	identities := map[string]storedTouch{}
	clicks := map[string]storedTouch{}
	for _, touch := range readTouches(t, pool, ctx, tenantID, ids[0]) {
		switch touch.TouchKind {
		case touchKindIdentity:
			identities[touch.IdentityKind] = touch
		case touchKindCampaignClick:
			clicks[touch.CampaignID] = touch
		}
	}

	// THE ASSERTION THIS TEST EXISTS FOR. Both identifiers the payload carried
	// are still on record, still resolving to the buyer, after a foreign-key
	// hazard passed through the same savepoint.
	if len(identities) != 2 {
		t.Fatalf("recorded %d identity touches (%v), want 2 — one orphaned click "+
			"id erased the identity evidence for a conversion that had nothing "+
			"to do with it", len(identities), identities)
	}
	hashTouch, ok := identities[identityKindEmailHMACSHA256]
	if !ok {
		t.Fatalf("the email_hmac_sha256 identity touch is gone; identities = %v", identities)
	}
	if hashTouch.IdentityValue != emailHMAC(buyer) || hashTouch.SubscriberID != buyerID ||
		!hashTouch.IsWinner || hashTouch.ResolutionRank != 1 {
		t.Errorf("email_hmac_sha256 touch = %+v, want the winning rank-1 row carrying "+
			"digest %q and subscriber %q", hashTouch, emailHMAC(buyer), buyerID)
	}
	externalTouch, ok := identities[identityKindExternalID]
	if !ok {
		t.Fatalf("the external_id identity touch is gone; identities = %v", identities)
	}
	if externalTouch.IdentityValue != "cust-survivor" || externalTouch.SubscriberID != buyerID ||
		externalTouch.ResolutionRank != 3 {
		t.Errorf("external_id touch = %+v, want the rank-3 row carrying "+
			"cust-survivor and subscriber %q", externalTouch, buyerID)
	}

	// And the click that is still valid survived alongside it.
	if len(clicks) != 1 {
		t.Fatalf("recorded %d campaign touches (%v), want exactly 1 — the live "+
			"click, and not the orphan", len(clicks), clicks)
	}
	liveTouch, ok := clicks[live]
	if !ok {
		t.Fatalf("the touch for the still-existing campaign %q is gone; clicks = %v",
			live, clicks)
	}
	if !liveTouch.IsWinner || liveTouch.SubscriberID != buyerID {
		t.Errorf("live campaign touch = %+v, want the winning row for subscriber %q",
			liveTouch, buyerID)
	}
	if _, leaked := clicks[ghost]; leaked {
		t.Errorf("recorded a touch for the deleted campaign %q", ghost)
	}
}

// seedBareConversion inserts a minimal conversion fact and returns its id, so a
// touch-ledger test can address a real row without going through the whole
// signed HTTP path.
func seedBareConversion(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email string, at time.Time,
) int64 {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, subscriber_email, amount_cents,
                         currency, occurred_at, attributed_via)
VALUES ($1::uuid, 'purchase', NULLIF($2, ''), 1500, 'USD', $3, 'none')
RETURNING id`, tenantID, email, at).Scan(&id); err != nil {
		t.Fatalf("insert conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion: %v", err)
	}
	return id
}

// deleteSubscriber removes a subscriber in its own committed transaction, which
// is what an erasure job does while an ingest is mid-flight.
func deleteSubscriber(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID, subscriberID string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriberID)
	if err != nil {
		t.Fatalf("delete subscriber: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("deleted %d subscribers, want 1 — the fixture must really remove "+
			"the row or the failure it is meant to cause never happens",
			tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber delete: %v", err)
	}
}

// A campaign-click phase that FAILS outright must not delete the identity
// evidence, and the click binding must survive both.
//
// The campaigns JOIN handles the one failure we anticipated. This asserts the
// property that has to hold for the failures we did NOT anticipate, because
// that is what the savepoint layout decides: with all three writes sharing one
// savepoint, any single refused row silently erases every row written before
// it, and the endpoint still answers 202.
//
// The failure here is real and reachable, not simulated: an erasure job commits
// a subscriber delete after resolution read that subscriber and before the
// touches are written, so the campaign-click insert meets a foreign key whose
// target has just gone. No mock, no injected error — the database refuses the
// row for the same reason it would in production.
func TestARefusedCampaignPhaseDoesNotEraseTheIdentityEvidence(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	now := time.Now().UTC()

	buyer := "phase-isolation@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")
	// The person resolution named, who is then erased out from under the write.
	vanishing := seedIdentitySubscriber(t, pool, ctx, tenantID, "erased@example.test", "")
	campaignID := createAttributionCampaign(t, pool, ctx, tenantID, "Live campaign")
	conversionID := seedBareConversion(t, pool, ctx, tenantID, buyer, now)

	resolved := newResolvedIdentity()
	resolved.candidates = []identityCandidate{{
		kind: identityKindEmailHMACSHA256, value: emailHMAC(buyer),
		keyID: "test-hmac-key", rank: 1,
		subscriberID: buyerID, email: buyer,
	}}
	resolved.winner = 0
	resolved.subscriberID = vanishing
	resolved.email = buyer
	resolved.touches = []campaignTouch{{campaignID: campaignID, touchedAt: now.Add(-time.Hour)}}
	resolved.winningTouch = 0
	// No observed click id: the binding phase writes the SAME subscriber and
	// would be refused for the same reason, which would confuse "this phase was
	// isolated" with "this phase never ran". Its isolation is asserted on its
	// own below.

	deleteSubscriber(t, pool, ctx, tenantID, vanishing)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	degraded, savepointErr := recordIdentityEvidence(ctx, tx, tenantID, conversionID, resolved, now)
	if savepointErr != nil {
		t.Fatalf("savepoint recovery failed: %v", savepointErr)
	}
	// Guard the guard: if nothing was refused, everything below is vacuous.
	if degraded == nil {
		t.Fatal("the campaign-click phase was expected to be refused by the " +
			"subscriber foreign key and was not; this test would then assert " +
			"nothing about failure isolation")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit after a degraded phase: %v — a best-effort phase failure "+
			"must leave the transaction committable", err)
	}

	identities := 0
	clicks := 0
	for _, touch := range readTouches(t, pool, ctx, tenantID, conversionID) {
		switch touch.TouchKind {
		case touchKindIdentity:
			identities++
			if touch.IdentityValue != emailHMAC(buyer) || touch.SubscriberID != buyerID ||
				!touch.IsWinner || touch.ResolutionRank != 1 {
				t.Errorf("identity touch = %+v, want the winning rank-1 row carrying "+
					"digest %q and subscriber %q", touch, emailHMAC(buyer), buyerID)
			}
		case touchKindCampaignClick:
			clicks++
		}
	}
	if identities != 1 {
		t.Errorf("recorded %d identity touches, want 1 — the refused campaign phase "+
			"deleted the identity evidence, which is the only copy of what the "+
			"payload's identifiers resolved to", identities)
	}
	if clicks != 0 {
		t.Errorf("recorded %d campaign touches, want 0 — the phase was refused", clicks)
	}
}

// A refused IDENTITY phase must not stop the phases after it from running.
//
// The other direction of the same property, and the one a naive "return on the
// first error" fix would break: an earlier failure must degrade that phase
// only, not abandon the rest of the ledger. Recomputing attribution needs the
// clicks whether or not the identity rows landed, and the two are collected
// from different tables for different reasons.
//
// The refusal is again a real erased subscriber — this time the one the WINNING
// candidate resolved to, which is exactly what an erasure job commits while a
// batch is mid-flight.
func TestARefusedIdentityPhaseStillWritesTheCampaignTouches(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	now := time.Now().UTC()

	buyer := "identity-phase-fails@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")
	vanishing := seedIdentitySubscriber(t, pool, ctx, tenantID, "erased3@example.test", "")
	campaignID := createAttributionCampaign(t, pool, ctx, tenantID, "Survives the identity phase")
	conversionID := seedBareConversion(t, pool, ctx, tenantID, buyer, now)

	resolved := newResolvedIdentity()
	// The CANDIDATE names the erased subscriber, so the identity phase is refused
	// while everything downstream of it is perfectly writable.
	resolved.candidates = []identityCandidate{{
		kind: identityKindEmailHMACSHA256, value: emailHMAC(buyer),
		keyID: "test-hmac-key", rank: 1,
		subscriberID: vanishing, email: buyer,
	}}
	resolved.winner = 0
	resolved.subscriberID = buyerID
	resolved.email = buyer
	resolved.touches = []campaignTouch{{campaignID: campaignID, touchedAt: now.Add(-time.Hour)}}
	resolved.winningTouch = 0
	resolved.observedClickID = "clk-" + uuid.NewString()

	deleteSubscriber(t, pool, ctx, tenantID, vanishing)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	degraded, savepointErr := recordIdentityEvidence(ctx, tx, tenantID, conversionID, resolved, now)
	if savepointErr != nil {
		t.Fatalf("savepoint recovery failed: %v", savepointErr)
	}
	if degraded == nil {
		t.Fatal("the identity phase was expected to be refused by the subscriber " +
			"foreign key and was not; the assertions below would then hold for a " +
			"run in which nothing failed at all")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit after a degraded phase: %v", err)
	}

	identities := 0
	clicks := 0
	for _, touch := range readTouches(t, pool, ctx, tenantID, conversionID) {
		switch touch.TouchKind {
		case touchKindIdentity:
			identities++
		case touchKindCampaignClick:
			clicks++
			if touch.CampaignID != campaignID || !touch.IsWinner || touch.SubscriberID != buyerID {
				t.Errorf("campaign touch = %+v, want the winning row for campaign %q "+
					"and subscriber %q", touch, campaignID, buyerID)
			}
		}
	}
	if identities != 0 {
		t.Errorf("recorded %d identity touches, want 0 — the phase was refused", identities)
	}
	if clicks != 1 {
		t.Errorf("recorded %d campaign touches, want 1 — a failure in an EARLIER "+
			"phase abandoned evidence that had nothing wrong with it", clicks)
	}
	if !clickIdentityExists(t, pool, ctx, tenantID, resolved.observedClickID) {
		t.Errorf("the click-id binding %q is missing; the phase after a refused one "+
			"must still run", resolved.observedClickID)
	}
}

// A refused click-binding phase must not delete the touches written before it.
//
// Same property from the other end: the LAST phase is the one whose failure a
// shared savepoint punishes hardest, because everything else is already
// written. Here the touches are perfectly valid — the binding alone is refused,
// by the same erased-subscriber foreign key.
func TestARefusedClickBindingDoesNotEraseTheTouches(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	now := time.Now().UTC()

	buyer := "binding-isolation@example.test"
	buyerID := seedIdentitySubscriber(t, pool, ctx, tenantID, buyer, "")
	vanishing := seedIdentitySubscriber(t, pool, ctx, tenantID, "erased2@example.test", "")
	conversionID := seedBareConversion(t, pool, ctx, tenantID, buyer, now)

	resolved := newResolvedIdentity()
	resolved.candidates = []identityCandidate{{
		kind: identityKindEmailHMACSHA256, value: emailHMAC(buyer),
		keyID: "test-hmac-key", rank: 1,
		subscriberID: buyerID, email: buyer,
	}}
	resolved.winner = 0
	// No campaign touches, so the campaign phase is a no-op and the ONLY thing
	// that can fail is the binding — which writes resolved.subscriberID.
	resolved.subscriberID = vanishing
	resolved.email = buyer
	resolved.observedClickID = "clk-" + uuid.NewString()

	deleteSubscriber(t, pool, ctx, tenantID, vanishing)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	degraded, savepointErr := recordIdentityEvidence(ctx, tx, tenantID, conversionID, resolved, now)
	if savepointErr != nil {
		t.Fatalf("savepoint recovery failed: %v", savepointErr)
	}
	if degraded == nil {
		t.Fatal("the click-binding phase was expected to be refused by the " +
			"subscriber foreign key and was not; the isolation claim below would " +
			"then be vacuous")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit after a degraded phase: %v", err)
	}

	identities := 0
	for _, touch := range readTouches(t, pool, ctx, tenantID, conversionID) {
		if touch.TouchKind == touchKindIdentity {
			identities++
		}
	}
	if identities != 1 {
		t.Errorf("recorded %d identity touches, want 1 — a refused click binding "+
			"deleted the identity evidence written before it", identities)
	}
	if clickIdentityExists(t, pool, ctx, tenantID, resolved.observedClickID) {
		t.Errorf("the binding for %q was stored even though its subscriber is gone",
			resolved.observedClickID)
	}
}

func clickIdentityExists(
	t *testing.T, pool *db.Pool, ctx context.Context, tenantID, clickID string,
) bool {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var found bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM conversion_click_identities
     WHERE tenant_id = $1::uuid AND click_id = $2)`, tenantID, clickID).Scan(&found); err != nil {
		t.Fatalf("probe click identity: %v", err)
	}
	return found
}
