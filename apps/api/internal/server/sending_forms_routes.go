// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/content_optimizer"
	"github.com/postwave/postwave/apps/api/internal/content_remix"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/form_variants"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/nql"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/search"
	"github.com/postwave/postwave/apps/api/internal/trigger_delay"
)

type SendingDiscoveryRouteDeps struct {
	Router                chi.Router
	Pool                  *db.Pool
	Logger                *slog.Logger
	Sending               *handlers.SendingHandlers
	EnableDirectProvision bool
	IntelligentRetry      *intelligent_retry.Queue
	TriggerDelay          *trigger_delay.Repo
	Audit                 *handlers.AuditHandlers
}

type SendingDiscoverySurface struct {
	Sending          *handlers.SendingHandlers
	IntelligentRetry *intelligent_retry.Deps
	TriggerDelay     *trigger_delay.Deps
	NQL              *nql.Deps
	AnalyticsNQL     *nql.AnalyticsDeps
}

func MountSendingDiscoveryRoutes(deps SendingDiscoveryRouteDeps) SendingDiscoverySurface {
	if deps.Router == nil || deps.Pool == nil || deps.Sending == nil || deps.IntelligentRetry == nil ||
		deps.IntelligentRetry.Pool == nil || deps.TriggerDelay == nil || deps.TriggerDelay.Pool == nil || deps.Audit == nil {
		return SendingDiscoverySurface{}
	}
	if deps.EnableDirectProvision {
		deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sending/provision", deps.Sending.Provision)
	}
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(readReports).Get("/api/v1/sending/state", deps.Sending.State)
	deps.Router.With(readReports).Get("/api/v1/sending/warmup", deps.Sending.Warmup)
	deps.Router.With(readReports).Get("/api/v1/sending/controls", deps.Sending.ControlsState)
	deps.Router.With(readReports).Get("/api/v1/sending/readiness", deps.Sending.Readiness)
	deps.Router.With(admin).Post("/api/v1/sending/controls/pause", deps.Sending.PauseEmailSending)
	deps.Router.With(admin).Post("/api/v1/sending/controls/resume", deps.Sending.ResumeEmailSending)

	frequency.MountRoutes(deps.Router, &frequency.Deps{
		Pool:   deps.Pool,
		Logger: deps.Logger,
	})
	intelligentRetry := &intelligent_retry.Deps{
		Queue:  deps.IntelligentRetry,
		Logger: deps.Logger,
	}
	intelligent_retry.MountRoutes(deps.Router, intelligentRetry)
	triggerDelay := &trigger_delay.Deps{Repo: deps.TriggerDelay}
	trigger_delay.MountRoutes(deps.Router, triggerDelay)
	content_optimizer.MountRoutes(deps.Router, &content_optimizer.Deps{Repo: &content_optimizer.Repo{Pool: deps.Pool}})
	content_remix.MountRoutes(deps.Router, &content_remix.Deps{Pool: deps.Pool})
	search.MountRoutes(deps.Router, &search.Deps{Repo: &search.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	nqlRoutes := &nql.Deps{Pool: deps.Pool}
	nql.MountRoutes(deps.Router, nqlRoutes)
	analyticsNQL := &nql.AnalyticsDeps{
		Pool: deps.Pool, Logger: deps.Logger, LLM: deps.Audit.NLQLLM, Tracker: deps.Audit.NLQTracker,
	}
	nql.MountAnalyticsRoutes(deps.Router, analyticsNQL)
	return SendingDiscoverySurface{
		Sending: deps.Sending, IntelligentRetry: intelligentRetry, TriggerDelay: triggerDelay, NQL: nqlRoutes, AnalyticsNQL: analyticsNQL,
	}
}

type FormAdminRouteDeps struct {
	Router          chi.Router
	Pool            *db.Pool
	Forms           *forms.Deps
	PublicBaseURL   string
	FormsPublicHost string
}

type FormAdminSurface struct {
	Embed    *forms.EmbedDeps
	Variants *form_variants.Deps
}

func MountFormAdminRoutes(deps FormAdminRouteDeps) FormAdminSurface {
	if deps.Router == nil || deps.Pool == nil || deps.Forms == nil || deps.Forms.Repo == nil {
		return FormAdminSurface{}
	}
	embed := &forms.EmbedDeps{Deps: deps.Forms, PublicBaseURL: deps.PublicBaseURL, FormsPublicHost: deps.FormsPublicHost}
	embed.MountAdminRoutes(deps.Router)
	readCampaigns := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	writeCampaigns := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(readCampaigns).Get("/api/v1/forms", observability.RecordSurfaceFunc("forms", "list", deps.Forms.List))
	deps.Router.With(readCampaigns).Get("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "get", deps.Forms.Get))
	deps.Router.With(writeCampaigns).Patch("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "update", deps.Forms.Update))
	// Deleting a form cascades through its response records, so deletion stays
	// at the explicit destructive/admin tier instead of inheriting ordinary
	// campaign-authoring authority.
	deps.Router.With(admin).Delete("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "delete", deps.Forms.Delete))
	// Submission rows and their CSV export contain email addresses, IP/user-agent
	// metadata, and arbitrary custom fields. The current scope vocabulary has no
	// form-response PII/export permission, so keep both fail-closed at admin until
	// a dedicated permission and masking policy exist. Aggregate analytics does
	// not expose response-level identity and follows the reports-read contract.
	deps.Router.With(admin).Get("/api/v1/forms/{id}/submissions", observability.RecordSurfaceFunc("forms", "list_submissions", deps.Forms.ListSubmissions))
	deps.Router.With(admin).Get("/api/v1/forms/{id}/submissions.csv", observability.RecordSurfaceFunc("forms", "submissions_csv", deps.Forms.SubmissionsCSV))
	// FORM-030: per-submission admin actions (delete spam, resend confirmation).
	deps.Router.With(admin).Delete("/api/v1/forms/{id}/submissions/{submissionId}", observability.RecordSurfaceFunc("forms", "delete_submission", deps.Forms.DeleteSubmission))
	deps.Router.With(admin).Post("/api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation", observability.RecordSurfaceFunc("forms", "resend_confirmation", deps.Forms.ResendConfirmation))
	deps.Router.With(readReports).Get("/api/v1/forms/{id}/analytics", observability.RecordSurfaceFunc("forms", "analytics", deps.Forms.Analytics))
	variants := &form_variants.Deps{Repo: &form_variants.Repo{Pool: deps.Pool}}
	variants.MountRoutes(deps.Router)
	return FormAdminSurface{Embed: embed, Variants: variants}
}
