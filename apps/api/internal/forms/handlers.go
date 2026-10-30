package forms

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Deps bundles the dependencies the form handlers need so main.go can wire
// them with one struct literal.
type Deps struct {
	Repo *Repo
	// SubmissionPages defaults to Repo and exists as a narrow read boundary for
	// full-history exports. Keeping the exporter on this interface lets alternate
	// stores preserve the same fail-closed pagination contract.
	SubmissionPages SubmissionPageReader
	// PublicHostBase is the hosted form origin (FORMS_PUBLIC_HOST). Confirmation
	// links and redirects are built on it, and a submission whose browser
	// origin is another host is recorded as an embedded form.
	PublicHostBase string
	// ConfirmationMailer sends the double opt-in confirmation email through
	// the product's outbound mailer (see DeliverConfirmation for who it is
	// sent from). Without it a double opt-in submission is recorded and stays
	// pending, the outbox retries the email, and the admin resend answers 503.
	ConfirmationMailer mailer.Mailer
	// ConfirmationFrom is the standard sender, used when a form names no
	// sender on a domain its workspace verified (FORMS_CONFIRMATION_FROM). It
	// must be an address kept for form confirmations, never the account-mail
	// sender. Empty: only a verified workspace sender may send.
	ConfirmationFrom string
	// SenderVerifier checks a form's own sender against the workspace's
	// verified sending identities, as the transactional API does.
	SenderVerifier SenderDomainVerifier
	// RecipientGuard refuses an address that bounced, complained, or was
	// erased. Required: without it no confirmation email is sent.
	RecipientGuard ConfirmationRecipientGuard
	// StandardSenderHourlyLimit caps the confirmation emails a workspace may
	// send through ConfirmationFrom in an hour; zero means the default.
	StandardSenderHourlyLimit int
	RecaptchaSecret           string // optional; empty disables verification
	RecaptchaSiteKey          string // public v2 checkbox key; verification requires both keys
	TrustForwardedIPHeaders   bool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
	// SignupGate, when set, runs email verification on the public
	// submit path. nil disables it entirely — see verification_gate.go
	// for why every failure mode admits the submission.
	SignupGate SignupGate
	// Outbox receives the durable audience intents: OutboxKindRecordSignup in
	// the submission's transaction and OutboxKindEnableListmonk in the
	// confirmation's. SignupAudience handles both. Required: without it a
	// submission or confirmation is recorded but never reaches the audience,
	// and each such request logs an error saying so.
	Outbox OutboxAppender
	// Webhooks, when set, fires form.submitted / form.confirmed events
	// for tenant subscriptions. Nil = no events fired (legacy / dev).
	// We expose this as a separate sink (not Outbox) because submit
	// events fire OUTSIDE the InsertSubmission tx — the row is already
	// committed by the time we'd want to fan out, so weak-atomicity is
	// fine and avoids invasive refactors of every submit handler.
	Webhooks WebhookFanoutAppender
	// Uploads, when set, lets the submit handler attach previously-
	// presigned file_upload field values (UUIDs) to the new submission
	// row by flipping form_file_uploads.submission_id. Nil disables
	// file-upload linking; the form still submits but uploaded files
	// remain orphaned (and sweepable later).
	Uploads *Uploads
}

type SubmissionPageReader interface {
	ListSubmissions(context.Context, string, string, int, pagination.Cursor) ([]Submission, string, error)
}

const (
	formAdminJSONMaxBodyBytes    int64 = 256 << 10 // 256 KiB
	formPublicSubmitMaxBodyBytes int64 = 512 << 10 // 512 KiB
	recaptchaMaxResponseBytes    int64 = 64 << 10  // 64 KiB
	recaptchaVerifyTimeout             = 5 * time.Second

	maxSubmitCustomFields          = 100
	maxSubmitCustomFieldKeyBytes   = 80
	maxSubmitCustomFieldValueBytes = 8 << 10 // 8 KiB per field
	maxSubmitNameBytes             = 200
	maxSubmitConsentBytes          = 2 << 10
	maxSubmitCaptchaTokenBytes     = 4 << 10
	maxSubmitHoneypotBytes         = 512
	maxSubmitAttemptIDBytes        = 128
)

var (
	recaptchaVerifyURL = "https://www.google.com/recaptcha/api/siteverify"
	recaptchaHTTP      = http.DefaultClient
)

// WebhookFanoutAppender is a tx-less alternative to OutboxAppender for
// "best-effort fan out an event after the business write committed".
// Implementation in main.go opens its own outbox tx.
type WebhookFanoutAppender interface {
	AppendFanout(ctx context.Context, tenantID, eventType string, body any) error
}

// ---------- admin (tenant-scoped) ----------

// List GET /api/v1/forms?q=
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Accept ?query= (desktop UI canonical) and ?q= (legacy clients).
	q := listsearch.ReadQuery(r.URL.Query())
	forms, err := d.Repo.List(r.Context(), t.ID, q)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, forms)
}

