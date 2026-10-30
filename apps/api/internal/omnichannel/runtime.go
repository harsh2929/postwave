// SPDX-License-Identifier: AGPL-3.0-only
//
// runtime.go is the contained omnichannel send-execution implementation. The control plane
// (omnichannel.go/repo.go) stored campaign paths as configuration but never
// produced recipients or sends — the side tables omni_recipients,
// channel_send_history, channel_sender_profiles and channel_smart_sending_policies
// were schema-only. These primitives remain unavailable at the public boundary
// until their durability and provider contracts are certified:
//
//	Materialize  — resolve each path's audience (segment + channel consent) into
//	               omni_recipients rows, one per (path, subscriber-identity).
//	Evaluate     — gate queued recipients: suppression by Smart-Sending recency
//	               (channel_send_history) and per-tenant sender readiness
//	               (channel_sender_profiles); survivors become 'eligible'.
//	Dispatch     — hand each eligible recipient to a ChannelSender, record the
//	               outcome in channel_send_history, advance the recipient.
//	Report       — aggregate channel_send_history per path+channel+status.
//
// No channel is advertised as runnable today. Direct use still requires an
// explicit segment, and a non-terminal/no-provider sender outcome fails rather
// than being counted as dispatched.
package omnichannel

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// consentChannel maps a path channel to the channel-consent vector it gates on.
// whatsapp/rcs are phone channels and reuse the sms consent gate.
func consentChannel(channel string) string {
	switch channel {
	case "sms", "whatsapp", "rcs":
		return "sms"
	case "push":
		return "push"
	default:
		return "email"
	}
}

// identityColumn is the subscriber column carrying the channel's send identity,
// and the omni_recipients column it lands in.
func identityColumns(channel string) (subCol, recipientCol string, ok bool) {
	switch channel {
	case "email":
		return "email", "email", true
	case "sms", "whatsapp", "rcs":
		// Operator-supplied first, DERIVED as a fallback.
		//
		// `phone_e164` is a profile field a tenant may maintain; `sms_send_identity`
		// is filled from the subscriber's eligible SMS opt-in by the consent
		// triggers (migration 1866). They are kept apart because
		// `sms_binding_not_contradicted` reads `phone_e164` as EVIDENCE of which
		// number belongs to a subscriber — deriving into it made that guard
		// arbitrate against its own output and locked a subscriber out of SMS
		// permanently after they changed numbers.
		return "COALESCE(subscribers.phone_e164, subscribers.sms_send_identity)", "phone_e164", true
	default:
		// push needs a device-token join that lives outside the subscriber row;
		// not materialized by this spine yet.
		return "", "", false
	}
}

// MaterializeResult reports how recipient materialization went, per path.
type MaterializeResult struct {
	CampaignID string                  `json:"campaign_id"`
	Paths      []PathMaterializeResult `json:"paths"`
	Total      int                     `json:"total_materialized"`
}

type PathMaterializeResult struct {
	PathID       string `json:"path_id"`
	PathKey      string `json:"path_key"`
	Channel      string `json:"channel"`
	Materialized int    `json:"materialized"`
	Skipped      string `json:"skipped,omitempty"`
}

var placeholderRe = regexp.MustCompile(`\$(\d+)`)

// renumberPlaceholders shifts $1..$N in a compiled fragment up by offset so it
// can be spliced after offset fixed parameters.
func renumberPlaceholders(frag string, offset int) string {
	return placeholderRe.ReplaceAllStringFunc(frag, func(m string) string {
		n, _ := strconv.Atoi(m[1:])
		return "$" + strconv.Itoa(n+offset)
	})
}

// pathSegmentID extracts the segment id a path (or the campaign) targets. Paths
// may carry their own audience.segment_id; otherwise the campaign-level
// audience_strategy.segment_id applies. An empty result is never an implicit
// whole-audience instruction; callers must fail closed.
func pathSegmentID(path CampaignPath, campaignAudience map[string]any) string {
	if id := stringField(path.Audience, "segment_id"); id != "" {
		return id
	}
	return stringField(campaignAudience, "segment_id")
}

