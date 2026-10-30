package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

var ErrNotFound = errors.New("campaign not found")
var ErrSegmentNotFound = errors.New("segment not found for tenant")
var ErrDeleteRequiresDraft = errors.New("campaign delete requires draft status")

// ErrPreconditionFailed is returned by Update when the caller supplied an
// If-Match concurrency token that no longer matches the row's current
// version (optimistic-concurrency conflict). The handler maps it to 412.
var ErrPreconditionFailed = errors.New("campaign: precondition failed (stale If-Match)")

// ErrCampaignDispatching means the campaign has started sending and its content
// is therefore frozen.
//
// Distinct from ErrNotFound on purpose. "This campaign is sending" is a state a
// caller can wait out or clone past; "no such campaign" means their id is wrong.
// Collapsing them would send someone hunting for a record that is right there.
var ErrCampaignDispatching = errors.New("campaign: content is frozen once sending has started")

// ErrNotSchedulable means the campaign is in a status the scheduler will never
// claim, so writing a send time onto it would produce a campaign that reads
// "scheduled for Tuesday" and never fires.
//
// FindDueScheduled claims `status = 'scheduled'` and nothing else. Repo.Update
// promotes draft -> scheduled and leaves every other status untouched, so
// without this a cancelled or failed campaign accepted a scheduled_at, answered
// 200, and sat there forever.
var ErrNotSchedulable = errors.New("campaign: only a draft or scheduled campaign can carry a send time")

type Repo struct {
	Pool *db.Pool
	// Webhooks is an optional dispatcher. When set, Update fires a
	// campaign.sent webhook event INSIDE the same tx as the status flip
	// — so a tenant's listener never sees a "sent" notification for a
	// campaign whose status flip rolled back. nil = no events fired.
	Webhooks WebhookDispatcher
	// AudienceCounter resolves a campaign's audience-typed id (list or
	// segment) to a live subscriber count for the pre-send checklist's
	// recipient_count_above_zero gate. Wired from main.go as an adapter
	// over lists.Repo + segments.Repo so this package stays decoupled
	// from those repos at the type level. nil = no counter, the gate
	// falls back to the TrackingSettings recipient-count hint.
	AudienceCounter AudienceCounter
	// ListNamer reads a list audience's display name for the checklist and
	// the send review; list names live in the engine, not here. nil = the
	// name reads as unavailable and the copy says so rather than printing an
	// id.
	ListNamer ListNamer
}

// WebhookDispatcher mirrors webhooks.Dispatcher's narrow Fire shape.
// Defined here so this package doesn't import webhooks; main.go
// provides a tiny adapter.
type WebhookDispatcher interface {
	Fire(ctx context.Context, tx pgx.Tx, in WebhookFireInput) (int, error)
}

type WebhookFireInput struct {
	TenantID       string
	EventType      string
	Body           any
	IdempotencyKey string
}

// CountByStatus is the projection returned by Count(). Each status
// the tenant has at least one campaign in produces an entry; a
// tenant with zero campaigns gets an empty map. Total is the sum
// across statuses — convenient so dashboards don't have to add up.
type CountByStatus struct {
	Total    int            `json:"total"`
	ByStatus map[string]int `json:"by_status"`
}

// Count returns the per-status campaign counts for the tenant in a
// single COUNT(*) query. Cheap to compute even on tenants with
// thousands of campaigns — much cheaper than fetching the full
// row set and computing length in the handler. Dashboard uses this
// to render the "Campaigns" + "Sent" stats without paying the
// list-payload cost. Audit perf finding FE-1 follow-through.
func (r *Repo) Count(ctx context.Context, tenantID string) (CountByStatus, error) {
	return r.CountFiltered(ctx, tenantID, "")
}

