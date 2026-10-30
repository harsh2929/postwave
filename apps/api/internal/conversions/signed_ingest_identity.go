// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Identity resolution for the signed conversion ingest (PRD F03).
//
// Migration 1944 gave the signed feed three identity columns and the ingest has
// written them faithfully ever since. Nothing read them. A server-to-server
// conversion therefore landed with no person, no campaign, no flow and no form
// on it: the revenue was recorded and could not be credited to anything. This
// file is the missing read.
//
// It deliberately builds NO parallel attribution machinery. The campaign lookup
// is lookupLastTouchCampaign and the non-campaign edges are
// lookupStructuralEdges — the same functions, the same 7-day window, the same
// occurred_at anchor as the browser ingest and the backfill. Two attribution
// implementations would eventually disagree about the same conversion, and the
// disagreement would surface as a customer asking why two reports show
// different revenue for one campaign.

// The identity kinds accepted as current proof. email_sha256 remains a
// historical database value only; the request boundary rejects it and this
// resolver never treats it as identity evidence.
const (
	identityKindEmailHMACSHA256 = "email_hmac_sha256"
	identityKindClickID         = "click_id"
	identityKindExternalID      = "external_id"
)

// signedIdentityResolutionOrder is the PRD's priority order, expressed as data
// rather than as the shape of an if/else chain.
//
// The ORDER is the contract, so it is one reorderable list that resolution
// iterates and that the stored resolution_rank is derived from. An email digest
// outranks a click id because the two identify different things: a digest names
// a PERSON, while a click id names a device or a link touch that a household,
// a shared machine or a forwarded message can detach from the person who
// received it. A payload carrying both must resolve to the person.
//
// external_id ranks last because it is whatever the customer's own system calls
// someone — authoritative when they set it, absent or stale far more often than
// either of the other two.
var signedIdentityResolutionOrder = []string{
	identityKindEmailHMACSHA256,
	identityKindClickID,
	identityKindExternalID,
}

// Touch kinds in conversion_attribution_touches. See migration 1960.
const (
	touchKindIdentity      = "identity"
	touchKindCampaignClick = "campaign_click"
)

// How a click-id -> subscriber binding was learned. 'link_click' is issued by
// the tracked-link redirect and names the campaign too; the observation is
// inferred here and names only the person.
const (
	clickIdentitySourceLinkClick   = "link_click"
	clickIdentitySourceObservation = "signed_ingest_observation"
)

const (
	// identityResolutionSavepoint isolates the whole read-side resolution.
	//
	// Attribution is best effort and the conversion fact is not: a probe that
	// fails must cost the graph, never the money. Under PostgreSQL a statement
	// error poisons the transaction until ROLLBACK TO SAVEPOINT, so "best
	// effort" without a savepoint would mean the commit failing and the revenue
	// being lost by the very code meant to enrich it.
	identityResolutionSavepoint = "conversion_signed_identity"

	// The write side is THREE phases and each gets its OWN savepoint.
	//
	// One savepoint around all of them would make every phase hostage to every
	// other. ROLLBACK TO SAVEPOINT undoes everything since the savepoint, not
	// merely the statement that failed, so a single refused row in a later phase
	// silently deletes the rows an earlier phase already wrote — and the caller
	// still gets its 202, because the conversion fact itself is fine. The loss
	// is invisible from every surface that could report it.
	//
	// That is not hypothetical. The campaign-click phase writes ids drawn from
	// campaign_report_events, whose monthly partitions do not fence campaign_id
	// while conversion_attribution_touches does, so it is precisely the phase
	// that can meet a row the schema refuses.
	//
	// The asymmetry that decides the split is recoverability. The identity phase
	// is the ONLY copy of what each presented identifier resolved to: the
	// payload is gone after ingest and "external_id cust-9 would have named
	// subscriber B" exists nowhere else. Campaign clicks are still in
	// campaign_report_events, and a click binding is re-learned from the next
	// payload carrying the same click id. Evidence that can be rebuilt must
	// never be able to destroy evidence that cannot.
	identityCandidateWriteSavepoint = "conversion_identity_candidates"
	campaignTouchWriteSavepoint     = "conversion_campaign_touches"
	clickBindingWriteSavepoint      = "conversion_click_binding"

	// maxRecordedTouches bounds how many in-window clicks one conversion may
	// record.
	//
	// A bound exists because this endpoint is reachable by anyone holding a
	// signing secret and an unbounded per-conversion write is a cheap way to
	// turn one request into arbitrarily many rows. The clicks are ordered most
	// recent first, so the bound discards the oldest — the touches every
	// attribution model weights least. A recipient with more than 100 clicks on
	// one address inside seven days is not a shopper.
	maxRecordedTouches = 100
)

