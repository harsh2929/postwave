// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_paste.go — SUB-089: comma/newline list pasted into the
// add-subscriber modal.
//
// The add-subscriber modal historically accepted ONE email at a time via
// POST /api/v1/subscribers. Operators migrating off Klaviyo / Mailchimp
// routinely have a flat list of addresses on the clipboard and expect to
// paste the whole list and see per-address results inline — without
// building a CSV and going through the bulk-import flow.
//
// This is the lightweight middle ground between the single-create endpoint
// and the full CSV importer (bulk_import.go):
//
//   - Input is a single raw "emails" string (newline / comma / semicolon /
//     whitespace separated), not a CSV with a header row.
//   - No custom-field columns, no name/status/tags columns — paste is
//     "just the addresses"; everything else takes the create defaults.
//   - Per-address outcomes are returned inline (created / updated / skipped
//     / error) in the SAME response, identical in spirit to ImportCSV, so
//     the modal can render a results list without a second round-trip.
//   - Capped at MaxBulkPasteEmails per call (a paste, not a migration);
//     bigger lists route through the CSV importer / migration service.
//
// It reuses Repo.Upsert (custom-field validation, erasure-suppression
// guard, engine sync are all inherited) so the only net-new logic is the
// raw-string parse + de-dupe.

package subscribers

import (
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxBulkPasteEmails caps a single paste. This is a paste, not a migration —
// it intentionally sits well below the CSV importer's 10k cap so the modal's
// inline results list stays readable and the synchronous upsert loop stays
// snappy. A list longer than this is the CSV-import / migration-service path.
const MaxBulkPasteEmails = 100

const bulkPasteJSONMaxBodyBytes int64 = 256 << 10 // 256 KiB

// BulkPasteInput is the POST /api/v1/subscribers/bulk-paste body. Emails is a
// single raw string the operator pasted: newline / comma / semicolon /
// whitespace separated. Status, when set, applies to every parsed address
// (validated up front); empty takes the conservative create default
// (unconfirmed/non-sendable).
type BulkPasteInput struct {
	Emails string   `json:"emails"`
	Status string   `json:"status,omitempty"`
	Tags   []string `json:"tags,omitempty"`
}

// BulkPasteRow is one parsed address in the response, mirroring
// BulkImportRow so the modal can reuse the same per-row renderer the CSV
// import results use.
type BulkPasteRow struct {
	Email     string `json:"email"`
	Status    string `json:"status"` // "created" | "updated" | "skipped" | "error"
	ErrorCode string `json:"error_code,omitempty"`
	Error     string `json:"error,omitempty"`
}

// BulkPasteResponse is the body returned by POST /subscribers/bulk-paste.
// Parsed is the count of distinct addresses extracted from the raw paste
// (after de-dupe); the per-status counters sum to Parsed.
type BulkPasteResponse struct {
	Parsed  int            `json:"parsed"`
	Created int            `json:"created"`
	Updated int            `json:"updated"`
	Skipped int            `json:"skipped"`
	Errored int            `json:"errored"`
	Rows    []BulkPasteRow `json:"rows"`
}

// parseBulkPasteEmails splits the raw paste into a de-duplicated, ordered
// list of trimmed addresses. Splitting is on any of newline, comma,
// semicolon, tab, or space so the common clipboard shapes ("a@x.com,
// b@y.com", one-per-line, space-separated) all work. Order is preserved
// (first occurrence wins) so the inline results match the operator's paste.
// De-dupe is case-insensitive on the trimmed address.
func parseBulkPasteEmails(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		switch r {
		case '\n', '\r', ',', ';', '\t', ' ':
			return true
		default:
			return false
		}
	})
	out := make([]string, 0, len(fields))
	seen := map[string]struct{}{}
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		key := strings.ToLower(f)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, f)
	}
	return out
}

