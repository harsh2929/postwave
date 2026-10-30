// SPDX-License-Identifier: AGPL-3.0-only

package contentreports

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// noticeMaxBodyBytes caps the intake. The explanation is capped at 10,000 runes
// by the model, so 64 KiB is generous for the envelope while keeping an
// anonymous, unauthenticated endpoint from being a memory amplifier.
const noticeMaxBodyBytes int64 = 64 << 10

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, message string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": message}}
}

// ---------------------------------------------------------------------------
// Public — DSA Art. 16
// ---------------------------------------------------------------------------

type publicNoticeRequest struct {
	SubjectKind       string `json:"subject_kind"`
	SubjectURL        string `json:"subject_url"`
	ReasonCategory    string `json:"reason_category"`
	Explanation       string `json:"explanation"`
	NotifierName      string `json:"notifier_name"`
	NotifierEmail     string `json:"notifier_email"`
	GoodFaithDeclared bool   `json:"good_faith_declared"`
}

// PublicSubmitNotice handles POST /api/public/content-reports.
//
// Unauthenticated by design. Art. 16(1) requires the mechanism to allow "any
// individual or entity" to notify us, and a login wall would exclude precisely
// the people it exists for — the subject of a privacy violation, a rights
// holder, a parent. It is rate-limited, size-capped and write-only.
func (d *Deps) PublicSubmitNotice(w http.ResponseWriter, r *http.Request) {
	var in publicNoticeRequest
	if err := httpbody.DecodeJSON(w, r, noticeMaxBodyBytes, &in); err != nil {
		return
	}

	receipt, err := d.Repo.RecordPublicNotice(r.Context(), PublicNotice{
		SubjectKind:       in.SubjectKind,
		SubjectURL:        in.SubjectURL,
		ReasonCategory:    in.ReasonCategory,
		Explanation:       in.Explanation,
		NotifierName:      in.NotifierName,
		NotifierEmail:     in.NotifierEmail,
		GoodFaithDeclared: in.GoodFaithDeclared,
	})
	if err != nil {
		// Validation failures are told to the notifier plainly. A generic 400
		// on a public reporting form is how a notice gets abandoned, and an
		// abandoned notice is one we never obtained knowledge of.
		switch {
		case errors.Is(err, ErrInvalidSubjectKind):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_subject_kind",
				"subject_kind must name the kind of content being reported"))
		case errors.Is(err, ErrInvalidCategory):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_reason_category",
				"reason_category must be one of the listed grounds"))
		case errors.Is(err, ErrInvalidSubjectURL):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_subject_url",
				"subject_url must be the full https address of the content you are reporting"))
		case errors.Is(err, ErrExplanationTooShort):
			writeJSON(w, http.StatusBadRequest, errEnv("explanation_too_short",
				"please explain why this content is illegal or breaks the rules, in at least 20 characters"))
		case errors.Is(err, ErrGoodFaithRequired):
			writeJSON(w, http.StatusBadRequest, errEnv("good_faith_required",
				"please confirm that the information in this report is accurate and complete to the best of your knowledge"))
		case errors.Is(err, ErrNotifierRequired):
			writeJSON(w, http.StatusBadRequest, errEnv("notifier_email_required",
				"an email address is required so we can tell you the outcome. Reports of child sexual abuse material may be submitted anonymously."))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}

	// Art. 16(4): confirmation of receipt, without undue delay. 201 with the
	// reference IS that confirmation for a synchronous submission.
	writeJSON(w, http.StatusCreated, map[string]any{
		"reference":   receipt.Reference,
		"received_at": receipt.ActualKnowledgeAt,
		"next_steps": "Keep this reference. You can check the outcome at " +
			"/legal/report-content using it, and we will email you when a decision is made.",
	})
}

// PublicNoticeStatus handles GET /api/public/content-reports/{reference}.
//
// Art. 16(5) requires notifying the notifier of the decision. A reference-keyed
// lookup is how that works for someone with no account: they hold a capability
// scoped to exactly one outcome, and the query behind it returns nothing else.
func (d *Deps) PublicNoticeStatus(w http.ResponseWriter, r *http.Request) {
	reference := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "reference")))
	if reference == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_reference", "a report reference is required"))
		return
	}
	status, err := d.Repo.LookupPublicStatus(r.Context(), reference)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no report with that reference"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// ---------------------------------------------------------------------------
// Authenticated — the in-app affordance the store policies require
// ---------------------------------------------------------------------------

