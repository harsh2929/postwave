// SPDX-License-Identifier: AGPL-3.0-only
//
// incidents.go — handlers for the privacy_incidents response workflow.
// State capture and non-terminal transitions remain available; legal rule
// resolution, sign-off, notification evidence, packet generation, incident
// clocks, and closure are release-held where the current model cannot support
// a truthful production claim.
//
// State machine:
//
//   open -> contained -> notifications_pending -> closed
//
// Every transition writes a row to incident_state_transitions. The legacy 72h
// operational target starts at clock_started_at (which
// currently defaults to detected_at). It is not a legal determination:
// applicable duties depend on awareness, risk, role, and jurisdiction.

package privacy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const incidentJSONMaxBody int64 = 64 << 10 // 64 KiB

const (
	incidentTransitionReasonMaxRunes = 2000
	incidentSummaryMaxRunes          = 4000
	incidentArrayMaxItems            = 64
	incidentArrayTokenMaxRunes       = 256
	incidentNotificationMaxBytes     = 65_536
	incidentMaxAffectedSubjectCount  = int64(1<<31 - 1)
	incidentFutureTimestampSkew      = 5 * time.Minute
	incidentCursorMaxBytes           = 8192
)

// Summary, transition reason, scenario, and findings are multiline narrative
// fields: tabs/newlines are allowed, but NUL is rejected because PostgreSQL
// text cannot store it. Bidirectional formatting controls are also rejected so
// operator-visible forensic text cannot visually reorder actor-supplied
// content. Token/path fields reject Unicode Cc controls plus the same bidi
// formatting controls, while preserving ordinary format characters such as
// the zero-width joiner used in composed emoji.

func containsUnsafeNarrativeControl(value string) bool {
	for _, r := range value {
		switch {
		case r == '\x00',
			r == '\u061c',
			r == '\u200e',
			r == '\u200f',
			r >= '\u202a' && r <= '\u202e',
			r >= '\u2066' && r <= '\u206f':
			return true
		}
	}
	return false
}

func containsUnsafeIncidentTokenControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0 ||
		containsUnsafeNarrativeControl(value)
}

const incidentTransitionLockSQL = `
SELECT status
  FROM privacy_incidents
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
 FOR UPDATE`

const incidentInsertSQL = `
INSERT INTO privacy_incidents (
    tenant_id, severity, status, detected_at, discovered_at, clock_started_at,
    gdpr_72h_deadline, affected_regions, affected_data_categories,
    affected_subject_count, summary, template_version, jurisdictions,
    notification_decisions
) VALUES (
    $1::uuid, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '{}'::jsonb
) RETURNING id, detected_at, discovered_at, clock_started_at,
            gdpr_72h_deadline, created_at, updated_at`

const incidentEventsSQL = `
SELECT event_id::text, source, schema_version, kind, at,
       from_state, to_state, actor, reason, audience,
       template_key, body_sha256, recipient_ref
  FROM (
        SELECT id AS event_id,
               'incident_state_transitions'::text AS source,
               1::int AS schema_version,
               'transition'::text AS kind,
               at,
               0 AS source_order,
               from_state,
               to_state,
               COALESCE(actor_email, '') AS actor,
               COALESCE(reason, '') AS reason,
               ''::text AS audience,
               ''::text AS template_key,
               ''::text AS body_sha256,
               ''::text AS recipient_ref
          FROM incident_state_transitions
         WHERE incident_id = $1::uuid
           AND tenant_id = $2::uuid
        UNION ALL
        SELECT id AS event_id,
               'incident_notifications'::text AS source,
               1::int AS schema_version,
               'notification'::text AS kind,
               sent_at AS at,
               1 AS source_order,
               ''::text AS from_state,
               ''::text AS to_state,
               COALESCE(sent_by, '') AS actor,
               ''::text AS reason,
               audience,
               COALESCE(template_key, '') AS template_key,
               COALESCE(rendered_body_sha256, '') AS body_sha256,
               COALESCE(recipient_ref, '') AS recipient_ref
          FROM incident_notifications
         WHERE incident_id = $1::uuid
           AND tenant_id = $2::uuid
       ) AS ledger
 ORDER BY at ASC, source_order ASC, event_id ASC`

const incidentEventParentLockSQL = `
SELECT true
  FROM privacy_incidents
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
 FOR SHARE`

// gdprWindow preserves the legacy operational target. It MUST NOT be treated
// as a legal deadline until the incident model captures controller awareness,
// risk assessment, role, and a versioned counsel-approved jurisdiction rule.
const gdprWindow = 72 * time.Hour