// identityCandidate is ONE identifier the payload carried and what it resolved
// to. Losing candidates are kept: they are the entire reason a different
// resolution order can be recomputed later without re-ingesting.
type identityCandidate struct {
	kind  string
	value string
	// keyID names the rotating signing key used for an email HMAC. It is empty
	// for click/external candidates, whose namespace is already tenant-scoped.
	keyID string
	// rank is the 1-based position this kind held in
	// signedIdentityResolutionOrder at the time of ingest.
	rank int
	// subscriberID is "" when this identifier resolved to nobody. That is a
	// RESULT, not a failure: an unknown identity is the ordinary case for a
	// first-time buyer.
	subscriberID string
	email        string
}

// campaignTouch is one click that could have contributed to this conversion.
type campaignTouch struct {
	campaignID string
	touchedAt  time.Time
}

// resolvedIdentity is everything the resolution learned about one conversion.
type resolvedIdentity struct {
	candidates []identityCandidate
	// winner indexes candidates, or -1 when no identifier resolved to anybody.
	winner       int
	subscriberID string
	email        string

	// campaignID / attributedVia are what the conversion row will store.
	campaignID    string
	attributedVia string

	// touches is every in-window click for the resolved person, most recent
	// first, plus the click the caller named when the ledger knows it.
	touches []campaignTouch
	// winningTouch indexes touches, or -1 when no campaign was attributed.
	winningTouch int

	// observedClickID is a click id worth remembering because a STRONGER
	// identifier in the same payload told us who it belongs to.
	observedClickID string

	edges structuralEdges
}

// newResolvedIdentity is the honest zero value: nothing resolved, nothing
// attributed. Every failure path degrades to exactly this rather than to a
// half-populated struct that reads as partial success.
func newResolvedIdentity() resolvedIdentity {
	return resolvedIdentity{
		winner:        -1,
		winningTouch:  -1,
		attributedVia: AttributedViaNone,
	}
}