// CountFiltered returns the same status projection restricted to the list
// search expression. It lets paginated clients calculate their final page
// without downloading every matching campaign.
func (r *Repo) CountFiltered(ctx context.Context, tenantID, q string) (CountByStatus, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return CountByStatus{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(status, '') AS status, COUNT(*)::int AS n
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR (name ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%'))
 GROUP BY status`, tenantID, q)
	if err != nil {
		return CountByStatus{}, err
	}
	out := CountByStatus{ByStatus: map[string]int{}}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			rows.Close()
			return CountByStatus{}, err
		}
		out.ByStatus[status] = n
		out.Total += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return CountByStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CountByStatus{}, err
	}
	return out, nil
}

// CampaignListMaxRows is the hard ceiling on `List` result size.
// Audit fix BE-2: the prior unbounded query returned every campaign
// row for a tenant on each page-load, with growth proportional to
// drafts + recurrences accumulated over time. The dashboard
// overview slices to 5 rows for display anyway. 500 is generous
// enough to cover power-user workspaces while bounding worst-case
// payload + query cost. Clients that need older campaigns should
// switch to a future paginated endpoint (out of scope here).
const CampaignListMaxRows = 500

// List returns the tenant's campaigns newest-first. `limit<=0`
// falls back to the hard ceiling (CampaignListMaxRows); callers
// that need fewer rows for a specific surface (e.g. dashboard
// overview that slices to 5) pass a smaller limit to avoid pulling
// 500 rows over the wire when 10 will do. When q is non-empty it
// filters by name OR subject substring (case-insensitive ILIKE).
func (r *Repo) List(ctx context.Context, tenantID, q string, limit int) ([]Campaign, error) {
	return r.ListPage(ctx, tenantID, q, limit, 0)
}

// ListPage is List with a bounded offset. List remains as the compatibility
// entry point for dashboard and older clients.
func (r *Repo) ListPage(ctx context.Context, tenantID, q string, limit, offset int) ([]Campaign, error) {
	return r.ListPageFilter(ctx, tenantID, q, "", limit, offset)
}

// ListPageFilter is ListPage with an optional source_template_id filter
// (TMPL-026). When sourceTemplateID is a non-empty UUID string, only
// campaigns built from that template are returned; an empty filter matches
// all campaigns (the plain ListPage behaviour). Callers must validate the
// UUID shape — a malformed non-empty value would fail the ::uuid cast.
func (r *Repo) ListPageFilter(ctx context.Context, tenantID, q, sourceTemplateID string, limit, offset int) ([]Campaign, error) {
	if limit <= 0 || limit > CampaignListMaxRows {
		limit = CampaignListMaxRows
	}
	if offset < 0 {
		offset = 0
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// nil (not "") for the empty case so `$5::uuid IS NULL` is true without
	// ever casting an empty string to uuid (which would error).
	var stid any
	if sourceTemplateID != "" {
		stid = sourceTemplateID
	}
	rows, err := tx.Query(ctx, campaignListSelectSQL+`
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR (name ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%'))
  AND ($5::uuid IS NULL OR source_template_id = $5::uuid)
ORDER BY updated_at DESC, id DESC
LIMIT $3 OFFSET $4`, tenantID, q, limit, offset, stid)
	if err != nil {
		return nil, err
	}
	out, err := scanCampaigns(rows)
	if err != nil {
		return nil, err
	}
	// D06#8: populate per-campaign open/click rates from a single batched
	// roll-up over campaign_report_events (index-backed on campaign_id),
	// merged in Go so scanCampaign (shared with Get/Create/Update) is left
	// untouched. Only campaigns with a delivered/sent denominator get a
	// non-nil rate; the rest serialise as absent → the desktop shows "—".
	if err := r.attachListRates(ctx, tx, tenantID, out); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// attachListRates fills OpenRate/ClickRate (0..1 fractions) on the given
// campaigns using one grouped query. No-op when the slice is empty.
func (r *Repo) attachListRates(ctx context.Context, tx pgx.Tx, tenantID string, campaigns []Campaign) error {
	if len(campaigns) == 0 {
		return nil
	}
	ids := make([]string, len(campaigns))
	for i := range campaigns {
		ids[i] = campaigns[i].ID
	}
	rows, err := tx.Query(ctx, `
SELECT campaign_id::text,
       COUNT(*) FILTER (WHERE event_type = 'delivered')::int                                   AS delivered,
       COUNT(*) FILTER (WHERE event_type = 'sent')::int                                        AS sent,
       COUNT(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int              AS unique_opens,
       COUNT(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')::int             AS unique_clicks
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = ANY($2::uuid[])
 GROUP BY campaign_id`, tenantID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	type rate struct{ open, click float64 }
	byID := make(map[string]rate, len(campaigns))
	for rows.Next() {
		var id string
		var delivered, sent, uOpens, uClicks int
		if err := rows.Scan(&id, &delivered, &sent, &uOpens, &uClicks); err != nil {
			return err
		}
		denom := delivered
		if denom == 0 {
			denom = sent
		}
		if denom <= 0 {
			continue
		}
		byID[id] = rate{
			open:  float64(uOpens) / float64(denom),
			click: float64(uClicks) / float64(denom),
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range campaigns {
		if rt, ok := byID[campaigns[i].ID]; ok {
			o, c := rt.open, rt.click
			campaigns[i].OpenRate = &o
			campaigns[i].ClickRate = &c
		}
	}
	return nil
}

func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Campaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, campaignSelectSQL+`
WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	c, err := scanCampaign(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// GetByTemplateDesignDraft returns the unique campaign committed from a
// durable template-design draft. It is the recovery seam for a process crash
// after campaign INSERT but before the design job's outcome marker advances.
func (r *Repo) GetByTemplateDesignDraft(
	ctx context.Context,
	tenantID, designDraftID string,
) (*Campaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, campaignSelectSQL+`
WHERE tenant_id = $1::uuid
  AND source_template_design_draft_id::text = $2`, tenantID, designDraftID)
	campaign, err := scanCampaign(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return campaign, nil
}

func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Campaign, error) {
	// Repository callers include governed MCP and catalog workflows that do
	// not pass through the HTTP normalizer. Apply the same storage-safe
	// defaults here so an omitted type/mode never violates the DB checks.
	if strings.TrimSpace(in.CampaignType) == "" {
		in.CampaignType = "regular"
	}
	if strings.TrimSpace(in.EditorMode) == "" {
		if strings.TrimSpace(in.BodyMJML) != "" {
			in.EditorMode = "mjml"
		} else if strings.TrimSpace(in.BodyHTML) != "" {
			in.EditorMode = "html"
		} else {
			in.EditorMode = "blocks"
		}
	}
	in.SourceMode = strings.ToLower(strings.TrimSpace(in.SourceMode))
	if in.SourceMode == "" {
		// Existing editor blocks are not yet the typed AST v2. Opt-in is
		// explicit so legacy drafts never receive an unsupported semantic label.
		in.SourceMode = campaignartifact.SourceModeLegacyHTML
	}
	if in.ContentSchemaVersion == 0 {
		if in.SourceMode == campaignartifact.SourceModeSemantic {
			in.ContentSchemaVersion = semanticContentSchemaVersion
		} else {
			in.ContentSchemaVersion = 1
		}
	}
	normalizedBlocks, contentRaw, err := normalizeCampaignContent(
		in.SourceMode, in.ContentSchemaVersion, in.ContentBlocks,
	)
	if err != nil {
		return nil, err
	}
	in.ContentBlocks = normalizedBlocks
	in.ListID = strings.TrimSpace(in.ListID)
	in.SegmentID = strings.TrimSpace(in.SegmentID)
	if in.ListID != "" && in.SegmentID != "" {
		return nil, ErrAudienceMixedSources
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := validateSegment(ctx, tx, tenantID, in.SegmentID); err != nil {
		return nil, err
	}
	if in.ListID != "" {
		list, resolveErr := resolveOwnedCampaignList(ctx, tx, tenantID, in.ListID)
		if resolveErr != nil {
			return nil, resolveErr
		}
		in.ListID = list.StoredListID()
	}
	// Apply the workspace STO preference to newly-created campaigns. A
	// 24-hour window is materialized immediately (anchored at scheduled_at or
	// now), so the setting changes real recipient dispatch rather than merely
	// storing a decorative flag.
	defaultOptimize := true
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(send_time_optimization_enabled, true)
  FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&defaultOptimize); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("load workspace send-time optimization: %w", err)
	}
	var sendWindowStart, sendWindowEnd *time.Time
	if defaultOptimize {
		start := time.Now().UTC()
		if in.ScheduledAt != nil {
			start = in.ScheduledAt.UTC()
		}
		end := start.Add(24 * time.Hour)
		sendWindowStart, sendWindowEnd = &start, &end
	}

	status := StatusDraft
	if in.ScheduledAt != nil {
		status = StatusScheduled
	}
	factRaw := in.FactContract
	if len(factRaw) == 0 {
		factRaw = json.RawMessage(`{}`)
	}
	factRaw, err = campaignartifact.NormalizeFactContractV1(
		factRaw, in.SourceMode, contentRaw,
	)
	if err != nil {
		return nil, err
	}
	variantsRaw, _ := json.Marshal(nonNilSliceMap(in.Variants))
	trackingRaw, _ := json.Marshal(nonNilMap(in.TrackingSettings))
	deliveryRaw, _ := json.Marshal(nonNilMap(in.DeliverySettings))
	templateVariablesRaw, _ := json.Marshal(nonNilMap(in.TemplateVariables))
	referenceTemplateIDs := in.ReferenceTemplateIDs
	if referenceTemplateIDs == nil {
		referenceTemplateIDs = []string{}
	}
	reusableSectionIDs := in.ReusableSectionIDs
	if reusableSectionIDs == nil {
		reusableSectionIDs = []string{}
	}
	priority := NormalizePriority(in.Priority)
	row := tx.QueryRow(ctx, `
INSERT INTO campaigns (
    tenant_id, name, subject, status, body_html, body_mjml, segment_id, scheduled_at,
    campaign_type, editor_mode, preview_text, plain_text, from_name, reply_to,
	content_blocks, reusable_section_ids, variants, tracking_settings, delivery_settings, priority,
	per_recipient_optimize, send_window_start, send_window_end,
	source_template_id, source_template_updated_at, reference_template_ids,
	template_variables, audience_list_id,
		source_template_design_draft_id, source_template_design_revision,
		source_template_design_output_hash,
		source_mode, content_schema_version, fact_contract
)
VALUES (
    $1::uuid, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, '')::uuid, $8,
    $9, $10, NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
	$15::jsonb, $16::uuid[], $17::jsonb, $18::jsonb, $19::jsonb, $20,
	$21, $22, $23,
	NULLIF($24, '')::uuid, $25, $26::uuid[], $27::jsonb, NULLIF($28, '')::bigint,
		NULLIF($29, '')::uuid, NULLIF($30, 0), NULLIF($31, ''),
		$32, $33, $34::jsonb
)
RETURNING `+campaignColumns,
		tenantID, in.Name, in.Subject, status, in.BodyHTML, in.BodyMJML, in.SegmentID, in.ScheduledAt,
		in.CampaignType, in.EditorMode, in.PreviewText, in.PlainText, in.FromName, in.ReplyTo,
		string(contentRaw), reusableSectionIDs, string(variantsRaw), string(trackingRaw), string(deliveryRaw), priority,
		defaultOptimize, sendWindowStart, sendWindowEnd, in.SourceTemplateID,
		in.SourceTemplateUpdatedAt, referenceTemplateIDs, string(templateVariablesRaw), in.ListID,
		in.SourceTemplateDesignDraftID, in.SourceTemplateDesignRevision,
		in.SourceTemplateDesignOutputHash, in.SourceMode,
		in.ContentSchemaVersion, []byte(factRaw))
	c, err := scanCampaign(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// hasDispatched answers the freeze question outside the write transaction.
//
// It opens its own tenant-scoped tx because campaigns is under RLS: querying
// r.Pool directly leaves app.tenant_id unset, the policy matches zero rows, and
// the Scan fails — which reads as "not dispatched" to a caller that only checks
// the error. Used only on rejection paths, where one extra round trip buys the
// operator an accurate reason.
func (r *Repo) hasDispatched(ctx context.Context, tenantID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return campaigndispatch.HasDispatched(ctx, tx, tenantID, id)
}

func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Campaign, error) {
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	// Optimistic concurrency: when the caller supplied an If-Match token,
	// reject the write if the row has advanced since they read it. The token
	// is derived from updated_at, which the same Get above just loaded. The
	// pre-check catches a client that is already stale relative to this read;
	// the UPDATE below ALSO carries an `updated_at = $expected` predicate so a
	// concurrent writer that commits between this read and the write is caught
	// atomically by Postgres (closing the read-committed TOCTOU window).
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		if in.IfMatchToken != httpcache.ConcurrencyToken("campaign", id, cur.UpdatedAt) {
			// A stale token on a campaign that has begun dispatching is not a
			// staleness problem. 412 tells the operator to reload and retry, and
			// the reload will hand them a fresh token for a campaign that still
			// refuses the edit — so they learn the real reason only on the second
			// attempt, if at all. Starting a send is itself what bumped
			// updated_at, which makes this the COMMON path, not a corner: the web
			// client sends If-Match on every campaign PATCH.
			if in.freezesOnceDispatched(cur.DeliverySettings) {
				if dispatched, qerr := r.hasDispatched(ctx, tenantID, id); qerr == nil && dispatched {
					return nil, ErrCampaignDispatching
				}
			}
			return nil, ErrPreconditionFailed
		}
		ts := cur.UpdatedAt
		expectedUpdatedAt = &ts
	}
	prevStatus := cur.Status
	// Snapshot before the patch loop below overwrites cur in place: the freeze
	// decision compares the incoming sender against the CURRENT one, and the
	// audience guard compares the incoming list and segment against the
	// current ones.
	currentDelivery := cur.DeliverySettings
	currentAudience := campaignAudienceOf(cur)
	applyCampaignUpdatePatch(cur, in)
	normalizedBlocks, contentRaw, err := normalizeCampaignContent(
		cur.SourceMode, cur.ContentSchemaVersion, cur.ContentBlocks,
	)
	if err != nil {
		return nil, err
	}
	cur.ContentBlocks = normalizedBlocks
	if in.SegmentID != nil {
		cur.SegmentID = strings.TrimSpace(*in.SegmentID)
	}
	if in.ListID != nil {
		cur.ListID = strings.TrimSpace(*in.ListID)
	}
	if strings.TrimSpace(cur.ListID) != "" && strings.TrimSpace(cur.SegmentID) != "" {
		return nil, ErrAudienceMixedSources
	}
	if err := r.applyCampaignScheduleUpdate(ctx, tenantID, id, cur, in); err != nil {
		return nil, err
	}
	if in.Priority != nil {
		cur.Priority = NormalizePriority(*in.Priority)
	}
	if in.GoalEvent != nil {
		cur.GoalEvent = strings.TrimSpace(*in.GoalEvent)
	}
	if in.GoalWindowHours != nil {
		cur.GoalWindowHours = *in.GoalWindowHours
	}
	if in.AudienceMode != nil {
		cur.AudienceMode = strings.TrimSpace(*in.AudienceMode)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := validateSegment(ctx, tx, tenantID, cur.SegmentID); err != nil {
		return nil, err
	}
	if audienceErr := resolveUpdatedAudience(ctx, tx, tenantID, cur, currentAudience, in); audienceErr != nil {
		return nil, audienceErr
	}

	factRaw := cur.FactContract
	if len(factRaw) == 0 {
		factRaw = json.RawMessage(`{}`)
	}
	factRaw, err = campaignartifact.NormalizeFactContractV1(
		factRaw, cur.SourceMode, contentRaw,
	)
	if err != nil {
		return nil, err
	}
	cur.FactContract = factRaw
	variantsRaw, _ := json.Marshal(nonNilSliceMap(cur.Variants))
	trackingRaw, _ := json.Marshal(nonNilMap(cur.TrackingSettings))
	deliveryRaw, _ := json.Marshal(nonNilMap(cur.DeliverySettings))
	row := tx.QueryRow(ctx, `
UPDATE campaigns SET
    name = $3,
    subject = $4,
    status = $5,
    body_html = NULLIF($6, ''),
    body_mjml = NULLIF($7, ''),
    segment_id = NULLIF($8, '')::uuid,
    scheduled_at = $9,
    campaign_type = $10,
    editor_mode = $11,
    preview_text = NULLIF($12, ''),
    plain_text = NULLIF($13, ''),
    from_name = NULLIF($14, ''),
    reply_to = NULLIF($15, ''),
    content_blocks = $16::jsonb,
    reusable_section_ids = $17::uuid[],
    variants = $18::jsonb,
    tracking_settings = $19::jsonb,
    delivery_settings = $20::jsonb,
    priority = $21,
    goal_event = NULLIF($22, ''),
	    goal_window_hours = NULLIF($23, 0),
	    audience_mode = COALESCE(NULLIF($24, ''), audience_mode),
	    source_mode = $25,
	    content_schema_version = $26,
	    fact_contract = $27::jsonb,
	    -- Written only when the patch names a list ($31). Every other update
	    -- (a rename, a status flip, a schedule) leaves the stored list alone,
	    -- so one that races a list change cannot write back the list it read.
	    audience_list_id = CASE WHEN $31::bool THEN NULLIF($30, '')::bigint
	                            ELSE audience_list_id END,
    -- Stamp the first entry into a dispatching status, monotonically. The queue
    -- route already does this; Update and SetStatus did not, so a campaign that
    -- reached 'sending' through them carried no record that dispatch had begun.
    -- The guard below needs that record: status alone cannot answer it, because
    -- a campaign paused halfway through a send reads 'paused' while some
    -- recipients already hold version A.
    started_at = CASE WHEN $5 IN ('sending', 'sent')
                      THEN COALESCE(started_at, now()) ELSE started_at END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id::text = $2
	  AND ($28::timestamptz IS NULL OR updated_at = $28::timestamptz)
  -- Delivered content is frozen once dispatch begins. sendloop.loadCampaignBodies
  -- re-reads subject and body_html inside EVERY batch transaction, so an edit
  -- accepted mid-send makes later batches deliver different content than earlier
  -- ones under one campaign id — and the archive then shows only the last
  -- version, leaving a complaint about the first unanswerable.
  --
	  -- $29 is false for updates that do not change what a recipient receives
  -- (status transitions, renames, priority, delivery throttles). Those must keep
  -- working mid-send: the send loop itself pauses campaigns through this very
  -- statement, and an operator resuming or renaming a running send is not the
  -- hazard. See UpdateInput.freezesOnceDispatched.
  --
  -- Enforced in SQL rather than in a handler so every caller is covered, and so
  -- it holds against a campaign that enters 'sending' between the Get above and
  -- this write. The existing hasDispatchState check is a different rule: it
  -- rejects a request that CARRIES status, which a body-only PATCH passes cleanly.
	  AND ($29::bool IS NOT TRUE OR (started_at IS NULL AND status NOT IN ('sending', 'sent')))
RETURNING `+campaignColumns,
		tenantID, cur.ID, cur.Name, cur.Subject, cur.Status, cur.BodyHTML,
		cur.BodyMJML, cur.SegmentID, cur.ScheduledAt, cur.CampaignType,
		cur.EditorMode, cur.PreviewText, cur.PlainText, cur.FromName, cur.ReplyTo,
		string(contentRaw), cur.ReusableSectionIDs, string(variantsRaw),
		string(trackingRaw), string(deliveryRaw), NormalizePriority(cur.Priority),
		cur.GoalEvent, cur.GoalWindowHours, cur.AudienceMode,
		cur.SourceMode, cur.ContentSchemaVersion, []byte(cur.FactContract), expectedUpdatedAt,
		in.freezesOnceDispatched(currentDelivery), cur.ListID, in.ListID != nil)
	c, err := scanCampaign(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// The Get above already confirmed the row exists for this tenant, so a
		// zero-row UPDATE here means the optimistic-concurrency predicate
		// failed (a concurrent writer advanced updated_at) — not not-found.
		// Which of the three predicates rejected it? The answers mean opposite
		// things to the caller, and ErrNotFound is the worst default: it sends
		// someone hunting for a record that is right there.
		//
		// The freeze is checked FIRST, ahead of the If-Match token. The
		// pre-check above already rejected a token that was stale at read time,
		// so reaching here with expectedUpdatedAt set means the token matched —
		// and a 412 would tell the operator to re-read and retry, which cannot
		// help, because on the next read the campaign is still sending. The
		// web client sends If-Match on every campaign PATCH, so without this
		// ordering the freeze's own 409 would almost never be the one seen.
		if in.freezesOnceDispatched(currentDelivery) {
			dispatched, qerr := campaigndispatch.HasDispatched(ctx, tx, tenantID, cur.ID)
			if qerr == nil && dispatched {
				return nil, ErrCampaignDispatching
			}
		}
		if expectedUpdatedAt != nil {
			return nil, ErrPreconditionFailed
		}
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// Fire campaign.sent ONLY on the prev != sent → next == sent
	// transition. We don't fire .sending or other intermediate flips
	// because the receiver almost certainly cares about "delivery
	// finished", not "delivery started". Atomic with the status flip:
	// if the dispatcher Fire fails, the UPDATE rolls back too.
	if r.Webhooks != nil && prevStatus != StatusSent && c.Status == StatusSent {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      "campaign.sent",
			Body:           c,
			IdempotencyKey: "campaign-sent:" + c.ID,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// applyCampaignUpdatePatch copies every supplied scalar/content field of the
// patch onto the loaded campaign, in place. Audience, schedule, and the
// derived fields that need the database stay in Update.
func applyCampaignUpdatePatch(cur *Campaign, in UpdateInput) {
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
	}
	if in.Subject != nil {
		cur.Subject = strings.TrimSpace(*in.Subject)
	}
	if in.Status != nil {
		cur.Status = *in.Status
	}
	if in.CampaignType != nil {
		cur.CampaignType = *in.CampaignType
	}
	if in.EditorMode != nil {
		cur.EditorMode = *in.EditorMode
	}
	if in.PreviewText != nil {
		cur.PreviewText = *in.PreviewText
	}
	if in.BodyHTML != nil {
		cur.BodyHTML = *in.BodyHTML
	}
	if in.BodyMJML != nil {
		cur.BodyMJML = *in.BodyMJML
	}
	if in.PlainText != nil {
		cur.PlainText = *in.PlainText
	}
	if in.FromName != nil {
		cur.FromName = *in.FromName
	}
	if in.ReplyTo != nil {
		cur.ReplyTo = *in.ReplyTo
	}
	if in.ContentBlocks != nil {
		cur.ContentBlocks = in.ContentBlocks
	}
	if in.ReusableSectionIDs != nil {
		cur.ReusableSectionIDs = normalizeIDs(in.ReusableSectionIDs)
	}
	if in.Variants != nil {
		cur.Variants = in.Variants
	}
	if in.TrackingSettings != nil {
		cur.TrackingSettings = in.TrackingSettings
	}
	if in.DeliverySettings != nil {
		cur.DeliverySettings = in.DeliverySettings
	}
	if in.SourceMode != nil {
		cur.SourceMode = strings.ToLower(strings.TrimSpace(*in.SourceMode))
		if in.ContentSchemaVersion == nil {
			switch cur.SourceMode {
			case campaignartifact.SourceModeSemantic:
				cur.ContentSchemaVersion = semanticContentSchemaVersion
			case campaignartifact.SourceModeLegacyHTML:
				cur.ContentSchemaVersion = 1
			}
		}
	}
	if in.ContentSchemaVersion != nil {
		cur.ContentSchemaVersion = *in.ContentSchemaVersion
	}
	if in.FactContract != nil {
		cur.FactContract = append(json.RawMessage(nil), in.FactContract...)
	}
}

// applyCampaignScheduleUpdate applies a scheduled_at set or clear, refusing
// the change for a campaign that is no longer draft or scheduled.
func (r *Repo) applyCampaignScheduleUpdate(ctx context.Context, tenantID, id string, cur *Campaign, in UpdateInput) error {
	if in.ScheduledAt != nil || in.ClearScheduledAt {
		// draft and scheduled are the only two states a send time belongs to.
		// Everything else is either already dispatching or terminal, and a
		// terminal campaign carrying a future send time is a lie the scheduler
		// will never act on: FindDueScheduled claims 'scheduled' and nothing else.
		if cur.Status != StatusDraft && cur.Status != StatusScheduled {
			// Both refusals are a 409, but they are not the same fact and the
			// caller acts on them differently. "This has started sending" is the
			// specific, actionable reason; "not schedulable" is the fallback for
			// cancelled, failed, or a pause that never dispatched. Ask which one
			// applies rather than letting whichever check runs first decide the
			// message.
			if dispatched, qerr := r.hasDispatched(ctx, tenantID, id); qerr == nil && dispatched {
				return ErrCampaignDispatching
			}
			return ErrNotSchedulable
		}
	}
	if in.ScheduledAt != nil {
		cur.ScheduledAt = in.ScheduledAt
		if cur.Status == StatusDraft {
			cur.Status = StatusScheduled
		}
	}
	if in.ClearScheduledAt {
		// Unschedule: drop the time AND return the campaign to draft. Leaving it
		// 'scheduled' with a NULL scheduled_at would strand it — FindDueScheduled
		// matches on `scheduled_at <= now()`, so the row would sit in a status
		// that can never fire and no UI would call it a draft.
		cur.ScheduledAt = nil
		if cur.Status == StatusScheduled {
			cur.Status = StatusDraft
		}
	}
	return nil
}

// FindDueScheduled atomically claims up to `limit` campaigns whose
// scheduled_at is in the past and whose status is still "scheduled".
// Claimed rows are flipped to status='sending' AS PART of the SELECT
// — closes the multi-replica race the worker audit flagged as
// CRITICAL: prior code did a plain SELECT, so two replicas could
// both fetch the same row and both call QueueScheduledCampaign,
// resulting in duplicate dispatch / duplicate sends.
//
// Cross-tenant by design (binds app.outbox_worker GUC, matching the
// outbox worker pattern). LIMIT is bounded so a post-deploy backlog
// doesn't fan out 10k dispatches in one tick.
//
// The "claim by flipping status" pattern means dispatchOne can rely
// on the row already being in 'sending' state — it doesn't need to
// flip status itself. The downstream queueCampaignCore is idempotent
// (ON CONFLICT DO NOTHING on campaign_recipients), so a worker crash
// AFTER claim but BEFORE queue completion leaves the row in
// 'sending' status; a stuck-claim sweep (in send.go Scheduler.tick)
// could revert these — out of scope for this commit, would need a
// claimed_at column on campaigns (same pattern as 0167).
func (r *Repo) FindDueScheduled(ctx context.Context, limit int) ([]ScheduledCampaign, error) {
	if limit <= 0 {
		limit = 16
	}
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
UPDATE campaigns
   SET status = 'sending',
       -- Stamp on every path into a dispatching status; the content freeze reads
       -- started_at, and a campaign that got here unstamped would unfreeze the
       -- moment it was paused mid-send.
       started_at = COALESCE(started_at, now())
 WHERE id IN (
   SELECT id FROM campaigns
    WHERE status = 'scheduled' AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
 )
RETURNING tenant_id::text, id::text`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ScheduledCampaign, 0, limit)
	for rows.Next() {
		var sc ScheduledCampaign
		if err := rows.Scan(&sc.TenantID, &sc.CampaignID); err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SetSandboxFlag persists `is_sandbox` on the campaigns row. Set at
// queue-time from the request's sandbox context so background
// dispatchers (scheduler, approval hook) can read it back without
// needing the original HTTP context. See migration 0159 + D6 fix in
// PRODUCTION_READINESS.md.
func (r *Repo) SetSandboxFlag(ctx context.Context, tenantID, id string, sandbox bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaigns SET is_sandbox = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id, sandbox)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// GetSandboxFlag reads `is_sandbox` for a campaign. Used by background
// dispatchers (scheduler, approval hook) that don't have an HTTP
// request to derive sandbox-ness from. A missing row returns ErrNotFound;
// callers must never conflate missing authority with a live-send decision.
func (r *Repo) GetSandboxFlag(ctx context.Context, tenantID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sb bool
	err = tx.QueryRow(ctx, `
SELECT is_sandbox FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id).Scan(&sb)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrNotFound
		}
		return false, err
	}
	return sb, nil
}

// UpdateStatusIf flips campaigns.status from one of `expectedAny` to
// `target` atomically. Returns ErrNotFound if the row is missing,
// ErrConflict if the row exists but its current status is not in
// `expectedAny` (caller raced another writer, e.g. operator cancelled
// while scheduler was dispatching). Use this instead of Repo.Update
// for state-machine transitions where reordering would silently
// resurrect cancelled / completed work.
func (r *Repo) UpdateStatusIf(ctx context.Context, tenantID, id string, expectedAny []string, target string) error {
	if len(expectedAny) == 0 {
		return fmt.Errorf("UpdateStatusIf: expectedAny must be non-empty")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET status = $3,
       -- Same stamp as every other path into a dispatching status. See
       -- campaigndispatch.StartedAtStamp for why the content freeze needs it.
       started_at = CASE WHEN $3 IN ('sending', 'sent')
                         THEN COALESCE(started_at, now()) ELSE started_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = ANY($4::text[])`,
		tenantID, id, target, expectedAny)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Disambiguate "row missing" vs "status race".
		var curStatus string
		row := tx.QueryRow(ctx, `SELECT status FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
		if err := row.Scan(&curStatus); err != nil {
			return ErrNotFound
		}
		return fmt.Errorf("campaigns: status %q not in %v (race)", curStatus, expectedAny)
	}
	return tx.Commit(ctx)
}

func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = $3`, tenantID, id, StatusDraft)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var status string
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(status, '') FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
			tenantID, id,
		).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return ErrDeleteRequiresDraft
	}
	return tx.Commit(ctx)
}

func validateSegment(ctx context.Context, tx pgx.Tx, tenantID, segmentID string) error {
	segmentID = strings.TrimSpace(segmentID)
	if segmentID == "" {
		return nil
	}
	var ok bool
	if err := tx.QueryRow(ctx, `
	SELECT EXISTS (
		SELECT 1 FROM segments
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	)`, tenantID, segmentID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrSegmentNotFound
	}
	return nil
}

const campaignSelectSQL = `
SELECT ` + campaignColumns + `
FROM campaigns
`

// campaignListSelectSQL is the projection for the LIST path. It is
// campaignSelectSQL with the message bodies and the large per-campaign JSON
// documents blanked out at the database.
//
// A designed marketing email is routinely 50-200KB of HTML plus its MJML
// source, and the list ceiling is CampaignListMaxRows (500) — which is exactly
// what the campaigns index asks for. Shipping bodies made a page of campaign
// NAMES cost tens of megabytes that Postgres detoasts, Go scans and marshals,
// and the browser parses before the first row paints. No list surface renders
// any of these fields; the editor loads them from Get when a campaign is
// opened.
//
// The column ORDER and count are identical to campaignColumns so scanCampaign
// stays a single shared scanner — the blanked columns arrive as the same empty
// values an unset campaign would produce, rather than a second row struct that
// could drift.
const campaignListSelectSQL = `
SELECT ` + campaignListColumns + `
FROM campaigns
`

const campaignColumns = `id::text, tenant_id::text, name, subject, status,
       campaign_type, editor_mode, COALESCE(preview_text, ''),
       COALESCE(body_html, ''), COALESCE(body_mjml, ''), COALESCE(plain_text, ''),
       COALESCE(from_name, ''), COALESCE(reply_to::text, ''),
       content_blocks, COALESCE(to_jsonb(reusable_section_ids), '[]'::jsonb),
       variants, tracking_settings, delivery_settings,
       COALESCE(segment_id::text, ''),
       COALESCE(audience_list_id::text, ''),
       scheduled_at, sent_at, COALESCE(priority, 5)::int, created_at, updated_at,
       COALESCE(per_recipient_optimize, false), send_window_start, send_window_end,
       COALESCE(archive_public, false), COALESCE(archive_slug, ''),
       COALESCE(goal_event, ''), COALESCE(goal_window_hours, 0),
       COALESCE(audience_mode, 'dynamic'), COALESCE(frozen_freeze_id::text, ''),
       COALESCE(folder_id::text, ''),
       COALESCE(source_template_id::text, ''), source_template_updated_at,
       COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
       template_variables,
	       COALESCE(source_template_design_draft_id::text, ''),
	       COALESCE(source_template_design_revision, 0),
	       COALESCE(source_template_design_output_hash, ''),
	       source_mode, content_schema_version, fact_contract`

// campaignListColumns mirrors campaignColumns position-for-position. Only the
// unbounded per-campaign documents differ: bodies become empty strings,
// content_blocks / variants become empty arrays and template_variables an
// empty object (matching each field's Go type, so the JSON shape is unchanged),
// and fact_contract becomes the empty object the schema documents as its
// no-contract value (never SQL NULL — `fact_contract` is a required property,
// so a null would be a wire-contract break rather than a payload trim).
// Everything the list actually shows — name, subject,
// status, type, schedule, folder, priority, timestamps — is read as before.
const campaignListColumns = `id::text, tenant_id::text, name, subject, status,
       campaign_type, editor_mode, COALESCE(preview_text, ''),
       ''::text, ''::text, ''::text,
       COALESCE(from_name, ''), COALESCE(reply_to::text, ''),
       '[]'::jsonb, COALESCE(to_jsonb(reusable_section_ids), '[]'::jsonb),
       '[]'::jsonb, tracking_settings, delivery_settings,
       COALESCE(segment_id::text, ''),
       COALESCE(audience_list_id::text, ''),
       scheduled_at, sent_at, COALESCE(priority, 5)::int, created_at, updated_at,
       COALESCE(per_recipient_optimize, false), send_window_start, send_window_end,
       COALESCE(archive_public, false), COALESCE(archive_slug, ''),
       COALESCE(goal_event, ''), COALESCE(goal_window_hours, 0),
       COALESCE(audience_mode, 'dynamic'), COALESCE(frozen_freeze_id::text, ''),
       COALESCE(folder_id::text, ''),
       COALESCE(source_template_id::text, ''), source_template_updated_at,
       COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
       '{}'::jsonb,
	       COALESCE(source_template_design_draft_id::text, ''),
	       COALESCE(source_template_design_revision, 0),
	       COALESCE(source_template_design_output_hash, ''),
	       source_mode, content_schema_version, '{}'::jsonb`

type scanner interface {
	Scan(dest ...any) error
}

func scanCampaign(row scanner) (*Campaign, error) {
	var c Campaign
	var contentRaw, sectionIDsRaw, variantsRaw, trackingRaw, deliveryRaw []byte
	var referenceTemplateIDsRaw, templateVariablesRaw, factContractRaw []byte
	if err := row.Scan(
		&c.ID,
		&c.TenantID,
		&c.Name,
		&c.Subject,
		&c.Status,
		&c.CampaignType,
		&c.EditorMode,
		&c.PreviewText,
		&c.BodyHTML,
		&c.BodyMJML,
		&c.PlainText,
		&c.FromName,
		&c.ReplyTo,
		&contentRaw,
		&sectionIDsRaw,
		&variantsRaw,
		&trackingRaw,
		&deliveryRaw,
		&c.SegmentID,
		&c.ListID,
		&c.ScheduledAt,
		&c.SentAt,
		&c.Priority,
		&c.CreatedAt,
		&c.UpdatedAt,
		&c.PerRecipientOptimize,
		&c.SendWindowStart,
		&c.SendWindowEnd,
		&c.ArchivePublic,
		&c.ArchiveSlug,
		&c.GoalEvent,
		&c.GoalWindowHours,
		&c.AudienceMode,
		&c.FrozenFreezeID,
		&c.FolderID,
		&c.SourceTemplateID,
		&c.SourceTemplateUpdatedAt,
		&referenceTemplateIDsRaw,
		&templateVariablesRaw,
		&c.SourceTemplateDesignDraftID,
		&c.SourceTemplateDesignRevision,
		&c.SourceTemplateDesignOutputHash,
		&c.SourceMode,
		&c.ContentSchemaVersion,
		&factContractRaw,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(contentRaw, &c.ContentBlocks)
	_ = json.Unmarshal(sectionIDsRaw, &c.ReusableSectionIDs)
	_ = json.Unmarshal(variantsRaw, &c.Variants)
	_ = json.Unmarshal(trackingRaw, &c.TrackingSettings)
	_ = json.Unmarshal(deliveryRaw, &c.DeliverySettings)
	_ = json.Unmarshal(referenceTemplateIDsRaw, &c.ReferenceTemplateIDs)
	_ = json.Unmarshal(templateVariablesRaw, &c.TemplateVariables)
	c.FactContract = append(json.RawMessage(nil), factContractRaw...)
	if c.ContentBlocks == nil {
		c.ContentBlocks = []map[string]any{}
	}
	if c.ReusableSectionIDs == nil {
		c.ReusableSectionIDs = []string{}
	}
	if c.Variants == nil {
		c.Variants = []map[string]any{}
	}
	if c.TrackingSettings == nil {
		c.TrackingSettings = map[string]any{}
	}
	if c.DeliverySettings == nil {
		c.DeliverySettings = map[string]any{}
	}
	if c.ReferenceTemplateIDs == nil {
		c.ReferenceTemplateIDs = []string{}
	}
	if c.TemplateVariables == nil {
		c.TemplateVariables = map[string]any{}
	}
	return &c, nil
}

func scanCampaigns(rows pgx.Rows) ([]Campaign, error) {
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		c, err := scanCampaign(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func nonNilSliceMap(v []map[string]any) []map[string]any {
	if v == nil {
		return []map[string]any{}
	}
	return v
}

func normalizeIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			out = append(out, id)
		}
	}
	return out
}