// Create POST /api/v1/forms
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, formAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Slug = strings.TrimSpace(in.Slug)
	in.Name = strings.TrimSpace(in.Name)
	if in.Slug == "" || in.Name == "" {
		httperror.WriteValidation(w, "missing_fields", "name + slug required")
		return
	}
	if err := validateSlug(in.Slug); err != nil {
		httperror.WriteValidation(w, "invalid_slug", err.Error())
		return
	}
	if len(in.Name) > MaxFormNameLength {
		httperror.WriteValidation(w, "invalid_name",
			fmt.Sprintf("name must be %d characters or fewer", MaxFormNameLength))
		return
	}
	if in.OptInMode != OptInSingle && in.OptInMode != OptInDouble {
		httperror.WriteValidation(w, "bad_optin", "optInMode must be single|double")
		return
	}
	structure := defaultStructure()
	settings := map[string]any{
		"successMessage": in.SuccessMessage,
	}
	if in.SuccessRedirectURL != "" {
		if err := validateSuccessRedirectURL(in.SuccessRedirectURL); err != nil {
			httperror.WriteValidation(w, "invalid_success_redirect", err.Error())
			return
		}
		settings["successRedirectUrl"] = in.SuccessRedirectURL
	}
	f, err := d.Repo.Create(r.Context(), t.ID, in, structure, settings)
	if err != nil {
		if errors.Is(err, ErrSlugConflict) {
			httperror.Write(w, http.StatusConflict, "slug_taken", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// FORM-038: record the create so the form's activity timeline has a start.
	audit.EmitOrLog(r.Context(), d.Repo.Pool, "form.create", "form", f.ID, nil, f, nil)
	w.Header().Set("ETag", httpcache.ConcurrencyToken("form", f.ID, f.UpdatedAt))
	writeJSON(w, http.StatusCreated, f)
}

// Get GET /api/v1/forms/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	f, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such form")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("form", f.ID, f.UpdatedAt))
	writeJSON(w, http.StatusOK, f)
}

// Update PATCH /api/v1/forms/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, formAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Settings != nil {
		if _, err := listIDsFromSettings(*in.Settings); err != nil {
			httperror.WriteValidation(w, "invalid_target_list", err.Error())
			return
		}
		if v, ok := (*in.Settings)["successRedirectUrl"]; ok {
			redirect, _ := v.(string)
			if err := validateSuccessRedirectURL(redirect); err != nil {
				httperror.WriteValidation(w, "invalid_success_redirect", err.Error())
				return
			}
		}
	}
	if in.Slug != nil {
		slug := strings.TrimSpace(*in.Slug)
		if err := validateSlug(slug); err != nil {
			httperror.WriteValidation(w, "invalid_slug", err.Error())
			return
		}
		in.Slug = &slug
	}
	if in.Structure != nil {
		if err := validateRequiredEmailField(*in.Structure); err != nil {
			httperror.WriteValidation(w, "invalid_structure", err.Error())
			return
		}
	}
	// `If-Match: *` means "only if this resource exists" — an explicitly
	// CONDITIONAL request. Discarding the wildcard bool made it an
	// unconditional write returning 200: the caller believes it sent a
	// precondition and got last-writer-wins. Refused instead, because silently
	// weakening a caller's stated intent is worse than rejecting a header shape
	// this resource does not support.
	if tok, present, wildcard := httpcache.ParseIfMatch(r); present {
		if wildcard {
			httpcache.WritePreconditionFailed(w)
			return
		}
		in.IfMatchToken = tok
	}
	// FORM-038: capture the pre-image so the activity timeline records status
	// transitions (publish/unpublish) and edits with before/after. Best-effort
	// — a failed read just yields a nil before-state, never blocks the update.
	before, _ := d.Repo.Get(r.Context(), t.ID, id)
	f, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		d.writeFormUpdateError(w, r, err)
		return
	}
	audit.EmitOrLog(r.Context(), d.Repo.Pool, "form.update", "form", f.ID, before, f, nil)
	w.Header().Set("ETag", httpcache.ConcurrencyToken("form", f.ID, f.UpdatedAt))
	writeJSON(w, http.StatusOK, f)
}

func (d *Deps) writeFormUpdateError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "no such form")
	case errors.Is(err, ErrPublicSlugConflict):
		httperror.Write(w, http.StatusConflict, "public_slug_taken",
			"That hosted form URL is already in use. Choose a different slug before publishing.")
	case errors.Is(err, ErrSlugConflict):
		httperror.Write(w, http.StatusConflict, "slug_taken", err.Error())
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrTargetListNotFound):
		httperror.WriteValidation(w, "invalid_target_list",
			"That list isn't available in this workspace. Choose one of your lists.")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

// Delete DELETE /api/v1/forms/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	ifMatchToken, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		ifMatchToken = ""
	}
	// FORM-038: capture the pre-image before the row is gone so the delete
	// event records what was removed.
	before, _ := d.Repo.Get(r.Context(), t.ID, id)
	if err := d.Repo.DeleteWithVersion(r.Context(), t.ID, id, ifMatchToken); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	audit.EmitOrLog(r.Context(), d.Repo.Pool, "form.delete", "form", id, before, nil, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListSubmissions GET /api/v1/forms/{id}/submissions
func (d *Deps) ListSubmissions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	// Keyset pagination; default page size preserves the prior LIMIT 1000 so
	// omitting ?limit= returns the same count as before (no regression). The
	// 1000 cap is passed as the max too so the default isn't clamped below it.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 1000, 1000)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	subs, next, err := d.Repo.ListSubmissions(r.Context(), t.ID, id, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// This endpoint historically returned a BARE JSON array, so adding a
	// top-level nextCursor field would break the response contract. Keep the
	// bare array and surface the keyset cursor in a response header instead —
	// pagination stays additive (clients that ignore the header are unaffected).
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	writeJSON(w, http.StatusOK, subs)
}

