// SPDX-License-Identifier: AGPL-3.0-only
//
// import.go layers Mailchimp / Klaviyo parity helpers on top of the
// existing bulk_import.go CSV ingest:
//
//   - merge-field auto-detection: a column called FNAME / LNAME /
//     PHONE / ADDRESS / EMAIL is moved off custom_fields and into
//     merge_fields where it belongs (GAP-LS-096).
//   - tag-on-import: ?tag=foo applies the tag to every row that
//     successfully lands (GAP-LS-098).
//   - auto-create custom property: ?create_missing_fields=true
//     pre-registers any unknown column header in tenant_custom_fields
//     before the row-by-row upsert hits the validator (GAP-LS-099).
//
// Kept separate from bulk_import.go on purpose — that file is the
// "vanilla CSV upload" wire surface, this file is the cross-cutting
// detection layer. Mixing them would make the row loop hard to read.

package subscribers

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"
)

// MergeFieldKeys lists the Mailchimp-style merge-field column headers
// the auto-detect layer recognises. Headers are compared
// case-insensitively after trimming.
var MergeFieldKeys = map[string]string{
	"fname":      "FNAME",
	"first_name": "FNAME",
	"firstname":  "FNAME",
	"lname":      "LNAME",
	"last_name":  "LNAME",
	"lastname":   "LNAME",
	"phone":      "PHONE",
	"address":    "ADDRESS",
	"company":    "COMPANY",
	"birthday":   "BIRTHDAY",
}

// DetectMergeField returns the canonical merge-field key for a CSV
// header, or "" when the column is not a merge field.
func DetectMergeField(header string) string {
	h := strings.ToLower(strings.TrimSpace(header))
	if h == "email" {
		// Email is the row key; never a merge field.
		return ""
	}
	if k, ok := MergeFieldKeys[h]; ok {
		return k
	}
	return ""
}

// ValidateMergeFieldType applies the Mailchimp-style per-key sanity
// check the import flow runs before handing the value to the upsert.
// Returns an error string suitable for the per-row Error column.
func ValidateMergeFieldType(key, value string) string {
	switch key {
	case "PHONE":
		// Mailchimp accepts almost anything for phone; the only check
		// we run is that it has at least 4 digits so we don't store
		// junk like "n/a" as a phone.
		digits := 0
		for _, r := range value {
			if r >= '0' && r <= '9' {
				digits++
			}
		}
		if digits < 4 {
			return "phone must contain at least 4 digits"
		}
	case "BIRTHDAY":
		// Mailchimp BIRTHDAY is MM/DD or YYYY-MM-DD. Lightweight
		// check — full date parsing is left to the merge_fields
		// validator if the tenant has registered a date type.
		if len(value) < 5 || len(value) > 10 {
			return "birthday must be MM/DD or YYYY-MM-DD"
		}
	}
	return ""
}

// ImportOptions is the parsed bag of toggles every Klaviyo-/Mailchimp-
// parity import accepts. Built from the query string by the handler.
type ImportOptions struct {
	UpdateExisting       bool   // GAP-LS-097
	Tag                  string // GAP-LS-098
	CreateMissingFields  bool   // GAP-LS-099
	AutoDetectMergeField bool   // GAP-LS-096 (default on)
	ConsentSource        string // GAP-LS-093
	ConsentFormID        string
	ConsentSourceURL     string
}

// PartitionColumns splits a CSV header row into custom-field columns
// and merge-field columns (when auto-detect is on). Returns the
// existing-column-index map (lowercased keys) plus a mapping of
// lowercased header -> canonical MERGE_FIELD_KEY for callers that need
// to route the cell value to merge_fields instead of custom_fields.
func PartitionColumns(headers []string, autoDetect bool) (cols map[string]int, mergeMap map[string]string) {
	cols = map[string]int{}
	mergeMap = map[string]string{}
	for i, h := range headers {
		key := strings.ToLower(strings.TrimSpace(h))
		cols[key] = i
		if !autoDetect {
			continue
		}
		if mfKey := DetectMergeField(h); mfKey != "" {
			mergeMap[key] = mfKey
		}
	}
	return cols, mergeMap
}

// BuildCreateInputWithMergeFields is the merge-field-aware variant of
// buildCreateInput in bulk_import.go. Routes each cell to either
// CustomFields or MergeFields based on the precomputed mergeMap.
//
// Validation: any cell whose merge-field key fails
// ValidateMergeFieldType is recorded in errs (one entry per offending
// column) so the per-row response can carry the diagnostic.
func BuildCreateInputWithMergeFields(
	record []string,
	cols map[string]int,
	mergeMap map[string]string,
) (CreateInput, []string) {
	in := CreateInput{
		Status:        StatusUnconfirmed,
		ConsentSource: ConsentUnknown,
		// signup_source pinned to 'import' on the CSV-merge-fields path
		// so a source-branched welcome flow can fork on it directly.
		// The capture-path resolver in Repo.Upsert would do the same
		// derivation from ConsentImport — pinning it here keeps the
		// CreateInput self-describing for callers that inspect it before
		// hand-off (test fixtures, the future Moosewave Cloud import
		// preview).
		SignupSource: SignupSourceImport,
		Tags:         splitCommaList(getCol(record, cols, "tags")),
		CustomFields: map[string]any{},
		MergeFields:  map[string]any{},
	}
	emailIdx, ok := cols["email"]
	if ok && emailIdx < len(record) {
		in.Email = strings.TrimSpace(record[emailIdx])
	}
	if statusVal := getCol(record, cols, "status"); statusVal != "" {
		in.Status = statusVal
	}
	errs := []string{}
	for col, i := range cols {
		switch col {
		case "email", "status", "tags":
			continue
		}
		if i >= len(record) {
			continue
		}
		v := strings.TrimSpace(record[i])
		if v == "" {
			continue
		}
		if mfKey, isMerge := mergeMap[col]; isMerge {
			if msg := ValidateMergeFieldType(mfKey, v); msg != "" {
				errs = append(errs, col+": "+msg)
				continue
			}
			in.MergeFields[mfKey] = v
			continue
		}
		in.CustomFields[col] = v
	}
	return in, errs
}

