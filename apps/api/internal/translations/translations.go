// SPDX-License-Identifier: AGPL-3.0-only
//
// Package translations implements sto-smart-translations: multi-locale AI
// translation of campaign bodies with a CSV-importable terminology
// dictionary so brand / product / trademark terms survive translation
// untouched.
//
// The high-level shape mirrors Klaviyo + beehiiv:
//
//  1. The tenant uploads a dictionary of terms ("Moosewave", "Pro plan",
//     "@postwave.io") that must NOT be translated, plus optional per-
//     locale overrides for terms that should map to a fixed string in
//     one locale (e.g. brand legal entity name in fr-CA).
//
//  2. At render time (just before handing the body off to Listmonk /
//     the mailer), the caller invokes Service.RenderBody with the
//     campaign body, the recipient's locale, and the tenant id. We:
//
//     a) Mask dictionary terms with sentinel tokens so the LLM
//     never sees them — eliminates the "Moosewave -> Pôtevague"
//     failure mode.
//     b) Hash the masked body. Cache lookup against
//     campaign_translation_cache (tenant, hash, locale).
//     c) On cache miss, fan out to the voice service AI gateway
//     with a "translate to <locale>" prompt.
//     d) Unmask the sentinels back to the original terms (or to
//     the per-locale override if one exists for this term +
//     locale).
//     e) Persist the masked translation into the cache so the next
//     same-body / same-locale render is a cheap DB read.
//
//  3. CSV import / export over POST/GET /api/v1/translations/dictionary
//     lets operations push N hundred terms from a spreadsheet without
//     hand-entering them in the UI.
//
// All routes are tenant-scoped via apikeys.RequireScope; the dictionary
// surface uses ScopeWriteCampaigns to write (it affects campaign
// content) and ScopeReadCampaigns to read. Settings use ScopeAdmin to
// flip the killswitch because enabling routes every send through the
// LLM gateway — that's a billing-impacting choice.
package translations

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Sentinels for the mask/unmask pass. We use a printable but extremely
// unlikely string ("[[PWMASK_N]]" with double square brackets) so the
// LLM, when given the body, sees something visually distinguishable as
// a placeholder and is far more likely to leave it untouched. The
// unmask pass is the belt-and-braces enforcement that doesn't trust
// the LLM honored that instruction. We also reject the sentinel
// prefix on the way IN (validateTerm) so an attacker can't pre-inject
// a sentinel into a dictionary entry and force the unmask pass to
// substitute arbitrary text into the LLM output.
const (
	sentinelOpen  = "[[PWMASK"
	sentinelClose = "]]"
)

// ErrTranslationDisabled is returned when the tenant has translations
// turned off in settings. Callers (e.g. the campaign render path) should
// treat this as "fall back to the original body, no translation needed".
var ErrTranslationDisabled = errors.New("translations: disabled for tenant")

// ErrInvalidLocale is returned for a locale value that fails the
// rudimentary BCP-47-ish check (length, alphanumeric/hyphen).
var ErrInvalidLocale = errors.New("translations: invalid locale")

// AIGateway is the narrow surface the translator uses against the voice
// service. The default implementation is a small HTTP client that calls
// /v1/voice/translate; tests pass a fake.
//
// Kept as an interface (not the concrete aicompose.HTTPVoiceClient) so
// we can fake it in unit tests and so the voice service can grow new
// kinds without dragging this package into a rebuild.
type AIGateway interface {
	// Translate asks the gateway to translate `body` to `targetLocale`
	// without modifying any text inside sentinel pairs (the gateway is
	// instructed to preserve them verbatim — the post-processing step
	// here un-masks them whether or not the LLM honored the instruction).
	Translate(ctx context.Context, tenantID string, body string, targetLocale string) (string, error)
}

// HTTPAIGateway is the production AIGateway that wraps the same voice
// service aicompose uses. Reuses aicompose's auth / timeout / rate-limit
// posture by delegating to its underlying client transparently.
type HTTPAIGateway struct {
	Voice aicompose.VoiceClient
}

