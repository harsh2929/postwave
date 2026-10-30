// SPDX-License-Identifier: AGPL-3.0-only
//
// Package audit_alerts implements composable alerting rules over
// audit_log. The flow:
//
//   1. Operator configures rules via /api/v1/audit-alerts (CRUD).
//   2. Worker tick (default 30s) scans audit_log rows above each
//      rule's last_audit_id cursor and fires the matching ones.
//   3. Delivery goes via the configured channel (email / slack /
//      webhook). Each fire is logged to audit_alert_fires.
//
// Rule match semantics: AND of all specified criteria. action_glob
// is required; the other criteria narrow the set.

package audit_alerts

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Rule is the wire shape.
type Rule struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Enabled        bool           `json:"enabled"`
	ActionGlob     string         `json:"action_glob"`
	ActorType      string         `json:"actor_type,omitempty"`
	ActorLabelGlob string         `json:"actor_label_glob,omitempty"`
	ResourceType   string         `json:"resource_type,omitempty"`
	OperatorKind   string         `json:"operator_kind"`
	OperatorConfig map[string]any `json:"operator_config"`
	ChannelKind    string         `json:"channel_kind"`
	ChannelConfig  map[string]any `json:"channel_config"`
	// NotifySlack (migration 0391): when true, every fire is ALSO
	// fanned out to the tenant's managed Slack integration
	// (slackint) via the slack.deliver outbox — on top of the
	// primary channel_kind. Distinct from channel_kind='slack',
	// which posts to a per-rule raw webhook URL in channel_config.
	NotifySlack bool    `json:"notify_slack"`
	FiredCount  int64   `json:"fired_count"`
	LastFiredAt *string `json:"last_fired_at,omitempty"`
	LastError   string  `json:"last_error,omitempty"`
	CreatedAt   string  `json:"created_at"`
}

// CreateInput is the POST body.
type CreateInput struct {
	Name           string         `json:"name"`
	ActionGlob     string         `json:"action_glob"`
	ActorType      string         `json:"actor_type,omitempty"`
	ActorLabelGlob string         `json:"actor_label_glob,omitempty"`
	ResourceType   string         `json:"resource_type,omitempty"`
	OperatorKind   string         `json:"operator_kind,omitempty"`
	OperatorConfig map[string]any `json:"operator_config,omitempty"`
	ChannelKind    string         `json:"channel_kind"`
	ChannelConfig  map[string]any `json:"channel_config"`
	NotifySlack    bool           `json:"notify_slack,omitempty"`
}

