// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/agency"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/compliance"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
	"github.com/postwave/postwave/apps/api/internal/feedback"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/paywall"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

// TenantGovernanceDeps retains the process-wide handler identity shared by the
// governance HTTP surface and its adjacent workers, webhooks, and public
// routes. Pool-only package graphs remain constructed inside the mount helpers.
type TenantGovernanceDeps struct {
	Security         *handlers.SecurityHandlers
	SendSettings     *handlers.SendSettingsHandlers
	Paywall          *paywall.Deps
	OutboxDLQ        *outbox.Deps
	Feedback         *feedback.Deps
	Regions          *regions.Handlers
	EmailPreview     *emailpreview.Deps
	Privacy          *privacy.Deps
	PrivacyIncidents *privacy.IncidentsDeps
	// PrivacyIncidentIdempotency is deliberately injected by the composition
	// root and mounted inside the route-local admin boundary. Keeping replay
	// outside that boundary would let a cached success short-circuit the
	// current API-key scope or effective dashboard-role decision.
	PrivacyIncidentIdempotency func(http.Handler) http.Handler
	Cost                       *cost.Handlers
	Billing                    *billing.Handlers
}

// NewAuditSinkAdminDeps assembles the shared encrypt/decrypt graph without
// duplicating security-sensitive cipher wiring in the composition root.
func NewAuditSinkAdminDeps(
	pool *db.Pool,
	encrypter auditsink.Encrypter,
	cipher auditsink.Cipher,
	logger *slog.Logger,
) *auditsink.AdminDeps {
	return &auditsink.AdminDeps{
		Pool:    pool,
		Encrypt: encrypter,
		Cipher:  cipher,
		Logger:  logger,
	}
}

// MountTenantPolicyRoutes registers workspace security/send defaults, paid
// membership administration, DLQ replay, feedback history, data residency,
// and render preview in their original order.
func MountTenantPolicyRoutes(deps Deps) {
	governance := deps.TenantGovernance
	if deps.Router == nil || governance == nil || governance.Security == nil ||
		governance.SendSettings == nil || governance.Paywall == nil ||
		governance.OutboxDLQ == nil || governance.Feedback == nil ||
		governance.Regions == nil || governance.EmailPreview == nil {
		return
	}

	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(admin).Get("/api/v1/security/settings", governance.Security.Get)
	deps.Router.With(admin).Put("/api/v1/security/settings", governance.Security.Update)
	deps.Router.With(admin).Get("/api/v1/send-settings", governance.SendSettings.Get)
	deps.Router.With(admin).Put("/api/v1/send-settings", governance.SendSettings.Update)
	deps.Router.With(admin).Get("/api/v1/paid-members", governance.Paywall.List)
	deps.Router.With(admin).Post("/api/v1/paid-members", governance.Paywall.Grant)
	deps.Router.With(admin).Delete("/api/v1/paid-members/{email}", governance.Paywall.Revoke)
	governance.Paywall.MountTierRoutes(deps.Router.With(admin))
	deps.Router.With(admin).Get("/api/v1/dlq", governance.OutboxDLQ.List)
	deps.Router.With(admin).Post("/api/v1/dlq/{id}/replay", governance.OutboxDLQ.Replay)
	deps.Router.With(admin).Post("/api/v1/feedback/history", governance.Feedback.HandleHistory)
	deps.Router.Get("/api/v1/tenant/region", governance.Regions.Get)
	deps.Router.Post("/api/v1/email-preview/render", governance.EmailPreview.Render)
}