// Translate fans the body out to the voice service as a free-form chat
// with a translation prompt. The prompt explicitly instructs the model
// to leave any [[PWMASK_N]] sentinels untouched — the unmask
// pass below is the belt-and-braces enforcement.
func (g *HTTPAIGateway) Translate(ctx context.Context, tenantID, body, targetLocale string) (string, error) {
	if g == nil || g.Voice == nil {
		return "", aicompose.ErrVoiceUnavailable
	}
	prompt := fmt.Sprintf(
		"Translate the email content below into %s. Preserve HTML structure exactly. "+
			"Any token of the form [[PWMASK_<digits>]] is a placeholder for a brand "+
			"or trademark term — leave it untouched character-for-character. Do not add "+
			"commentary; return only the translated body.",
		targetLocale,
	)
	out, err := g.Voice.Generate(ctx, tenantID, aicompose.KindFreeForm, prompt, body)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out.Text) == "" {
		return "", fmt.Errorf("translations: gateway returned empty body")
	}
	return out.Text, nil
}

// Settings is the per-tenant configuration row.
type Settings struct {
	TenantID         string    `json:"tenant_id"`
	Enabled          bool      `json:"enabled"`
	DefaultLocale    string    `json:"default_locale"`
	SupportedLocales []string  `json:"supported_locales"`
	FallbackStrategy string    `json:"fallback_strategy"`
	LocaleAttribute  string    `json:"locale_attribute"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// DictionaryEntry is one term in the no-translate / per-locale-override
// list.
type DictionaryEntry struct {
	ID            string            `json:"id"`
	Term          string            `json:"term"`
	Translations  map[string]string `json:"translations"`
	CaseSensitive bool              `json:"case_sensitive"`
	Notes         string            `json:"notes,omitempty"`
	UpdatedAt     time.Time         `json:"updated_at"`
}

// Deps bundles collaborators. AI may be nil — RenderBody then errors
// with ErrVoiceUnavailable on every call, which is the correct behavior
// when the voice service isn't deployed.
type Deps struct {
	Pool   *db.Pool
	AI     AIGateway
	Logger *slog.Logger
}

// Service is the entry point for both HTTP handlers and the render-time
// integration in the campaign send path. Construct via New.
type Service struct {
	deps *Deps
}

// New constructs a Service. Returns nil if deps is nil or pool missing —
// callers must handle that (we do not panic on bad wiring; main.go
// already skips Mount* when deps is nil).
func New(d *Deps) *Service {
	if d == nil || d.Pool == nil {
		return nil
	}
	return &Service{deps: d}
}

// MountRoutes wires all HTTP endpoints under /api/v1/translations.
//
//	GET    /settings                 — read-only inspection
//	PUT    /settings                 — admin-only toggle + locale set
//	GET    /dictionary               — list entries
//	POST   /dictionary               — create or upsert one entry
//	DELETE /dictionary/{id}          — remove one entry
//	POST   /dictionary/import        — bulk CSV import
//	GET    /dictionary/export.csv    — bulk CSV export
//	POST   /preview                  — render-time dry run (returns the
//	                                   would-be translated body without
//	                                   touching the cache or sending)
func MountRoutes(r chi.Router, d *Deps) {
	svc := New(d)
	if svc == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/translations/settings", svc.getSettings)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/translations/settings", svc.putSettings)

	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/translations/dictionary", svc.listDictionary)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/translations/dictionary", svc.upsertDictionaryEntry)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/translations/dictionary/{id}", svc.deleteDictionaryEntry)

	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/translations/dictionary/import", svc.importCSV)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/translations/dictionary/export.csv", svc.exportCSV)

	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/translations/preview", svc.previewRender)
}

/* ---------- Settings -------------------------------------------- */

func (s *Service) getSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	settings, err := s.LoadSettings(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

type putSettingsInput struct {
	Enabled          *bool    `json:"enabled,omitempty"`
	DefaultLocale    *string  `json:"default_locale,omitempty"`
	SupportedLocales []string `json:"supported_locales,omitempty"`
	FallbackStrategy *string  `json:"fallback_strategy,omitempty"`
	LocaleAttribute  *string  `json:"locale_attribute,omitempty"`
}

func (s *Service) putSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in putSettingsInput
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	cur, err := s.LoadSettings(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if in.Enabled != nil {
		cur.Enabled = *in.Enabled
	}
	if in.DefaultLocale != nil {
		loc := strings.TrimSpace(*in.DefaultLocale)
		if err := validateLocale(loc); err != nil {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		cur.DefaultLocale = loc
	}
	if in.SupportedLocales != nil {
		out := make([]string, 0, len(in.SupportedLocales))
		seen := map[string]bool{}
		for _, l := range in.SupportedLocales {
			l = strings.TrimSpace(l)
			if l == "" || seen[l] {
				continue
			}
			if err := validateLocale(l); err != nil {
				httperror.WriteValidation(w, "validation_failed", err.Error())
				return
			}
			seen[l] = true
			out = append(out, l)
		}
		if len(out) == 0 {
			out = []string{cur.DefaultLocale}
		}
		cur.SupportedLocales = out
	}
	if in.FallbackStrategy != nil {
		switch *in.FallbackStrategy {
		case "subscriber_locale", "default_only":
			cur.FallbackStrategy = *in.FallbackStrategy
		default:
			writeErr(w, http.StatusBadRequest, "bad_fallback",
				"fallback_strategy must be subscriber_locale or default_only")
			return
		}
	}
	if in.LocaleAttribute != nil {
		la := strings.TrimSpace(*in.LocaleAttribute)
		if la == "" || len(la) > 64 {
			writeErr(w, http.StatusBadRequest, "bad_attribute",
				"locale_attribute must be 1..64 chars")
			return
		}
		cur.LocaleAttribute = la
	}
	if err := s.saveSettings(r.Context(), t.ID, cur); err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

// LoadSettings reads (or seeds the default) settings row for a tenant.
// Exposed for the campaign send-time hook so it can decide whether to
// route through the translator at all.
func (s *Service) LoadSettings(ctx context.Context, tenantID string) (Settings, error) {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return Settings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := Settings{TenantID: tenantID}
	err = tx.QueryRow(ctx, `
		SELECT enabled, default_locale, supported_locales, fallback_strategy,
		       locale_attribute, updated_at
		  FROM tenant_translation_settings
		 WHERE tenant_id = $1`, tenantID).
		Scan(&out.Enabled, &out.DefaultLocale, &out.SupportedLocales,
			&out.FallbackStrategy, &out.LocaleAttribute, &out.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Defaults match the migration DEFAULTs so a tenant that
			// has never opened the settings page still gets sensible
			// values from this method.
			out.Enabled = false
			out.DefaultLocale = "en"
			out.SupportedLocales = []string{"en"}
			out.FallbackStrategy = "subscriber_locale"
			out.LocaleAttribute = "language"
			out.UpdatedAt = time.Time{}
			return out, nil
		}
		return Settings{}, err
	}
	return out, nil
}

func (s *Service) saveSettings(ctx context.Context, tenantID string, in Settings) error {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO tenant_translation_settings
		  (tenant_id, enabled, default_locale, supported_locales,
		   fallback_strategy, locale_attribute, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (tenant_id) DO UPDATE SET
		  enabled            = EXCLUDED.enabled,
		  default_locale     = EXCLUDED.default_locale,
		  supported_locales  = EXCLUDED.supported_locales,
		  fallback_strategy  = EXCLUDED.fallback_strategy,
		  locale_attribute   = EXCLUDED.locale_attribute,
		  updated_at         = now()`,
		tenantID, in.Enabled, in.DefaultLocale, in.SupportedLocales,
		in.FallbackStrategy, in.LocaleAttribute)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ---------- Dictionary CRUD ------------------------------------- */