// validIncidentStates is the canonical state set. Mirrors the CHECK
// constraint on privacy_incidents.status from migration 0094.
var validIncidentStates = map[string]bool{
	"open":                  true,
	"contained":             true,
	"notifications_pending": true,
	"closed":                true,
}

// validIncidentTransitions enforces the workflow direction. A
// transition is allowed when validIncidentTransitions[from][to]==true.
var validIncidentTransitions = map[string]map[string]bool{
	"open":                  {"contained": true, "notifications_pending": true, "closed": true},
	"contained":             {"notifications_pending": true, "closed": true},
	"notifications_pending": {"closed": true, "contained": true},
	"closed":                {},
}

// IncidentsDeps wires the breach-response handlers. Reuses the Pool
// + Now pattern from Deps so tests can inject a deterministic clock.
type IncidentsDeps struct {
	Pool   *db.Pool
	Now    func() time.Time
	Logger *slog.Logger
}

func (d *IncidentsDeps) now() time.Time {
	if d == nil || d.Now == nil {
		return time.Now().UTC()
	}
	return d.Now().UTC()
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type createIncidentRequest struct {
	Severity               string     `json:"severity"`
	Summary                string     `json:"summary"`
	DetectedAt             time.Time  `json:"detected_at"`
	DiscoveredAt           *time.Time `json:"discovered_at"`
	AffectedRegions        []string   `json:"affected_regions"`
	AffectedDataCategories []string   `json:"affected_data_categories"`
	AffectedSubjectCount   *int       `json:"affected_subject_count"`
	Jurisdictions          []string   `json:"jurisdictions"`
}

type incidentRow struct {
	ID                     string                  `json:"id"`
	Severity               string                  `json:"severity"`
	Status                 string                  `json:"status"`
	DetectedAt             time.Time               `json:"detected_at"`
	DiscoveredAt           *time.Time              `json:"discovered_at,omitempty"`
	ClockStartedAt         *time.Time              `json:"clock_started_at,omitempty"`
	GDPR72hDeadline        *time.Time              `json:"gdpr_72h_deadline,omitempty"`
	CounselSignoffAt       *time.Time              `json:"counsel_signoff_at,omitempty"`
	SignoffBy              string                  `json:"signoff_by,omitempty"`
	TemplateVersion        string                  `json:"template_version"`
	AffectedRegions        []string                `json:"affected_regions"`
	AffectedDataCategories []string                `json:"affected_data_categories"`
	AffectedSubjectCount   *int                    `json:"affected_subject_count,omitempty"`
	NotificationDecisions  map[string]any          `json:"notification_decisions"`
	Jurisdictions          []string                `json:"jurisdictions"`
	Summary                string                  `json:"summary"`
	CreatedAt              time.Time               `json:"created_at"`
	UpdatedAt              time.Time               `json:"updated_at"`
	Resolution             *JurisdictionResolution `json:"jurisdiction_resolution,omitempty"`
}

type transitionRequest struct {
	ExpectedFrom string `json:"expected_from"`
	To           string `json:"to"`
	Reason       string `json:"reason"`
}

type transitionResponse struct {
	IncidentID string    `json:"incident_id"`
	From       string    `json:"from"`
	To         string    `json:"to"`
	At         time.Time `json:"at"`
}

type incidentEventRow struct {
	EventID       string    `json:"event_id"`
	Source        string    `json:"source"`
	SchemaVersion int       `json:"schema_version"`
	Kind          string    `json:"kind"`
	At            time.Time `json:"at"`
	FromState     string    `json:"from_state,omitempty"`
	ToState       string    `json:"to_state,omitempty"`
	Actor         string    `json:"actor,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	Audience      string    `json:"audience,omitempty"`
	Template      string    `json:"template_key,omitempty"`
	BodySHA256    string    `json:"body_sha256,omitempty"`
	Recipient     string    `json:"recipient_ref,omitempty"`
}

type listEventsResponse struct {
	IncidentID string             `json:"incident_id"`
	Events     []incidentEventRow `json:"events"`
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Create records a new breach incident. For backward wire compatibility the
// legacy gdpr_72h_deadline field remains derived from detected_at (or now), but
// it is only an operational target and not proof of a statutory deadline. The
// state defaults to 'open'.
func (d *IncidentsDeps) Create(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !requireIncidentIdempotencyKey(w, r) {
		return
	}
	var body createIncidentRequest
	if err := httpbody.DecodeJSONWith(w, r, incidentJSONMaxBody, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	severity := normalizeSeverity(body.Severity)
	if severity == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_severity", "severity must be one of investigating|low|medium|high|critical")
		return
	}
	summary := strings.TrimSpace(body.Summary)
	if summary == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_summary", "summary is required")
		return
	}
	if utf8.RuneCountInString(summary) > incidentSummaryMaxRunes {
		writeJSONError(w, http.StatusBadRequest, "summary_too_long", fmt.Sprintf("summary must be at most %d characters", incidentSummaryMaxRunes))
		return
	}
	if containsUnsafeNarrativeControl(summary) {
		writeJSONError(w, http.StatusBadRequest, "invalid_summary", "summary cannot contain NUL or bidirectional formatting characters")
		return
	}
	if body.AffectedSubjectCount != nil &&
		(*body.AffectedSubjectCount < 0 || int64(*body.AffectedSubjectCount) > incidentMaxAffectedSubjectCount) {
		writeJSONError(w, http.StatusBadRequest, "invalid_affected_subject_count", fmt.Sprintf("affected_subject_count must be between 0 and %d", incidentMaxAffectedSubjectCount))
		return
	}
	regions, categories, jurisdictions, scopeIssue := normalizeIncidentScope(body)
	if scopeIssue != nil {
		writeJSONError(w, http.StatusBadRequest, scopeIssue.Code, scopeIssue.Message)
		return
	}
	now := d.now()
	detectedAt := body.DetectedAt
	if detectedAt.IsZero() {
		detectedAt = now
	}
	var discoveredAt *time.Time
	if body.DiscoveredAt != nil {
		discovered := body.DiscoveredAt.UTC()
		discoveredAt = &discovered
	}
	if detectedAt.After(now.Add(incidentFutureTimestampSkew)) ||
		(discoveredAt != nil && discoveredAt.After(now.Add(incidentFutureTimestampSkew))) {
		writeJSONError(w, http.StatusBadRequest, "invalid_incident_timestamp", "detected_at and discovered_at cannot be more than 5 minutes in the future")
		return
	}
	clockStarted := detectedAt
	deadline := clockStarted.Add(gdprWindow).UTC()
	var affectedSubjectCount any
	if body.AffectedSubjectCount != nil {
		affectedSubjectCount = *body.AffectedSubjectCount
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		id                 string
		storedDetectedAt   time.Time
		storedDiscoveredAt *time.Time
		storedClockStarted time.Time
		storedDeadline     time.Time
		storedCreatedAt    time.Time
		storedUpdatedAt    time.Time
	)
	err = tx.QueryRow(r.Context(), incidentInsertSQL,
		tenant.ID, severity, detectedAt, discoveredAt, clockStarted, deadline,
		regions, categories, affectedSubjectCount, summary, templateVersion,
		jurisdictions,
	).Scan(
		&id,
		&storedDetectedAt,
		&storedDiscoveredAt,
		&storedClockStarted,
		&storedDeadline,
		&storedCreatedAt,
		&storedUpdatedAt,
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	actor := incidentActorLabel(r)
	if _, err := tx.Exec(r.Context(), `
INSERT INTO incident_state_transitions (
    tenant_id, incident_id, from_state, to_state, actor_email, reason, at
) VALUES ($1::uuid, $2::uuid, '', 'open', $3, 'incident opened', $4)`,
		tenant.ID, id, actor, now,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(
		r.Context(),
		tx,
		auditMetaFromRequest(r, tenant.ID),
		"privacy.incident_opened",
		"privacy_incident",
		id,
		incidentOpenedAuditMetadata(regions, categories, jurisdictions, body.AffectedSubjectCount),
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	resolution := ResolveJurisdictions(jurisdictions, categories, intOrZero(body.AffectedSubjectCount), storedClockStarted)
	row := incidentRow{
		ID:                     id,
		Severity:               severity,
		Status:                 "open",
		DetectedAt:             storedDetectedAt.UTC(),
		DiscoveredAt:           ptrUTCTime(storedDiscoveredAt),
		ClockStartedAt:         ptrTime(storedClockStarted),
		GDPR72hDeadline:        ptrTime(storedDeadline),
		TemplateVersion:        templateVersion,
		AffectedRegions:        regions,
		AffectedDataCategories: categories,
		AffectedSubjectCount:   body.AffectedSubjectCount,
		NotificationDecisions:  map[string]any{},
		Jurisdictions:          jurisdictions,
		Summary:                summary,
		CreatedAt:              storedCreatedAt.UTC(),
		UpdatedAt:              storedUpdatedAt.UTC(),
		Resolution:             &resolution,
	}
	writeJSON(w, http.StatusCreated, row)
}

// ---------------------------------------------------------------------------
// List & Get
// ---------------------------------------------------------------------------

// List returns all privacy_incidents visible to the tenant (RLS-scoped) with
// keyset pagination on (detected_at, id). The default page size preserves the
// prior LIMIT 200 so omitting ?limit= returns the same count as before. The
// known_jurisdictions sibling field is preserved on every page.
func (d *IncidentsDeps) List(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := readIncidentPageParams(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// $1 tenant, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{tenant.ID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (detected_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(r.Context(), `
SELECT id, severity, status, detected_at, discovered_at, clock_started_at,
       gdpr_72h_deadline, counsel_signoff_at, COALESCE(signoff_by, ''),
       template_version, affected_regions, affected_data_categories,
       affected_subject_count, notification_decisions, jurisdictions,
       summary, created_at, updated_at
FROM privacy_incidents
WHERE tenant_id = $1::uuid
`+keyset+`
ORDER BY detected_at DESC, id DESC
LIMIT $2`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := make([]incidentRow, 0, 32)
	for rows.Next() {
		row, err := scanIncidentRow(rows)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.DetectedAt, ID: last.ID})
	}
	resp := map[string]any{
		"incidents":           out,
		"known_jurisdictions": KnownJurisdictions(),
	}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// Get returns a single incident plus the resolved jurisdiction view.
func (d *IncidentsDeps) Get(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, ok := incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	row, err := loadIncidentByID(r.Context(), tx, tenant.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "not_found", "incident not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolution := ResolveJurisdictions(row.Jurisdictions, row.AffectedDataCategories,
		intOrZero(row.AffectedSubjectCount), derefTime(row.ClockStartedAt))
	row.Resolution = &resolution
	writeJSON(w, http.StatusOK, row)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

// TransitionState moves an incident through the state machine and
// records the move in incident_state_transitions.
func (d *IncidentsDeps) TransitionState(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, ok := incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	var body transitionRequest
	if err := httpbody.DecodeJSONWith(w, r, incidentJSONMaxBody, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	to := strings.ToLower(strings.TrimSpace(body.To))
	if !validIncidentStates[to] {
		writeJSONError(w, http.StatusBadRequest, "invalid_state", "to must be one of open|contained|notifications_pending|closed")
		return
	}
	if to == "closed" {
		writeJSONError(w, http.StatusServiceUnavailable, "incident_closure_release_hold", "incident closure is unavailable until jurisdiction-specific notification decisions and authenticated delivery evidence are recorded; no change was committed")
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_reason", "reason is required")
		return
	}
	if utf8.RuneCountInString(reason) > incidentTransitionReasonMaxRunes {
		writeJSONError(w, http.StatusBadRequest, "reason_too_long", fmt.Sprintf("reason must be at most %d characters", incidentTransitionReasonMaxRunes))
		return
	}
	if containsUnsafeNarrativeControl(reason) {
		writeJSONError(w, http.StatusBadRequest, "invalid_reason", "reason cannot contain NUL or bidirectional formatting characters")
		return
	}
	expectedFrom := strings.ToLower(strings.TrimSpace(body.ExpectedFrom))
	if !validIncidentStates[expectedFrom] {
		writeJSONError(w, http.StatusBadRequest, "invalid_expected_from", "expected_from is required and must be one of open|contained|notifications_pending|closed")
		return
	}
	now := d.now()
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var from string
	if err := tx.QueryRow(r.Context(), incidentTransitionLockSQL, id, tenant.ID).Scan(&from); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "not_found", "incident not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if from != expectedFrom {
		writeJSONError(w, http.StatusConflict, "stale_incident_state", fmt.Sprintf("incident state is %q, not the expected %q; refresh before retrying", from, expectedFrom))
		return
	}
	if from == to {
		writeJSONError(w, http.StatusConflict, "no_op", fmt.Sprintf("incident already in state %q", from))
		return
	}
	allowed := validIncidentTransitions[from]
	if !allowed[to] {
		writeJSONError(w, http.StatusConflict, "invalid_transition", fmt.Sprintf("cannot transition from %q to %q", from, to))
		return
	}
	tag, err := tx.Exec(r.Context(), `
UPDATE privacy_incidents
SET status = $3, updated_at = $4
WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = $5`,
		id, tenant.ID, to, now, from,
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() != 1 {
		writeJSONError(w, http.StatusConflict, "transition_conflict", "incident state changed before the transition could be recorded; retry with the current state")
		return
	}
	actor := incidentActorLabel(r)
	if _, err := tx.Exec(r.Context(), `
INSERT INTO incident_state_transitions (
    tenant_id, incident_id, from_state, to_state, actor_email, reason, at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
		tenant.ID, id, from, to, actor, reason, now,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(
		r.Context(),
		tx,
		auditMetaFromRequest(r, tenant.ID),
		"privacy.incident_transitioned",
		"privacy_incident",
		id,
		incidentTransitionAuditMetadata(from, to, reason),
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, transitionResponse{
		IncidentID: id, From: from, To: to, At: now,
	})
}

// ---------------------------------------------------------------------------
// CounselSignoff
// ---------------------------------------------------------------------------

// CounselSignoff is release-held. The legacy request accepts a caller-supplied
// email address, which cannot prove that a distinct authenticated principal
// approved the incident. Persisting that value as a legal sign-off would make
// a false assurance claim, so this handler fails before parsing or persistence.
func (d *IncidentsDeps) CounselSignoff(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	_, ok = incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	writeJSONError(w, http.StatusServiceUnavailable, "counsel_signoff_release_hold", "counsel sign-off is unavailable until approval is bound to a distinct authenticated principal and durable verification receipt; no change was committed")
}

// ---------------------------------------------------------------------------
// Notification ledger
// ---------------------------------------------------------------------------

// RecordNotification is release-held. The legacy request is only a manual
// assertion and does not carry provider-authenticated delivery evidence.
func (d *IncidentsDeps) RecordNotification(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	_, ok = incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	writeJSONError(w, http.StatusServiceUnavailable, "incident_notification_release_hold", "notification evidence recording is unavailable until it is bound to a durable provider or regulator receipt; no change was committed")
}

// ---------------------------------------------------------------------------
// Packet download
// ---------------------------------------------------------------------------

// DownloadPacket is release-held because the current templates contain legal
// and operational assertions that are not derived from verified evidence.
func (d *IncidentsDeps) DownloadPacket(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	_, ok = incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	audienceParam := strings.TrimSpace(chi.URLParam(r, "audience"))
	if !ValidAudience(audienceParam) {
		writeJSONError(w, http.StatusBadRequest, "invalid_audience", "audience must be one of authority|customer|data_subject")
		return
	}
	audience := PacketAudience(audienceParam)
	writeJSONError(w, http.StatusServiceUnavailable, "incident_packet_release_hold", fmt.Sprintf("%s packet generation is unavailable until every legal assertion is backed by verified incident evidence; no packet was generated", audience))
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// ListEvents returns the merged ledger of state transitions +
// recorded notifications for an incident, ordered by time.
func (d *IncidentsDeps) ListEvents(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, ok := incidentIDFromRequest(w, r)
	if !ok {
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var exists bool
	if err := tx.QueryRow(r.Context(), incidentEventParentLockSQL, id, tenant.ID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "not_found", "incident not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !exists { // Defensive: SELECT true can only produce true when a row exists.
		writeJSONError(w, http.StatusNotFound, "not_found", "incident not found")
		return
	}

	out := make([]incidentEventRow, 0, 32)
	rows, err := tx.Query(r.Context(), incidentEventsSQL, id, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var ev incidentEventRow
		if err := rows.Scan(
			&ev.EventID, &ev.Source, &ev.SchemaVersion, &ev.Kind, &ev.At,
			&ev.FromState, &ev.ToState, &ev.Actor,
			&ev.Reason, &ev.Audience, &ev.Template, &ev.BodySHA256, &ev.Recipient,
		); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows.Close()
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, listEventsResponse{IncidentID: id, Events: out})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func prepareIncidentResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	for _, value := range []string{"Authorization", "Cookie"} {
		present := false
		for _, line := range w.Header().Values("Vary") {
			for _, existing := range strings.Split(line, ",") {
				if strings.EqualFold(strings.TrimSpace(existing), value) {
					present = true
					break
				}
			}
			if present {
				break
			}
		}
		if !present {
			w.Header().Add("Vary", value)
		}
	}
}

// ProtectIncidentResponses stamps the complete privacy-incident route family
// before downstream authentication, authorization, replay, or handler code can
// return. Mount it at the outer authenticated boundary as well as immediately
// outside the route-local admin/replay chain: sensitive early refusals must be
// just as non-cacheable and credential-varying as successful incident data.
// The handler-level prepareIncidentResponse calls remain defense in depth.
func ProtectIncidentResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isPrivacyIncidentRoute(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &incidentResponseWriter{ResponseWriter: w}
		prepareIncidentResponse(protected)
		next.ServeHTTP(protected, r)
	})
}

// incidentResponseWriter reasserts the sensitive response policy at commit
// time. Several shared error writers intentionally install their own generic
// cache policy; an early Header().Set alone would let those inner writers
// weaken the exact incident-family contract before WriteHeader.
type incidentResponseWriter struct {
	http.ResponseWriter
}

func (w *incidentResponseWriter) WriteHeader(status int) {
	prepareIncidentResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *incidentResponseWriter) Write(body []byte) (int, error) {
	prepareIncidentResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

// Unwrap keeps standard-library ResponseController traversal intact without
// claiming optional streaming or connection-hijacking capabilities that the
// underlying writer may not implement.
func (w *incidentResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the incident policy is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this still claims no streaming capability it lacks.
func (w *incidentResponseWriter) FlushError() error {
	prepareIncidentResponse(w.ResponseWriter)
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func isPrivacyIncidentRoute(r *http.Request) bool {
	if r == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	const base = "/api/v1/privacy/incidents"
	return path == base || strings.HasPrefix(path, base+"/")
}

// BypassIncidentGlobalReplay delegates the complete incident family to its
// route-local idempotency middleware. That dedicated boundary is mounted only
// after RequireScope(admin), so a cached response can never short-circuit the
// current API-key scope or effective dashboard-role decision.
func BypassIncidentGlobalReplay(r *http.Request, _ []byte) bool {
	return isPrivacyIncidentRoute(r)
}

// BypassIncidentReleaseHoldReplay prevents a pre-deployment idempotency record
// from replaying an old successful response for operations that are now
// release-held. It also keeps sensitive incident GET responses out of the
// mutation idempotency store. The selected handlers cannot mutate state in
// their current implementation. Authentication, authorization, validation,
// and the current response still run in the normal inner handler chain.
func BypassIncidentReleaseHoldReplay(r *http.Request, body []byte) bool {
	if !isPrivacyIncidentRoute(r) {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	if r.Method == http.MethodGet {
		return true
	}
	if r.Method == http.MethodPost &&
		(strings.HasSuffix(path, "/signoff") || strings.HasSuffix(path, "/notifications")) {
		return true
	}
	if r.Method != http.MethodPost || !strings.HasSuffix(path, "/transition") {
		return false
	}
	var request struct {
		To string `json:"to"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(request.To), "closed")
}

func requireIncidentIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) == 0 || (len(values) == 1 && strings.TrimSpace(values[0]) == "") {
		writeJSONError(w, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key is required for this append operation")
		return false
	}
	if len(values) != 1 {
		writeJSONError(w, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key must be supplied exactly once")
		return false
	}
	key := strings.TrimSpace(values[0])
	if len(key) > idempotency.MaxKeyLength || !utf8.ValidString(key) ||
		strings.IndexFunc(key, unicode.IsControl) >= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid_idempotency_key", fmt.Sprintf("Idempotency-Key must be 1-%d valid UTF-8 bytes without control characters", idempotency.MaxKeyLength))
		return false
	}
	return true
}

func incidentIDFromRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "incident_id"))
	canonical, ok := canonicalIncidentUUID(raw)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "invalid_incident_id", "incident id must be a canonical UUID")
		return "", false
	}
	return canonical, true
}

func canonicalIncidentUUID(raw string) (string, bool) {
	parsed, err := uuid.Parse(raw)
	if err != nil || len(raw) != 36 || !strings.EqualFold(parsed.String(), raw) {
		return "", false
	}
	return parsed.String(), true
}

func readIncidentPageParams(r *http.Request) (int, pagination.Cursor, error) {
	rawCursor := r.URL.Query().Get("cursor")
	if len(rawCursor) > incidentCursorMaxBytes {
		return 0, pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil || cursor.ID == "" {
		return limit, cursor, err
	}
	canonical, ok := canonicalIncidentUUID(strings.TrimSpace(cursor.ID))
	if !ok {
		return 0, pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	cursor.ID = canonical
	return limit, cursor, nil
}

func boundedIncidentStringSlice(field string, in []string) ([]string, error) {
	if len(in) > incidentArrayMaxItems {
		return nil, fmt.Errorf("%s must contain at most %d items", field, incidentArrayMaxItems)
	}
	for _, raw := range in {
		value := strings.TrimSpace(raw)
		if utf8.RuneCountInString(value) > incidentArrayTokenMaxRunes {
			return nil, fmt.Errorf("each %s item must be at most %d characters", field, incidentArrayTokenMaxRunes)
		}
		if containsUnsafeIncidentTokenControl(value) {
			return nil, fmt.Errorf("%s items cannot contain control or bidirectional formatting characters", field)
		}
	}
	return sanitizeStringSlice(in), nil
}

type incidentValidationIssue struct {
	Code    string
	Message string
}

func normalizeIncidentScope(body createIncidentRequest) (
	regions, categories, jurisdictions []string,
	issue *incidentValidationIssue,
) {
	var err error
	regions, err = boundedIncidentStringSlice("affected_regions", body.AffectedRegions)
	if err != nil {
		return nil, nil, nil, &incidentValidationIssue{Code: "invalid_affected_regions", Message: err.Error()}
	}
	categories, err = boundedIncidentStringSlice("affected_data_categories", body.AffectedDataCategories)
	if err != nil {
		return nil, nil, nil, &incidentValidationIssue{Code: "invalid_affected_data_categories", Message: err.Error()}
	}
	jurisdictions, err = boundedIncidentStringSlice("jurisdictions", body.Jurisdictions)
	if err != nil {
		return nil, nil, nil, &incidentValidationIssue{Code: "invalid_jurisdictions", Message: err.Error()}
	}
	// Affected geography and candidate legal jurisdiction are deliberately
	// distinct. An empty jurisdiction list remains unknown; it is never inferred
	// from affected_regions.
	return regions, categories, jurisdictions, nil
}

func incidentOpenedAuditMetadata(
	regions, categories, jurisdictions []string,
	affectedSubjectCount *int,
) map[string]any {
	return map[string]any{
		"initial_status":                     "open",
		"affected_regions_recorded":          len(regions) > 0,
		"affected_categories_recorded":       len(categories) > 0,
		"jurisdictions_recorded":             len(jurisdictions) > 0,
		"affected_subject_count_recorded":    affectedSubjectCount != nil,
		"legacy_operational_target_recorded": true,
	}
}

func incidentTransitionAuditMetadata(from, to, reason string) map[string]any {
	return map[string]any{
		"from":            from,
		"to":              to,
		"reason_recorded": strings.TrimSpace(reason) != "",
	}
}

func normalizeSeverity(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "investigating", "":
		return "investigating"
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "critical":
		return "critical"
	default:
		return ""
	}
}

func sanitizeStringSlice(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// incidentActorLabel supplies forensic attribution to legacy domain columns
// named actor_email/created_by. Those columns predate typed actor identities,
// so the value is an audit-safe label rather than necessarily an email:
// configured actor label, non-secret API-key id, then session email.
func incidentActorLabel(r *http.Request) string {
	if r == nil {
		return ""
	}
	ctx := r.Context()
	if _, label := middleware.ActorFromContext(ctx); strings.TrimSpace(label) != "" {
		return strings.TrimSpace(label)
	}
	if id := strings.TrimSpace(middleware.APIKeyIDFromContext(ctx)); id != "" {
		return "apikey:" + id
	}
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		return strings.TrimSpace(u.Email)
	}
	return ""
}

func ptrTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

func ptrUTCTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	return ptrTime(*t)
}

func derefTime(p *time.Time) time.Time {
	if p == nil {
		return time.Time{}
	}
	return *p
}

func intOrZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// scanIncidentRow scans a SELECT (matching the column list in List())
// into an incidentRow.
func scanIncidentRow(rows pgx.Rows) (incidentRow, error) {
	var row incidentRow
	var (
		discoveredAt   *time.Time
		clockStartedAt *time.Time
		gdpr           *time.Time
		signoffAt      *time.Time
		signoffBy      string
		subjectCount   *int
		decisions      []byte
		regions        []string
		categories     []string
		jurisdictions  []string
	)
	if err := rows.Scan(
		&row.ID, &row.Severity, &row.Status, &row.DetectedAt,
		&discoveredAt, &clockStartedAt, &gdpr, &signoffAt, &signoffBy,
		&row.TemplateVersion, &regions, &categories, &subjectCount,
		&decisions, &jurisdictions, &row.Summary, &row.CreatedAt, &row.UpdatedAt,
	); err != nil {
		return row, err
	}
	row.DiscoveredAt = discoveredAt
	row.ClockStartedAt = clockStartedAt
	row.GDPR72hDeadline = gdpr
	row.CounselSignoffAt = signoffAt
	row.SignoffBy = signoffBy
	row.AffectedRegions = regions
	row.AffectedDataCategories = categories
	row.AffectedSubjectCount = subjectCount
	row.Jurisdictions = jurisdictions
	decodedDecisions, err := decodeStoredNotificationDecisions(decisions)
	if err != nil {
		return row, fmt.Errorf("decode incident %s notification decisions: %w", row.ID, err)
	}
	row.NotificationDecisions = decodedDecisions
	return row, nil
}

func decodeStoredNotificationDecisions(raw []byte) (map[string]any, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("notification_decisions payload is empty")
	}
	if len(raw) > incidentNotificationMaxBytes {
		return nil, fmt.Errorf("notification_decisions exceeds %d bytes", incidentNotificationMaxBytes)
	}
	var decisions map[string]any
	if err := json.Unmarshal(raw, &decisions); err != nil {
		return nil, fmt.Errorf("notification_decisions is not an object: %w", err)
	}
	if decisions == nil {
		return nil, fmt.Errorf("notification_decisions must be an object")
	}
	return decisions, nil
}

func loadIncidentByID(ctx context.Context, tx pgx.Tx, tenantID, id string) (incidentRow, error) {
	rows, err := tx.Query(ctx, `
SELECT id, severity, status, detected_at, discovered_at, clock_started_at,
       gdpr_72h_deadline, counsel_signoff_at, COALESCE(signoff_by, ''),
       template_version, affected_regions, affected_data_categories,
       affected_subject_count, notification_decisions, jurisdictions,
       summary, created_at, updated_at
FROM privacy_incidents
WHERE id = $1::uuid AND tenant_id = $2::uuid`, id, tenantID)
	if err != nil {
		return incidentRow{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return incidentRow{}, err
		}
		return incidentRow{}, pgx.ErrNoRows
	}
	return scanIncidentRow(rows)
}

func snapshotFromRow(row incidentRow, controller string) IncidentSnapshot {
	formatTime := func(p *time.Time) string {
		if p == nil {
			return ""
		}
		return p.UTC().Format(time.RFC3339)
	}
	subjects := ""
	if row.AffectedSubjectCount != nil {
		subjects = fmt.Sprintf("%d", *row.AffectedSubjectCount)
	}
	return IncidentSnapshot{
		IncidentID:           row.ID,
		ControllerName:       controller,
		Summary:              row.Summary,
		DetectedAt:           row.DetectedAt.UTC().Format(time.RFC3339),
		ClockStartedAt:       formatTime(row.ClockStartedAt),
		ContainmentAt:        formatTime(row.UpdatedAtIfContained()),
		DeadlineAt:           formatTime(row.GDPR72hDeadline),
		AffectedCategories:   strings.Join(row.AffectedDataCategories, ", "),
		AffectedRegions:      strings.Join(row.AffectedRegions, ", "),
		AffectedSubjectCount: subjects,
		Jurisdictions:        row.Jurisdictions,
		ContentRequirements:  nil,
		DPOName:              "Moosewave Privacy Office",
		DPOEmail:             "privacy@moosewave.com",
		SignoffBy:            row.SignoffBy,
		SignoffAt:            formatTime(row.CounselSignoffAt),
		TemplateVersion:      row.TemplateVersion,
		GeneratedAt:          time.Now().UTC().Format(time.RFC3339),
	}
}

// UpdatedAtIfContained returns the most recent UpdatedAt time as a
// pointer when the incident has progressed past 'open'; otherwise nil.
func (r incidentRow) UpdatedAtIfContained() *time.Time {
	if r.Status == "open" {
		return nil
	}
	u := r.UpdatedAt.UTC()
	return &u
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

// MountIncidentRoutes wires the incident workflow handlers under the
// caller-supplied router. Caller is expected to wrap the router with
// the admin scope.
func MountIncidentRoutes(r chi.Router, d *IncidentsDeps) {
	if d == nil {
		return
	}
	r.Post("/api/v1/privacy/incidents", d.Create)
	r.Get("/api/v1/privacy/incidents", d.List)
	r.Get("/api/v1/privacy/incidents/{incident_id}", d.Get)
	r.Post("/api/v1/privacy/incidents/{incident_id}/transition", d.TransitionState)
	r.Post("/api/v1/privacy/incidents/{incident_id}/signoff", d.CounselSignoff)
	r.Post("/api/v1/privacy/incidents/{incident_id}/notifications", d.RecordNotification)
	r.Get("/api/v1/privacy/incidents/{incident_id}/events", d.ListEvents)
	r.Get("/api/v1/privacy/incidents/{incident_id}/packet/{audience}", d.DownloadPacket)
}
