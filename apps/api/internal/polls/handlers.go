// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The two-step link, as HTTP.
//
// The split is the entire mitigation, and it only exists at this layer: GET
// PREVIEWS and POST RECORDS. A GET that recorded would register a vote for every
// option in the message the first time a security gateway walked the links, and
// the poll would return a plausible tie that nobody could tell from a real one.
//
// Both routes are unauthenticated by design — a recipient clicking from an email
// has no session, which is the whole reason per-(recipient, option) tokens exist.
// The token is the credential, it names exactly one recipient and one option, and
// neither route reveals anything a caller does not already hold.
//
// This mirrors internal/actionticket, which already documents the same GET/POST
// split for the same reason. Copying the shape rather than inventing one keeps a
// reader who has seen the other surface from having to re-derive why.

// Deps carries the poll HTTP surface.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// Classifier resolves whether a confirmation looks like human traffic.
	//
	// Optional: when nil, confirmations are retained as unknown and excluded.
	// Only the explicit `human` verdict may enter a customer-visible tally.
	Classifier RequestClassifier
}

// RequestClassifier classifies an inbound HTTP request as human or machine.
type RequestClassifier interface {
	ClassifyRequest(r *http.Request) ClassificationDecision
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// MountPublicRoutes registers the recipient-facing poll surface.
func MountPublicRoutes(r chi.Router, d *Deps) error {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return ErrInvalidConfiguration
	}
	if err := d.Repo.Validate(); err != nil {
		return err
	}
	// GET previews. It must never record a response — see the package comment.
	r.Get("/api/public/polls/{tenant}/{poll}/{option}", d.Preview)
	// POST records. The button on the preview page posts here.
	r.Post("/api/public/polls/{tenant}/{poll}/{option}", d.Confirm)
	return nil
}

// AdminRouters keeps authoring, campaign reads, and report reads on their
// narrow API-key scopes. Passing the same router for all three is convenient
// in focused tests; production supplies separately scoped routers.
type AdminRouters struct {
	ReadCampaigns  chi.Router
	WriteCampaigns chi.Router
	ReadReports    chi.Router
}

// MountAdminRoutes registers campaign-scoped materialization and tally reads.
func MountAdminRoutes(routes AdminRouters, d *Deps) error {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return ErrInvalidConfiguration
	}
	if err := d.Repo.Validate(); err != nil {
		return err
	}
	if routes.ReadCampaigns == nil || routes.WriteCampaigns == nil || routes.ReadReports == nil {
		return ErrInvalidConfiguration
	}
	routes.WriteCampaigns.Post("/api/v1/campaigns/{campaign}/polls", d.Create)
	routes.ReadCampaigns.Get("/api/v1/campaigns/{campaign}/polls", d.List)
	routes.ReadReports.Get("/api/v1/campaigns/{campaign}/polls/{poll}/tally", d.Tally)
	return nil
}

// Preview handles GET — it records that the link was fetched and returns what to
// render, and it does NOT count a vote.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	setBearerResponseHeaders(w)
	tenantID := strings.TrimSpace(chi.URLParam(r, "tenant"))
	pollKey := strings.TrimSpace(chi.URLParam(r, "poll"))
	optionKey := strings.TrimSpace(chi.URLParam(r, "option"))
	recipient := strings.TrimSpace(r.URL.Query().Get("r"))
	token := strings.TrimSpace(r.URL.Query().Get("t"))
	if !opaqueRecipientReference.MatchString(recipient) {
		d.writePublicError(w, r, ErrUnknownToken)
		return
	}

	target, err := d.Repo.Preview(r.Context(), tenantID, pollKey, optionKey, recipient, token)
	if err != nil {
		d.writePublicError(w, r, err)
		return
	}
	confirmQuery := r.URL.Query()
	if target.TwoStepRequired {
		confirmQuery.Set("c", target.ConfirmationToken)
	}
	if pollWantsHTML(r.Header.Get("Accept")) {
		// The form action is query-only, so it resolves against the current poll
		// route without reflecting the tenant identifier into the page body. The
		// opaque recipient reference and long-lived option token are already in
		// the clicked URL; the one-time challenge travels in the POST body.
		formQuery := make(url.Values, 2)
		formQuery.Set("r", recipient)
		formQuery.Set("t", token)
		writePollPage(w, http.StatusOK, pollPageData{
			Title:             "Confirm your response · Moosewave",
			Eyebrow:           "Poll response",
			Heading:           "Confirm your response",
			Message:           "Review the selection below before submitting it.",
			Question:          target.Question,
			OptionLabel:       target.OptionLabel,
			FormAction:        confirmationURL("", formQuery),
			ConfirmationToken: target.ConfirmationToken,
			ButtonLabel:       "Confirm response",
			Footnote:          "Opening this page did not record a response. Only the confirmation button submits it.",
			Tone:              "preview",
			ShowForm:          true,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"poll_key":          target.PollKey,
		"question":          target.Question,
		"option_label":      target.OptionLabel,
		"two_step_required": target.TwoStepRequired,
		// Stated in the response so a client cannot mistake a preview for a
		// recorded response — the distinction the whole feature rests on.
		"recorded": false,
		"confirm": map[string]any{
			"method": http.MethodPost,
			"url":    confirmationURL(r.URL.Path, confirmQuery),
		},
	})
}

