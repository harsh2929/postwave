// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-018 — Identifier normalization transforms at ingest.
//
// Email lowercasing is unconditional and already lives in
// handlers.go:normalizeEmail. This file adds the *optional*, per-tenant
// transforms an operator can opt into via PATCH
// /api/v1/settings/identifier-transforms:
//
//   - email_normalize_dots: strip dots from the email local-part (Gmail-style
//     "j.o.h.n@gmail.com" -> "john@gmail.com").
//   - email_normalize_plus: drop the "+tag" sub-address from the local-part
//     ("john+promo@gmail.com" -> "john@gmail.com").
//   - phone_e164_format: coerce phone identifiers found in merge_fields /
//     custom_fields to E.164, using phone_default_region for national-format
//     numbers that lack an explicit "+countrycode".
//
// The config is loaded once per ingest (Repo.LoadIdentifierTransforms); when no
// settings row exists the defaults are all-off, so a tenant that never touches
// this surface keeps the historic lowercase-only behaviour. The transforms are
// applied by normalizeCreate / normalizeUpdate *after* the existing validation
// so a malformed email is still rejected before we try to reshape it.
//
// Phone E.164 is implemented in-package (no libphonenumber dependency) to keep
// the build hermetic: it covers the common cases — an already-international
// "+<cc><national>" number, and a national-format number plus a known default
// region whose calling code we look up in a small curated table. Unknown
// regions or numbers we can't confidently coerce are left untouched (the raw
// value survives, never silently corrupted).

package subscribers

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// phoneFieldKeys are the well-known merge_fields / custom_fields keys that hold
// a phone identifier. Matching is case-insensitive on the trimmed key. We keep
// the list explicit so the phone transform never reshapes an unrelated field
// that merely happens to contain digits.
var phoneFieldKeys = map[string]struct{}{
	"phone":        {},
	"phone_number": {},
	"mobile":       {},
	"sms":          {},
	"smsnumber":    {},
	"sms_number":   {},
	"cell":         {},
}

// regionCallingCodes maps an ISO 3166-1 alpha-2 region to its E.164 country
// calling code. Intentionally a curated subset of high-traffic regions rather
// than the full ITU table — a region we don't know simply disables the
// national-format coercion (international "+..." numbers still normalize). This
// keeps the build dependency-free while covering the regions tenants actually
// configure.
var regionCallingCodes = map[string]string{
	"US": "1", "CA": "1",
	"GB": "44", "IE": "353",
	"AU": "61", "NZ": "64",
	"DE": "49", "FR": "33", "ES": "34", "IT": "39", "NL": "31",
	"SE": "46", "NO": "47", "DK": "45", "FI": "358",
	"IN": "91", "SG": "65", "JP": "81", "BR": "55", "MX": "52",
	"ZA": "27", "AE": "971", "CH": "41", "AT": "43", "BE": "32",
	"PT": "351", "PL": "48", "CZ": "420",
}

// normalizeEmailWithConfig applies the optional email transforms to an already
// lowercased, validated email address. cfg.EmailNormalizeDots and
// cfg.EmailNormalizePlus are independent. The domain part is never touched
// (dots in the domain are significant). Returns the (possibly) rewritten
// address; an address without a single "@" is returned unchanged.
func normalizeEmailWithConfig(email string, cfg IdentifierTransformConfig) string {
	if !cfg.EmailNormalizeDots && !cfg.EmailNormalizePlus {
		return email
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return email
	}
	local := email[:at]
	domain := email[at:]
	if cfg.EmailNormalizePlus {
		if plus := strings.IndexByte(local, '+'); plus >= 0 {
			local = local[:plus]
		}
	}
	if cfg.EmailNormalizeDots {
		local = strings.ReplaceAll(local, ".", "")
	}
	// Defensive: dot/plus stripping must not empty the local-part (that would
	// produce an invalid "@domain" address). If it did, keep the original.
	if local == "" {
		return email
	}
	return local + domain
}