// Incident is the wire shape for a linked external incident.
type Incident struct {
	ID                 int64   `json:"id"`
	RuleID             string  `json:"rule_id"`
	AuditID            *int64  `json:"audit_id,omitempty"`
	ExternalSystem     string  `json:"external_system"`
	ExternalIncidentID string  `json:"external_incident_id"`
	IncidentStatus     string  `json:"incident_status,omitempty"`
	IncidentURL        string  `json:"incident_url,omitempty"`
	LastSyncedAt       *string `json:"last_synced_at,omitempty"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

// Deps wires the handlers + worker.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers admin endpoints.
//
//	GET    /api/v1/audit-alerts             list
//	POST   /api/v1/audit-alerts             create
//	PATCH  /api/v1/audit-alerts/{id}        toggle enabled / update
//	DELETE /api/v1/audit-alerts/{id}        delete
//	GET    /api/v1/audit-alerts/{id}/fires  recent firings
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	// RBAC-meta-audit: list + fires are reads; rule mutations are
	// sink-configuration (alerts wire up email/Slack/webhook
	// notifications, conceptually a destination). ScopeAdmin still
	// grants everything as a wildcard.
	readGate := apikeys.RequireScope(apikeys.ScopeAuditRead)
	cfgGate := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	r.With(readGate).Get("/api/v1/audit-alerts", d.List)
	r.With(cfgGate).Post("/api/v1/audit-alerts", d.Create)
	r.With(cfgGate).Patch("/api/v1/audit-alerts/{id}", d.Patch)
	r.With(cfgGate).Delete("/api/v1/audit-alerts/{id}", d.Delete)
	r.With(readGate).Get("/api/v1/audit-alerts/{id}/fires", d.Fires)
	r.With(readGate).Get("/api/v1/audit-alerts/{id}/incidents", d.Incidents)
	// Inbound webhook is intentionally outside the api-key gates —
	// it authenticates via the per-rule channel_config.inbound_secret
	// bearer token, since external SOC systems can't carry our
	// session cookies or scoped api-keys.
	r.Post("/api/v1/audit-alerts/inbound-webhook", d.InboundWebhook)
}

// Create POST /api/v1/audit-alerts.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Name = strings.TrimSpace(in.Name)
	in.ActionGlob = strings.TrimSpace(in.ActionGlob)
	if in.Name == "" || in.ActionGlob == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_fields",
			"name and action_glob are required")
		return
	}
	switch in.ChannelKind {
	case "email", "slack", "webhook", "servicenow", "jira", "pagerduty":
	default:
		writeJSONErr(w, http.StatusBadRequest, "invalid_channel",
			"channel_kind must be email|slack|webhook|servicenow|jira|pagerduty")
		return
	}
	if err := validateChannelConfig(in.ChannelKind, in.ChannelConfig); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	if in.OperatorKind == "" {
		in.OperatorKind = "glob"
	}
	switch in.OperatorKind {
	case "glob", "threshold_window", "rate_deviation", "outlier":
	default:
		writeJSONErr(w, http.StatusBadRequest, "invalid_operator",
			"operator_kind must be glob|threshold_window|rate_deviation|outlier")
		return
	}
	if err := validateOperatorConfig(in.OperatorKind, in.OperatorConfig); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	configJSON, _ := json.Marshal(in.ChannelConfig)
	if in.OperatorConfig == nil {
		in.OperatorConfig = map[string]any{}
	}
	operatorJSON, _ := json.Marshal(in.OperatorConfig)

	// Bootstrap the cursor at max(audit_log.id) so we don't fire
	// retroactive alerts the moment the rule is enabled.
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var startID int64
	_ = tx.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(id), 0) FROM audit_log WHERE tenant_id = $1::uuid`,
		t.ID).Scan(&startID)

	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO audit_alert_rules
  (tenant_id, name, action_glob, actor_type, actor_label_glob,
   resource_type, channel_kind, channel_config, last_audit_id,
   operator_kind, operator_config, notify_slack)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''),
        $7, $8::jsonb, $9, $10, $11::jsonb, $12)
RETURNING id::text`,
		t.ID, in.Name, in.ActionGlob, in.ActorType, in.ActorLabelGlob,
		in.ResourceType, in.ChannelKind, string(configJSON), startID,
		in.OperatorKind, string(operatorJSON), in.NotifySlack).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), d.Pool, "audit_alert.create", "audit_alert_rule", id, nil,
		map[string]any{
			"name":          in.Name,
			"action_glob":   in.ActionGlob,
			"operator_kind": in.OperatorKind,
			"channel_kind":  in.ChannelKind,
			"notify_slack":  in.NotifySlack,
			"secret_fields": "withheld",
		}, nil)
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// List GET /api/v1/audit-alerts.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, name, enabled, action_glob,
       COALESCE(actor_type,''), COALESCE(actor_label_glob,''),
       COALESCE(resource_type,''), channel_kind, channel_config,
       fired_count, last_fired_at::text, COALESCE(last_error,''),
       created_at::text,
       COALESCE(operator_kind,'glob'), COALESCE(operator_config,'{}'::jsonb),
       COALESCE(notify_slack, false)
  FROM audit_alert_rules
WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 1000`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var rule Rule
		var configJSON []byte
		var operatorJSON []byte
		var lastFiredAt *string
		if err := rows.Scan(&rule.ID, &rule.Name, &rule.Enabled, &rule.ActionGlob,
			&rule.ActorType, &rule.ActorLabelGlob, &rule.ResourceType,
			&rule.ChannelKind, &configJSON, &rule.FiredCount,
			&lastFiredAt, &rule.LastError, &rule.CreatedAt,
			&rule.OperatorKind, &operatorJSON, &rule.NotifySlack); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		_ = json.Unmarshal(configJSON, &rule.ChannelConfig)
		// Channel configuration contains write-only provider credentials (API
		// tokens, routing keys, passwords, bearer tokens and signed-webhook
		// secrets).  Inventory consumers only need channel_kind; returning the
		// raw blob made a read response a credential-recovery endpoint.
		rule.ChannelConfig = redactChannelConfigForRead(rule.ChannelConfig)
		_ = json.Unmarshal(operatorJSON, &rule.OperatorConfig)
		rule.LastFiredAt = lastFiredAt
		out = append(out, rule)
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": out})
}