func (s *Service) listDictionary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	entries, err := s.LoadDictionary(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

type upsertEntryInput struct {
	Term          string            `json:"term"`
	Translations  map[string]string `json:"translations"`
	CaseSensitive bool              `json:"case_sensitive"`
	Notes         string            `json:"notes"`
}

func (s *Service) upsertDictionaryEntry(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in upsertEntryInput
	if err := httpbody.DecodeJSON(w, r, 64<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if err := validateTerm(in.Term); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	for loc := range in.Translations {
		if err := validateLocale(loc); err != nil {
			httperror.WriteValidation(w, "validation_failed",
				fmt.Sprintf("translations key %q: %s", loc, err.Error()))
			return
		}
	}
	entry, err := s.upsertEntry(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Service) deleteDictionaryEntry(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "bad_id", "id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), s.deps.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM tenant_translation_dictionary WHERE id = $1`, id)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "entry not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// LoadDictionary returns all entries for a tenant, ordered by term
// (case-insensitive) so the UI sees a stable list and the masker can
// iterate longest-first for substring safety.
func (s *Service) LoadDictionary(ctx context.Context, tenantID string) ([]DictionaryEntry, error) {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, term, translations, case_sensitive, COALESCE(notes,''),
		       updated_at
		  FROM tenant_translation_dictionary
		 WHERE tenant_id = $1
		 ORDER BY lower(term)`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DictionaryEntry, 0, 32)
	for rows.Next() {
		var e DictionaryEntry
		var translationsRaw []byte
		if err := rows.Scan(&e.ID, &e.Term, &translationsRaw, &e.CaseSensitive,
			&e.Notes, &e.UpdatedAt); err != nil {
			return nil, err
		}
		if len(translationsRaw) > 0 {
			if err := json.Unmarshal(translationsRaw, &e.Translations); err != nil {
				return nil, fmt.Errorf("decode translations for %s: %w", e.ID, err)
			}
		}
		if e.Translations == nil {
			e.Translations = map[string]string{}
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) upsertEntry(ctx context.Context, tenantID string, in upsertEntryInput) (DictionaryEntry, error) {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return DictionaryEntry{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	translationsJSON, err := json.Marshal(in.Translations)
	if err != nil {
		return DictionaryEntry{}, fmt.Errorf("encode translations: %w", err)
	}
	var out DictionaryEntry
	var resultJSON []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO tenant_translation_dictionary
		  (tenant_id, term, translations, case_sensitive, notes, updated_at)
		VALUES ($1, $2, $3, $4, NULLIF($5,''), now())
		ON CONFLICT (tenant_id, term) DO UPDATE SET
		  translations    = EXCLUDED.translations,
		  case_sensitive  = EXCLUDED.case_sensitive,
		  notes           = EXCLUDED.notes,
		  updated_at      = now()
		RETURNING id::text, term, translations, case_sensitive, COALESCE(notes,''), updated_at`,
		tenantID, in.Term, string(translationsJSON), in.CaseSensitive, in.Notes,
	).Scan(&out.ID, &out.Term, &resultJSON, &out.CaseSensitive, &out.Notes, &out.UpdatedAt)
	if err != nil {
		return DictionaryEntry{}, err
	}
	if len(resultJSON) > 0 {
		if err := json.Unmarshal(resultJSON, &out.Translations); err != nil {
			return DictionaryEntry{}, err
		}
	}
	if out.Translations == nil {
		out.Translations = map[string]string{}
	}
	if err := tx.Commit(ctx); err != nil {
		return DictionaryEntry{}, err
	}
	return out, nil
}

/* ---------- CSV import / export --------------------------------- */
//
// CSV column convention (header row REQUIRED):
//
//	term,case_sensitive,notes,<locale>,<locale>,<locale>,...
//
// Example:
//
//	term,case_sensitive,notes,fr,de,es
//	Moosewave,true,brand,,,
//	Pro plan,false,product tier,plan Pro,Pro-Plan,plan Pro
//
// An empty locale cell means "no override; leave the term untouched in
// this locale". The masker pass already accomplishes that for *every*
// locale by default — the per-locale columns only matter when the
// operator WANTS a localized override.

const (
	csvMaxBytes          = 5 << 20                 // 5 MiB file/body payload
	csvMultipartMaxBytes = csvMaxBytes + (1 << 20) // bounded MIME framing allowance
)

// ImportResult reports the per-row outcome of a CSV import. Exported so
// the desktop client and tests can consume it as a typed value.
type ImportResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

func (s *Service) importCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Accept either raw text/csv or multipart with field name 'file'. Both
	// paths have an exact transport quota; multipart framing gets a separate
	// bounded allowance while the uploaded file remains capped at 5 MiB.
	var body io.Reader
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil {
		httperror.Write(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be text/csv or multipart/form-data")
		return
	}
	switch mediaType {
	case "multipart/form-data":
		r.Body = http.MaxBytesReader(w, r.Body, csvMultipartMaxBytes)
		if err := r.ParseMultipartForm(csvMaxBytes); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				httpbody.WriteError(w, httpbody.ErrTooLarge)
				return
			}
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		f, header, err := r.FormFile("file")
		if err != nil {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		defer func() { _ = f.Close() }()
		if header.Size > csvMaxBytes {
			httpbody.WriteError(w, httpbody.ErrTooLarge)
			return
		}
		body = f
	case "text/csv", "application/csv":
		if r.ContentLength > csvMaxBytes {
			httpbody.WriteError(w, httpbody.ErrTooLarge)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, csvMaxBytes)
		body = r.Body
	default:
		httperror.Write(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be text/csv or multipart/form-data")
		return
	}

	res, err := s.ImportCSV(r.Context(), t.ID, body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httpbody.WriteError(w, httpbody.ErrTooLarge)
			return
		}
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ImportCSV parses a CSV stream and upserts the dictionary entries.
// Exported so a future CLI / SDK path can re-use the same parser.
func (s *Service) ImportCSV(ctx context.Context, tenantID string, r io.Reader) (ImportResult, error) {
	res := ImportResult{}
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // tolerate ragged rows; we validate per-row
	header, err := cr.Read()
	if err != nil {
		return res, fmt.Errorf("read header: %w", err)
	}
	idxTerm := -1
	idxCase := -1
	idxNotes := -1
	localeCols := map[int]string{}
	for i, h := range header {
		switch strings.TrimSpace(strings.ToLower(h)) {
		case "term":
			idxTerm = i
		case "case_sensitive":
			idxCase = i
		case "notes":
			idxNotes = i
		case "":
			// ignore stray blank header
		default:
			loc := strings.TrimSpace(h)
			if err := validateLocale(loc); err == nil {
				localeCols[i] = loc
			} else {
				res.Errors = append(res.Errors,
					fmt.Sprintf("unknown header column %q (skipped)", h))
			}
		}
	}
	if idxTerm < 0 {
		return res, fmt.Errorf("missing required `term` column")
	}

	for {
		row, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("row read: %s", err.Error()))
			continue
		}
		if idxTerm >= len(row) {
			res.Skipped++
			continue
		}
		term := strings.TrimSpace(row[idxTerm])
		if term == "" {
			res.Skipped++
			continue
		}
		if err := validateTerm(term); err != nil {
			res.Errors = append(res.Errors,
				fmt.Sprintf("row %q: %s", term, err.Error()))
			res.Skipped++
			continue
		}
		caseSensitive := false
		if idxCase >= 0 && idxCase < len(row) {
			switch strings.ToLower(strings.TrimSpace(row[idxCase])) {
			case "true", "1", "yes", "y":
				caseSensitive = true
			}
		}
		notes := ""
		if idxNotes >= 0 && idxNotes < len(row) {
			notes = strings.TrimSpace(row[idxNotes])
		}
		translations := map[string]string{}
		for col, loc := range localeCols {
			if col >= len(row) {
				continue
			}
			val := strings.TrimSpace(row[col])
			if val == "" {
				// Treat empty as "no override" — same as missing column.
				continue
			}
			translations[loc] = val
		}
		if _, err := s.upsertEntry(ctx, tenantID, upsertEntryInput{
			Term:          term,
			Translations:  translations,
			CaseSensitive: caseSensitive,
			Notes:         notes,
		}); err != nil {
			res.Errors = append(res.Errors,
				fmt.Sprintf("row %q: %s", term, err.Error()))
			res.Skipped++
			continue
		}
		res.Imported++
	}
	return res, nil
}

func (s *Service) exportCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	entries, err := s.LoadDictionary(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, s.deps.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Discover every locale ever used so we emit one column per locale.
	localeSet := map[string]bool{}
	for _, e := range entries {
		for loc := range e.Translations {
			localeSet[loc] = true
		}
	}
	locales := make([]string, 0, len(localeSet))
	for l := range localeSet {
		locales = append(locales, l)
	}
	sort.Strings(locales)

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="translation-dictionary.csv"`)
	cw := csv.NewWriter(w)
	defer cw.Flush()
	header := append([]string{"term", "case_sensitive", "notes"}, locales...)
	_ = cw.Write(header)
	for _, e := range entries {
		row := []string{e.Term, fmt.Sprintf("%t", e.CaseSensitive), e.Notes}
		for _, l := range locales {
			row = append(row, e.Translations[l])
		}
		_ = cw.Write(row)
	}
}

/* ---------- Render-time hook ------------------------------------ */

// RenderResult is what RenderBody returns; the campaign send path uses
// CacheHit to decide whether to log a billing event for the LLM call.
type RenderResult struct {
	Body              string `json:"body"`
	Locale            string `json:"locale"`
	CacheHit          bool   `json:"cache_hit"`
	DictionaryMatches int    `json:"dictionary_matches"`
	// Skipped is true when the tenant has translations disabled OR the
	// locale equals the default locale (no work needed). The caller
	// can short-circuit on this without inspecting cache_hit.
	Skipped bool `json:"skipped"`
}

// RenderBody is the public render-time entry point. The campaign send
// loop should call this once per (campaign, recipient_locale) pair —
// the cache makes repeated calls cheap.
//
// The contract:
//
//   - If the tenant has disabled translations OR locale == default
//     locale OR locale is not in supported_locales, returns
//     RenderResult{Body: body, Skipped: true} and no DB writes happen.
//   - Otherwise produces the translated body, persists to the cache,
//     and returns RenderResult with the translated body + CacheHit
//     flag.
//   - On AI gateway failure the original body is returned with
//     Skipped=true and the error — callers must decide whether to
//     surface the error to the user or silently fall back.
func (s *Service) RenderBody(ctx context.Context, tenantID, body, locale string) (RenderResult, error) {
	if s == nil {
		return RenderResult{Body: body, Skipped: true}, nil
	}
	locale = strings.TrimSpace(locale)
	if locale == "" {
		return RenderResult{Body: body, Skipped: true}, nil
	}
	settings, err := s.LoadSettings(ctx, tenantID)
	if err != nil {
		return RenderResult{Body: body, Skipped: true}, err
	}
	if !settings.Enabled {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, ErrTranslationDisabled
	}
	if settings.FallbackStrategy == "default_only" {
		// Killswitch — every recipient sees default_locale, no LLM call.
		return RenderResult{Body: body, Skipped: true, Locale: settings.DefaultLocale}, nil
	}
	if locale == settings.DefaultLocale {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, nil
	}
	if !contains(settings.SupportedLocales, locale) {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, nil
	}

	// Mask dictionary terms in the body before hashing / cache lookup /
	// translation, so the LLM never sees them. We then unmask at the end,
	// applying any per-locale overrides from the dictionary row.
	dict, err := s.LoadDictionary(ctx, tenantID)
	if err != nil {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, err
	}
	masked, masks := maskTerms(body, dict)
	hash := hashBody(masked)

	if cached, ok, err := s.lookupCache(ctx, tenantID, hash, locale); err != nil {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, err
	} else if ok {
		// Unmask the cached masked-translation so per-locale overrides
		// (which may have changed since the cache was written) are
		// applied fresh. The cache stores the MASKED translated body,
		// not the final body, to make this cheap.
		return RenderResult{
			Body:              unmaskTerms(cached, masks, locale),
			Locale:            locale,
			CacheHit:          true,
			DictionaryMatches: len(masks),
		}, nil
	}

	if s.deps.AI == nil {
		// Translation requested but no gateway wired. Return the original
		// body — preferable to a 500 in the send hot path.
		return RenderResult{Body: body, Skipped: true, Locale: locale},
			aicompose.ErrVoiceUnavailable
	}

	translatedMasked, err := s.deps.AI.Translate(ctx, tenantID, masked, locale)
	if err != nil {
		return RenderResult{Body: body, Skipped: true, Locale: locale}, err
	}
	if err := s.storeCache(ctx, tenantID, hash, locale, translatedMasked); err != nil {
		// Cache failure is non-fatal — the translation succeeded.
		// Swallow rather than fail the render hot path.
		_ = err
	}
	return RenderResult{
		Body:              unmaskTerms(translatedMasked, masks, locale),
		Locale:            locale,
		CacheHit:          false,
		DictionaryMatches: len(masks),
	}, nil
}

func (s *Service) lookupCache(ctx context.Context, tenantID, hash, locale string) (string, bool, error) {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var body string
	err = tx.QueryRow(ctx, `
		SELECT translated_body
		  FROM campaign_translation_cache
		 WHERE tenant_id = $1 AND body_hash = $2 AND locale = $3`,
		tenantID, hash, locale).Scan(&body)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return body, true, nil
}

func (s *Service) storeCache(ctx context.Context, tenantID, hash, locale, translated string) error {
	tx, err := db.WithTenant(ctx, s.deps.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO campaign_translation_cache
		  (tenant_id, body_hash, locale, translated_body, dictionary_version, created_at)
		VALUES ($1, $2, $3, $4, 0, now())
		ON CONFLICT (tenant_id, body_hash, locale) DO UPDATE SET
		  translated_body = EXCLUDED.translated_body,
		  created_at      = now()`,
		tenantID, hash, locale, translated)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ---------- Preview endpoint ------------------------------------ */

type previewInput struct {
	Body   string `json:"body"`
	Locale string `json:"locale"`
}

func (s *Service) previewRender(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in previewInput
	if err := httpbody.DecodeJSON(w, r, 1<<20, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if strings.TrimSpace(in.Body) == "" {
		writeErr(w, http.StatusBadRequest, "bad_body", "body required")
		return
	}
	if err := validateLocale(in.Locale); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	res, err := s.RenderBody(r.Context(), t.ID, in.Body, in.Locale)
	if err != nil && !errors.Is(err, ErrTranslationDisabled) {
		// Surface gateway failures as 502 so the desktop can show a
		// distinct "AI down" affordance vs. "you turned it off". The
		// raw provider error text is intentionally NOT echoed to the
		// client — it can leak LLM provider implementation details.
		if s.deps.Logger != nil {
			s.deps.Logger.LogAttrs(r.Context(), slog.LevelError,
				"translations.preview_failed",
				slog.String("tenant_id", t.ID),
				slog.String("err", err.Error()))
		}
		httperror.Write(w, http.StatusBadGateway, "translate_failed",
			"translation gateway unavailable")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

/* ---------- mask / unmask --------------------------------------- */

type maskRecord struct {
	original string
	entry    DictionaryEntry
}

// maskTerms walks the dictionary longest-first and replaces matched
// occurrences with sentinel tokens [[PWMASK_N]]. The returned slice is
// indexed by N so unmaskTerms can do an O(1) lookup. Longest-first
// prevents a short term like "Pro" eating a substring of "Pro plan".
//
// Case-insensitive entries match case-insensitively; the original cased
// surface form from the body is preserved in maskRecord.original so the
// unmask pass can put it back verbatim.
func maskTerms(body string, dict []DictionaryEntry) (string, []maskRecord) {
	sorted := append([]DictionaryEntry(nil), dict...)
	sort.Slice(sorted, func(i, j int) bool {
		return len(sorted[i].Term) > len(sorted[j].Term)
	})
	out := body
	var masks []maskRecord
	for _, e := range sorted {
		if e.Term == "" {
			continue
		}
		if e.CaseSensitive {
			if !strings.Contains(out, e.Term) {
				continue
			}
			masks = append(masks, maskRecord{original: e.Term, entry: e})
			sentinel := sentinelFor(len(masks) - 1)
			out = strings.ReplaceAll(out, e.Term, sentinel)
		} else {
			lowerOut := strings.ToLower(out)
			lowerTerm := strings.ToLower(e.Term)
			idx := strings.Index(lowerOut, lowerTerm)
			if idx < 0 {
				continue
			}
			// Capture the first cased surface form so we restore the
			// original casing on unmask. Multiple surface forms across
			// the body all collapse to this one — best-effort.
			origForm := out[idx : idx+len(e.Term)]
			masks = append(masks, maskRecord{original: origForm, entry: e})
			sentinel := sentinelFor(len(masks) - 1)
			// Manual scan-and-replace so we always advance past the
			// just-inserted sentinel.
			var b strings.Builder
			b.Grow(len(out))
			i := 0
			for {
				lower := strings.ToLower(out[i:])
				rel := strings.Index(lower, lowerTerm)
				if rel < 0 {
					b.WriteString(out[i:])
					break
				}
				b.WriteString(out[i : i+rel])
				b.WriteString(sentinel)
				i += rel + len(e.Term)
			}
			out = b.String()
		}
	}
	return out, masks
}

// unmaskTerms restores sentinels to their final string per the target
// locale: an explicit override in entry.Translations[locale] wins,
// otherwise the original (un-translated) term goes back in.
func unmaskTerms(body string, masks []maskRecord, locale string) string {
	for i, m := range masks {
		replacement := m.original
		if m.entry.Translations != nil {
			if override, ok := m.entry.Translations[locale]; ok && override != "" {
				replacement = override
			}
		}
		body = strings.ReplaceAll(body, sentinelFor(i), replacement)
	}
	return body
}

func sentinelFor(n int) string {
	return fmt.Sprintf("%s_%d%s", sentinelOpen, n, sentinelClose)
}

// hashBody returns the sha256 hex of the (masked) body. The cache uses
// this as part of its primary key so a dictionary edit that changes the
// masked output invalidates the cache organically.
func hashBody(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

/* ---------- helpers --------------------------------------------- */

// validateLocale is a rudimentary BCP-47-ish check: 2..16 chars, only
// alphanumerics and hyphens/underscores. We deliberately don't pull in
// a full BCP-47 parser because the locale is operator-supplied;
// rejecting "pirate" is not our job, only rejecting injection attempts.
func validateLocale(loc string) error {
	if len(loc) < 2 || len(loc) > 16 {
		return fmt.Errorf("%w: %q (must be 2..16 chars)", ErrInvalidLocale, loc)
	}
	for _, r := range loc {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return fmt.Errorf("%w: %q (only alphanumerics + - _ allowed)", ErrInvalidLocale, loc)
		}
	}
	return nil
}

// validateTerm rejects empty/oversized terms, terms with control chars,
// and terms that contain the sentinel prefix (which would let a
// malicious operator inject text into the LLM round-trip).
func validateTerm(term string) error {
	t := strings.TrimSpace(term)
	if len(t) == 0 || len(t) > 256 {
		return fmt.Errorf("term must be 1..256 chars")
	}
	if strings.Contains(t, sentinelOpen) || strings.Contains(t, sentinelClose) {
		return fmt.Errorf("term contains reserved sentinel marker")
	}
	for _, r := range t {
		if r < 0x20 && r != '\t' {
			return fmt.Errorf("term contains control character")
		}
	}
	return nil
}

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
