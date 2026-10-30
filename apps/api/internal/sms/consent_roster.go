// SPDX-License-Identifier: AGPL-3.0-only
//
// SMS consent roster + log (SMS-006): a read surface over the existing
// sms_consent_events store (populated by RecordConsent), so operators can see
// who opted in/out, from where, and with what proof — plus a CSV export.
package sms

import (
	"context"
	"encoding/csv"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ConsentEventRow is one recorded SMS consent action.
type ConsentEventRow struct {
	ID              string `json:"id"`
	PhoneE164       string `json:"phone_e164"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
	Action          string `json:"action"`
	Source          string `json:"source"`
	ProofText       string `json:"proof_text,omitempty"`
	Provider        string `json:"provider,omitempty"`
	CreatedAt       string `json:"created_at"`
}

// ListConsentEvents returns the tenant's SMS consent events, newest first,
// optionally filtered by action and/or a phone substring.
func (s *Store) ListConsentEvents(ctx context.Context, tenantID, action, phone string) ([]ConsentEventRow, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, phone_e164, COALESCE(subscriber_email, ''), action,
		       source, COALESCE(proof_text, ''), COALESCE(provider, ''),
		       created_at::text
		  FROM sms_consent_events
		 WHERE tenant_id = $1::uuid
		   AND ($2 = '' OR action = $2)
		   AND ($3 = '' OR phone_e164 ILIKE '%'||$3||'%')
		 ORDER BY created_at DESC
		 LIMIT 500`, tenantID, action, phone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConsentEventRow{}
	for rows.Next() {
		var row ConsentEventRow
		if err := rows.Scan(&row.ID, &row.PhoneE164, &row.SubscriberEmail,
			&row.Action, &row.Source, &row.ProofText, &row.Provider,
			&row.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ListConsent GET /api/v1/sms/consent?action=&phone= (SMS-006).
func (d *Deps) ListConsent(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	out, err := d.Store.ListConsentEvents(r.Context(), tenant.ID, action, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

// ConsentExport GET /api/v1/sms/consent/export — the consent log as CSV.
func (d *Deps) ConsentExport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	rows, err := d.Store.ListConsentEvents(r.Context(), tenant.ID, action, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="sms-consent-log.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"phone", "action", "source", "timestamp", "proof", "provider"})
	for _, row := range rows {
		_ = cw.Write([]string{
			row.PhoneE164, row.Action, row.Source, row.CreatedAt,
			row.ProofText, row.Provider,
		})
	}
	cw.Flush()
}