// Incidents GET /api/v1/audit-alerts/{id}/incidents — external
// incidents linked to this rule with synced status.
func (d *Deps) Incidents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	// Keyset pagination on (updated_at, id); default page size preserves the
	// prior LIMIT 200 so omitting ?limit= returns the same count as before.
	// updated_at is mutable, so a row edited between page fetches may shift
	// pages — acceptable for this admin incidents list. The
	// idx_audit_alert_incidents_rule (rule_id, updated_at DESC) index serves
	// the rule_id filter + sort; id is an in-memory tiebreaker.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// $1 tenant, $2 rule_id, $3 limit+1; the keyset bound (when paging) takes
	// $4 (updated_at) / $5 (id).
	args := []any{t.ID, id, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::bigint)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(r.Context(), `
SELECT id, rule_id::text, audit_id, external_system,
       external_incident_id, COALESCE(incident_status,''),
       COALESCE(incident_url,''), last_synced_at::text,
       created_at::text, updated_at::text, updated_at AS updated_at_sort
  FROM audit_alert_incidents
 WHERE tenant_id = $1::uuid AND rule_id = $2::uuid
 `+keyset+`
 -- updated_at_sort, not updated_at. A cast PRESERVES the column name, so the
 -- updated_at::text above is ALSO an output column called updated_at; with two
 -- of them, ORDER BY updated_at matched both and Postgres refused the whole
 -- statement with 42702. The route answered 500 on every call, for any rule id.
 ORDER BY updated_at_sort DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []Incident{}
	sortKeys := []time.Time{}
	for rows.Next() {
		var inc Incident
		var auditID *int64
		var lastSynced *string
		var updatedAt time.Time
		if err := rows.Scan(&inc.ID, &inc.RuleID, &auditID,
			&inc.ExternalSystem, &inc.ExternalIncidentID,
			&inc.IncidentStatus, &inc.IncidentURL, &lastSynced,
			&inc.CreatedAt, &inc.UpdatedAt, &updatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		inc.AuditID = auditID
		inc.LastSyncedAt = lastSynced
		out = append(out, inc)
		sortKeys = append(sortKeys, updatedAt)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{
			SortKey: sortKeys[len(out)-1],
			ID:      strconv.FormatInt(last.ID, 10),
		})
	}
	body := map[string]any{"incidents": out}
	if next != "" {
		body["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, body)
}

// Patch PATCH /api/v1/audit-alerts/{id}.
func (d *Deps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	var in struct {
		Enabled       *bool          `json:"enabled,omitempty"`
		Name          string         `json:"name,omitempty"`
		ChannelConfig map[string]any `json:"channel_config,omitempty"`
		NotifySlack   *bool          `json:"notify_slack,omitempty"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	name := strings.TrimSpace(in.Name)
	if in.Enabled == nil && name == "" && in.ChannelConfig == nil && in.NotifySlack == nil {
		writeJSONErr(w, http.StatusBadRequest, "empty_patch", "at least one alert-rule field is required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		beforeName        string
		beforeEnabled     bool
		beforeNotifySlack bool
		channelKind       string
	)
	if err := tx.QueryRow(r.Context(), `
SELECT name, enabled, notify_slack, channel_kind
  FROM audit_alert_rules
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id).Scan(&beforeName, &beforeEnabled, &beforeNotifySlack, &channelKind); err != nil {
		writeJSONErr(w, http.StatusNotFound, "not_found", "audit alert rule not found")
		return
	}
	if in.ChannelConfig != nil {
		if err := validateChannelConfig(channelKind, in.ChannelConfig); err != nil {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
	}
	if in.Enabled != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE audit_alert_rules SET enabled = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			*in.Enabled, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if name != "" {
		if _, err := tx.Exec(r.Context(),
			`UPDATE audit_alert_rules SET name = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			name, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.ChannelConfig != nil {
		cb, _ := json.Marshal(in.ChannelConfig)
		if _, err := tx.Exec(r.Context(),
			`UPDATE audit_alert_rules SET channel_config = $1::jsonb, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			string(cb), t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.NotifySlack != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE audit_alert_rules SET notify_slack = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			*in.NotifySlack, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	changed := []string{}
	if in.Enabled != nil {
		changed = append(changed, "enabled")
	}
	if name != "" {
		changed = append(changed, "name")
	}
	if in.ChannelConfig != nil {
		changed = append(changed, "channel_config")
	}
	if in.NotifySlack != nil {
		changed = append(changed, "notify_slack")
	}
	audit.EmitOrLog(r.Context(), d.Pool, "audit_alert.update", "audit_alert_rule", id,
		map[string]any{
			"name":         beforeName,
			"enabled":      beforeEnabled,
			"notify_slack": beforeNotifySlack,
		},
		map[string]any{
			"name":           alertFirstNonEmpty(name, beforeName),
			"enabled":        boolOr(in.Enabled, beforeEnabled),
			"notify_slack":   boolOr(in.NotifySlack, beforeNotifySlack),
			"channel_kind":   channelKind,
			"changed_fields": changed,
			"secret_fields":  "withheld",
		}, nil)
	writeJSON(w, http.StatusOK, map[string]any{"updated": true, "id": id})
}

// Delete DELETE /api/v1/audit-alerts/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var name, channelKind string
	if err := tx.QueryRow(r.Context(), `
SELECT name, channel_kind
  FROM audit_alert_rules
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id).Scan(&name, &channelKind); err != nil {
		writeJSONErr(w, http.StatusNotFound, "not_found", "audit alert rule not found")
		return
	}
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM audit_alert_rules
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() != 1 {
		writeJSONErr(w, http.StatusConflict, "delete_conflict", "audit alert rule changed before deletion")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), d.Pool, "audit_alert.delete", "audit_alert_rule", id,
		map[string]any{"name": name, "channel_kind": channelKind}, nil, nil)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id})
}