// SubmissionsCSV GET /api/v1/forms/{id}/submissions.csv
func (d *Deps) SubmissionsCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	pages := d.SubmissionPages
	if pages == nil {
		pages = d.Repo
	}
	if pages == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("form submission page reader is unavailable"), r.Context())
		return
	}
	// Fetch one bounded keyset page at a time. This keeps memory stable while
	// exporting the complete history instead of silently stopping at 1,000.
	subs, next, err := pages.ListSubmissions(r.Context(), t.ID, id, 1000, pagination.Cursor{})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="form-submissions.csv"`)
	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"id", "email", "status", "submitted_at", "confirmed_at", "ip", "user_agent", "custom_fields_json"}); err != nil {
		d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("write header: %w", err))
	}
	for {
		for _, s := range subs {
			cf, marshalErr := json.Marshal(s.CustomFields)
			if marshalErr != nil {
				d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("encode custom fields: %w", marshalErr))
			}
			ip := ""
			if s.IP != nil {
				ip = *s.IP
			}
			ua := ""
			if s.UserAgent != nil {
				ua = *s.UserAgent
			}
			conf := ""
			if s.ConfirmedAt != nil {
				conf = s.ConfirmedAt.Format(time.RFC3339)
			}
			if writeErr := cw.Write([]string{
				csvCell(s.ID),
				csvCell(s.Email),
				csvCell(string(s.Status)),
				s.SubmittedAt.Format(time.RFC3339),
				conf,
				csvCell(ip),
				csvCell(ua),
				csvCell(string(cf)),
			}); writeErr != nil {
				d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("write submission row: %w", writeErr))
			}
		}
		cw.Flush()
		if writeErr := cw.Error(); writeErr != nil {
			d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("flush submission rows: %w", writeErr))
		}
		if next == "" {
			return
		}
		cursor, decodeErr := pagination.Decode(next)
		if decodeErr != nil {
			d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("decode next cursor: %w", decodeErr))
		}
		subs, next, err = pages.ListSubmissions(r.Context(), t.ID, id, 1000, cursor)
		if err != nil {
			d.abortSubmissionsCSV(r.Context(), t.ID, id, fmt.Errorf("load next submission page: %w", err))
		}
	}
}

// abortSubmissionsCSV is used only after the CSV response may have committed.
// Returning normally would turn a truncated export into a plausible HTTP 200;
// net/http treats ErrAbortHandler as an intentional connection abort/reset and
// suppresses the usual panic stack, while the structured log retains the cause.
func (d *Deps) abortSubmissionsCSV(ctx context.Context, tenantID, formID string, err error) {
	if d.Logger != nil {
		d.Logger.LogAttrs(ctx, slog.LevelError, "forms.submissions_csv_aborted",
			slog.String("tenant_id", tenantID),
			slog.String("form_id", formID),
			slog.String("err", err.Error()),
		)
	}
	panic(http.ErrAbortHandler)
}

// Analytics GET /api/v1/forms/{id}/analytics?days=30
//
// A23 (desktop audit 2026-06-10): per-day hosted-form visits for one
// form, zero-filled over the trailing window (default 30 days, max
// 90), so the desktop can chart traffic next to the visit-weighted
// conversion the list payload's visits30d enables. Days are UTC
// buckets — the same bucketing RecordVisit writes.
//
// Response:
//
//	{
//	  "form_id":      "…",
//	  "days":         30,
//	  "visits":       [{"date":"YYYY-MM-DD","count":n}, …],
//	  "visits_total": n
//	}
func (d *Deps) Analytics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	days := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			httperror.Write(w, http.StatusBadRequest, "bad_days", "days must be a positive integer")
			return
		}
		days = n
	}
	if days > maxVisitWindowDays {
		days = maxVisitWindowDays
	}
	// 404 unknown ids explicitly — an empty zero-filled series would
	// otherwise be indistinguishable from a real never-visited form.
	if _, err := d.Repo.Get(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such form")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	visits, err := d.Repo.VisitsByDay(r.Context(), t.ID, id, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	total := 0
	for _, p := range visits {
		total += p.Count
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"form_id":      id,
		"days":         days,
		"visits":       visits,
		"visits_total": total,
	})
}

func csvCell(value string) string {
	visible := strings.TrimLeft(value, " \t\r\n")
	if visible == "" {
		return value
	}
	switch visible[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}

// ---------- public (no auth) ----------

// PublicGet GET /api/public/forms/{slug}
func (d *Deps) PublicGet(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	f, err := d.Repo.ByPublicSlug(r.Context(), slug)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		httperror.Write(w, http.StatusNotFound, "not_found", "no such form")
		return
	}
	d.recordRenderVisit(r, f)
	// FORM-034: per-form captcha config, falling back to the deployment keys.
	captchaRequired, siteKey := d.captchaConfig(f)
	writeJSON(w, http.StatusOK, map[string]any{
		"form":               publicFormFrom(f),
		"captcha_required":   captchaRequired,
		"recaptcha_site_key": siteKey,
	})
}

func publicFormFrom(f *Form) PublicForm {
	return PublicForm{
		Slug:      f.Slug,
		OptInMode: f.OptInMode,
		Structure: f.Structure,
		Settings: PublicSettings{
			SuccessMessage: stringFromSettings(f.Settings, "successMessage"),
			StyleClass:     stringFromSettings(f.Settings, "styleClass"),
		},
		Status: f.Status,
	}
}

// recordVisit bumps the form_visits daily counter (A23). Best-effort:
// a failed counter write must never break the public form render, so
// errors are logged and swallowed.
func (d *Deps) recordVisit(ctx context.Context, f *Form) {
	if f == nil {
		return
	}
	if err := d.Repo.RecordVisit(ctx, f.TenantID, f.ID); err != nil && d.Logger != nil {
		d.Logger.Warn("forms: record visit failed",
			"form_id", f.ID, "err", err)
	}
}

// PublicSubmit POST /api/public/forms/{slug}/submit
//
// Flow:
//  1. Look up the published form by slug.
//  2. Honeypot check on the `website` field — if filled, answer as for an
//     accepted signup so bots cannot tell.
//  3. Optional reCAPTCHA verification (env-gated).
//  4. Validate email is present + plausible, and the form's required fields.
//  5. Decide whether the visitor asked to subscribe (evaluateSignupConsent).
//  6. Write the submission, its consent evidence and the durable audience
//     intent (OutboxKindRecordSignup) in ONE transaction, with the form's
//     target lists resolved under its tenant. SignupAudience then writes the
//     subscriber, its consent and list memberships, and the Listmonk
//     projection; nothing on this path waits for Listmonk.
//  7. Double opt-in: mail the confirmation link through the outbound mailer.
//
// The response depends only on the form and on what the visitor sent — never
// on whether the address is already known — so a published form cannot be
// used to test addresses for membership.
func (d *Deps) PublicSubmit(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	form, err := d.Repo.ByPublicSlug(r.Context(), slug)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			d.writeSubmitError(w, r, nil, http.StatusInternalServerError, "submit_failed", "We could not process this form right now. Please try again.", err)
			return
		}
		d.writeSubmitError(w, r, nil, http.StatusNotFound, "not_found", "This form is no longer available.", nil)
		return
	}

	in, err := parseSubmitInput(w, r)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || httpbody.StatusCode(err) == http.StatusRequestEntityTooLarge {
			d.writeSubmitError(w, r, form, http.StatusRequestEntityTooLarge, "payload_too_large", "This submission is too large. Remove large values and try again.", nil)
			return
		}
		d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity, "bad_input", "Some submitted fields could not be read. Please review the form and try again.", nil)
		return
	}

	// (2) Honeypot — answered exactly as the same body without it would be,
	// so a bot cannot learn that it was caught.
	if strings.TrimSpace(in.Website) != "" {
		d.writeSubmitSuccess(w, r, form, submitResponseFor(form, evaluateSignupConsent(form, in)))
		return
	}
	if strings.TrimSpace(in.Consent) != "" {
		if _, valid := consentAction(in.Consent); !valid {
			d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity,
				"invalid_consent", "The consent selection is not recognized. Review it and try again.", nil)
			return
		}
	}

	// (3) Optional reCAPTCHA — enforced per-form or globally (FORM-034), always
	// verified with the deployment secret.
	antiAbuseAuthorized := false
	if required, _ := d.captchaConfig(form); required {
		if err := verifyRecaptcha(d.RecaptchaSecret, in.CaptchaToken); err != nil {
			d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity, "captcha_failed", "Captcha verification failed. Complete the checkbox and try again.", nil)
			return
		}
		antiAbuseAuthorized = true
	}

	// (4) Email validation. Reject controls on the raw value before trimming:
	// TrimSpace includes VT/FF/C1 whitespace, so normalizing first would erase
	// evidence of an unsafe boundary value before the paid-verification gate.
	var validEmail bool
	in.Email, validEmail = normalizePublicSubmitEmail(in.Email)
	if !validEmail {
		d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity, "bad_email", "Enter a valid email address and try again.", nil)
		return
	}
	if err := validateRequiredSubmissionFields(form.Structure, in); err != nil {
		d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity, "required_field_missing", err.Error(), nil)
		return
	}
	consent := evaluateSignupConsent(form, in)

	// (4a) C10 idempotency: a double-click or browser-prefetch on
	// the form sends two POSTs in quick succession; without this
	// guard the user gets two confirmation emails AND two
	// form_submissions rows. Dedupe by (form_id, lower(email))
	// inside a short window (60s) — long enough to catch
	// double-submit, short enough that intentional re-submits
	// after a typo still work. Only a submission that made the same subscribe
	// decision counts, so its answer is the one the first POST got: a
	// double-click on a double opt-in form must still say "check your inbox",
	// and a distinct answer would reveal a recent submission. A visitor who
	// first left the consent box unticked and then ticked it is a new request
	// to subscribe, and is recorded.
	if recent, err := d.Repo.RecentSubmissionExists(r.Context(), form.TenantID, form.ID, in.Email, consent.Affirmed, 60); err == nil && recent {
		d.writeSubmitSuccess(w, r, form, submitResponseFor(form, consent))
		return
	}

	// (4b) Optional email verification. Runs only after cheap syntax,
	// required-field, CAPTCHA, and recent-submission checks. Full-mode paid
	// egress additionally requires the explicit successful CAPTCHA proof above;
	// otherwise the gate deliberately degrades to local-only.
	if allow, decision := d.checkSignupVerification(
		r.Context(), form.TenantID, form.ID, in.Email,
		in.SubmissionAttemptID, in.verificationFingerprint(), antiAbuseAuthorized,
	); !allow {
		if decision.Retryable {
			w.Header().Set("Retry-After", "2")
			d.writeSubmitError(w, r, form, http.StatusServiceUnavailable,
				"email_verification_pending", "Email verification is still in progress. Try again shortly.", nil)
			return
		}
		message := decision.Reason
		if message == "" {
			message = "That email address could not be accepted. Check it and try again."
		}
		if decision.DidYouMean != "" {
			message += " Did you mean " + decision.DidYouMean + "?"
		}
		d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity,
			"email_verification_failed", message, nil)
		return
	}

	d.acceptSubmission(w, r, form, in, consent)
}

// acceptSubmission records a validated public submission and answers it.
func (d *Deps) acceptSubmission(w http.ResponseWriter, r *http.Request, form *Form, in *SubmitInput, consent signupConsent) {
	now := time.Now().UTC()
	sub := Submission{
		FormID:       form.ID,
		Email:        in.Email,
		Name:         in.Name,
		CustomFields: in.CustomFields,
		Consent:      in.Consent, ConsentEvidence: consent.Evidence,
		// X3 UTM capture: lift utm_*/ref off the request URL and any
		// matching keys present in CustomFields into the metadata bag.
		Metadata:     ExtractUTMsFromRequest(r, in.CustomFields),
		IP:           strPtr(clientIP(r, d.TrustForwardedIPHeaders)),
		UserAgent:    strPtr(r.UserAgent()),
		SignupSource: signupSourceFor(r, d.PublicHostBase),
		SubmittedAt:  now,
	}
	listIDs, err := listIDsFromSettings(form.Settings)
	if err != nil {
		d.writeMisconfiguredTarget(w, r, form, err)
		return
	}
	signup := SignupIntent{Subscribe: consent.Affirmed, EngineListIDs: listIDs}
	switch {
	case !consent.Affirmed:
		// A response that did not ask to subscribe: recorded, with nothing to
		// confirm and nothing to join.
		sub.Status = SubmissionReceived
	case form.OptInMode == OptInSingle:
		sub.Status, sub.ConfirmedAt = SubmissionConfirmed, &now
		signup.Consent = &SignupConsentGrant{
			Method:     consentMethodSingleOptIn,
			OccurredAt: now,
			Evidence:   consent.Evidence,
		}
	default:
		token, tokenErr := NewConfirmationToken()
		if tokenErr != nil {
			d.writeSubmitError(w, r, form, http.StatusInternalServerError, "submit_failed", "We could not prepare your confirmation. Please try again.", tokenErr)
			return
		}
		sub.Status, sub.ConfirmationToken = SubmissionPending, token
	}

	subID, err := d.Repo.InsertSubmissionWithSignup(r.Context(), form.TenantID, form.ID, sub, signup, d.Outbox)
	switch {
	case errors.Is(err, ErrTargetListNotFound):
		d.writeMisconfiguredTarget(w, r, form, err)
		return
	case err != nil:
		d.writeSubmitError(w, r, form, http.StatusInternalServerError, "submit_failed", "We could not save your submission. Please try again.", err)
		return
	}
	if d.Outbox == nil {
		d.log().ErrorContext(r.Context(), "forms: no transactional outbox is configured; the submission is recorded but will not reach the audience or Listmonk",
			"tenant_id", form.TenantID, "form_id", form.ID, "submission_id", subID)
	}
	sub.ID = subID
	d.linkUploads(r.Context(), form.TenantID, form.ID, subID, in.CustomFields)
	d.fireSubmitted(r.Context(), form, sub)
	// A pending submission's confirmation email was queued in the insert
	// transaction (OutboxKindSendConfirmation); nothing here waits for it.
	d.writeSubmitSuccess(w, r, form, submitResponseFor(form, consent))
}

// writeMisconfiguredTarget answers a submission to a form whose target list is
// malformed or not one of its workspace's lists. The visitor can do nothing
// about it; the operator needs the log line.
func (d *Deps) writeMisconfiguredTarget(w http.ResponseWriter, r *http.Request, form *Form, err error) {
	d.log().WarnContext(r.Context(), "forms: public submission refused because the form's target list is not usable",
		"tenant_id", form.TenantID, "form_id", form.ID, "err", err)
	d.writeSubmitError(w, r, form, http.StatusUnprocessableEntity, "invalid_target_list",
		"This form is temporarily misconfigured. Please contact its owner.", nil)
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// submitAcceptedResponse is the success envelope for a submission that asked
// to subscribe, derived from the form's opt-in mode and nothing about the
// address.
//
// It exists because the response used to differ: a new address got
// "subscribed" / "pending-confirmation" while an existing one got a distinct
// "already_subscribed". A script POSTing {"email":"victim@example.com"} to a
// published form slug could therefore read list membership straight off the
// state string — and every negative probe also injected a real subscriber row
// and, in double opt-in, mailed the victim a confirmation. Every path builds
// the envelope here so they cannot drift apart again.
func submitAcceptedResponse(form *Form) SubmitResponse {
	if form.OptInMode == OptInSingle {
		return SubmitResponse{
			OK:       true,
			State:    "subscribed",
			Redirect: stringFromSettings(form.Settings, "successRedirectUrl"),
			Message:  stringFromSettings(form.Settings, "successMessage"),
		}
	}
	return SubmitResponse{
		OK:      true,
		State:   "pending-confirmation",
		Message: stringFromSettings(form.Settings, "successMessage"),
	}
}

// submitReceivedResponse is the envelope for a submission that did not ask to
// subscribe: the form has a consent checkbox and the visitor left it
// unticked. "subscribed" or "check your inbox" would be untrue, so the state
// says only that the response was received. The form's success message and
// redirect are written for signups and are not used.
func submitReceivedResponse() SubmitResponse {
	return SubmitResponse{OK: true, State: "received"}
}

// submitResponseFor picks the envelope from what the visitor sent — never
// from whether the address is already known.
func submitResponseFor(form *Form, consent signupConsent) SubmitResponse {
	if !consent.Affirmed {
		return submitReceivedResponse()
	}
	return submitAcceptedResponse(form)
}

// DeleteSubmission DELETE /api/v1/forms/{id}/submissions/{submissionId} —
// remove a single (e.g. spam) submission (FORM-030).
func (d *Deps) DeleteSubmission(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	formID := chi.URLParam(r, "id")
	submissionID := chi.URLParam(r, "submissionId")
	if err := d.Repo.DeleteSubmission(r.Context(), t.ID, formID, submissionID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such submission")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ResendConfirmation POST /api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation
// — re-send the double-opt-in confirmation email for a still-pending submission
// (FORM-030). 409s if the submission is already confirmed (nothing to resend).
func (d *Deps) ResendConfirmation(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	formID := chi.URLParam(r, "id")
	submissionID := chi.URLParam(r, "submissionId")
	form, err := d.Repo.Get(r.Context(), t.ID, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such form")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	sub, err := d.Repo.GetSubmission(r.Context(), t.ID, form.ID, submissionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such submission")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if sub.Status != SubmissionPending {
		httperror.Write(w, http.StatusConflict, "not_pending",
			"only a pending submission can be re-sent a confirmation")
		return
	}
	if sub.ConfirmationToken == "" {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("pending submission %s has no confirmation token", submissionID), r.Context())
		return
	}
	// Re-open the window BEFORE mailing. The resend reuses the same token, so
	// without this an old pending submission gets a confirmation email whose
	// link is already dead — and the operator is told it was sent.
	if err = d.Repo.RefreshConfirmationWindow(r.Context(), t.ID, submissionID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	target, err := d.Repo.confirmationTarget(r.Context(), t.ID, submissionID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	state, sendErr := d.deliverConfirmation(r.Context(), target)
	if err := d.Repo.recordConfirmationEmail(r.Context(), t.ID, submissionID, state); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if sendErr != nil {
		status, code, message := resendFailure(sendErr)
		d.log().Log(r.Context(), resendFailureLevel(status), "forms: re-sending a confirmation email failed",
			"tenant_id", t.ID, "form_id", formID, "submission_id", submissionID, "state", string(state), "code", code, "err", sendErr)
		// Written directly, not through httperror.Write, which replaces every
		// 5xx message with the generic one: these are fixed, safe sentences
		// the operator can act on.
		writeJSON(w, status, errEnv(code, message))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "resent_to": sub.Email})
}

// resendFailure is the operator-facing answer to a failed resend; a failure
// the email provider reported is answered by sendFailureAnswer.
func resendFailure(err error) (status int, code, message string) {
	switch {
	case errors.Is(err, ErrConfirmationMailerUnavailable):
		return http.StatusServiceUnavailable, "confirmation_email_unavailable",
			"Confirmation emails can't be sent because outgoing email isn't set up on this server."
	case errors.Is(err, ErrConfirmationNoSender):
		return http.StatusUnprocessableEntity, "confirmation_sender_missing",
			"This form has no sender for confirmation emails. In the form's settings, set a sender address on a domain you've verified, then resend."
	case errors.Is(err, ErrConfirmationRecipientSuppressed):
		return http.StatusUnprocessableEntity, "confirmation_recipient_suppressed",
			"This address bounced, reported spam, or was erased, so it can't be sent a confirmation email."
	case errors.Is(err, ErrConfirmationQuotaExceeded):
		return http.StatusTooManyRequests, "confirmation_quota_exceeded",
			"This workspace has sent as many confirmation emails as the standard sender allows in an hour. Try again later, or send them from a domain you've verified."
	default:
		return sendFailureAnswer(err)
	}
}

// PublicConfirm GET /api/public/forms/confirm/{token}
//
// Flips the form_submissions row from pending → confirmed and, in the same
// transaction, appends the durable OutboxKindEnableListmonk event whose
// handler (SignupAudience.RecordConfirmed) enables the subscriber with double
// opt-in consent, joins the lists the visitor signed up to, and projects both
// into Listmonk.
//
// There is no synchronous fallback. The one that existed enabled the Listmonk
// subscriber only, discarded its errors, and replaced the subscription list
// with none; production always has the outbox.
func (d *Deps) PublicConfirm(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	tenantID, formID, _, err := d.Repo.ConfirmByTokenWithOutbox(r.Context(), token, d.Outbox)
	if err != nil {
		switch {
		case errors.Is(err, ErrAlreadyConfirmed):
			writeJSON(w, http.StatusOK, map[string]string{"state": "already"})
		case errors.Is(err, ErrConfirmationExpired):
			// 410 Gone, not 500 and not "missing".
			//
			// Without this arm the new error fell to WriteInternal and an expired
			// confirmation link rendered as "an internal error occurred" — a
			// person who clicked a real link they simply left too long was told
			// the system was broken, with nothing to do about it. The distinction
			// the repo layer draws is only worth drawing if it reaches a page.
			writeJSON(w, http.StatusGone, map[string]string{"state": "expired"})
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"state": "missing"})
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if d.Outbox == nil {
		d.log().ErrorContext(r.Context(), "forms: no transactional outbox is configured; the confirmation is recorded but the subscriber will not be subscribed",
			"tenant_id", tenantID, "form_id", formID)
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": "confirmed"})
}

// linkUploads scans a submission's custom_fields for UUID-shaped values
// and tries to attach the matching form_file_uploads rows to the new
// submission. Best-effort: a failure here does NOT roll back the
// submission write (the row is already committed) — orphans get swept
// by a periodic cleaner. Skipped silently when Uploads is unconfigured.
func (d *Deps) linkUploads(ctx context.Context, tenantID, formID, submissionID string, fields map[string]string) {
	if d.Uploads == nil || tenantID == "" || formID == "" || submissionID == "" || len(fields) == 0 {
		return
	}
	candidates := make([]string, 0, len(fields))
	for _, v := range fields {
		if v != "" {
			candidates = append(candidates, v)
		}
	}
	if len(candidates) == 0 {
		return
	}
	_ = d.Uploads.LinkToSubmission(ctx, tenantID, formID, submissionID, candidates)
}

// fireSubmitted emits a form.submitted webhook event. Best-effort: a
// fanout failure does NOT roll back the submission write (the row is
// already committed by the time we get here). We swallow the error so
// a flaky outbox write doesn't surface as a 5xx to the form's public
// poster — the audit log + the dashboard's last-delivery status are
// the operator's signals if something's stuck.
func (d *Deps) fireSubmitted(ctx context.Context, form *Form, sub Submission) {
	if d.Webhooks == nil || form == nil {
		return
	}
	body := map[string]any{
		"tenant_id":     form.TenantID,
		"form_id":       form.ID,
		"submission_id": sub.ID,
		"email":         sub.Email,
		"status":        string(sub.Status),
		"submitted_at":  sub.SubmittedAt,
	}
	_ = d.Webhooks.AppendFanout(ctx, form.TenantID, "form.submitted", body)
}

// ---------- helpers ----------

func parseSubmitInput(w http.ResponseWriter, r *http.Request) (*SubmitInput, error) {
	contentType := r.Header.Get("Content-Type")
	in := &SubmitInput{CustomFields: map[string]string{}}

	if strings.HasPrefix(contentType, "application/json") {
		if err := httpbody.DecodeJSON(w, r, formPublicSubmitMaxBodyBytes, in); err != nil {
			return nil, fmt.Errorf("decode json: %w", err)
		}
		if in.CustomFields == nil {
			in.CustomFields = map[string]string{}
		}
		return in, validateSubmitInputBounds(in)
	}

	// Default: form-encoded (the hosted page POSTs application/x-www-form-urlencoded).
	r.Body = http.MaxBytesReader(w, r.Body, formPublicSubmitMaxBodyBytes)
	if err := r.ParseForm(); err != nil {
		return nil, fmt.Errorf("parse form: %w", err)
	}
	in.Email = r.FormValue("email")
	in.Name = r.FormValue("name")
	in.Consent = r.FormValue("consent")
	in.Website = r.FormValue("website")
	in.CaptchaToken = r.FormValue("g-recaptcha-response")
	in.SubmissionAttemptID = r.FormValue("submission_attempt_id")
	for k, vs := range r.PostForm {
		if strings.HasPrefix(k, "cf_") && len(vs) > 0 {
			in.CustomFields[strings.TrimPrefix(k, "cf_")] = vs[0]
		}
	}
	return in, validateSubmitInputBounds(in)
}

func validateSubmitInputBounds(in *SubmitInput) error {
	if in == nil {
		return errors.New("submission is required")
	}
	if containsUnsafeSubmitControlText(in.Email) {
		return fmt.Errorf("email contains control characters")
	}
	if len(in.Name) > maxSubmitNameBytes {
		return fmt.Errorf("name is too long")
	}
	if len(in.Consent) > maxSubmitConsentBytes {
		return fmt.Errorf("consent value is too long")
	}
	if len(in.Website) > maxSubmitHoneypotBytes {
		return fmt.Errorf("honeypot value is too long")
	}
	if len(in.CaptchaToken) > maxSubmitCaptchaTokenBytes || containsUnsafeSubmitControlText(in.CaptchaToken) {
		return fmt.Errorf("captcha token is too long")
	}
	if len(in.SubmissionAttemptID) > maxSubmitAttemptIDBytes || containsUnsafeSubmitControlText(in.SubmissionAttemptID) {
		return fmt.Errorf("submission attempt id is invalid")
	}
	if in.CustomFields == nil {
		in.CustomFields = map[string]string{}
	}
	if len(in.CustomFields) > maxSubmitCustomFields {
		return fmt.Errorf("too many custom fields")
	}
	for key, value := range in.CustomFields {
		if strings.TrimSpace(key) == "" {
			return fmt.Errorf("custom field key is required")
		}
		if len(key) > maxSubmitCustomFieldKeyBytes {
			return fmt.Errorf("custom field key is too long")
		}
		if containsUnsafeSubmitControlText(key) {
			return fmt.Errorf("custom field key contains control characters")
		}
		if len(value) > maxSubmitCustomFieldValueBytes {
			return fmt.Errorf("custom field %q is too large", key)
		}
	}
	return nil
}

func (d *Deps) writeSubmitSuccess(w http.ResponseWriter, r *http.Request, form *Form, resp SubmitResponse) {
	if wantsJSONResponse(r) {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	target := ""
	if resp.State == "subscribed" {
		target = safeSubmitRedirect(resp.Redirect)
	}
	if target == "" {
		target = d.defaultSubmitRedirect(form, resp.State)
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// writeSubmitError preserves the JSON API contract for fetch clients while
// giving native form navigations a human-readable recovery page instead of a
// bare error envelope.
func (d *Deps) writeSubmitError(w http.ResponseWriter, r *http.Request, form *Form, status int, code, message string, internal error) {
	if internal != nil && d.Logger != nil {
		d.Logger.Error("forms: public submission failed", "code", code, "err", internal)
	}
	if wantsJSONResponse(r) {
		httperror.Write(w, status, code, message)
		return
	}
	back := strings.TrimRight(d.PublicHostBase, "/")
	if form != nil {
		back += "/forms/" + url.PathEscape(form.Slug)
	} else if back == "" {
		back = "/"
	}
	if back == "" {
		back = "/"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Form submission problem</title></head><body><main><h1>We couldn't submit the form</h1><p>%s</p><p><a href="%s">Return to the form</a></p></main></body></html>`, stdhtml.EscapeString(message), stdhtml.EscapeString(back))
}