// MountPrivacyComplianceRoutes registers the complete tenant privacy workflow,
// breach/tabletop operations, DPA download, and compliance attestations. The
// DPA values are read at composition time exactly where main.go read them.
func MountPrivacyComplianceRoutes(deps Deps) {
	governance := deps.TenantGovernance
	if deps.Router == nil || deps.Pool == nil || governance == nil ||
		governance.Privacy == nil || governance.PrivacyIncidents == nil ||
		governance.PrivacyIncidentIdempotency == nil {
		return
	}

	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(admin).Post("/api/v1/privacy/export-requests", governance.Privacy.RequestExport)
	deps.Router.With(admin).Get("/api/v1/privacy/requests", governance.Privacy.ListRequests)
	deps.Router.With(admin).Get("/api/v1/privacy/export-requests/{request_id}/download", governance.Privacy.DownloadExport)
	deps.Router.With(admin).Post("/api/v1/privacy/deletion-requests", governance.Privacy.RequestDeletion)
	deps.Router.With(admin).Post("/api/v1/privacy/requests", governance.Privacy.CreateGenericRequest)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/verify", governance.Privacy.IssueVerification)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/verify/confirm", governance.Privacy.ConfirmVerification)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/hold", governance.Privacy.SetLegalHold)
	deps.Router.With(admin).Delete("/api/v1/privacy/requests/{request_id}/hold", governance.Privacy.ClearLegalHold)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/deny", governance.Privacy.DenyRequest)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/appeal", governance.Privacy.CreateAppeal)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/subprocessors/{subprocessor}/ack", governance.Privacy.RecordSubprocessorAck)

	deps.Router.Group(func(router chi.Router) {
		// Keep incident refusals non-cacheable even when the route-local admin
		// or idempotency boundary returns before a handler is reached. main.go
		// mounts the same conditional guard outside tenant authentication so
		// credential and tenant-resolution failures receive the same policy.
		router.Use(privacy.ProtectIncidentResponses)
		router.Use(admin)
		// Authorization must execute for every attempt, including a cache hit.
		// This inner replay boundary therefore observes the post-auth decision
		// rather than allowing tenant-wide cached responses to bypass it.
		router.Use(governance.PrivacyIncidentIdempotency)
		privacy.MountIncidentRoutes(router, governance.PrivacyIncidents)
		privacy.MountTabletopRoutes(router, governance.PrivacyIncidents)
	})
	privacy.MountDPARoutes(deps.Router, &privacy.DPADeps{
		Pool:             deps.Pool,
		Version:          os.Getenv("POSTWAVE_DPA_VERSION"),
		ProcessorName:    os.Getenv("POSTWAVE_LEGAL_ENTITY"),
		ProcessorAddress: os.Getenv("POSTWAVE_LEGAL_ADDRESS"),
		EUReprName:       os.Getenv("POSTWAVE_EU_REPR_NAME"),
		EUReprAddress:    os.Getenv("POSTWAVE_EU_REPR_ADDRESS"),
	})
	deps.Router.Group(func(router chi.Router) {
		router.Use(admin)
		(&compliance.Deps{Pool: deps.Pool, Logger: deps.Log()}).MountRoutes(router)
	})
}

// MountCommercialAdminRoutes registers agency, cost-ledger, and billing
// administration after the independently scoped audit-sink surface.
func MountCommercialAdminRoutes(deps Deps) {
	governance := deps.TenantGovernance
	if deps.Router == nil || deps.Pool == nil || governance == nil ||
		governance.Cost == nil || governance.Billing == nil {
		return
	}

	agency.MountRoutes(deps.Router, &agency.Deps{Pool: deps.Pool, Logger: deps.Log()})
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(readReports).Get("/api/v1/costs", governance.Cost.Aggregate)
	deps.Router.With(readReports).Get("/api/v1/cost/aggregate", governance.Cost.Aggregate)
	deps.Router.With(readReports).Get("/api/v1/costs/ledger", governance.Cost.Ledger)
	deps.Router.With(readReports).Get("/api/v1/billing/state", governance.Billing.State)
	deps.Router.With(readReports).Get("/api/v1/billing/plan-summary", governance.Billing.PlanSummary)
	deps.Router.With(admin).Post("/api/v1/billing/checkout", governance.Billing.Checkout)
	deps.Router.With(admin).Post("/api/v1/billing/portal", governance.Billing.Portal)
	deps.Router.With(readReports).Get("/api/v1/billing/invoices", governance.Billing.Invoices)
	deps.Router.With(readReports).Get("/api/v1/billing/usage", governance.Billing.Usage)
	// BILL-052: set the metered-overage preference. A mutation → admin scope,
	// matching checkout/portal (readReports would be a privilege bug).
	deps.Router.With(admin).Put("/api/v1/billing/overage", governance.Billing.SetOverage)
}

// MountTenantGovernanceSurface assembles the complete migrated cohort for
// standalone server construction. main.go invokes the focused helpers around
// the existing audit-sink boundary to retain its exact registration position.
func MountTenantGovernanceSurface(deps Deps) {
	governance := deps.TenantGovernance
	if deps.Router == nil || deps.Pool == nil || governance == nil ||
		governance.Security == nil || governance.SendSettings == nil ||
		governance.Paywall == nil || governance.OutboxDLQ == nil ||
		governance.Feedback == nil || governance.Regions == nil ||
		governance.EmailPreview == nil || governance.Privacy == nil ||
		governance.PrivacyIncidents == nil ||
		governance.PrivacyIncidentIdempotency == nil || governance.Cost == nil ||
		governance.Billing == nil {
		return
	}

	MountTenantPolicyRoutes(deps)
	MountPrivacyComplianceRoutes(deps)
	MountCommercialAdminRoutes(deps)
}