// normalizePhoneE164 coerces a raw phone string to E.164 when possible.
//
//   - Strips all formatting (spaces, dashes, parens, dots).
//   - A leading "+" or "00" is treated as an explicit international prefix; the
//     remaining digits are used as-is.
//   - Otherwise, if defaultRegion is a known calling code, the national digits
//     are prefixed with "+<calling code>", dropping a single leading trunk "0".
//
// Returns (normalized, true) only when a confident E.164 string was produced;
// otherwise (raw, false) so callers can leave the value untouched. The output
// is validated against the 8–16 char "+<7..15 digits>" E.164 envelope.
func normalizePhoneE164(raw, defaultRegion string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return raw, false
	}

	hadPlus := strings.HasPrefix(trimmed, "+")
	hadIntlZeros := strings.HasPrefix(trimmed, "00")

	// Keep digits only.
	var b strings.Builder
	for _, r := range trimmed {
		if r >= '0' && r <= '9' {
			b.WriteByte(byte(r))
		}
	}
	digits := b.String()
	if digits == "" {
		return raw, false
	}

	var e164 string
	switch {
	case hadPlus:
		e164 = "+" + digits
	case hadIntlZeros && len(digits) > 2:
		// "00<cc><national>" international access prefix.
		e164 = "+" + digits[2:]
	default:
		cc, ok := regionCallingCodes[strings.ToUpper(strings.TrimSpace(defaultRegion))]
		if !ok {
			return raw, false
		}
		national := strings.TrimPrefix(digits, "0")
		e164 = "+" + cc + national
	}

	if !isE164(e164) {
		return raw, false
	}
	return e164, true
}

// isE164 validates the "+" prefix and 7–15 trailing digits (the ITU E.164
// envelope: max 15 digits total, never starting with 0 after the "+").
func isE164(s string) bool {
	if len(s) < 8 || s[0] != '+' {
		return false
	}
	rest := s[1:]
	if len(rest) < 7 || len(rest) > 15 || rest[0] == '0' {
		return false
	}
	for i := 0; i < len(rest); i++ {
		if rest[i] < '0' || rest[i] > '9' {
			return false
		}
	}
	return true
}

// applyPhoneTransforms walks the provided field map (merge_fields or
// custom_fields) and, for every well-known phone key whose value is a string,
// rewrites it to E.164 in place when a confident normalization is produced.
// Non-string values and unknown keys are left untouched. Returns the number of
// fields actually rewritten (used by the preview endpoint to report changes).
func applyPhoneTransforms(fields map[string]any, cfg IdentifierTransformConfig) int {
	if !cfg.PhoneE164Format || len(fields) == 0 {
		return 0
	}
	changed := 0
	for k, v := range fields {
		if _, ok := phoneFieldKeys[strings.ToLower(strings.TrimSpace(k))]; !ok {
			continue
		}
		s, ok := v.(string)
		if !ok || s == "" {
			continue
		}
		if normalized, did := normalizePhoneE164(s, cfg.PhoneDefaultRegion); did && normalized != s {
			fields[k] = normalized
			changed++
		}
	}
	return changed
}

// applyIdentifierTransforms applies the email transforms to *email and the
// phone transforms to mergeFields + customFields, all in place. It is the
// single chokepoint wired into normalizeCreate / normalizeUpdate so the ingest
// surfaces share identical normalization semantics. A zero-value cfg is a
// no-op.
func applyIdentifierTransforms(email *string, mergeFields, customFields map[string]any, cfg IdentifierTransformConfig) {
	if email != nil && *email != "" {
		*email = normalizeEmailWithConfig(*email, cfg)
	}
	applyPhoneTransforms(mergeFields, cfg)
	applyPhoneTransforms(customFields, cfg)
}

// applyTenantIdentifierTransforms loads the tenant's transform config and
// applies it to the supplied identifier fields in place. It is the ingest
// chokepoint called by Create / Update after the unconditional normalization.
//
// Fail-open: when the config cannot be read (e.g. the 0463 table is missing on
// an un-migrated deployment, or a transient DB error), it logs a warning and
// falls back to the all-off defaults rather than blocking the write. A
// zero-value config is a no-op, so the worst case is "no optional transform
// applied" — never a corrupted or rejected identifier.
func (d *Deps) applyTenantIdentifierTransforms(ctx context.Context, tenantID string, email *string, mergeFields, customFields map[string]any) {
	if d == nil || d.Repo == nil {
		return
	}
	cfg, err := d.Repo.LoadIdentifierTransforms(ctx, tenantID)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("load identifier transforms failed; falling back to defaults",
				"tenant_id", tenantID, "err", err.Error())
		}
		return
	}
	applyIdentifierTransforms(email, mergeFields, customFields, cfg)
}