// AutoCreateMissingFields pre-registers any header that is not yet a
// tenant_custom_fields row, so the validator inside Repo.Upsert won't
// later reject the row in strict mode. Skips reserved column names
// (email/status/tags) and any column the mergeMap claims as a
// merge-field. Returns the list of newly-created keys for logging /
// debugging.
//
// This is opt-in (the handler only calls it when
// ?create_missing_fields=true is set). We pick "string" as the type;
// the operator can edit the field definition in the UI afterwards.
func AutoCreateMissingFields(
	ctx context.Context,
	cf *customfields.Repo,
	tenantID string,
	headers []string,
	mergeMap map[string]string,
) ([]string, error) {
	if cf == nil {
		return nil, nil
	}
	existing, err := cf.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	known := map[string]struct{}{}
	for _, f := range existing {
		known[strings.ToLower(f.Key)] = struct{}{}
	}
	created := []string{}
	for _, h := range headers {
		key := strings.ToLower(strings.TrimSpace(h))
		switch key {
		case "", "email", "status", "tags":
			continue
		}
		if _, isMerge := mergeMap[key]; isMerge {
			continue
		}
		if _, ok := known[key]; ok {
			continue
		}
		if _, err := cf.Create(ctx, tenantID, key, defaultLabelForKey(key), customfields.TypeString); err != nil {
			// Conflict means we raced with another concurrent import
			// that pre-registered the key; treat as success.
			continue
		}
		created = append(created, key)
	}
	return created, nil
}

// defaultLabelForKey humanises "first_name" → "First name" so the
// auto-created field has a UI-friendly label until the operator edits
// it. Kept tiny on purpose: the customfields package has the same
// helper but it's lowercase so we can't reuse it.
func defaultLabelForKey(k string) string {
	parts := strings.FieldsFunc(k, func(r rune) bool {
		return r == '_' || r == '-' || r == ' '
	})
	if len(parts) == 0 {
		return k
	}
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

// ApplyImportTag applies the import-time tag to a freshly-inserted
// subscriber by looking up (or creating) the tag id and writing into
// subscriber_tags. Best-effort — failure to apply a tag should NOT
// fail the import row. Returns nil to keep the caller's error path
// uncomplicated.
//
// Tag id resolution + write happens inside a tenant-scoped tx so the
// RLS clamp on tags / subscriber_tags is respected.
func ApplyImportTag(ctx context.Context, pool *db.Pool, tenantID, subscriberID, tagName string) error {
	tagName = strings.TrimSpace(tagName)
	if tagName == "" || subscriberID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tagID string
	err = tx.QueryRow(ctx, `
INSERT INTO tags (tenant_id, name)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
RETURNING id::text`,
		tenantID, tagName).Scan(&tagID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'import')
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING`,
		tenantID, subscriberID, tagID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordImportConsent appends one consent_records row per row
// successfully imported, capturing the IP / source / form / source-URL
// passed in opts. Nil-pool callers (tests) get nil error.
//
// We use the consent.RecordProof helper rather than rolling our own
// INSERT so any future schema change to consent_records lands in one
// place.
func RecordImportConsent(
	ctx context.Context,
	pool *db.Pool,
	tenantID, subscriberID, email string,
	ip string,
	opts ImportOptions,
) error {
	if pool == nil {
		return nil
	}
	src := opts.ConsentSource
	if src == "" {
		src = "import"
	}
	_, err := consent.RecordProof(ctx, pool, consent.ProofInput{
		TenantID:      tenantID,
		SubscriberID:  subscriberID,
		Email:         email,
		ConsentStatus: "granted",
		Source:        src,
		SourceURL:     opts.ConsentSourceURL,
		FormID:        opts.ConsentFormID,
		IP:            ip,
		Evidence: map[string]any{
			"import_tag":            opts.Tag,
			"create_missing_fields": opts.CreateMissingFields,
			"update_existing":       opts.UpdateExisting,
		},
	})
	return err
}

// MergeIntoOptions parses the query-string toggles every parity-aware
// import handler accepts.
func MergeIntoOptions(getQuery func(string) string) ImportOptions {
	autoDetect := true
	if v := strings.ToLower(strings.TrimSpace(getQuery("merge_field_detect"))); v == "false" || v == "0" || v == "off" {
		autoDetect = false
	}
	return ImportOptions{
		UpdateExisting:       parseBoolish(getQuery("update_existing")),
		Tag:                  strings.TrimSpace(getQuery("tag")),
		CreateMissingFields:  parseBoolish(getQuery("create_missing_fields")),
		AutoDetectMergeField: autoDetect,
		ConsentSource:        strings.TrimSpace(getQuery("consent_source")),
		ConsentFormID:        strings.TrimSpace(getQuery("consent_form_id")),
		ConsentSourceURL:     strings.TrimSpace(getQuery("consent_source_url")),
	}
}

func parseBoolish(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

// EmailLooksValid is the same lightweight check buildCreateInput uses
// — exposed here so the merge-field-aware variant in this file can
// reuse it without duplicating the import.
func EmailLooksValid(s string) bool {
	_, err := emailidentity.Normalize(s)
	return err == nil
}