// resolveSignedIdentity turns a signed conversion's identity into a subscriber,
// a campaign and the full set of touches behind both.
//
// It probes EVERY identifier the payload carried, not merely up to the first
// hit. That costs at most two extra indexed lookups on a batch item and buys
// the one thing the all-touches table exists for: a later model can ask what
// the losing identifiers would have resolved to, which is unanswerable if the
// probes were short-circuited away at ingest and the payload is long gone.
func resolveSignedIdentity(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emailHMACBindings map[string]emailHMACBinding,
	fact signedConversionFact,
	occurredAt time.Time,
) (resolvedIdentity, error) {
	out := newResolvedIdentity()

	presented := map[string]string{
		identityKindEmailHMACSHA256: fact.emailHMACSHA256,
		identityKindClickID:         fact.clickID,
		identityKindExternalID:      fact.externalID,
	}

	// The campaign a presented click id names, learned from the click ledger.
	// Captured independently of whether the click id WON identity resolution:
	// the digest names the person, the click names the touch, and a payload
	// carrying both should get the person from one and the campaign from the
	// other.
	var clickCampaignID string
	var clickTouchedAt time.Time

	for index, kind := range signedIdentityResolutionOrder {
		value := presented[kind]
		if value == "" {
			continue
		}
		candidate := identityCandidate{kind: kind, value: value, rank: index + 1}

		switch kind {
		case identityKindEmailHMACSHA256:
			candidate.keyID = fact.emailHMACKeyID
			binding := emailHMACBindings[value]
			candidate.subscriberID, candidate.email = binding.subscriberID, binding.email
		case identityKindClickID:
			binding, err := lookupClickIdentity(ctx, tx, tenantID, value)
			if err != nil {
				return newResolvedIdentity(), err
			}
			candidate.subscriberID, candidate.email = binding.subscriberID, binding.email
			clickCampaignID, clickTouchedAt = binding.campaignID, binding.clickedAt
		case identityKindExternalID:
			subscriberID, email, err := lookupSubscriberByExternalID(ctx, tx, tenantID, value)
			if err != nil {
				return newResolvedIdentity(), err
			}
			candidate.subscriberID, candidate.email = subscriberID, email
		}

		out.candidates = append(out.candidates, candidate)
		// First resolving candidate in priority order wins. Later ones are still
		// probed and still recorded; they simply do not decide the person.
		if out.winner < 0 && candidate.subscriberID != "" {
			out.winner = len(out.candidates) - 1
			out.subscriberID, out.email = candidate.subscriberID, candidate.email
		}
	}

	// A click id whose owner we now know from a STRONGER identifier is worth
	// remembering, so the next conversion carrying only that click id resolves
	// instead of landing anonymous forever.
	if fact.clickID != "" && out.subscriberID != "" &&
		(out.winner < 0 || out.candidates[out.winner].kind != identityKindClickID) {
		out.observedClickID = fact.clickID
	}

	// Campaign attribution. The click id the caller presented is DIRECT evidence
	// tied to this conversion — the customer's own server captured that touch on
	// the way to this purchase — so it outranks the last-touch heuristic, which
	// only knows "some click, within seven days, by the same person".
	//
	// attributed_via stays 'last_touch' in both cases and no new value joins the
	// vocabulary, because in both cases the EVIDENCE is a click. Inventing a
	// second name for a click would make two reports over the same fact
	// disagree about what happened. Which click won, and how it was named, is
	// recorded in conversion_attribution_touches, where a model can read it
	// without the enum having to carry the distinction.
	if clickCampaignID != "" {
		if clickTouchedAt.IsZero() {
			clickTouchedAt = occurredAt
		}
		out.touches = append(out.touches, campaignTouch{
			campaignID: clickCampaignID, touchedAt: clickTouchedAt,
		})
		out.campaignID, out.attributedVia = clickCampaignID, AttributedViaLastTouch
		out.winningTouch = 0
	}

	if out.email == "" {
		return out, nil
	}

	// Every in-window click, not only the winning one. Last-touch keeps one and
	// discards the rest; first-touch, linear and time-decay need exactly the
	// ones it discards, and after ingest they are unrecoverable.
	clicks, err := lookupInWindowClicks(ctx, tx, tenantID, out.email, occurredAt)
	if err != nil {
		return newResolvedIdentity(), err
	}
	firstWindowTouch := len(out.touches)
	out.touches = append(out.touches, clicks...)

	// Fall back to the heuristic only when the caller named no click. clicks is
	// ordered most-recent-first, so clicks[0] IS what lookupLastTouchCampaign
	// would return; re-querying would be a second definition of the same rule.
	if out.campaignID == "" && len(clicks) > 0 {
		out.campaignID, out.attributedVia = clicks[0].campaignID, AttributedViaLastTouch
		out.winningTouch = firstWindowTouch
	}

	edges, err := lookupStructuralEdges(ctx, tx, tenantID, out.email, occurredAt)
	if err != nil {
		return newResolvedIdentity(), err
	}
	out.edges = edges
	return out, nil
}

type emailHMACBinding struct {
	subscriberID string
	email        string
}

