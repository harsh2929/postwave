// SPDX-License-Identifier: AGPL-3.0-only
//
// tabletop.go — operator-supplied breach-response drill records.
//
// Operators POST drill scenarios, participant names, findings, and an evidence
// path. The current schema does not bind that path to immutable object storage,
// a content hash, or an attested participant identity, so these rows are not by
// themselves proof that the team rehearsed the playbook.

package privacy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const (
	tabletopScenarioMaxRunes     = 500
	tabletopFindingsMaxRunes     = 16000
	tabletopEvidencePathMaxRunes = 2048
)

const tabletopInsertSQL = `
INSERT INTO incident_tabletops (
    tenant_id, scenario, ran_at, participants, findings, evidence_path, created_by
) VALUES (
    $1::uuid, $2, $3, $4::jsonb, $5, $6, $7
) RETURNING id, ran_at, created_at`

type recordTabletopRequest struct {
	Scenario     string    `json:"scenario"`
	RanAt        time.Time `json:"ran_at"`
	Participants []string  `json:"participants"`
	Findings     string    `json:"findings"`
	EvidencePath string    `json:"evidence_path"`
}

type tabletopRow struct {
	ID           string    `json:"id"`
	Scenario     string    `json:"scenario"`
	RanAt        time.Time `json:"ran_at"`
	Participants []string  `json:"participants"`
	Findings     string    `json:"findings"`
	EvidencePath string    `json:"evidence_path,omitempty"`
	CreatedBy    string    `json:"created_by,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// RecordTabletop appends caller-supplied drill metadata to incident_tabletops.
func (d *IncidentsDeps) RecordTabletop(w http.ResponseWriter, r *http.Request) {
	prepareIncidentResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !requireIncidentIdempotencyKey(w, r) {
		return
	}
	var body recordTabletopRequest
	if err := httpbody.DecodeJSONWith(w, r, incidentJSONMaxBody, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	scenario := strings.TrimSpace(body.Scenario)
	if scenario == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_scenario", "scenario is required")
		return
	}
	if utf8.RuneCountInString(scenario) > tabletopScenarioMaxRunes {
		writeJSONError(w, http.StatusBadRequest, "scenario_too_long", "scenario must be at most 500 characters")
		return
	}
	if containsUnsafeNarrativeControl(scenario) {
		writeJSONError(w, http.StatusBadRequest, "invalid_scenario", "scenario cannot contain NUL or bidirectional formatting characters")
		return
	}
	now := d.now()
	ranAt := body.RanAt
	if ranAt.IsZero() {
		ranAt = now
	}
	if ranAt.After(now.Add(incidentFutureTimestampSkew)) {
		writeJSONError(w, http.StatusBadRequest, "invalid_ran_at", "ran_at cannot be more than 5 minutes in the future")
		return
	}
	participants, err := boundedIncidentStringSlice("participants", body.Participants)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_participants", err.Error())
		return
	}
	if len(participants) == 0 {
		writeJSONError(w, http.StatusBadRequest, "missing_participants", "at least one participant required for evidence")
		return
	}
	findings := strings.TrimSpace(body.Findings)
	if utf8.RuneCountInString(findings) > tabletopFindingsMaxRunes {
		writeJSONError(w, http.StatusBadRequest, "findings_too_long", "findings must be at most 16000 characters")
		return
	}
	if containsUnsafeNarrativeControl(findings) {
		writeJSONError(w, http.StatusBadRequest, "invalid_findings", "findings cannot contain NUL or bidirectional formatting characters")
		return
	}
	evidencePath := strings.TrimSpace(body.EvidencePath)
	if utf8.RuneCountInString(evidencePath) > tabletopEvidencePathMaxRunes ||
		containsUnsafeIncidentTokenControl(evidencePath) {
		writeJSONError(w, http.StatusBadRequest, "invalid_evidence_path", "evidence_path must be at most 2048 characters without control or bidirectional formatting characters")
		return
	}
	pBytes, err := json.Marshal(participants)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	actor := incidentActorLabel(r)

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		id              string
		storedRanAt     time.Time
		storedCreatedAt time.Time
	)
	err = tx.QueryRow(r.Context(), tabletopInsertSQL,
		tenant.ID, scenario, ranAt, pBytes, findings,
		evidencePath, actor,
	).Scan(&id, &storedRanAt, &storedCreatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(
		r.Context(),
		tx,
		auditMetaFromRequest(r, tenant.ID),
		"privacy.incident_tabletop_recorded",
		"privacy_incident_tabletop",
		id,
		tabletopAuditMetadata(participants, findings, evidencePath),
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, tabletopRow{
		ID: id, Scenario: scenario, RanAt: storedRanAt.UTC(),
		Participants: participants, Findings: findings,
		EvidencePath: evidencePath,
		CreatedBy:    actor, CreatedAt: storedCreatedAt.UTC(),
	})
}

func tabletopAuditMetadata(participants []string, findings, evidencePath string) map[string]any {
	return map[string]any{
		"participant_count":           len(participants),
		"findings_recorded":           strings.TrimSpace(findings) != "",
		"evidence_reference_recorded": strings.TrimSpace(evidencePath) != "",
	}
}

// ListTabletops returns recorded tabletop drills for the tenant with keyset
// pagination on (ran_at, id). The default page size preserves the prior
// LIMIT 200 so omitting ?limit= returns the same count as before.
//
// Caveat: ran_at is caller-supplied at record time (not a server clock), so
// it is not strictly monotonic with insertion order. Keyset still works
// correctly — pages are stable for any fixed snapshot of rows — but two
// drills recorded with the same ran_at are tie-broken by id, and a backdated
// drill inserted after a client started paging may land on an already-seen
// page. Acceptable for this admin/auditor evidence list.
func (d *IncidentsDeps) ListTabletops(w http.ResponseWriter, r *http.Request) {
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
		keyset = "AND (ran_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(r.Context(), `
SELECT id, scenario, ran_at, participants, findings, evidence_path,
       COALESCE(created_by, ''), created_at
  FROM incident_tabletops
 WHERE tenant_id = $1::uuid
 `+keyset+`
 ORDER BY ran_at DESC, id DESC
 LIMIT $2`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := make([]tabletopRow, 0, 16)
	for rows.Next() {
		var (
			row    tabletopRow
			pBytes []byte
		)
		if err := rows.Scan(&row.ID, &row.Scenario, &row.RanAt, &pBytes,
			&row.Findings, &row.EvidencePath, &row.CreatedBy, &row.CreatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		participants, err := decodeStoredTabletopParticipants(pBytes)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, fmt.Errorf("decode tabletop %s participants: %w", row.ID, err), r.Context())
			return
		}
		row.Participants = participants
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
		next = pagination.Encode(pagination.Cursor{SortKey: last.RanAt, ID: last.ID})
	}
	resp := map[string]any{"tabletops": out}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// decodeStoredTabletopParticipants keeps the read contract fail-closed when a
// legacy or manually modified JSONB value cannot have been produced by the
// current write path. Silently converting malformed evidence metadata into an
// empty successful array would make "no participants" indistinguishable from
// storage corruption and violates the response schema's minItems guarantee.
func decodeStoredTabletopParticipants(raw []byte) ([]string, error) {
	var participants []string
	if len(raw) == 0 {
		return nil, fmt.Errorf("participants payload is empty")
	}
	if err := json.Unmarshal(raw, &participants); err != nil {
		return nil, fmt.Errorf("participants payload is not a string array: %w", err)
	}
	normalized, err := boundedIncidentStringSlice("participants", participants)
	if err != nil {
		return nil, err
	}
	if len(normalized) == 0 {
		return nil, fmt.Errorf("participants payload must contain at least one participant")
	}
	if len(normalized) != len(participants) {
		return nil, fmt.Errorf("participants payload contains empty or duplicate values")
	}
	for i := range participants {
		if participants[i] != normalized[i] {
			return nil, fmt.Errorf("participants payload contains a non-canonical value")
		}
	}
	return participants, nil
}

// MountTabletopRoutes wires the tabletop record / list handlers.
func MountTabletopRoutes(r chi.Router, d *IncidentsDeps) {
	if d == nil {
		return
	}
	r.Post("/api/v1/privacy/incidents/tabletops", d.RecordTabletop)
	r.Get("/api/v1/privacy/incidents/tabletops", d.ListTabletops)
}
