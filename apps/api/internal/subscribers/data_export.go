// Per-subscriber DSAR (GDPR Art. 15 / CCPA §1798.100) download. Mounts
// GET /api/v1/subscribers/{id}/data-export.zip under admin scope and
// returns a ZIP whose entries are split by data type — subscriber row,
// events history, consent receipts, notes, suppressions — so the
// requester (or their counsel) doesn't have to grep one giant blob.
//
// The bundle stitching itself is delegated to sar.BuildBundle so this
// file stays in lockstep with the source-of-truth SAR surface. A row
// is persisted to sar_bundles for the auditor trail and a
// `subscriber.data_export` audit_log entry captures the operator
// user_id + email + IP.
//
// Wire surface:
//
//	GET /api/v1/subscribers/{id}/data-export.zip   admin scope
//
// Filename: subscriber-{email}-data-export-{YYYY-MM-DD}.zip

package subscribers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sar"
)

// MountDataExportRoutes registers the per-subscriber DSAR download.
// Kept in a sibling Mount* so main.go can opt in independently of the
// rest of the subscriber surface (the route is admin-scope, not
// read-subscribers).
func MountDataExportRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/subscribers/{id}/data-export.zip", d.DataExport)
}

// DataExport GET /api/v1/subscribers/{id}/data-export.zip.
//
// Resolves the subscriber by id (or email), runs sar.BuildBundle, then
// writes the bundle out as a ZIP split by data type. A sar_bundles row
// captures the disclosed snapshot for the regulator trail and an
// audit_log row captures the operator identity.
func (d *Deps) DataExport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	sub, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if email == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("missing_email", "subscriber has no email"))
		return
	}

	// Single tenant-scoped tx covers both the bundle build and the
	// sar_bundles insert so we never persist a partial disclosure
	// without the matching audit row.
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	bundle, counts, err := sar.BuildBundle(
		r.Context(), tx, t.ID, email, d.PlaygroundSubjectAccess,
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	raw, err := json.Marshal(bundle)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	requestedBy := "admin:unknown"
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if e := strings.TrimSpace(u.Email); e != "" {
			requestedBy = "admin:" + e
		}
	}

	var bundleID string
	err = tx.QueryRow(r.Context(), `
INSERT INTO sar_bundles
  (tenant_id, subscriber_email, status, event_count, consent_count,
   bundle_bytes, bundle, requested_by, ready_at)
VALUES ($1::uuid, $2, 'ready', $3, $4, $5, $6::jsonb, $7, now())
RETURNING id::text`,
		t.ID, email, counts.Events, counts.Consents, len(raw), raw, requestedBy,
	).Scan(&bundleID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = t.ID
	if err := db.Audit(r.Context(), tx, meta, "subscriber.data_export", "subscriber", sub.ID, map[string]any{
		"subscriber_email": email,
		"sar_bundle_id":    bundleID,
		"event_count":      counts.Events,
		"consent_count":    counts.Consents,
		"bundle_bytes":     len(raw),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	zipBytes, err := buildDataExportZip(bundleID, email, time.Now().UTC(), bundle)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	filename := fmt.Sprintf("subscriber-%s-data-export-%s.zip",
		sanitizeEmailForFilename(email),
		time.Now().UTC().Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Postwave-SAR-Request-ID", bundleID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(zipBytes)
}

// buildDataExportZip splits the SAR bundle into the per-data-type
// archive entries the spec calls for. JSONL is used for streaming-
// friendly multi-row sections (events, consent receipts, notes); the
// single-object and small-list sections stay JSON for legibility.
func buildDataExportZip(id, email string, generatedAt time.Time, bundle map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	readme := fmt.Sprintf(`Moosewave per-subscriber data export
=====================================

Request ID:        %s
Subscriber email:  %s
Generated at:      %s

Contents:
  subscriber.json          Canonical subscriber row + custom fields
  events.jsonl             Sends / opens / clicks / bounces (newest first)
  consent_receipts.jsonl   Consent state transitions with receipt IDs
  notes.jsonl              Operator notes attached to this subscriber
  suppressions.json        Email + SMS suppressions affecting this address
  bundle.json              Full snapshot (kept for cross-reference / auditor)

This bundle was produced under GDPR Article 15 / CCPA §1798.100.
It is a point-in-time snapshot. Subsequent activity is NOT reflected —
re-run the export to get a fresh bundle.
`, id, email, generatedAt.Format(time.RFC3339))
	if err := writeZipEntry(zw, "README.txt", []byte(readme)); err != nil {
		return nil, err
	}

	// subscriber.json — single object.
	subRaw, _ := json.MarshalIndent(bundle["subscriber"], "", "  ")
	if len(subRaw) == 0 {
		subRaw = []byte("{}")
	}
	if err := writeZipEntry(zw, "subscriber.json", subRaw); err != nil {
		return nil, err
	}

	// events.jsonl
	if err := writeZipEntry(zw, "events.jsonl", marshalJSONL(bundle["events"])); err != nil {
		return nil, err
	}

	// consent_receipts.jsonl
	if err := writeZipEntry(zw, "consent_receipts.jsonl", marshalJSONL(bundle["consent_receipts"])); err != nil {
		return nil, err
	}

	// notes.jsonl — keyed as subscriber_notes in the bundle.
	if err := writeZipEntry(zw, "notes.jsonl", marshalJSONL(bundle["subscriber_notes"])); err != nil {
		return nil, err
	}

	// suppressions.json — both email + SMS in one object so the
	// recipient sees the full set at a glance.
	suppressions := map[string]any{
		"email": coerceList(bundle["email_suppressions"]),
		"sms":   coerceList(bundle["sms_suppressions"]),
	}
	supRaw, err := json.MarshalIndent(suppressions, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipEntry(zw, "suppressions.json", supRaw); err != nil {
		return nil, err
	}

	// bundle.json — kept verbatim so auditors can cross-check the
	// split-by-type files against the canonical SAR snapshot.
	fullRaw, _ := json.MarshalIndent(bundle, "", "  ")
	if err := writeZipEntry(zw, "bundle.json", fullRaw); err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeZipEntry(zw *zip.Writer, name string, content []byte) error {
	f, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = f.Write(content)
	return err
}

// marshalJSONL writes a list-of-objects bundle entry as JSON Lines.
// Returns an empty payload (single newline) when the section is empty
// or absent, so consumers can rely on the file existing.
func marshalJSONL(section any) []byte {
	list := coerceList(section)
	if len(list) == 0 {
		return []byte{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// SetIndent off — JSONL is one record per line.
	for _, row := range list {
		if err := enc.Encode(row); err != nil {
			continue
		}
	}
	return buf.Bytes()
}

// coerceList normalises a bundle section into []any. The SAR builder
// hands back either []map[string]any (typed) or nil — both collapse
// to a uniform shape here so the zip writer can iterate without type
// switches.
func coerceList(v any) []any {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		return t
	case []map[string]any:
		out := make([]any, 0, len(t))
		for _, m := range t {
			out = append(out, m)
		}
		return out
	default:
		return nil
	}
}

// sanitizeEmailForFilename produces a filesystem-safe rendering of an
// email address: lowercased, non-alnum characters collapsed to '-'.
// The output is suitable for a Content-Disposition filename slot.
func sanitizeEmailForFilename(email string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(email) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_.")
	if out == "" {
		return "subscriber"
	}
	return out
}
