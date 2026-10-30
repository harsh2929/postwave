// SPDX-License-Identifier: AGPL-3.0-only
//
// Reply persistence — RLS-scoped CRUD against campaign_replies. The
// table is defined in infra/migrations/0087_campaign_replies.sql.

package replies

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

var ErrIdempotencyConflict = errors.New("replies: idempotency conflict")

// TransactionalEngagementClassifier is the canonical F01 composition seam.
// The reply package supplies only normalized event/provenance input; rule and
// registry ownership stays in engagementclassification.
type TransactionalEngagementClassifier interface {
	RecordProviderEvent(
		context.Context,
		pgx.Tx,
		string,
		engagementclassification.ProviderEventInput,
	) error
}

type TransactionalCampaignReportProjector interface {
	ProjectCanonicalEvent(
		context.Context,
		pgx.Tx,
		string,
		campaignreportprojection.CanonicalEvent,
	) error
}

// Store is the per-tenant repository for campaign_replies. It holds a
// reference to the shared pgx pool; every method opens its own
// db.WithTenant transaction so RLS fires.
type Store struct {
	Pool                    *db.Pool
	EngagementClassifier    TransactionalEngagementClassifier
	CampaignReportProjector TransactionalCampaignReportProjector
	Now                     func() time.Time

	// boundTx is set only on the short-lived clone created by PersistInTx. It
	// lets another durable ingest ledger and campaign_replies share one commit
	// without mutating the production Store or opening a nested transaction.
	boundTx pgx.Tx
}

func (s *Store) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// RequiresWorkerScope reports whether PersistInTx must receive a transaction
// carrying app.outbox_worker=true. F01 observation/classification policies use
// that second factor in addition to the tenant GUC; callers must choose the
// stronger transaction before any write instead of having a repository grant
// itself worker authority halfway through a request.
func (s *Store) RequiresWorkerScope() bool {
	return s != nil && s.EngagementClassifier != nil
}

// PersistInTx writes the reply, its human-only canonical event, F01 evidence,
// and compatibility projection on the caller's transaction. It never commits
// or rolls back. This is the convergence seam used by signed generic inbound
// email ingest so inbound_emails and campaign_replies cannot diverge.
func (s *Store) PersistInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	r Reply,
) (id string, isDup bool, err error) {
	if s == nil || tx == nil {
		return "", false, errors.New("replies: PersistInTx requires store and transaction")
	}
	clone := *s
	clone.boundTx = tx
	return clone.Persist(ctx, tenantID, r)
}