// LoadIdentifierTransforms reads the per-tenant transform config. When no
// settings row exists the zero-value (all transforms off) config is returned,
// so callers never have to special-case "unconfigured". A read error is
// surfaced so the ingest path can decide whether to fail open (it does — see
// the handler wiring, which logs and falls back to defaults).
func (r *Repo) LoadIdentifierTransforms(ctx context.Context, tenantID string) (IdentifierTransformConfig, error) {
	var cfg IdentifierTransformConfig
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return cfg, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT email_normalize_dots, email_normalize_plus, phone_e164_format, phone_default_region
  FROM tenant_identifier_transforms
 WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&cfg.EmailNormalizeDots, &cfg.EmailNormalizePlus, &cfg.PhoneE164Format, &cfg.PhoneDefaultRegion)
	if err != nil {
		// No row -> defaults (every transform off). Distinguish pgx.ErrNoRows
		// from a real error so a missing config never looks like a DB fault.
		if errors.Is(err, pgx.ErrNoRows) {
			return IdentifierTransformConfig{}, nil
		}
		return IdentifierTransformConfig{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// UpdateIdentifierTransforms upserts the per-tenant transform config and
// returns the resolved values. Omitted (nil) fields keep their current value
// (or the all-off default when no row exists yet) so a tenant can flip one
// transform without resending the whole config.
func (r *Repo) UpdateIdentifierTransforms(ctx context.Context, tenantID string, in UpdateIdentifierTransformInput) (IdentifierTransformConfig, error) {
	cur, err := r.LoadIdentifierTransforms(ctx, tenantID)
	if err != nil {
		return cur, err
	}
	next := cur
	if in.EmailNormalizeDots != nil {
		next.EmailNormalizeDots = *in.EmailNormalizeDots
	}
	if in.EmailNormalizePlus != nil {
		next.EmailNormalizePlus = *in.EmailNormalizePlus
	}
	if in.PhoneE164Format != nil {
		next.PhoneE164Format = *in.PhoneE164Format
	}
	if in.PhoneDefaultRegion != nil {
		next.PhoneDefaultRegion = strings.ToUpper(strings.TrimSpace(*in.PhoneDefaultRegion))
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return cur, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_identifier_transforms
       (tenant_id, email_normalize_dots, email_normalize_plus, phone_e164_format, phone_default_region)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id) DO UPDATE
   SET email_normalize_dots = EXCLUDED.email_normalize_dots,
       email_normalize_plus = EXCLUDED.email_normalize_plus,
       phone_e164_format    = EXCLUDED.phone_e164_format,
       phone_default_region = EXCLUDED.phone_default_region,
       updated_at           = now()`,
		tenantID, next.EmailNormalizeDots, next.EmailNormalizePlus, next.PhoneE164Format, next.PhoneDefaultRegion); err != nil {
		return cur, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cur, err
	}
	return next, nil
}

// validRegionCode reports whether a non-empty region is a known calling-code
// region. Empty is allowed (means "no default region"). Used by the PATCH
// handler so an operator can't enable phone_e164_format with a region we can't
// actually resolve.
func validRegionCode(region string) bool {
	if region == "" {
		return true
	}
	_, ok := regionCallingCodes[strings.ToUpper(region)]
	return ok
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

// PreviewTransformInput is the POST /api/v1/subscribers/preview-transforms body
// — a dry-run that shows the operator exactly what the *currently configured*
// transforms would do to a sample identifier, without writing anything.
type PreviewTransformInput struct {
	Email        string         `json:"email"`
	MergeFields  map[string]any `json:"merge_fields"`
	CustomFields map[string]any `json:"custom_fields"`
	// Overrides, when present, preview an as-yet-unsaved config instead of the
	// tenant's stored one (so the settings UI can show a live preview while the
	// operator toggles switches). nil = use the stored config.
	Overrides *IdentifierTransformConfig `json:"overrides,omitempty"`
}

// PreviewTransformResult reports the before/after for each identifier the
// transforms touched. Unchanged identifiers are still echoed so the UI can show
// "no change" explicitly.
type PreviewTransformResult struct {
	Config       IdentifierTransformConfig `json:"config"`
	EmailInput   string                    `json:"email_input"`
	EmailOutput  string                    `json:"email_output"`
	EmailChanged bool                      `json:"email_changed"`
	Phones       []PhonePreview            `json:"phones"`
}

// PhonePreview is one phone field's before/after.
type PhonePreview struct {
	Key     string `json:"key"`
	Input   string `json:"input"`
	Output  string `json:"output"`
	Changed bool   `json:"changed"`
}

// MountIdentifierTransformRoutes wires the SUB-018 surface:
//
//	GET   /api/v1/settings/identifier-transforms   (read config; read scope)
//	PATCH /api/v1/settings/identifier-transforms   (set config; admin scope)
//	POST  /api/v1/subscribers/preview-transforms   (dry-run; read scope)
//
// The mutating PATCH requires the admin scope since it changes a workspace
// ingest policy; the read + preview surfaces are read-scoped.
func MountIdentifierTransformRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/settings/identifier-transforms", d.GetIdentifierTransforms)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/settings/identifier-transforms", d.UpdateIdentifierTransforms)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Post("/api/v1/subscribers/preview-transforms", d.PreviewIdentifierTransforms)
}

// GetIdentifierTransforms GET /api/v1/settings/identifier-transforms
func (d *Deps) GetIdentifierTransforms(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	cfg, err := d.Repo.LoadIdentifierTransforms(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// UpdateIdentifierTransforms PATCH /api/v1/settings/identifier-transforms
func (d *Deps) UpdateIdentifierTransforms(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpdateIdentifierTransformInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.EmailNormalizeDots == nil && in.EmailNormalizePlus == nil &&
		in.PhoneE164Format == nil && in.PhoneDefaultRegion == nil {
		httperror.WriteValidation(w, "validation_failed",
			"at least one transform field is required")
		return
	}
	if in.PhoneDefaultRegion != nil {
		region := strings.ToUpper(strings.TrimSpace(*in.PhoneDefaultRegion))
		if !validRegionCode(region) {
			httperror.WriteValidation(w, "invalid_region",
				"phone_default_region must be a known ISO 3166-1 alpha-2 region (or empty)")
			return
		}
	}
	cfg, err := d.Repo.UpdateIdentifierTransforms(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber.identifier_transforms.updated", map[string]any{
		"email_normalize_dots": cfg.EmailNormalizeDots,
		"email_normalize_plus": cfg.EmailNormalizePlus,
		"phone_e164_format":    cfg.PhoneE164Format,
		"phone_default_region": cfg.PhoneDefaultRegion,
	})
	writeJSON(w, http.StatusOK, cfg)
}

// PreviewIdentifierTransforms POST /api/v1/subscribers/preview-transforms
func (d *Deps) PreviewIdentifierTransforms(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in PreviewTransformInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	cfg := IdentifierTransformConfig{}
	if in.Overrides != nil {
		cfg = *in.Overrides
		cfg.PhoneDefaultRegion = strings.ToUpper(strings.TrimSpace(cfg.PhoneDefaultRegion))
	} else {
		loaded, err := d.Repo.LoadIdentifierTransforms(r.Context(), t.ID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		cfg = loaded
	}
	out := buildTransformPreview(in, cfg)
	writeJSON(w, http.StatusOK, out)
}

// buildTransformPreview is the pure core of the preview endpoint: it applies
// cfg to the sample input and reports each before/after. Kept separate from the
// handler so it can be unit-tested without HTTP. The email is lowercased first
// (mirroring normalizeEmail's unconditional step) before the optional
// transforms are applied, so the preview matches what ingest would actually
// store.
func buildTransformPreview(in PreviewTransformInput, cfg IdentifierTransformConfig) PreviewTransformResult {
	emailIn := strings.TrimSpace(in.Email)
	emailOut := emailIn
	if emailOut != "" {
		emailOut = strings.ToLower(emailOut)
		emailOut = normalizeEmailWithConfig(emailOut, cfg)
	}
	res := PreviewTransformResult{
		Config:       cfg,
		EmailInput:   emailIn,
		EmailOutput:  emailOut,
		EmailChanged: emailIn != emailOut,
		Phones:       []PhonePreview{},
	}
	// Walk both field maps for phone keys; preview each in place without
	// mutating the caller's maps.
	previewPhones := func(fields map[string]any) {
		for k, v := range fields {
			if _, ok := phoneFieldKeys[strings.ToLower(strings.TrimSpace(k))]; !ok {
				continue
			}
			s, ok := v.(string)
			if !ok {
				continue
			}
			out := s
			if cfg.PhoneE164Format {
				if normalized, did := normalizePhoneE164(s, cfg.PhoneDefaultRegion); did {
					out = normalized
				}
			}
			res.Phones = append(res.Phones, PhonePreview{
				Key:     k,
				Input:   s,
				Output:  out,
				Changed: s != out,
			})
		}
	}
	previewPhones(in.MergeFields)
	previewPhones(in.CustomFields)
	return res
}