func wantsJSONResponse(r *http.Request) bool {
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "application/json") {
		return true
	}
	accept := strings.ToLower(r.Header.Get("Accept"))
	if strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/html") {
		return true
	}
	return false
}

func validateSuccessRedirectURL(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if safeSubmitRedirect(raw) == "" {
		return fmt.Errorf("successRedirectUrl must be an https URL, a local development http URL, or a root-relative path")
	}
	return nil
}

func safeSubmitRedirect(raw string) string {
	target := strings.TrimSpace(raw)
	if target == "" || containsUnsafeSubmitRedirectBytes(target) {
		return ""
	}
	if strings.HasPrefix(target, "/") && !strings.HasPrefix(target, "//") {
		return target
	}
	u, err := url.Parse(target)
	if err != nil || u.User != nil {
		return ""
	}
	if u.Scheme == "https" {
		u.Fragment = ""
		return u.String()
	}
	if u.Scheme == "http" && isLocalRedirectHost(u.Hostname()) {
		u.Fragment = ""
		return u.String()
	}
	return ""
}

func containsUnsafeSubmitRedirectBytes(raw string) bool {
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "%0d") || strings.Contains(lower, "%0a") {
		return true
	}
	return strings.ContainsAny(raw, "\x00\r\n")
}

func isLocalRedirectHost(host string) bool {
	h := strings.ToLower(host)
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// defaultSubmitRedirect is the hosted success page a native (non-JSON) form
// post lands on. Its mode picks the page's copy: "double" asks the visitor to
// check their inbox, "received" confirms a response that did not subscribe,
// and "single" says they are subscribed.
func (d *Deps) defaultSubmitRedirect(form *Form, state string) string {
	mode := "single"
	switch state {
	case "pending-confirmation":
		mode = "double"
	case "received":
		mode = "received"
	}
	base := strings.TrimRight(strings.TrimSpace(d.PublicHostBase), "/")
	path := "/forms/success?form=" + url.QueryEscape(form.Slug) + "&mode=" + url.QueryEscape(mode)
	if base == "" {
		return path
	}
	return base + path
}

// MaxFormSlugLength caps the per-tenant form slug length. Slugs become
// public URL components (`/api/public/forms/<slug>/...`), so unbounded
// slugs blow up index size + URL display. 128 is generous for any
// realistic name and small enough that abuse is bounded.
const MaxFormSlugLength = 128

// MaxFormNameLength caps the form's display name. Same rationale; the
// admin UI surfaces names in tables.
const MaxFormNameLength = 200

// validateSlug rejects slugs that are too long or contain bytes that
// would either break URLs (whitespace, control chars) or invite SQL
// awkwardness via casting. The lower-level rejectControlBytesInPath
// middleware already strips ASCII control bytes from the path; this
// adds shape + length validation at the application layer.
func validateSlug(s string) error {
	if strings.TrimSpace(s) == "" {
		return errors.New("slug is required")
	}
	if len(s) > MaxFormSlugLength {
		return fmt.Errorf("slug must be %d characters or fewer", MaxFormSlugLength)
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		// Allow common slug bytes: a-z A-Z 0-9 - _ . and ~ (RFC 3986
		// unreserved). Reject everything else including %, /, spaces.
		if !((c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~') {
			return fmt.Errorf("slug contains invalid character at position %d", i)
		}
	}
	return nil
}

func validateRequiredSubmissionFields(structure map[string]any, in *SubmitInput) error {
	raw, err := json.Marshal(structure)
	if err != nil {
		return errors.New("Form requirements could not be read.")
	}
	var parsed struct {
		Fields []struct {
			ID        string `json:"id"`
			Kind      string `json:"kind"`
			Label     string `json:"label"`
			CustomKey string `json:"customKey"`
			Required  bool   `json:"required"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return errors.New("Form requirements could not be read.")
	}
	for _, field := range parsed.Fields {
		if !field.Required {
			continue
		}
		switch field.Kind {
		case "email":
			continue
		case "name":
			if strings.TrimSpace(in.Name) == "" {
				return errors.New("Name is required.")
			}
		case "checkbox":
			if !consentChecked(in.Consent) {
				return errors.New("Consent is required.")
			}
		case "heading", "text", "submit", "step_break", "honeypot":
			continue
		default:
			key := field.CustomKey
			if key == "" {
				key = field.ID
			}
			key = safeSubmissionFieldKey(key)
			if strings.TrimSpace(in.CustomFields[key]) == "" {
				label := field.Label
				if strings.TrimSpace(label) == "" {
					label = "This field"
				}
				return fmt.Errorf("%s is required.", label)
			}
		}
	}
	return nil
}

func consentChecked(value string) bool {
	action, recognized := consentAction(value)
	return recognized && action == "granted"
}

func safeSubmissionFieldKey(raw string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(raw) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' || r == ':' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
		if b.Len() >= 80 {
			break
		}
	}
	return strings.Trim(b.String(), "_")
}

// normalizePublicSubmitEmail accepts exactly the mailboxes a subscriber can
// have (emailidentity.Normalize): every accepted submission becomes a
// subscriber, and an address the subscriber store refuses would be answered
// "subscribed" and then never reach the audience.
func normalizePublicSubmitEmail(raw string) (string, bool) {
	if containsUnsafeSubmitControlText(raw) {
		return "", false
	}
	normalized, err := emailidentity.Normalize(raw)
	if err != nil {
		return "", false
	}
	return normalized, true
}

func containsUnsafeSubmitControlText(raw string) bool {
	return !utf8.ValidString(raw) || emailidentity.ContainsControl(raw)
}

func clientIP(r *http.Request, trustForwarded bool) string {
	return middleware.ResolveClientIPString(r, trustForwarded)
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func stringFromSettings(s map[string]any, key string) string {
	if s == nil {
		return ""
	}
	v, ok := s[key]
	if !ok {
		return ""
	}
	s2, _ := v.(string)
	return s2
}

func boolFromSettings(s map[string]any, key string) bool {
	if s == nil {
		return false
	}
	v, _ := s[key].(bool)
	return v
}

// captchaConfig resolves the effective reCAPTCHA enforcement + public site key
// for one form (FORM-034). The verifying SECRET is always deployment-level
// (d.RecaptchaSecret) and is never read from tenant-editable settings; a form
// can only opt IN to enforcement and supply a public site key. Enforcement is
// only possible when the deployment has a secret to verify with AND there is a
// site key to render the widget, so a form that toggles captcha on without a
// usable key is a no-op rather than an unsubmittable form.
func (d *Deps) captchaConfig(f *Form) (required bool, siteKey string) {
	if f == nil {
		return false, ""
	}
	siteKey = stringFromSettings(f.Settings, "recaptchaSiteKey")
	if siteKey == "" {
		siteKey = d.RecaptchaSiteKey
	}
	if d.RecaptchaSecret == "" || siteKey == "" {
		return false, ""
	}
	// Server globally requires captcha when both deployment keys are set
	// (preserves the prior all-forms behaviour); a form may additionally opt in.
	serverRequired := d.RecaptchaSecret != "" && d.RecaptchaSiteKey != ""
	if serverRequired || boolFromSettings(f.Settings, "captchaRequired") {
		return true, siteKey
	}
	return false, ""
}

func listIDsFromSettings(s map[string]any) ([]int64, error) {
	if s == nil {
		return nil, nil
	}
	v, ok := s["targetListId"]
	if !ok {
		return nil, nil
	}
	switch t := v.(type) {
	case float64:
		if t <= 0 || t != float64(int64(t)) {
			return nil, fmt.Errorf("targetListId must be a positive integer")
		}
		return []int64{int64(t)}, nil
	case int:
		if t <= 0 {
			return nil, fmt.Errorf("targetListId must be a positive integer")
		}
		return []int64{int64(t)}, nil
	case int64:
		if t <= 0 {
			return nil, fmt.Errorf("targetListId must be a positive integer")
		}
		return []int64{t}, nil
	case string:
		t = strings.TrimSpace(t)
		if t == "" {
			return nil, nil
		}
		var n int64
		if _, err := fmt.Sscanf(t, "%d", &n); err != nil || n <= 0 || fmt.Sprintf("%d", n) != t {
			return nil, fmt.Errorf("targetListId %q is invalid; expected a positive Listmonk integer id", t)
		}
		return []int64{n}, nil
	}
	return nil, fmt.Errorf("targetListId has unsupported type %T; expected positive integer", v)
}

func defaultStructure() map[string]any {
	return map[string]any{
		"fields": []map[string]any{
			{"id": "h1", "kind": "heading", "label": "Heading", "required": false, "content": "Subscribe to our newsletter"},
			{"id": "f_email", "kind": "email", "label": "Email address", "placeholder": "you@example.com", "required": true},
			{"id": "f_name", "kind": "name", "label": "First name", "required": false},
			{"id": "f_consent", "kind": "checkbox", "label": "I agree to receive emails.", "required": true},
			{"id": "f_hp", "kind": "honeypot", "label": "Leave empty", "required": false},
			{"id": "f_submit", "kind": "submit", "label": "Subscribe", "required": false},
		},
	}
}

func validateRequiredEmailField(structure map[string]any) error {
	raw, err := json.Marshal(structure)
	if err != nil {
		return errors.New("form structure is invalid")
	}
	var parsed struct {
		Fields []struct {
			Kind     string `json:"kind"`
			Required bool   `json:"required"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return errors.New("form structure is invalid")
	}
	for _, field := range parsed.Fields {
		if field.Kind == "email" && field.Required {
			return nil
		}
	}
	return errors.New("form structure must contain a required email field")
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// verifyRecaptcha calls Google's siteverify endpoint. Returns nil on
// success, error otherwise. In V1 we accept any score >= 0.5 (v3) — V2
// will tune per-site.
func verifyRecaptcha(secret, token string) error {
	if token == "" {
		return errors.New("missing captcha token")
	}
	ctx, cancel := context.WithTimeout(context.Background(), recaptchaVerifyTimeout)
	defer cancel()
	form := url.Values{"secret": {secret}, "response": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, recaptchaVerifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := recaptchaHTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("recaptcha verify status %d", resp.StatusCode)
	}
	var out struct {
		Success bool    `json:"success"`
		Score   float64 `json:"score"`
	}
	if resp.ContentLength > recaptchaMaxResponseBytes {
		return errors.New("recaptcha response body too large")
	}
	if err := decodeJSONLimited(resp.Body, recaptchaMaxResponseBytes, &out); err != nil {
		return err
	}
	if !out.Success {
		return errors.New("recaptcha rejected")
	}
	if out.Score > 0 && out.Score < 0.5 {
		return errors.New("recaptcha score too low")
	}
	return nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return errors.New("response body too large")
	}
	return json.Unmarshal(buf, out)
}