// Confirm handles POST — it records the response, subject to all three
// mitigations.
func (d *Deps) Confirm(w http.ResponseWriter, r *http.Request) {
	setBearerResponseHeaders(w)
	tenantID := strings.TrimSpace(chi.URLParam(r, "tenant"))
	pollKey := strings.TrimSpace(chi.URLParam(r, "poll"))
	optionKey := strings.TrimSpace(chi.URLParam(r, "option"))
	recipient := strings.TrimSpace(r.URL.Query().Get("r"))
	token := strings.TrimSpace(r.URL.Query().Get("t"))
	if !opaqueRecipientReference.MatchString(recipient) {
		d.writePublicError(w, r, ErrUnknownToken)
		return
	}
	confirmationToken, err := confirmationTokenFromRequest(w, r)
	if err != nil {
		d.writePublicError(w, r, err)
		return
	}

	decision := ClassificationDecision{
		Classification: "unknown", UpstreamClassification: "unknown",
		ClassifierStatus: classificationStatusUnavailable,
		StableReason:     classifierUnavailableReason,
	}
	if d.Classifier != nil {
		decision = d.Classifier.ClassifyRequest(r)
	}

	result, err := d.Repo.Confirm(r.Context(), tenantID, pollKey, optionKey,
		recipient, token, confirmationToken, decision)
	if err != nil {
		d.writePublicError(w, r, err)
		return
	}
	if pollWantsHTML(r.Header.Get("Accept")) {
		writePollPage(w, http.StatusOK, confirmationResultPage(result))
		return
	}
	// The state is reported back verbatim, including `voided_multi_option`. A
	// caller told only "ok" could not distinguish a counted response from one the
	// multi-option guard threw away, and a recipient who genuinely clicked twice
	// deserves to be told their answer was discarded rather than silently dropped.
	writeJSON(w, http.StatusOK, map[string]any{
		"recorded":       true,
		"state":          result.State,
		"counted":        result.State == StateCounted,
		"voided_options": result.VoidedOptions,
		"receipt_id":     result.ReceiptID,
		"replayed":       result.Replayed,
		"choice_changed": result.ChoiceChanged,
	})
}

func setBearerResponseHeaders(w http.ResponseWriter) {
	// Poll and confirmation credentials live in the URL. Neither a browser cache
	// nor an intermediary may replay one recipient's one-time challenge.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// The browser page is completely self-contained and script-free. Keeping
	// this policy on JSON responses too avoids representation-specific gaps on
	// the same bearer URL.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()")
	w.Header().Set("Vary", "Accept")
}

const maxConfirmationFormBytes int64 = 4 << 10

// confirmationTokenFromRequest preserves the existing query-parameter API and
// additionally accepts the browser form's one-time challenge in a small
// application/x-www-form-urlencoded body. Reading no other form field keeps the
// route from becoming a second input surface for tenant or recipient identity.
func confirmationTokenFromRequest(w http.ResponseWriter, r *http.Request) (string, error) {
	if token := strings.TrimSpace(r.URL.Query().Get("c")); token != "" {
		return token, nil
	}
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if contentType == "" {
		return "", nil
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		if strings.HasPrefix(strings.ToLower(contentType), "application/x-www-form-urlencoded") {
			return "", fmt.Errorf("%w: malformed confirmation form", ErrInvalidInput)
		}
		return "", nil
	}
	if !strings.EqualFold(mediaType, "application/x-www-form-urlencoded") {
		return "", nil
	}
	if r.ContentLength > maxConfirmationFormBytes {
		return "", fmt.Errorf("%w: confirmation form is too large", ErrInvalidInput)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxConfirmationFormBytes)
	if err := r.ParseForm(); err != nil {
		return "", fmt.Errorf("%w: malformed confirmation form", ErrInvalidInput)
	}
	return strings.TrimSpace(r.PostForm.Get("c")), nil
}

func confirmationURL(path string, query url.Values) string {
	encoded := query.Encode()
	if encoded == "" {
		return path
	}
	return path + "?" + encoded
}