// BulkPaste POST /api/v1/subscribers/bulk-paste
//
// Accepts a JSON body with a raw "emails" string (newline / comma /
// semicolon / whitespace separated). Parses it into distinct addresses,
// validates the optional shared status up front, then upserts each address
// via Repo.Upsert (same path as Create) and returns per-address outcomes
// inline.
//
// Behaviour:
//   - Empty/whitespace-only "emails" → 400 no_emails.
//   - More than MaxBulkPasteEmails distinct addresses → 422 too_many_emails
//     (the operator should use the CSV importer instead).
//   - A malformed individual address is recorded in Rows[] with
//     status="error" rather than failing the whole paste (mirrors ImportCSV).
//   - Plan contact limits are enforced once for the count of NEW addresses
//     when an Enforcer is wired, matching the single Create path.
func (d *Deps) BulkPaste(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in BulkPasteInput
	if err := httpbody.DecodeJSON(w, r, bulkPasteJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	emails := parseBulkPasteEmails(in.Emails)
	if len(emails) == 0 {
		httperror.Write(w, http.StatusBadRequest, "no_emails",
			"emails must contain at least one address (newline/comma separated)")
		return
	}
	if len(emails) > MaxBulkPasteEmails {
		httperror.Write(w, http.StatusUnprocessableEntity, "too_many_emails",
			"too many addresses pasted; use the CSV importer for larger lists")
		return
	}

	// Pasted addresses never carry subscriber-specific consent evidence, so
	// they can only enter as unconfirmed. This rejects an unsafe sendable
	// claim once up front rather than returning one per-row validation error.
	status := strings.ToLower(strings.TrimSpace(in.Status))
	if status != "" && status != StatusUnconfirmed {
		httperror.Write(w, http.StatusBadRequest, "invalid_status", "bulk-pasted subscribers must be unconfirmed; record consent evidence separately")
		return
	}
	// Shared tags apply to every pasted address. Normalize (trim/dedupe/blank-
	// drop) once so each per-row Upsert reuses the cleaned set.
	sharedTags := normalizeTags(in.Tags)

	resp := BulkPasteResponse{Parsed: len(emails)}

	// Enforce the plan contact limit once for the count of NEW addresses
	// (existing addresses are updates, not new contacts). Best-effort: an
	// existence-check error is non-fatal — it falls through to the per-row
	// Upsert which carries its own error handling.
	if d.Limits != nil {
		newCount := 0
		for _, e := range emails {
			if exists, err := d.Repo.ExistsByEmail(r.Context(), t.ID, e); err == nil && !exists {
				newCount++
			}
		}
		if newCount > 0 {
			if err := d.Limits.Check(r.Context(), t.ID, limits.ResourceContacts, newCount); err != nil {
				if limits.WriteExceeded(w, err) {
					return
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
		}
	}

	for _, email := range emails {
		row := CreateInput{
			Email:         email,
			Status:        status,
			ConsentSource: ConsentUnknown,
			Tags:          append([]string(nil), sharedTags...),
			CustomFields:  map[string]any{},
		}
		if err := normalizeCreate(&row); err != nil {
			rowErr := validationRowError(err)
			resp.Rows = append(resp.Rows, BulkPasteRow{
				Email: email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		// SUB-018: apply per-tenant identifier transforms, same as Create.
		d.applyTenantIdentifierTransforms(r.Context(), t.ID, &row.Email, row.MergeFields, row.CustomFields)
		if err := d.Repo.PreflightUpsert(r.Context(), t.ID, row.Email, row.MergeFields); err != nil {
			rowErr := persistenceRowError(err)
			resp.Rows = append(resp.Rows, BulkPasteRow{
				Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		// Decide created-vs-updated by pre-existence (cheap on the
		// (tenant_id, email) idx), matching ImportCSV.
		existed, _ := d.Repo.ExistsByEmail(r.Context(), t.ID, row.Email)
		if err := d.syncCreateWithEngine(r.Context(), &row); err != nil {
			rowErr := engineRowError(err)
			resp.Rows = append(resp.Rows, BulkPasteRow{
				Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		sub, err := d.Repo.Upsert(r.Context(), t.ID, row)
		if err != nil {
			rowErr := persistenceRowError(err)
			resp.Rows = append(resp.Rows, BulkPasteRow{
				Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		if existed {
			resp.Updated++
			resp.Rows = append(resp.Rows, BulkPasteRow{Email: row.Email, Status: "updated"})
		} else {
			resp.Created++
			resp.Rows = append(resp.Rows, BulkPasteRow{Email: row.Email, Status: "created"})
			d.emit(t.ID, "subscriber.added", map[string]any{
				"id":     sub.ID,
				"email":  sub.Email,
				"status": sub.Status,
			})
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
