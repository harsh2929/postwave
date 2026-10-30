// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-120-GPP-ingest-emit — IAB Global Privacy Platform (GPP) section ingest/emit.
//
// A Consent Management Platform (CMP) emits a per-jurisdiction GPP string
// (us-national, California, EU TCF, ...) when a data subject sets their privacy
// preferences. This surface stores those strings verbatim on the subscriber's
// gpp_sections jsonb (migration 0562) and appends every change to the
// subscriber_gpp_audit ledger, so an auditor can reconstruct who set which
// jurisdiction's section when. No parsing/decoding happens here — that is a
// future compliance phase; this phase is durable storage + audit + emit.
//
// Endpoints (scoped under an existing subscriber id):
//
//	GET   /api/v1/subscribers/{id}/gpp   — fetch current sections + audit trail (read scope)
//	POST  /api/v1/subscribers/{id}/gpp   — ingest from a CMP webhook (write scope; HMAC-verified)
//	PATCH /api/v1/subscribers/{id}/gpp   — manual override (admin scope)
//
// The POST path is intended for a CMP webhook and supports an optional HMAC
// signature check: when the tenant has a configured signing secret AND the
// request carries an X-GPP-Signature header, the body's HMAC-SHA256 must match.
// Absent header + secret = trusted (the route is already API-key gated). The
// successful ingest emits subscriber.gpp.updated on the existing event bus.

package subscribers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// gppSourceCMPWebhook / gppSourceManual mirror the migration 0562 source CHECK.
const (
	gppSourceCMPWebhook     = "cmp_webhook"
	gppSourceManualOverride = "manual_override"
)

// gppAllowedSources is the closed set of provenance values the audit ledger
// accepts. Mirrors the migration 0562 CHECK.
var gppAllowedSources = map[string]struct{}{
	"cmp_webhook":     {},
	"manual_override": {},
	"import":          {},
	"api":             {},
}

// GppAuditEntry is one row of the per-jurisdiction GPP change ledger.
type GppAuditEntry struct {
	ID           string    `json:"id"`
	SubscriberID string    `json:"subscriber_id"`
	Jurisdiction string    `json:"jurisdiction"`
	SectionValue string    `json:"section_value"`
	Source       string    `json:"source"`
	CreatedAt    time.Time `json:"created_at"`
}

// GppResponse is the GET /subscribers/{id}/gpp body: the current sections plus
// the (capped) audit trail, newest-first.
type GppResponse struct {
	SubscriberID string            `json:"subscriber_id"`
	Sections     map[string]string `json:"sections"`
	Audit        []GppAuditEntry   `json:"audit"`
}

// IngestGppInput is the POST/PATCH /subscribers/{id}/gpp body. Sections is the
// per-jurisdiction map being ingested/overridden; an empty-string value for a
// key deletes that jurisdiction's section. Source defaults to cmp_webhook on
// POST and manual_override on PATCH.
type IngestGppInput struct {
	Sections map[string]string `json:"sections"`
	Source   string            `json:"source,omitempty"`
}

// MountGppRoutes wires the SUB-120 GPP ingest/emit surface.
func MountGppRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/gpp", d.GetGpp)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/gpp", d.IngestGpp)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/subscribers/{id}/gpp", d.OverrideGpp)
}