type inAppReportRequest struct {
	Origin         string `json:"origin"`
	SubjectKind    string `json:"subject_kind"`
	SubjectURL     string `json:"subject_url"`
	SubjectRef     string `json:"subject_ref"`
	ReasonCategory string `json:"reason_category"`
	Explanation    string `json:"explanation"`
}

// SubmitInAppReport handles POST /api/v1/content-reports.
//
// Backs the report control on inbound replies, helpdesk threads, archive
// comments and model output. Apple Guideline 1.2 and Google Play's UGC and
// generative-AI policies each require it, and each requires it to go somewhere
// — so it lands in the same queue as a public notice rather than in a
// write-only feedback bucket.
func (d *Deps) SubmitInAppReport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", "sign in to report content"))
		return
	}
	var in inAppReportRequest
	if err := httpbody.DecodeJSON(w, r, noticeMaxBodyBytes, &in); err != nil {
		return
	}
	origin := strings.TrimSpace(in.Origin)
	if origin == "" {
		origin = OriginInAppUGC
	}
	receipt, err := d.Repo.RecordInAppReport(r.Context(), tenant.ID, InAppReport{
		Origin:         origin,
		SubjectKind:    in.SubjectKind,
		SubjectURL:     in.SubjectURL,
		SubjectRef:     in.SubjectRef,
		ReasonCategory: in.ReasonCategory,
		Explanation:    in.Explanation,
		ReportedByUser: userIDFrom(r),
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidSubjectKind), errors.Is(err, ErrInvalidCategory),
			errors.Is(err, ErrInvalidSubjectURL), errors.Is(err, ErrExplanationTooShort):
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_report", err.Error()))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, receipt)
}

// List handles GET /api/v1/content-reports.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", ""))
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	reports, err := d.Repo.List(r.Context(), tenant.ID, r.URL.Query().Get("status"), limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": reports})
}

type decideRequest struct {
	Action             string `json:"action"`
	Ground             string `json:"ground"`
	Reasoning          string `json:"reasoning"`
	AutomatedMeansUsed bool   `json:"automated_means_used"`
}

// Decide handles POST /api/v1/content-reports/{id}/decide — the Art. 17
// statement of reasons.
//
// Admin-scoped: a statement of reasons is a legal communication to the affected
// recipient, and it is final (one per report, enforced by a unique constraint).
func (d *Deps) Decide(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", ""))
		return
	}
	reportID := strings.TrimSpace(chi.URLParam(r, "id"))
	if reportID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	var in decideRequest
	if err := httpbody.DecodeJSON(w, r, noticeMaxBodyBytes, &in); err != nil {
		return
	}
	decision, err := d.Repo.Decide(r.Context(), tenant.ID, reportID, DecisionInput{
		Action:             in.Action,
		Ground:             in.Ground,
		Reasoning:          in.Reasoning,
		AutomatedMeansUsed: in.AutomatedMeansUsed,
		DecidedByUser:      userIDFrom(r),
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrAlreadyDecided):
			writeJSON(w, http.StatusConflict, errEnv("already_decided",
				"this report already has a statement of reasons"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such report"))
		case errors.Is(err, ErrExplanationTooShort):
			writeJSON(w, http.StatusBadRequest, errEnv("reasoning_too_short",
				"the statement of reasons must set out the facts relied on, in at least 20 characters"))
		default:
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_decision", err.Error()))
		}
		return
	}
	writeJSON(w, http.StatusOK, decision)
}

// MountPublicRoutes registers the anonymous Art. 16 surface. The caller supplies
// the rate limiter; this package does not choose its own budget because the
// public bucket is shared and sized in the composition root.
func MountPublicRoutes(r chi.Router, d *Deps) {
	r.Post("/api/public/content-reports", d.PublicSubmitNotice)
	r.Get("/api/public/content-reports/{reference}", d.PublicNoticeStatus)
}

// MountAuthenticatedRoutes registers the in-app and operator surface.
func MountAuthenticatedRoutes(r chi.Router, d *Deps) {
	// Any signed-in principal may report: the person looking at the content is
	// the one who can see it is wrong, and gating reporting behind an admin
	// role would defeat the store requirement it exists to satisfy.
	r.Post("/api/v1/content-reports", d.SubmitInAppReport)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/content-reports", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/content-reports/{id}/decide", d.Decide)
}

// userIDFrom returns the acting user's id, or "" when the request is
// API-key-authenticated rather than session-authenticated. An empty actor is
// legitimate here — a report can arrive from an integration — so the column is
// nullable rather than the handler refusing.
func userIDFrom(r *http.Request) string {
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		return u.ID
	}
	return ""
}