// Persist inserts a reply row and reports whether it collapsed into an
// existing row via the (tenant_id, source, raw_message_id) unique
// index. When raw_message_id is empty the index doesn't apply, so the
// row is always inserted (caller is responsible for upstream
// idempotency in that case).
//
// Returns the row's id on either branch (existing row id on duplicate)
// so the caller can log a stable identifier.
func (s *Store) Persist(ctx context.Context, tenantID string, r Reply) (id string, isDup bool, err error) {
	if s == nil || s.Pool == nil {
		return "", false, errors.New("replies: store not initialised")
	}
	if tenantID == "" {
		return "", false, errors.New("replies: empty tenant id")
	}
	// boundedUTF8 BEFORE the emptiness check, not after.
	//
	// recipient_email was the one mandatory string that never reached the
	// chokepoint every other field goes through, so a single 0x00 in a stranger's
	// From address failed the insert on EVERY provider path — and this is an
	// at-least-once ingest, so a failed insert is retried forever rather than
	// dropped. The bytes come from outside; this field is no more trustworthy
	// than the subject or the body beside it.
	//
	// Ordering matters: an address consisting only of NULs must be rejected as
	// EMPTY rather than stored as "". Sanitising after the check would let it
	// through, and 320 bounds it to the RFC 5321 maximum address length.
	r.RecipientEmail = boundedUTF8(strings.ToLower(strings.TrimSpace(r.RecipientEmail)), 320)
	if r.RecipientEmail == "" {
		return "", false, errors.New("replies: empty recipient_email")
	}
	if !r.Source.Valid() {
		return "", false, errors.New("replies: empty source")
	}
	if r.MatchMethod == "" {
		r.MatchMethod = MatchNone
	}
	if !r.MatchMethod.Valid() {
		return "", false, errors.New("replies: invalid match method")
	}
	r.RawMessageID = boundedUTF8(strings.TrimSpace(r.RawMessageID), 500)
	r.InReplyTo = boundedUTF8(stripAngleBrackets(r.InReplyTo), 998)
	r.Subject = boundedUTF8(strings.TrimSpace(r.Subject), 4096)
	r.BodySnippet = boundedUTF8(strings.TrimSpace(r.BodySnippet), BodySnippetMaxLen)

	classificationBody := r.ClassificationBody
	if strings.TrimSpace(classificationBody) == "" {
		classificationBody = r.BodySnippet
	}
	classificationBody = boundedUTF8(classificationBody, ClassificationBodyMaxLen)
	r.BodyStripped = boundedUTF8(
		StripQuotedHistory(classificationBody), ClassificationBodyMaxLen,
	)
	decision := ClassifyReplyWithEvidence(
		cloneClassificationHeaders(r.ClassificationHeaders), r.Subject, r.BodyStripped,
	)
	// Incoming Classification is never trusted. This assignment is the one
	// production classification authority for campaign_replies.
	r.Classification = decision.Class

	receivedAt := r.ReceivedAt.UTC()
	if receivedAt.IsZero() {
		receivedAt = s.now()
	}
	r.ReceivedAt = receivedAt

	if r.MatchMethod == MatchInReplyTo && r.InReplyTo == "" {
		return "", false, errors.New("replies: in_reply_to match has no Message-ID")
	}
	if r.MatchMethod == MatchVERP && strings.TrimSpace(r.EnvelopeRecipient) == "" {
		return "", false, errors.New("replies: VERP match has no envelope recipient")
	}

	// F01 refuses to grant itself worker authority. An owned transaction opens
	// the stronger scope before any write. A caller-bound transaction is
	// verified rather than upgraded, preserving the same least-authority rule.
	tx := s.boundTx
	ownsTx := tx == nil
	if ownsTx {
		if s.EngagementClassifier != nil {
			tx, err = db.WithTenantWorker(ctx, s.Pool, tenantID)
		} else {
			tx, err = db.WithTenant(ctx, s.Pool, tenantID)
		}
		if err != nil {
			return "", false, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
	} else if err := verifyPersistTxScope(ctx, tx, tenantID, s.RequiresWorkerScope()); err != nil {
		return "", false, err
	}

	isSandbox := false
	if strings.TrimSpace(r.CampaignID) != "" {
		err = tx.QueryRow(ctx, `
SELECT is_sandbox
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, r.CampaignID).
			Scan(&isSandbox)
		if err != nil {
			return "", false, fmt.Errorf("replies: validate correlated campaign: %w", err)
		}
	}
	metadata, err := replyMetadata(r.Metadata, decision, r.MatchMethod, isSandbox)
	if err != nil {
		return "", false, err
	}
	r.Metadata = metadata

	// We use ON CONFLICT DO NOTHING + a follow-up SELECT so we can
	// report isDup without relying on the row count return shape.
	// The unique index is partial (raw_message_id IS NOT NULL) so the
	// conflict target uses the same predicate.
	const ins = `
INSERT INTO campaign_replies
       (tenant_id, campaign_id, subscriber_id, recipient_email, in_reply_to,
        subject, body_snippet, raw_message_id, source, metadata,
        classification, body_stripped, classified_at, received_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::citext, NULLIF($5,''),
        NULLIF($6,''), NULLIF($7,''), NULLIF($8,''), $9, COALESCE($10::jsonb, '{}'::jsonb),
        $11, NULLIF($12,''), clock_timestamp(), $13)
ON CONFLICT (tenant_id, source, raw_message_id) WHERE raw_message_id IS NOT NULL
DO NOTHING
RETURNING id::text`
	row := tx.QueryRow(ctx, ins,
		tenantID,
		nilIfEmpty(r.CampaignID),
		nilIfEmpty(r.SubscriberID),
		r.RecipientEmail,
		strings.TrimSpace(r.InReplyTo),
		r.Subject,
		r.BodySnippet,
		strings.TrimSpace(r.RawMessageID),
		string(r.Source),
		stringOrNil(r.Metadata),
		string(r.Classification),
		r.BodyStripped,
		r.ReceivedAt,
	)
	if err := row.Scan(&id); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", false, fmt.Errorf("replies: insert: %w", err)
		}
		// Conflict replay is accepted only when all immutable payload fields
		// match. A provider id reused for another sender/body/classification is
		// an integrity error, not a duplicate success.
		isDup = true
		row2 := tx.QueryRow(ctx, `
SELECT id::text FROM campaign_replies
 WHERE tenant_id = $1::uuid
   AND source = $2
   AND raw_message_id = $3
   AND campaign_id IS NOT DISTINCT FROM NULLIF($4, '')::uuid
   AND subscriber_id IS NOT DISTINCT FROM NULLIF($5, '')::uuid
   AND recipient_email = $6::citext
   AND in_reply_to IS NOT DISTINCT FROM NULLIF($7, '')
   AND subject IS NOT DISTINCT FROM NULLIF($8, '')
   AND body_snippet IS NOT DISTINCT FROM NULLIF($9, '')
   AND metadata = $10::jsonb
   AND classification = $11
   AND body_stripped IS NOT DISTINCT FROM NULLIF($12, '')
   AND received_at = $13
 LIMIT 1`, tenantID, string(r.Source), r.RawMessageID, r.CampaignID,
			r.SubscriberID, r.RecipientEmail, r.InReplyTo, r.Subject,
			r.BodySnippet, string(r.Metadata), string(r.Classification), r.BodyStripped,
			r.ReceivedAt)
		if err := row2.Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", true, ErrIdempotencyConflict
			}
			return "", true, fmt.Errorf("replies: verify existing reply: %w", err)
		}
	}
	// Emit the canonical event only for a newly stored, header-classified human
	// reply with strong correlation, a stable replay key, a non-sandbox campaign,
	// and the F01 runtime composed. Sender fallback never becomes human evidence.
	//
	// Four subsystems already weight this event type and no writer produced it:
	// send-time optimisation (signal weight), day-of-week patterns (three
	// queries), lead scoring (weight 10), and the profile summary. All of them
	// were reading zero rows, so a subscriber who replied to every campaign
	// looked identical to one who never opened anything.
	//
	// Human-only is not a refinement, it is the point. An out-of-office notice
	// emitting `replied` would push a lead score up by 10 and teach send-time
	// optimisation that the recipient is most engaged at 03:00 when their
	// auto-responder fired — the same corruption as counting it in reply totals,
	// with a longer blast radius because these signals feed scheduling.
	//
	// Skipped on the duplicate path: a redelivered webhook must not score twice.
	emitCanonical := !isDup && decision.Class.CountsAsEngagement() &&
		r.MatchMethod.Strong() && r.CampaignID != "" && r.RawMessageID != "" &&
		!isSandbox && s.EngagementClassifier != nil
	if emitCanonical {
		eventSource := "reply." + string(r.Source)
		claim, err := subscriberevents.ClaimDedupKey(
			ctx, tx, tenantID, eventSource, r.RawMessageID,
		)
		if err != nil {
			return "", false, err
		}
		if !claim.Claimed {
			return "", false, fmt.Errorf("%w: canonical reply key already belongs to event %d", ErrIdempotencyConflict, claim.ExistingID)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','true',true)`); err != nil {
			return "", false, fmt.Errorf("replies: enable seed origin resolution: %w", err)
		}
		eventMetadata, _ := json.Marshal(map[string]any{
			"campaign_reply_id":        id,
			"correlation_method":       string(r.MatchMethod),
			"reply_classifier_version": decision.Version,
		})
		var eventID int64
		var eventAt time.Time
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, campaign_id, at, source,
     source_event_id, message_id, metadata)
VALUES ($1::uuid, $2, 'replied', $3::uuid, $4, $5, $6, NULLIF($7,''), $8::jsonb)
RETURNING id, at`, tenantID, r.RecipientEmail, r.CampaignID, r.ReceivedAt,
			eventSource, r.RawMessageID, r.InReplyTo, string(eventMetadata)).
			Scan(&eventID, &eventAt); err != nil {
			return "", false, fmt.Errorf("replies: emit canonical replied event: %w", err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','false',true)`); err != nil {
			return "", false, fmt.Errorf("replies: close seed origin resolution: %w", err)
		}
		if err := subscriberevents.BindDedupKey(
			ctx, tx, tenantID, eventSource, r.RawMessageID, eventID, eventAt,
		); err != nil {
			return "", false, err
		}

		if err := s.EngagementClassifier.RecordProviderEvent(
			ctx, tx, tenantID, engagementclassification.ProviderEventInput{
				EventRef: engagementclassification.EventRef{ID: eventID, At: eventAt},
				Source:   eventSource, SourceEventID: r.RawMessageID,
				IdempotencyKey: fmt.Sprintf(
					"reply-event:%d:%s", eventID,
					eventAt.UTC().Format(time.RFC3339Nano),
				),
				EventSchemaVersion: engagementclassification.ObservationSchemaV1,
				EventType:          "replied",
				OccurredAt:         eventAt,
				IngestedAt:         s.now(),
				RecipientAddress:   r.RecipientEmail,
				MessageIdentity:    replyMessageIdentity(r),
				ProviderMessageID:  r.RawMessageID,
				OrderedHeaders:     evidenceHeaderNames(r.ClassificationHeaders),
				// Values are intentionally removed; names prove availability only.
				OrderedHeadersComplete: false,
				ProviderSignals: map[string]any{
					"reply_classification":       string(decision.Class),
					"reply_classifier_version":   decision.Version,
					"reply_classifier_reason":    decision.StableReason,
					"reply_classifier_evidence":  append([]string(nil), decision.Evidence...),
					"reply_correlation_method":   string(r.MatchMethod),
					"reply_correlation_strength": "strong",
				},
			},
		); err != nil {
			return "", false, fmt.Errorf("replies: classify canonical replied event: %w", err)
		}
		if s.CampaignReportProjector != nil {
			if err := s.CampaignReportProjector.ProjectCanonicalEvent(
				ctx, tx, tenantID, campaignreportprojection.CanonicalEvent{
					EventRef:  campaignreportprojection.EventRef{ID: eventID, At: eventAt},
					EventType: "replied", CampaignID: r.CampaignID,
				},
			); err != nil {
				return "", false, fmt.Errorf("replies: project canonical replied event: %w", err)
			}
		}
	}

	if ownsTx {
		if err := tx.Commit(ctx); err != nil {
			return "", isDup, err
		}
	}
	return id, isDup, nil
}