func explicitPathSegmentID(path CampaignPath, campaignAudience map[string]any) (string, error) {
	segmentID := pathSegmentID(path, campaignAudience)
	if segmentID == "" {
		return "", fmt.Errorf("%w: path %q requires an explicit segment_id", ErrInvalidInput, path.PathKey)
	}
	return segmentID, nil
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// Materialize resolves every path's audience into omni_recipients. Idempotent:
// re-running only adds newly-matching identities (ON CONFLICT DO NOTHING against
// the per-(campaign,path,identity) unique index). Returns per-path counts.
func (r *Repo) Materialize(ctx context.Context, tenantID, campaignID string) (*MaterializeResult, error) {
	if !omnichannelRuntimeQualified {
		return nil, ErrOmnichannelRuntimeUnavailable
	}
	camp, err := r.GetCampaign(ctx, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &MaterializeResult{CampaignID: campaignID}
	for _, path := range camp.Paths {
		res := PathMaterializeResult{PathID: path.ID, PathKey: path.PathKey, Channel: path.Channel}
		subCol, recipientCol, ok := identityColumns(path.Channel)
		if !ok {
			res.Skipped = "channel not materializable by this spine yet"
			out.Paths = append(out.Paths, res)
			continue
		}
		segmentID, err := explicitPathSegmentID(path, camp.AudienceStrategy)
		if err != nil {
			return nil, err
		}
		where, args, err := buildPathAudienceWhere(ctx, tx, tenantID, campaignID, path.ID, segmentID, path.Channel)
		if err != nil {
			return nil, err
		}
		// $1 tenant, $2 campaign, $3 path are referenced by the SELECT constants
		// (and $1 again by the WHERE tenant filter). Segment args start at $4.
		sql := `
INSERT INTO omni_recipients (tenant_id, campaign_id, path_id, subscriber_id, ` + recipientCol + `, channel, status)
SELECT $1::uuid, $2::uuid, $3::uuid, id, ` + subCol + `, $` + strconv.Itoa(len(args)+1) + `, 'queued'
FROM subscribers
WHERE ` + where + `
  AND ` + subCol + ` IS NOT NULL AND ` + subCol + `::text <> ''
ON CONFLICT DO NOTHING`
		args = append(args, path.Channel)
		tag, err := tx.Exec(ctx, sql, args...)
		if err != nil {
			return nil, fmt.Errorf("omnichannel: materialize path %s: %w", path.PathKey, err)
		}
		res.Materialized = int(tag.RowsAffected())
		out.Total += res.Materialized
		out.Paths = append(out.Paths, res)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// buildPathAudienceWhere builds the subscriber WHERE for one path: enabled
// subscribers in the path's segment, gated by the path channel's consent
// vector. Mirrors campaigns.buildAudienceWhere but renumbers segment
// placeholders to sit after the 3 fixed INSERT parameters (tenant, campaign,
// path).
func buildPathAudienceWhere(ctx context.Context, tx pgx.Tx, tenantID, campaignID, pathID, segmentID, channel string) (string, []any, error) {
	where := "tenant_id = $1::uuid"
	args := []any{tenantID, campaignID, pathID}
	var astRaw []byte
	if segmentID != "" {
		err := tx.QueryRow(ctx, `SELECT query_ast FROM segments WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, segmentID).Scan(&astRaw)
		if err != nil {
			if err == pgx.ErrNoRows {
				return "", nil, fmt.Errorf("%w: segment %s", ErrInvalidInput, segmentID)
			}
			return "", nil, err
		}
	}
	predicate, err := segments.CompilePopulation(
		ctx,
		astRaw,
		tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		segments.ActivationPopulation(segments.ActivationChannel(consentChannel(channel))),
	)
	if err != nil {
		return "", nil, fmt.Errorf("omnichannel: compile activation population: %w", err)
	}
	where += " AND (" + renumberPlaceholders(predicate.SQL, len(args)) + ")"
	args = append(args, predicate.Args...)
	return where, args, nil
}

// EligibilityResult summarizes an Evaluate pass.
type EligibilityResult struct {
	CampaignID       string         `json:"campaign_id"`
	Eligible         int            `json:"eligible"`
	Suppressed       int            `json:"suppressed"`
	BySuppressReason map[string]int `json:"suppressed_by_reason,omitempty"`
}

// Evaluate gates every 'queued' recipient of the campaign:
//   - sender readiness: email is always ready; other channels require a
//     channel_sender_profiles row with status='ready'. Unready ⇒ suppressed.
//   - Smart Sending: if the identity was contacted on the same channel within
//     the tenant's policy window (channel_send_history), suppress as a dup.
//
// Recipients that pass become 'eligible'; the rest become 'suppressed' with a
// reason. Set-based so it scales to large audiences.
func (r *Repo) Evaluate(ctx context.Context, tenantID, campaignID string) (*EligibilityResult, error) {
	if !omnichannelRuntimeQualified {
		return nil, ErrOmnichannelRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &EligibilityResult{CampaignID: campaignID, BySuppressReason: map[string]int{}}

	// 1) Sender readiness — suppress queued recipients on channels with no ready
	//    sender profile (email is exempt: it is always sendable natively).
	readinessTag, err := tx.Exec(ctx, `
UPDATE omni_recipients o
   SET status = 'suppressed', suppressed_reason = 'sender_not_ready'
 WHERE o.tenant_id = $1::uuid AND o.campaign_id = $2::uuid AND o.status = 'queued'
   AND o.channel <> 'email'
   AND NOT EXISTS (
       SELECT 1 FROM channel_sender_profiles p
        WHERE p.tenant_id = o.tenant_id AND p.channel = o.channel AND p.status = 'ready'
   )`, tenantID, campaignID)
	if err != nil {
		return nil, fmt.Errorf("omnichannel: readiness gate: %w", err)
	}
	out.BySuppressReason["sender_not_ready"] = int(readinessTag.RowsAffected())

	// 2) Smart Sending — suppress queued recipients whose identity was contacted
	//    on the same channel within the active policy window. A policy whose
	//    channel is 'all' applies across every channel; only campaign-scoped
	//    policies (scope campaigns / campaigns_and_flows) gate this campaign
	//    path. No matching policy ⇒ no recency suppression.
	smartTag, err := tx.Exec(ctx, `
UPDATE omni_recipients o
   SET status = 'suppressed', suppressed_reason = 'smart_sending'
 WHERE o.tenant_id = $1::uuid AND o.campaign_id = $2::uuid AND o.status = 'queued'
   AND EXISTS (
       SELECT 1
         FROM channel_smart_sending_policies pol
         JOIN channel_send_history h
           ON h.tenant_id = o.tenant_id
          AND h.channel = o.channel
          AND COALESCE(h.email::text,'') = COALESCE(o.email::text,'')
          AND h.phone_e164 = o.phone_e164
          AND h.status NOT IN ('failed','bounced','suppressed')
        WHERE pol.tenant_id = o.tenant_id
          AND (pol.channel = o.channel OR pol.channel = 'all')
          AND pol.status = 'active'
          AND pol.scope IN ('campaigns','campaigns_and_flows')
          AND h.created_at >= now() - make_interval(secs => pol.window_seconds)
   )`, tenantID, campaignID)
	if err != nil {
		return nil, fmt.Errorf("omnichannel: smart-sending gate: %w", err)
	}
	out.BySuppressReason["smart_sending"] = int(smartTag.RowsAffected())

	// 3) Promote survivors to eligible.
	eligTag, err := tx.Exec(ctx, `
UPDATE omni_recipients
   SET status = 'eligible'
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND status = 'queued'`, tenantID, campaignID)
	if err != nil {
		return nil, fmt.Errorf("omnichannel: promote eligible: %w", err)
	}
	out.Eligible = int(eligTag.RowsAffected())
	out.Suppressed = out.BySuppressReason["sender_not_ready"] + out.BySuppressReason["smart_sending"]
	for k, v := range out.BySuppressReason {
		if v == 0 {
			delete(out.BySuppressReason, k)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// SendOutcome is what a ChannelSender reports for one recipient.
type SendOutcome struct {
	// Status is a channel_send_history status. The current synchronous runtime
	// accepts only terminal 'sent' or 'failed' evidence. 'queued' and unknown
	// outcomes fail closed because no durable continuation owns them.
	Status            string
	Provider          string
	ProviderMessageID string
	Reason            string // failure detail, recorded in metadata
}

// EligibleRecipient is one recipient handed to a ChannelSender.
type EligibleRecipient struct {
	RecipientID  string
	PathID       string
	SubscriberID string
	Channel      string
	Email        string
	PhoneE164    string
	TemplateID   string
}

// ChannelSender delivers one message. Provider adapters must return terminal
// evidence; an asynchronous handoff needs a separate durable continuation
// before it can be accepted by this runtime.
type ChannelSender interface {
	Send(ctx context.Context, tenantID string, rec EligibleRecipient) SendOutcome
}

// recordOnlySender is retained for source compatibility, but deliberately
// fails. Recording intent without a live provider must not advance a recipient
// or inflate dispatch reporting.
type recordOnlySender struct{}

func (recordOnlySender) Send(_ context.Context, _ string, _ EligibleRecipient) SendOutcome {
	return SendOutcome{Status: "failed", Reason: "no live channel sender is configured"}
}

// DefaultSender is fail-closed when no live provider adapter is wired.
var DefaultSender ChannelSender = recordOnlySender{}

// DispatchResult summarizes a Dispatch pass.
type DispatchResult struct {
	CampaignID string `json:"campaign_id"`
	Dispatched int    `json:"dispatched"`
	Failed     int    `json:"failed"`
}

// Dispatch hands each 'eligible' recipient to sender, records the outcome in
// channel_send_history, and advances the recipient (sent/failed). batchLimit
// caps one pass so a huge audience drains across calls. A per-recipient send
// error never aborts the batch.
func (r *Repo) Dispatch(ctx context.Context, tenantID, campaignID string, sender ChannelSender, batchLimit int) (*DispatchResult, error) {
	if !omnichannelRuntimeQualified {
		return nil, ErrOmnichannelRuntimeUnavailable
	}
	if sender == nil {
		sender = DefaultSender
	}
	if batchLimit <= 0 || batchLimit > 5000 {
		batchLimit = 1000
	}
	// Self-heal: requeue recipients stranded in 'sending' by a prior dispatch
	// that crashed between claim and record. Dispatch is synchronous, so any
	// 'sending' row older than the threshold is genuinely stuck (not in flight).
	// Best-effort — a requeue failure must not block this dispatch.
	_ = r.requeueStuckSending(ctx, tenantID, campaignID, 15*time.Minute)
	recs, err := r.claimEligible(ctx, tenantID, campaignID, batchLimit)
	if err != nil {
		return nil, err
	}
	out := &DispatchResult{CampaignID: campaignID}
	for _, rec := range recs {
		outcome := sender.Send(ctx, tenantID, rec)
		status := terminalSendStatus(&outcome)
		if err := r.recordSend(ctx, tenantID, campaignID, rec, status, outcome); err != nil {
			return out, err
		}
		if status == "failed" {
			out.Failed++
		} else {
			out.Dispatched++
		}
	}
	return out, nil
}

func terminalSendStatus(outcome *SendOutcome) string {
	if outcome != nil && (outcome.Status == "sent" || outcome.Status == "failed") {
		return outcome.Status
	}
	if outcome != nil {
		if strings.TrimSpace(outcome.Reason) == "" {
			outcome.Reason = "sender returned no terminal delivery evidence"
		}
		outcome.Status = "failed"
	}
	return "failed"
}

// requeueStuckSending flips 'sending' recipients older than olderThan back to
// 'eligible' so a dispatch that crashed mid-batch doesn't strand them. Safe
// because Dispatch records synchronously, so a 'sending' row that hasn't moved
// in olderThan is not in flight.
func (r *Repo) requeueStuckSending(ctx context.Context, tenantID, campaignID string, olderThan time.Duration) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE omni_recipients
   SET status = 'eligible'
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND status = 'sending'
   AND updated_at < now() - make_interval(secs => $3)`,
		tenantID, campaignID, int(olderThan.Seconds())); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// claimEligible atomically flips up to limit 'eligible' recipients to 'sending'
// and returns them, so concurrent dispatchers never double-send (FOR UPDATE
// SKIP LOCKED).
func (r *Repo) claimEligible(ctx context.Context, tenantID, campaignID string, limit int) ([]EligibleRecipient, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
UPDATE omni_recipients
   SET status = 'sending'
 WHERE id IN (
   SELECT id FROM omni_recipients
    WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND status = 'eligible'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT $3
 )
RETURNING id::text, COALESCE(path_id::text,''), COALESCE(subscriber_id::text,''),
          channel, COALESCE(email::text,''), phone_e164`, tenantID, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EligibleRecipient
	for rows.Next() {
		var rec EligibleRecipient
		if err := rows.Scan(&rec.RecipientID, &rec.PathID, &rec.SubscriberID, &rec.Channel, &rec.Email, &rec.PhoneE164); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// recordSend writes a channel_send_history row and advances the recipient.
func (r *Repo) recordSend(ctx context.Context, tenantID, campaignID string, rec EligibleRecipient, status string, outcome SendOutcome) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	meta := "{}"
	if outcome.Reason != "" {
		meta = `{"reason":` + strconv.Quote(outcome.Reason) + `}`
	}
	var sentAt any
	recipientStatus := "failed"
	if status != "failed" {
		sentAt = time.Now().UTC()
		recipientStatus = "sent"
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO channel_send_history
   (tenant_id, campaign_id, path_id, recipient_id, subscriber_id, email, phone_e164,
    channel, provider, provider_message_id, status, metadata, sent_at)
VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, NULLIF($5,'')::uuid,
        NULLIF($6,'')::citext, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
		tenantID, campaignID, rec.PathID, rec.RecipientID, rec.SubscriberID, rec.Email, rec.PhoneE164,
		rec.Channel, outcome.Provider, outcome.ProviderMessageID, status, meta, sentAt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE omni_recipients SET status = $3, sent_at = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, rec.RecipientID, recipientStatus, sentAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CampaignReport is path-level send analytics over channel_send_history.
type CampaignReport struct {
	CampaignID string          `json:"campaign_id"`
	Paths      []PathReportRow `json:"paths"`
	Totals     map[string]int  `json:"totals"`
}

type PathReportRow struct {
	PathID  string         `json:"path_id"`
	Channel string         `json:"channel"`
	Counts  map[string]int `json:"counts"` // status -> count
}

// Report aggregates channel_send_history by path + channel + status, plus a
// status-keyed grand total. This is the path-level reporting the control plane
// previously lacked.
func (r *Repo) Report(ctx context.Context, tenantID, campaignID string) (*CampaignReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(path_id::text,''), channel, status, count(*)
FROM channel_send_history
WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
GROUP BY 1, 2, 3`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type key struct{ path, channel string }
	byPath := map[key]map[string]int{}
	totals := map[string]int{}
	for rows.Next() {
		var path, channel, status string
		var n int
		if err := rows.Scan(&path, &channel, &status, &n); err != nil {
			return nil, err
		}
		k := key{path, channel}
		if byPath[k] == nil {
			byPath[k] = map[string]int{}
		}
		byPath[k][status] += n
		totals[status] += n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := &CampaignReport{CampaignID: campaignID, Totals: totals}
	for k, counts := range byPath {
		out.Paths = append(out.Paths, PathReportRow{PathID: k.path, Channel: k.channel, Counts: counts})
	}
	return out, tx.Commit(ctx)
}