// Fires GET /api/v1/audit-alerts/{id}/fires — recent firings.
func (d *Deps) Fires(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id, audit_id, delivered, COALESCE(delivery_error,''), fired_at::text
  FROM audit_alert_fires
 WHERE tenant_id = $1::uuid AND rule_id = $2::uuid
 ORDER BY fired_at DESC LIMIT 100`, t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			fireID, auditID int64
			delivered       bool
			deliveryErr     string
			firedAt         string
		)
		if err := rows.Scan(&fireID, &auditID, &delivered, &deliveryErr, &firedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		out = append(out, map[string]any{
			"id":             fireID,
			"audit_id":       auditID,
			"delivered":      delivered,
			"delivery_error": deliveryErr,
			"fired_at":       firedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"fires": out})
}

// validateChannelConfig enforces per-kind config shape so an
// operator's typo doesn't land in the worker as a runtime error.
func validateChannelConfig(kind string, config map[string]any) error {
	switch kind {
	case "email":
		to, _ := config["to"].(string)
		if strings.TrimSpace(to) == "" {
			return errors.New("email channel requires 'to'")
		}
	case "slack":
		url, _ := config["webhook_url"].(string)
		if !strings.HasPrefix(url, "https://hooks.slack.com/") {
			return errors.New("slack channel requires 'webhook_url' starting with https://hooks.slack.com/")
		}
	case "webhook":
		url, _ := config["url"].(string)
		if !strings.HasPrefix(url, "https://") {
			return errors.New("webhook channel requires 'url' starting with https://")
		}
	case "servicenow":
		url, _ := config["instance_url"].(string)
		if !strings.HasPrefix(url, "https://") {
			return errors.New("servicenow channel requires 'instance_url' starting with https://")
		}
		if _, hasTok := config["bearer_token"].(string); !hasTok {
			user, _ := config["username"].(string)
			pass, _ := config["password"].(string)
			if user == "" || pass == "" {
				return errors.New("servicenow channel requires either 'bearer_token' or 'username'+'password'")
			}
		}
	case "jira":
		site, _ := config["site_url"].(string)
		if !strings.HasPrefix(site, "https://") {
			return errors.New("jira channel requires 'site_url' starting with https://")
		}
		if pk, _ := config["project_key"].(string); strings.TrimSpace(pk) == "" {
			return errors.New("jira channel requires 'project_key'")
		}
		email, _ := config["email"].(string)
		token, _ := config["api_token"].(string)
		if email == "" || token == "" {
			return errors.New("jira channel requires 'email' + 'api_token'")
		}
	case "pagerduty":
		rk, _ := config["routing_key"].(string)
		if strings.TrimSpace(rk) == "" {
			return errors.New("pagerduty channel requires 'routing_key'")
		}
	}
	return nil
}

// validateOperatorConfig enforces per-operator config shape — a
// misconfigured threshold_window with count=0 would silently never
// fire; failing at create time gives the operator clear feedback.
func validateOperatorConfig(kind string, config map[string]any) error {
	switch kind {
	case "", "glob":
		return nil
	case "threshold_window":
		count := asInt(config["count"])
		windowMin := asInt(config["window_min"])
		if count <= 0 {
			return errors.New("threshold_window requires 'count' > 0")
		}
		if windowMin <= 0 || windowMin > 1440 {
			return errors.New("threshold_window requires 'window_min' in (0, 1440]")
		}
		if gb, _ := config["group_by"].(string); gb != "" && gb != "actor_label" {
			return errors.New("threshold_window 'group_by' must be empty or 'actor_label'")
		}
	case "rate_deviation":
		dev := asFloat(config["deviation_pct"])
		baselineDays := asInt(config["baseline_days"])
		if dev <= 0 {
			return errors.New("rate_deviation requires 'deviation_pct' > 0")
		}
		if baselineDays <= 0 || baselineDays > 90 {
			return errors.New("rate_deviation requires 'baseline_days' in (0, 90]")
		}
	case "outlier":
		k, _ := config["kind"].(string)
		switch k {
		case "impossible_travel", "escalation_chain", "off_hours":
		default:
			return errors.New("outlier 'kind' must be impossible_travel|escalation_chain|off_hours")
		}
	}
	return nil
}

func alertFirstNonEmpty(candidate, fallback string) string {
	if candidate != "" {
		return candidate
	}
	return fallback
}

// redactChannelConfigForRead intentionally returns no channel values. The
// channel kind is a separate Rule field and is sufficient for inventory UI;
// every currently supported config can contain either a credential or a
// destination whose URL itself embeds sensitive routing material.
func redactChannelConfigForRead(_ map[string]any) map[string]any {
	return map[string]any{}
}

func boolOr(candidate *bool, fallback bool) bool {
	if candidate != nil {
		return *candidate
	}
	return fallback
}

// keep context referenced for future timeout-aware ops.
var _ context.Context = nil
var _ time.Time

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