func verifyPersistTxScope(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	requireWorker bool,
) error {
	var scopedTenant, worker string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(current_setting('app.tenant_id', true), ''),
       COALESCE(current_setting('app.outbox_worker', true), '')`).
		Scan(&scopedTenant, &worker); err != nil {
		return fmt.Errorf("replies: inspect caller transaction scope: %w", err)
	}
	if scopedTenant != tenantID {
		return errors.New("replies: caller transaction tenant scope mismatch")
	}
	if requireWorker && worker != "true" {
		return errors.New("replies: caller transaction lacks required worker scope")
	}
	return nil
}

// CountForCampaign returns the total reply count for a campaign. Used
// by the A/B winner picker as the numerator for reply_rate.
//
// Counts only rows the header-first reply classifier identified as human.
// Unclassified historical rows and every automatic/exclusion class remain
// visible in their own report bands but cannot select an A/B winner.
func (s *Store) CountForCampaign(ctx context.Context, tenantID, campaignID string) (int, error) {
	if s == nil || s.Pool == nil {
		return 0, errors.New("replies: store not initialised")
	}
	if tenantID == "" || campaignID == "" {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	row := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM campaign_replies
 WHERE campaign_id = $1::uuid`+HumanEngagementPredicate, campaignID)
	if err := row.Scan(&n); err != nil {
		return 0, fmt.Errorf("replies: count: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ListForCampaign returns the most recent reply rows for a campaign.
// limit is clamped to (0, 500]; offset is non-negative.
func (s *Store) ListForCampaign(ctx context.Context, tenantID, campaignID string, limit, offset int) ([]Reply, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("replies: store not initialised")
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text,
       COALESCE(campaign_id::text, ''),
       COALESCE(subscriber_id::text, ''),
       recipient_email::text,
       COALESCE(in_reply_to, ''),
       COALESCE(subject, ''),
       COALESCE(body_snippet, ''),
       COALESCE(raw_message_id, ''),
       source, received_at, metadata
  FROM campaign_replies
 WHERE campaign_id = $1::uuid
 ORDER BY received_at DESC
 LIMIT $2 OFFSET $3`, campaignID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("replies: list: %w", err)
	}
	defer rows.Close()
	out := make([]Reply, 0, limit)
	for rows.Next() {
		var r Reply
		var src string
		var meta []byte
		if err := rows.Scan(&r.ID, &r.TenantID, &r.CampaignID, &r.SubscriberID,
			&r.RecipientEmail, &r.InReplyTo, &r.Subject, &r.BodySnippet,
			&r.RawMessageID, &src, &r.ReceivedAt, &meta); err != nil {
			return nil, err
		}
		r.Source = Source(src)
		if len(meta) > 0 {
			r.Metadata = append([]byte(nil), meta...)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LinkSubscriber attaches a subscriber id to a previously-persisted
// reply. Used by the retroactive resolution path: when a subscriber
// signs up after their reply has already been recorded, we backfill
// the link so analytics queries can group by subscriber.
func (s *Store) LinkSubscriber(ctx context.Context, tenantID, replyID, subscriberID string) error {
	if s == nil || s.Pool == nil {
		return errors.New("replies: store not initialised")
	}
	if tenantID == "" || replyID == "" || subscriberID == "" {
		return errors.New("replies: LinkSubscriber requires tenant, reply, subscriber")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_replies
   SET subscriber_id = $1::uuid
 WHERE id = $2::uuid
   AND tenant_id = $3::uuid`,
		subscriberID, replyID, tenantID)
	if err != nil {
		return fmt.Errorf("replies: link subscriber: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("replies: link subscriber: not found")
	}
	return tx.Commit(ctx)
}

var classificationHeaderNames = map[string]string{
	"auto-submitted":           "Auto-Submitted",
	"precedence":               "Precedence",
	"x-autoreply":              "X-Autoreply",
	"x-autorespond":            "X-Autorespond",
	"x-auto-response-suppress": "X-Auto-Response-Suppress",
	"content-type":             "Content-Type",
	"return-path":              "Return-Path",
}

func cloneClassificationHeaders(input Headers) Headers {
	out := make(Headers, len(input))
	for name, value := range input {
		canonical, allowed := classificationHeaderNames[strings.ToLower(strings.TrimSpace(name))]
		if !allowed {
			continue
		}
		out[canonical] = boundedUTF8(strings.TrimSpace(value), 4096)
	}
	return out
}

func evidenceHeaderNames(input Headers) []engagementclassification.Header {
	names := make([]string, 0, len(input))
	for name, value := range cloneClassificationHeaders(input) {
		if value != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	out := make([]engagementclassification.Header, 0, len(names))
	for _, name := range names {
		// Empty Value is intentional: raw values may contain addresses or other
		// user-controlled text. Stable reply rule ids carry the useful meaning.
		out = append(out, engagementclassification.Header{Name: name})
	}
	return out
}

func replyMetadata(
	raw json.RawMessage,
	decision ClassificationDecision,
	method MatchMethod,
	isSandbox bool,
) (json.RawMessage, error) {
	metadata := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &metadata); err != nil || metadata == nil {
			return nil, errors.New("replies: metadata must be a JSON object")
		}
	}
	metadata["classification_receipt"] = map[string]any{
		"version":       decision.Version,
		"class":         string(decision.Class),
		"stable_reason": decision.StableReason,
		"evidence":      append([]string(nil), decision.Evidence...),
	}
	metadata["correlation"] = map[string]any{
		"method":           string(method),
		"strong":           method.Strong(),
		"sandbox_excluded": isSandbox,
	}
	out, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("replies: marshal metadata: %w", err)
	}
	return json.RawMessage(out), nil
}