// loadEmailHMACBindings resolves every distinct email HMAC in a signed batch
// through migration 2017's exact (tenant,key,digest) primary-key index. It never
// receives the signing secret and never evaluates HMAC over subscribers.
//
// Pending and failed are explicit failures, not empty match sets. Otherwise a
// newly-created/renamed subscriber could be recorded as anonymous during the
// reconciliation window and the false result would look indistinguishable from
// a genuinely unknown buyer.
func loadEmailHMACBindings(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, keyID string,
	facts []signedConversionFact,
) (map[string]emailHMACBinding, error) {
	requestedSet := make(map[string]struct{})
	for _, fact := range facts {
		if fact.emailHMACSHA256 != "" {
			requestedSet[fact.emailHMACSHA256] = struct{}{}
		}
	}
	out := make(map[string]emailHMACBinding, len(requestedSet))
	if len(requestedSet) == 0 {
		return out, nil
	}
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return nil, ErrEmailIdentityProjectionNotReady
	}
	requested := make([]string, 0, len(requestedSet))
	for digest := range requestedSet {
		requested = append(requested, digest)
	}
	// Read readiness and bindings in ONE statement snapshot. A separate
	// readiness probe followed by this lookup has a read-committed race: an
	// email mutation may mark the projection pending between the two statements,
	// turning a known address into a silent false no-match. The inner readiness
	// joins below emit one row per requested digest only for an exact live, ready
	// key; LEFT JOIN preserves genuinely unknown digests as empty bindings. The
	// SHARE locks serialize the rest of this ingest transaction against both a
	// subscriber trigger changing readiness and permanent key revocation. A
	// mutation that starts later waits; one that already owns either row commits
	// first and is rechecked by PostgreSQL before this query can return.
	rows, err := tx.Query(ctx, `
WITH requested(digest) AS (
    SELECT unnest($2::text[])
)
SELECT requested.digest, COALESCE(binding.subscriber_id::text, ''),
       COALESCE(lower(btrim(subscriber.email::text)), '')
  FROM requested
  JOIN conversion_email_hmac_projection_states projection
    ON projection.tenant_id = $1::uuid
   AND projection.key_id = $3
   AND projection.status = 'ready'
  JOIN conversion_ingest_secrets secret
    ON secret.tenant_id = projection.tenant_id
   AND secret.key_id = projection.key_id
   AND secret.revoked_at IS NULL
  LEFT JOIN conversion_email_hmac_bindings binding
    ON binding.tenant_id = $1::uuid
   AND binding.key_id = $3
   AND binding.digest = requested.digest
  LEFT JOIN subscribers subscriber
    ON subscriber.tenant_id = binding.tenant_id
   AND subscriber.id = binding.subscriber_id
 ORDER BY requested.digest, subscriber.id
 FOR SHARE OF projection, secret`, tenantID, requested, keyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seenRequested := 0
	for rows.Next() {
		var digest string
		var binding emailHMACBinding
		if err := rows.Scan(&digest, &binding.subscriberID, &binding.email); err != nil {
			return nil, err
		}
		seenRequested++
		if binding.subscriberID == "" {
			continue
		}
		if prior, exists := out[digest]; exists && prior.subscriberID != binding.subscriberID {
			return nil, fmt.Errorf("conversions: email HMAC resolved ambiguously")
		}
		out[digest] = binding
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if seenRequested != len(requested) {
		return nil, ErrEmailIdentityProjectionNotReady
	}
	return out, nil
}

// lookupSubscriberByExternalID resolves the customer's own identifier.
func lookupSubscriberByExternalID(
	ctx context.Context, tx pgx.Tx, tenantID, externalID string,
) (subscriberID, email string, err error) {
	err = tx.QueryRow(ctx, `
SELECT id::text, lower(email::text)
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND external_id = $2
 LIMIT 1`, tenantID, externalID).Scan(&subscriberID, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return subscriberID, email, nil
}

// clickIdentityBinding is what the click ledger knows about one click id.
type clickIdentityBinding struct {
	subscriberID string
	email        string
	campaignID   string
	clickedAt    time.Time
}

// lookupClickIdentity resolves a click id through conversion_click_identities.
func lookupClickIdentity(
	ctx context.Context, tx pgx.Tx, tenantID, clickID string,
) (clickIdentityBinding, error) {
	var out clickIdentityBinding
	err := tx.QueryRow(ctx, `
SELECT COALESCE(c.subscriber_id::text, ''),
       COALESCE(lower(s.email::text), ''),
       COALESCE(c.campaign_id::text, ''),
       c.clicked_at
  FROM conversion_click_identities c
  LEFT JOIN subscribers s
         ON s.id = c.subscriber_id AND s.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid
   AND c.click_id = $2
 LIMIT 1`, tenantID, clickID).
		Scan(&out.subscriberID, &out.email, &out.campaignID, &out.clickedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return clickIdentityBinding{}, nil
	}
	if err != nil {
		return clickIdentityBinding{}, err
	}
	return out, nil
}

// lookupInWindowClicks returns every click by this person inside the shared
// attribution window, most recent first.
//
// Same window, same source table and same strictly-before anchor as
// lookupLastTouchCampaign. Two look-backs over one conversion would let two
// reports disagree about which touches counted.
func lookupInWindowClicks(
	ctx context.Context, tx pgx.Tx, tenantID, email string, occurredAt time.Time,
) ([]campaignTouch, error) {
	if email == "" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
SELECT campaign_id::text, at
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND event_type = 'clicked'
   AND at < $3
   AND at >= $4
 ORDER BY at DESC
 LIMIT $5`, tenantID, email, occurredAt,
		occurredAt.Add(-lastTouchAttributionWindow), maxRecordedTouches)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []campaignTouch{}
	for rows.Next() {
		var touch campaignTouch
		if err := rows.Scan(&touch.campaignID, &touch.touchedAt); err != nil {
			return nil, err
		}
		out = append(out, touch)
	}
	return out, rows.Err()
}

// recordIdentityEvidence writes everything the resolution learned about one
// conversion: the identifiers it presented, the clicks that could have
// contributed, and the click-id binding this payload taught us.
//
// Written AFTER the conversion row because every touch points at it, and
// written for resolved and unresolved conversions alike: "this digest matched
// nobody" is a fact a later resolution pass needs, and it is exactly the fact
// that disappears if only successes are stored.
//
// Three phases, each ONE statement inside its OWN savepoint. One statement so a
// phase cannot half-succeed and leave a ledger that is neither the old state
// nor the new one; its own savepoint so a phase that fails cannot delete
// another phase's rows on its way out. See the savepoint constants for why the
// identity phase in particular must not be collateral damage.
//
// Returns two errors that mean different things:
//
//	degradedErr   one or more phases were dropped. Best effort, exactly like the
//	              lookup that produced the data: the caller logs it and keeps
//	              the conversion, and every phase that did NOT fail is still on
//	              disk.
//	savepointErr  transaction recovery itself failed. Nothing after this point
//	              can be trusted, so the caller must abort rather than claim the
//	              conversion survived.
func recordIdentityEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	conversionID int64,
	resolved resolvedIdentity,
	observedAt time.Time,
) (degradedErr, savepointErr error) {
	candidateErr, savepointErr := runBestEffortInSavepoint(ctx, tx,
		identityCandidateWriteSavepoint, func() error {
			return insertIdentityCandidateTouches(ctx, tx, tenantID, conversionID, resolved)
		})
	if savepointErr != nil {
		return nil, savepointErr
	}
	clickErr, savepointErr := runBestEffortInSavepoint(ctx, tx,
		campaignTouchWriteSavepoint, func() error {
			return insertCampaignClickTouches(ctx, tx, tenantID, conversionID, resolved)
		})
	if savepointErr != nil {
		return nil, savepointErr
	}
	bindErr, savepointErr := runBestEffortInSavepoint(ctx, tx,
		clickBindingWriteSavepoint, func() error {
			return rememberObservedClickIdentity(ctx, tx, tenantID,
				resolved.observedClickID, resolved.subscriberID, observedAt)
		})
	if savepointErr != nil {
		return nil, savepointErr
	}
	return errors.Join(candidateErr, clickErr, bindErr), nil
}

// insertIdentityCandidateTouches records every identifier the payload carried
// and what it resolved to, as ONE statement over parallel arrays.
//
// One statement rather than one per candidate because these rows are a set, not
// a sequence: half of them is not a smaller truth, it is a resolution order
// that never happened. A per-row loop can leave exactly that behind when the
// third row is refused.
func insertIdentityCandidateTouches(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	conversionID int64,
	resolved resolvedIdentity,
) error {
	if len(resolved.candidates) == 0 {
		return nil
	}
	kinds := make([]string, len(resolved.candidates))
	values := make([]string, len(resolved.candidates))
	keyIDs := make([]string, len(resolved.candidates))
	ranks := make([]int32, len(resolved.candidates))
	subscriberIDs := make([]string, len(resolved.candidates))
	winners := make([]bool, len(resolved.candidates))
	for index, candidate := range resolved.candidates {
		kinds[index] = candidate.kind
		values[index] = candidate.value
		keyIDs[index] = candidate.keyID
		ranks[index] = int32(candidate.rank)
		subscriberIDs[index] = candidate.subscriberID
		winners[index] = index == resolved.winner
	}
	_, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches
    (tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
     identity_key_id, resolution_rank, subscriber_id, is_winner)
SELECT $1::uuid, $2, $3, candidate.kind, candidate.value,
	   NULLIF(candidate.key_id, ''), candidate.rank,
	   NULLIF(candidate.subscriber_id, '')::uuid,
       candidate.is_winner
  FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::boolean[])
       AS candidate(kind, value, key_id, rank, subscriber_id, is_winner)`,
		tenantID, conversionID, touchKindIdentity,
		kinds, values, keyIDs, ranks, subscriberIDs, winners)
	return err
}

// insertCampaignClickTouches records every in-window click behind this
// conversion, as ONE statement over parallel arrays.
func insertCampaignClickTouches(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	conversionID int64,
	resolved resolvedIdentity,
) error {
	if len(resolved.touches) == 0 {
		return nil
	}
	campaignIDs := make([]string, len(resolved.touches))
	touchedAt := make([]time.Time, len(resolved.touches))
	winners := make([]bool, len(resolved.touches))
	for index, touch := range resolved.touches {
		campaignIDs[index] = touch.campaignID
		touchedAt[index] = touch.touchedAt
		winners[index] = index == resolved.winningTouch
	}
	// JOIN campaigns, so a click naming a campaign that has since been deleted
	// contributes NOTHING instead of raising a foreign-key violation. The monthly
	// campaign_report_events partitions do not fence campaign_id and this table
	// does, so one tidied-up campaign is enough to make the whole phase refused —
	// which would discard the clicks that ARE still valid alongside the orphan.
	//
	// This is a filter, not a fence: it must skip only the orphan rows and keep
	// the rest. Deleting the JOIN is what the test for it asserts against.
	_, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches
    (tenant_id, conversion_id, touch_kind, campaign_id, touched_at,
     subscriber_id, is_winner)
SELECT $1::uuid, $2, $3, campaign.id, click.touched_at,
       NULLIF($7, '')::uuid, click.is_winner
  FROM unnest($4::text[], $5::timestamptz[], $6::boolean[])
       AS click(campaign_id, touched_at, is_winner)
  JOIN campaigns campaign
    ON campaign.tenant_id = $1::uuid
   AND campaign.id = click.campaign_id::uuid`,
		tenantID, conversionID, touchKindCampaignClick,
		campaignIDs, touchedAt, winners, resolved.subscriberID)
	return err
}

// rememberObservedClickIdentity binds a click id to the person a stronger
// identifier in the same payload resolved to.
//
// DO NOTHING rather than DO UPDATE. An existing binding was either issued by
// the tracked-link redirect — which knows the campaign as well as the person and
// is therefore strictly better than this inference — or observed earlier from
// the same kind of payload. Overwriting the authoritative one with the weaker
// one would quietly delete the campaign it carries.
func rememberObservedClickIdentity(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, clickID, subscriberID string,
	observedAt time.Time,
) error {
	if clickID == "" || subscriberID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `
INSERT INTO conversion_click_identities
    (tenant_id, click_id, subscriber_id, clicked_at, source)
VALUES ($1::uuid, $2, $3::uuid, $4, $5)
ON CONFLICT (tenant_id, click_id) DO NOTHING`,
		tenantID, clickID, subscriberID, observedAt, clickIdentitySourceObservation)
	return err
}

// ClickIdentity is one authoritative click-id binding, as the tracked-link
// redirect knows it: this recipient, this campaign, this moment.
type ClickIdentity struct {
	ClickID      string
	SubscriberID string
	CampaignID   string
	ClickedAt    time.Time
}

// RecordClickIdentity stores the binding that makes a click id resolvable.
//
// Exported and taking a caller's tx for the same reason RecordCommerceOrder
// does: the producer is the link-redirect path, which must be able to issue the
// click id and record who it was issued to in ONE transaction. A binding that
// committed without its redirect — or a redirect without its binding — would
// hand the customer a click id that can never resolve, which is worse than not
// issuing one, because it looks like it works.
//
// DO UPDATE here, unlike the inferred observation: this caller knows the
// campaign, and a re-issued click id must be able to correct a weaker row
// written earlier by the signed feed.
func RecordClickIdentity(ctx context.Context, tx pgx.Tx, tenantID string, in ClickIdentity) error {
	if in.ClickID == "" || in.SubscriberID == "" {
		return errors.New("conversions: a click identity needs both a click id and a subscriber")
	}
	clickedAt := in.ClickedAt
	if clickedAt.IsZero() {
		clickedAt = time.Now().UTC()
	}
	_, err := tx.Exec(ctx, `
INSERT INTO conversion_click_identities
    (tenant_id, click_id, subscriber_id, campaign_id, clicked_at, source)
VALUES ($1::uuid, $2, $3::uuid, NULLIF($4, '')::uuid, $5, $6)
ON CONFLICT (tenant_id, click_id) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    campaign_id   = COALESCE(EXCLUDED.campaign_id, conversion_click_identities.campaign_id),
    clicked_at    = EXCLUDED.clicked_at,
    source        = EXCLUDED.source,
    updated_at    = now()`,
		tenantID, in.ClickID, in.SubscriberID, in.CampaignID, clickedAt,
		clickIdentitySourceLinkClick)
	return err
}