// GetGpp GET /api/v1/subscribers/{id}/gpp
func (d *Deps) GetGpp(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetGppSections(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeGppErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// IngestGpp POST /api/v1/subscribers/{id}/gpp (CMP webhook ingest).
func (d *Deps) IngestGpp(w http.ResponseWriter, r *http.Request) {
	d.ingestGpp(w, r, gppSourceCMPWebhook, true)
}

// OverrideGpp PATCH /api/v1/subscribers/{id}/gpp (manual admin override).
func (d *Deps) OverrideGpp(w http.ResponseWriter, r *http.Request) {
	d.ingestGpp(w, r, gppSourceManualOverride, false)
}

// ingestGpp is the shared write path. verifySig toggles the optional CMP
// webhook HMAC check (POST path); the PATCH override path skips it (admin
// scope already gates it).
func (d *Deps) ingestGpp(w http.ResponseWriter, r *http.Request, defaultSource string, verifySig bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Read the raw body so we can both HMAC-verify and JSON-decode it.
	body, err := httpbody.ReadJSONAtMost(r, subscriberJSONMaxBodyBytes, httpbody.Options{})
	if err != nil {
		if status := httpbody.StatusCode(err); status != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteValidation(w, "invalid_body", "could not read request body")
		return
	}
	if verifySig && d.GppWebhookSecret != nil {
		if sig := strings.TrimSpace(r.Header.Get("X-GPP-Signature")); sig != "" {
			secret := d.GppWebhookSecret(t.ID)
			if secret != "" && !verifyGppSignature(secret, body, sig) {
				httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "GPP webhook signature mismatch")
				return
			}
		}
	}
	var in IngestGppInput
	if err := httpbody.DecodeJSONValue(body, &in, httpbody.Options{}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if len(in.Sections) == 0 {
		httperror.WriteValidation(w, "validation_failed", "sections is required and must be non-empty")
		return
	}
	source := strings.TrimSpace(in.Source)
	if source == "" {
		source = defaultSource
	}
	if _, ok := gppAllowedSources[source]; !ok {
		httperror.WriteValidation(w, "validation_failed", "source must be one of cmp_webhook|manual_override|import|api")
		return
	}
	out, err := d.Repo.SetGppSections(r.Context(), t.ID, chi.URLParam(r, "id"), in.Sections, source)
	if err != nil {
		d.writeGppErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.gpp.updated", map[string]any{
		"subscriber_id": out.SubscriberID,
		"jurisdictions": gppKeys(in.Sections),
		"source":        source,
	})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) writeGppErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

// verifyGppSignature returns whether sigHex is a valid HMAC-SHA256 of body
// under secret. Accepts an optional "sha256=" prefix (GitHub-style). Constant-
// time comparison.
func verifyGppSignature(secret string, body []byte, sigHex string) bool {
	sigHex = strings.TrimPrefix(strings.TrimSpace(sigHex), "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(sigHex))
}

func gppKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

// GetGppSections reads the current per-jurisdiction GPP map plus the most
// recent audit entries (capped at 100, newest first). ErrNotFound when the
// subscriber does not exist.
func (r *Repo) GetGppSections(ctx context.Context, tenantID, subscriberID string) (*GppResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `
SELECT gpp_sections
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sub.ID).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	sections := map[string]string{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &sections); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, jurisdiction, section_value, source, created_at
  FROM subscriber_gpp_audit
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY created_at DESC
 LIMIT 100`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	audit := []GppAuditEntry{}
	for rows.Next() {
		var e GppAuditEntry
		if err := rows.Scan(&e.ID, &e.SubscriberID, &e.Jurisdiction, &e.SectionValue, &e.Source, &e.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		audit = append(audit, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &GppResponse{SubscriberID: sub.ID, Sections: sections, Audit: audit}, nil
}

// SetGppSections merges the supplied per-jurisdiction sections into the
// subscriber's gpp_sections jsonb and appends one audit row per changed
// jurisdiction, all in one tenant-scoped tx. An empty-string value for a key
// deletes that jurisdiction's section. Returns the resulting sections + audit
// trail. ErrNotFound when the subscriber does not exist.
func (r *Repo) SetGppSections(ctx context.Context, tenantID, subscriberID string, sections map[string]string, source string) (*GppResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out, err := setGppSectionsInTx(ctx, tx, tenantID, sub.ID, sections, source)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// setGppSectionsInTx is the transaction-scoped GPP merge+audit core shared by
// the dedicated SetGppSections write path and the subscriber Upsert create
// path (SUB-120). It loads the current gpp_sections jsonb, merges the supplied
// per-jurisdiction sections (an empty-string value deletes a key, an unchanged
// value is not re-audited), appends one subscriber_gpp_audit row per changed
// jurisdiction, persists the merged map, and returns the resulting sections +
// (capped, newest-first) audit trail. The caller owns commit/rollback so the
// merge participates atomically in the surrounding tx. subscriberID must
// already be resolved to the canonical row id.
func setGppSectionsInTx(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, sections map[string]string, source string) (*GppResponse, error) {
	// Load current sections.
	var raw []byte
	if err := tx.QueryRow(ctx, `
SELECT gpp_sections
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	cur := map[string]string{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cur); err != nil {
			return nil, err
		}
	}

	// Merge + audit. A key with empty value deletes; an unchanged value is not
	// re-audited.
	for jurisdiction, value := range sections {
		jurisdiction = strings.ToLower(strings.TrimSpace(jurisdiction))
		if jurisdiction == "" {
			continue
		}
		if value == "" {
			if _, existed := cur[jurisdiction]; !existed {
				continue
			}
			delete(cur, jurisdiction)
		} else {
			if prev, existed := cur[jurisdiction]; existed && prev == value {
				continue
			}
			cur[jurisdiction] = value
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_gpp_audit (tenant_id, subscriber_id, jurisdiction, section_value, source)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`, tenantID, subscriberID, jurisdiction, value, source); err != nil {
			return nil, err
		}
	}

	merged, err := json.Marshal(cur)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET gpp_sections = $3::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, string(merged)); err != nil {
		return nil, err
	}

	// Re-read audit (newest-first, capped) for the response.
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, jurisdiction, section_value, source, created_at
  FROM subscriber_gpp_audit
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY created_at DESC
 LIMIT 100`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	audit := []GppAuditEntry{}
	for rows.Next() {
		var e GppAuditEntry
		if err := rows.Scan(&e.ID, &e.SubscriberID, &e.Jurisdiction, &e.SectionValue, &e.Source, &e.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		audit = append(audit, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return &GppResponse{SubscriberID: subscriberID, Sections: cur, Audit: audit}, nil
}