func replyMessageIdentity(r Reply) string {
	if r.MatchMethod == MatchInReplyTo {
		return r.InReplyTo
	}
	if r.MatchMethod == MatchVERP {
		// A VERP token is deliberately allowed to carry the nil subscriber, so a
		// recipient with no subscribers row still gets CAMPAIGN attribution. But
		// the message identity must not be minted from it.
		//
		// "verp:<campaign>:" is the SAME STRING for every subscriber-less
		// recipient of that campaign, and it is not empty, so it hashes to a real
		// message_identity_hash and loadMessageAggregate groups on exactly that
		// column. Replies from N different strangers would be aggregated as if
		// they were one message — and message-level rules then reason about
		// "forty opens 200ms apart" that belong to forty different people.
		//
		// An empty identity means "this observation has no message identity",
		// which is the truth here: without a subscriber there is nothing that
		// names one message. That is the same rule the rest of this system
		// follows — an unknown value stays unknown rather than being folded into
		// a bucket it was never measured into.
		if strings.TrimSpace(r.SubscriberID) == "" {
			return ""
		}
		return "verp:" + r.CampaignID + ":" + r.SubscriberID
	}
	return ""
}

func boundedUTF8(value string, maximum int) string {
	// NUL is removed before the UTF-8 repair, not by it. 0x00 is perfectly
	// valid UTF-8, so strings.ToValidUTF8 keeps it — and Postgres text rejects
	// it outright ("invalid byte sequence for encoding UTF8: 0x00"), while
	// json.Marshal turns it into a \u0000 escape that jsonb also rejects.
	//
	// The bytes here came from a stranger. Without this, one 0x00 anywhere in a
	// sender's subject, body or address turns every attempt to store that reply
	// into a failed insert, which an at-least-once ingest path retries forever.
	// Every provider adapter reaches the database through this one function, so
	// this is the one place the whole class is closed.
	value = strings.ToValidUTF8(strings.ReplaceAll(value, "\x00", ""), "")
	if maximum <= 0 || len(value) <= maximum {
		return value
	}
	end := maximum
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func nilIfEmpty(s string) interface{} {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func stringOrNil(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}
