// SPDX-License-Identifier: AGPL-3.0-only
//
// batch_upsert.go — POST /api/v1/subscribers/batch: a per-record batch
// upsert. Neither the CSV importer (emails + a shared status) nor bulk-paste
// (emails only) lets an API/agent caller upsert N *distinct* records each
// with its own custom_fields / merge_fields / tags in one round-trip — the
// shape Klaviyo's batch profile-import and an MCP agent expect. This wraps
// the existing Repo.Upsert per record, reusing the same normalization,
// identifier/property transforms, plan-limit check, and engine sync as the
// single Create path.

package subscribers

import (
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxBatchUpsert caps a single batch call. Larger imports use the CSV
// importer / migration service.
const MaxBatchUpsert = 1000

const batchUpsertJSONMaxBodyBytes int64 = 4 << 20 // 4 MiB

// BatchUpsertRecord is one record in the batch.
type BatchUpsertRecord struct {
	Email        string         `json:"email"`
	Status       string         `json:"status,omitempty"`
	FirstName    string         `json:"first_name,omitempty"`
	LastName     string         `json:"last_name,omitempty"`
	CustomFields map[string]any `json:"custom_fields,omitempty"`
	MergeFields  map[string]any `json:"merge_fields,omitempty"`
	Tags         []string       `json:"tags,omitempty"`
}

// BatchUpsertInput is the request body.
type BatchUpsertInput struct {
	Subscribers []BatchUpsertRecord `json:"subscribers"`
}

// BatchUpsertRow is one record's outcome.
type BatchUpsertRow struct {
	Email     string `json:"email"`
	Status    string `json:"status"` // "created" | "updated" | "error"
	ErrorCode string `json:"error_code,omitempty"`
	Error     string `json:"error,omitempty"`
}

// BatchUpsertResponse is the aggregate result.
type BatchUpsertResponse struct {
	Total   int              `json:"total"`
	Created int              `json:"created"`
	Updated int              `json:"updated"`
	Errored int              `json:"errored"`
	Rows    []BatchUpsertRow `json:"rows"`
}

// BatchUpsert handles POST /api/v1/subscribers/batch.
func (d *Deps) BatchUpsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in BatchUpsertInput
	if err := httpbody.DecodeJSON(w, r, batchUpsertJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Subscribers) == 0 {
		httperror.Write(w, http.StatusBadRequest, "no_records",
			"subscribers must contain at least one record")
		return
	}
	if len(in.Subscribers) > MaxBatchUpsert {
		httperror.Write(w, http.StatusUnprocessableEntity, "too_many_records",
			"too many records; use the CSV importer for larger imports")
		return
	}

	resp := BatchUpsertResponse{Total: len(in.Subscribers)}

	// Enforce the plan contact limit once for the count of NEW addresses
	// (existing addresses are updates, not new contacts). Best-effort.
	if d.Limits != nil {
		newCount := 0
		for _, rec := range in.Subscribers {
			email := strings.TrimSpace(rec.Email)
			if email == "" {
				continue
			}
			if exists, err := d.Repo.ExistsByEmail(r.Context(), t.ID, email); err == nil && !exists {
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

	for _, rec := range in.Subscribers {
		row := batchRecordToCreateInput(rec)
		if err := normalizeCreate(&row); err != nil {
			rowErr := validationRowError(err)
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: rec.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message})
			resp.Errored++
			continue
		}
		d.applyTenantIdentifierTransforms(r.Context(), t.ID, &row.Email, row.MergeFields, row.CustomFields)
		// allocateIfNil=true: batch records are full upserts (row.CustomFields
		// is always a non-nil map here anyway), so deriving into it is safe.
		d.applyPropertyTransformRules(r.Context(), t.ID, row.MergeFields, &row.CustomFields, true)
		if err := d.Repo.PreflightUpsert(r.Context(), t.ID, row.Email, row.MergeFields); err != nil {
			rowErr := persistenceRowError(err)
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message})
			resp.Errored++
			continue
		}

		existed, _ := d.Repo.ExistsByEmail(r.Context(), t.ID, row.Email)
		if err := d.syncCreateWithEngine(r.Context(), &row); err != nil {
			rowErr := engineRowError(err)
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message})
			resp.Errored++
			continue
		}
		sub, err := d.Repo.Upsert(r.Context(), t.ID, row)
		if err != nil {
			rowErr := persistenceRowError(err)
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: row.Email, Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message})
			resp.Errored++
			continue
		}
		if existed {
			resp.Updated++
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: row.Email, Status: "updated"})
		} else {
			resp.Created++
			resp.Rows = append(resp.Rows, BatchUpsertRow{Email: row.Email, Status: "created"})
			d.emit(t.ID, "subscriber.added", map[string]any{
				"id":     sub.ID,
				"email":  sub.Email,
				"status": sub.Status,
			})
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// batchRecordToCreateInput maps a batch record onto the shared CreateInput.
// first_name/last_name fold into custom_fields (the system reads the display
// name from custom_fields["name"]), unless the caller already set "name".
func batchRecordToCreateInput(rec BatchUpsertRecord) CreateInput {
	cf := map[string]any{}
	for k, v := range rec.CustomFields {
		cf[k] = v
	}
	first := strings.TrimSpace(rec.FirstName)
	last := strings.TrimSpace(rec.LastName)
	if first != "" {
		cf["first_name"] = first
	}
	if last != "" {
		cf["last_name"] = last
	}
	if _, hasName := cf["name"]; !hasName {
		if full := strings.TrimSpace(first + " " + last); full != "" {
			cf["name"] = full
		}
	}
	return CreateInput{
		Email:  strings.TrimSpace(rec.Email),
		Status: strings.ToLower(strings.TrimSpace(rec.Status)),
		// Batch provenance does not establish marketing permission. The shared
		// create normalizer defaults blank status to unconfirmed and only an
		// explicit evidence-bearing consent flow may enable a subscriber.
		ConsentSource: ConsentUnknown,
		Tags:          normalizeTags(rec.Tags),
		CustomFields:  cf,
		MergeFields:   rec.MergeFields,
	}
}
