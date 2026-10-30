// SPDX-License-Identifier: AGPL-3.0-only
//
// inbound_webhook.go — receives status updates from external SOC
// systems (ServiceNow business rules, Jira webhooks, PagerDuty
// webhooks) and updates the corresponding audit_alert_incidents row.
//
// Authentication: every inbound payload must include a bearer token
// matching the tenant's channel_config.inbound_secret. This is the
// same shared-secret pattern outbound_webhooks uses on the other
// direction; rotating secrets cuts off compromised senders without
// touching the rule definition.
//
// Wire format (all systems normalised to this envelope):
//   POST /api/v1/audit-alerts/inbound-webhook
//   Authorization: Bearer <inbound_secret>
//   {
//     "external_system":      "servicenow"|"jira"|"pagerduty",
//     "external_incident_id": "<sys_id|issue_key|dedup_key>",
//     "incident_status":      "open"|"in_progress"|"resolved"|"closed",
//     "incident_url":         "https://..." (optional override)
//   }

package audit_alerts

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// inboundWebhookBody is the normalised payload tenants/integrations
// POST to /api/v1/audit-alerts/inbound-webhook.
type inboundWebhookBody struct {
	ExternalSystem     string `json:"external_system"`
	ExternalIncidentID string `json:"external_incident_id"`
	IncidentStatus     string `json:"incident_status"`
	IncidentURL        string `json:"incident_url,omitempty"`
}

// InboundWebhook handles status callbacks from external SOC systems.
//
// The handler is intentionally tenant-scoped via Bearer-token lookup
// against audit_alert_rules.channel_config.inbound_secret rather than
// requiring a Moosewave session — SOC systems can rarely carry our
// cookies.
func (d *Deps) InboundWebhook(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		writeJSONErr(w, http.StatusUnauthorized, "missing_bearer", "")
		return
	}
	secret := strings.TrimSpace(strings.TrimPrefix(auth, prefix))
	if secret == "" {
		writeJSONErr(w, http.StatusUnauthorized, "missing_bearer", "")
		return
	}
	var body inboundWebhookBody
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &body); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	switch body.ExternalSystem {
	case "servicenow", "jira", "pagerduty":
	default:
		writeJSONErr(w, http.StatusBadRequest, "invalid_system",
			"external_system must be servicenow|jira|pagerduty")
		return
	}
	if strings.TrimSpace(body.ExternalIncidentID) == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_incident_id", "")
		return
	}
	// Look up the rule by inbound_secret. We do not yet know the
	// tenant; the secret carries that identity. Use the outbox_worker
	// GUC to bypass the per-tenant RLS during lookup, then narrow.
	tx, err := db.WithWorkerScope(r.Context(), d.Pool)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, tenant_id::text, channel_config
  FROM audit_alert_rules
 WHERE channel_kind = $1`, body.ExternalSystem)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	var matchedRule, matchedTenant string
	for rows.Next() {
		var (
			ruleID, tenantID string
			cfg              []byte
		)
		if err := rows.Scan(&ruleID, &tenantID, &cfg); err != nil {
			continue
		}
		var cfgMap map[string]any
		if err := json.Unmarshal(cfg, &cfgMap); err != nil {
			continue
		}
		stored := asString(cfgMap["inbound_secret"])
		if stored == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(stored), []byte(secret)) == 1 {
			matchedRule = ruleID
			matchedTenant = tenantID
			break
		}
	}
	rows.Close()
	if matchedRule == "" {
		writeJSONErr(w, http.StatusUnauthorized, "bad_secret", "")
		return
	}

	if _, err := tx.Exec(r.Context(), `
INSERT INTO audit_alert_incidents
  (rule_id, tenant_id, external_system, external_incident_id,
   incident_status, incident_url, last_synced_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''), NULLIF($6,''), now(), now())
ON CONFLICT (rule_id, external_system, external_incident_id) DO UPDATE
  SET incident_status = COALESCE(NULLIF(EXCLUDED.incident_status,''),
                                 audit_alert_incidents.incident_status),
      incident_url    = COALESCE(NULLIF(EXCLUDED.incident_url,''),
                                 audit_alert_incidents.incident_url),
      last_synced_at  = now(),
      updated_at      = now()`,
		matchedRule, matchedTenant, body.ExternalSystem,
		body.ExternalIncidentID, body.IncidentStatus, body.IncidentURL); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), matchedTenant))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), matchedTenant))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"synced": true})
}

// recordOutboundIncident is called by the worker after a successful
// outbound incident creation. It persists the (rule, external_system,
// external_incident_id) mapping so future inbound webhooks can find
// the corresponding row.
func recordOutboundIncident(
	ctx context.Context, pool *db.Pool,
	ruleID, tenantID, externalSystem, externalIncidentID, incidentURL string,
	auditID int64,
) error {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_alert_incidents
  (rule_id, tenant_id, audit_id, external_system, external_incident_id,
   incident_status, incident_url, last_synced_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'open', NULLIF($6,''), now())
ON CONFLICT (rule_id, external_system, external_incident_id) DO UPDATE
  SET incident_url   = COALESCE(NULLIF(EXCLUDED.incident_url,''),
                                audit_alert_incidents.incident_url),
      last_synced_at = now(),
      updated_at     = now()`,
		ruleID, tenantID, auditID, externalSystem,
		externalIncidentID, incidentURL); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