// Create materializes a poll selected from the canonical campaign semantic
// tree. The body contains no duplicate question/options content.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantFromContext(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	var input CreateInput
	if err := httpbody.DecodeJSONWith(w, r, 16<<10, &input, httpbody.Options{
		AllowMissingContentType: true,
	}); err != nil {
		message := "invalid JSON body"
		if errors.Is(err, httpbody.ErrMultipleJSONValues) {
			message = "request body must contain one JSON value"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": message})
		return
	}
	definition, err := d.Repo.CreateFromCampaign(r.Context(), tenantID,
		strings.TrimSpace(chi.URLParam(r, "campaign")), input)
	if err != nil {
		d.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, definition)
}

// List returns the materialized semantic polls for one campaign.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantFromContext(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant context required"})
		return
	}
	input, err := campaignPollListInput(r)
	if err != nil {
		d.writeError(w, err)
		return
	}
	page, err := d.Repo.ListForCampaignPage(r.Context(), tenantID,
		strings.TrimSpace(chi.URLParam(r, "campaign")), input)
	if err != nil {
		d.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func campaignPollListInput(r *http.Request) (CampaignPollListInput, error) {
	input := CampaignPollListInput{Limit: DefaultCampaignPollListLimit}
	query := r.URL.Query()
	if values, present := query["limit"]; present {
		if len(values) != 1 || values[0] == "" || strings.TrimSpace(values[0]) != values[0] {
			return CampaignPollListInput{}, fmt.Errorf("%w: campaign poll list limit is invalid", ErrInvalidInput)
		}
		limit, err := strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > MaxCampaignPollListLimit {
			return CampaignPollListInput{}, fmt.Errorf("%w: campaign poll list limit must be between 1 and %d",
				ErrInvalidInput, MaxCampaignPollListLimit)
		}
		input.Limit = limit
	}
	if values, present := query["cursor"]; present {
		if len(values) != 1 || values[0] == "" || len(values[0]) > MaxCampaignPollCursorBytes ||
			strings.TrimSpace(values[0]) != values[0] {
			return CampaignPollListInput{}, fmt.Errorf("%w: campaign poll list cursor is invalid", ErrInvalidInput)
		}
		input.Cursor = values[0]
	}
	return input, nil
}

// Tally handles the authenticated campaign-scoped results read.
func (d *Deps) Tally(w http.ResponseWriter, r *http.Request) {
	tenantID := tenantFromContext(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized,
			map[string]any{"error": "tenant context required"})
		return
	}
	campaignID := strings.TrimSpace(chi.URLParam(r, "campaign"))
	pollKey := strings.TrimSpace(chi.URLParam(r, "poll"))
	revisionID := strings.TrimSpace(r.URL.Query().Get("content_revision_id"))
	var tally *Tally
	var err error
	if revisionID == "" {
		tally, err = d.Repo.TallyForCampaign(r.Context(), tenantID, campaignID, pollKey)
	} else {
		tally, err = d.Repo.TallyForCampaignRevision(r.Context(), tenantID, campaignID, revisionID, pollKey)
	}
	if err != nil {
		d.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tally)
}

func (d *Deps) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnknownToken):
		// 404, not 403. A 403 confirms the poll and option exist, which lets a
		// caller enumerate them; an unknown token and an unknown poll are
		// deliberately indistinguishable.
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	case errors.Is(err, ErrPollClosed):
		writeJSON(w, http.StatusGone, map[string]any{"error": "this poll has closed"})
	case errors.Is(err, ErrConfirmationRequired):
		writeJSON(w, http.StatusPreconditionRequired,
			map[string]any{"error": "preview this option before confirming"})
	case errors.Is(err, ErrInvalidInput):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	case errors.Is(err, ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
	default:
		d.log().Error("polls: request failed", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
	}
}

// writePublicError negotiates recipient-facing errors without changing the
// authenticated JSON admin APIs. Public misses remain deliberately
// indistinguishable, and no internal error or identifier reaches the HTML.
func (d *Deps) writePublicError(w http.ResponseWriter, r *http.Request, err error) {
	if !pollWantsHTML(r.Header.Get("Accept")) {
		d.writeError(w, err)
		return
	}
	status, page := publicPollErrorPage(err)
	if status == http.StatusInternalServerError {
		d.log().Error("polls: request failed", "err", err.Error())
	}
	writePollPage(w, status, page)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// tenantFromContext reads the authenticated tenant.
func tenantFromContext(r *http.Request) string {
	if t, ok := middleware.TenantFromContext(r.Context()); ok && t != nil {
		return t.ID
	}
	return ""
}
