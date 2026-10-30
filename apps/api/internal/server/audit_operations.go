// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit/agent"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AuditOperationsDeps preserves the already-assembled handler identities used
// by adjacent public portal routes, NLQ configuration, and background exports.
type AuditOperationsDeps struct {
	Handlers *handlers.AuditHandlers
	Portal   *handlers.AuditPortalHandlers
}

type auditRouteGates struct {
	read    func(http.Handler) http.Handler
	raw     func(http.Handler) http.Handler
	execute func(http.Handler) http.Handler
	meta    func(middleware.AuditReadKind) func(http.Handler) http.Handler
}

func newAuditRouteGates(deps Deps) auditRouteGates {
	return auditRouteGates{
		read: apikeys.RequireScope(apikeys.ScopeAuditRead),
		raw: apikeys.RequireAllScopes(
			apikeys.ScopeAuditRead,
			apikeys.ScopeAuditReadPII,
		),
		execute: apikeys.RequireAllScopes(
			apikeys.ScopeAuditRead,
			apikeys.ScopeAuditReadPII,
			apikeys.ScopeAuditExecuteActions,
		),
		meta: func(kind middleware.AuditReadKind) func(http.Handler) http.Handler {
			return middleware.AuditMetaMiddleware(deps.Pool, kind)
		},
	}
}

func mountAuditCoreRoutes(router chi.Router, audit *handlers.AuditHandlers, gates auditRouteGates) {
	router.With(gates.raw, gates.meta(middleware.AuditReadList)).Get("/api/v1/audit", audit.List)
	router.With(gates.raw, gates.meta(middleware.AuditReadExport)).Get("/api/v1/audit/export", audit.Export)
	router.With(gates.raw).Get("/api/v1/audit/export/manifests", audit.ListExportManifests)
	router.With(gates.raw, gates.meta(middleware.AuditReadStats)).Get("/api/v1/audit/stats", audit.Stats)
	// The chain for one request id returns full audit rows. A request id is
	// correlation data, not a capability, so the raw-evidence gate applies.
	router.With(gates.raw, gates.meta(middleware.AuditReadList)).
		Get("/api/v1/audit/chain/{requestId}", audit.AuditChain)
	router.With(gates.raw, gates.meta(middleware.AuditReadStreamOpen)).Get("/api/v1/audit/stream", audit.Stream)
	router.With(gates.raw, gates.meta(middleware.AuditReadSavedViews)).Get("/api/v1/audit/saved-views", audit.ListSavedViews)
	router.With(gates.execute).Post("/api/v1/audit/saved-views", audit.CreateSavedView)
	router.With(gates.execute).Patch("/api/v1/audit/saved-views/{id}", audit.UpdateSavedView)
	router.With(gates.execute).Delete("/api/v1/audit/saved-views/{id}", audit.DeleteSavedView)
	router.With(gates.read, gates.meta(middleware.AuditReadRetention)).Get("/api/v1/audit/retention", audit.GetRetention)
	router.With(apikeys.RequireAllScopes(apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureRetention)).
		Put("/api/v1/audit/retention", audit.SetRetention)
	router.With(gates.execute).Post("/api/v1/audit/nlq", audit.QueryNaturalLanguage)
	router.With(gates.read).Get("/api/v1/audit/nlq/cost-status", audit.NLQCostStatus)
}

func mountAuditInvestigationRoutes(deps Deps, gates auditRouteGates) {
	audit := deps.AuditOperations.Handlers
	rbac := &handlers.AuditRBACHandlers{Pool: deps.Pool, Logger: deps.Log()}
	deps.Router.Get("/api/v1/audit/my-scopes", rbac.MyScopes)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/roles", rbac.ListRoles)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/roles/{id}/scopes", rbac.UpdateRoleScopes)
	// G-48 custom-role create/delete, same ScopeAdmin gate as the list/scope
	// routes (mirrored in mountLegacyAuditOperationsSurface for the parity
	// guard; route-authz manifest entries added).
	handlers.MountRoleCRUD(deps.Router, rbac)

	proofs := handlers.NewProofHandlers(deps.Pool)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/checkpoint/latest", proofs.LatestCheckpoint)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/consistency-proof", proofs.ConsistencyProof)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/{id}/inclusion-proof", proofs.InclusionProof)
	deps.Router.With(gates.raw).Get("/api/v1/audit/{id}/session-replay", audit.SessionReplay)
	deps.Router.With(gates.raw).Get("/api/v1/audit/{id}/anomaly-score", audit.AnomalyScore)
	deps.Router.With(gates.raw).Get("/api/v1/audit/anomalies/recent", audit.RecentAnomalies)

	investigations := &handlers.AuditInvestigationHandlers{
		Investigator: agent.NewInvestigator(deps.Pool),
		Store:        &agent.Store{Pool: deps.Pool},
		Logger:       deps.Log(),
	}
	deps.Router.With(gates.execute).Post("/api/v1/audit/{id}/investigate", investigations.Trigger)
	deps.Router.With(gates.raw).Get("/api/v1/audit/investigations", investigations.List)
	deps.Router.With(gates.raw).Get("/api/v1/audit/investigations/{id}", investigations.Get)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/investigations/{id}/approve", investigations.Approve)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/investigations/{id}/reject", investigations.Reject)
	deps.Router.With(gates.raw).Get("/api/v1/audit/investigations/{id}/stream", investigations.Stream)
}

func mountAuditEvidenceRoutes(deps Deps, gates auditRouteGates) {
	audit := deps.AuditOperations.Handlers
	portal := deps.AuditOperations.Portal
	deps.Router.With(gates.raw).Get("/api/v1/audit/ai-session/{session_id}/aivs-bundle", audit.AIVSBundle)
	deps.Router.With(gates.read).Get("/api/v1/audit/redaction-policies", audit.GetRedactionPolicy)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/audit/redaction-policies", audit.PutRedactionPolicy)
	deps.Router.With(gates.execute).Post("/api/v1/audit/{id}/unmask", audit.UnmaskPII)
	deps.Router.With(gates.raw).Get("/api/v1/audit/retention-activity", audit.ListRetentionActivity)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/audit/{id}/retention-override", audit.SetRetentionOverride)
	deps.Router.With(gates.raw).Get("/api/v1/audit/count", audit.Count)
	deps.Router.With(gates.execute).Post("/api/v1/audit/export-async", audit.ExportAsync)
	deps.Router.With(gates.raw).Get("/api/v1/audit/export-jobs", audit.ListExportJobs)
	deps.Router.With(gates.raw).Get("/api/v1/audit/export-jobs/{id}", audit.GetExportJob)
	deps.Router.With(gates.raw).Get("/api/v1/audit/export-jobs/{id}/download", audit.DownloadExportJob)
	deps.Router.With(gates.raw).Get("/api/v1/audit/export-schedules", audit.ListExportSchedules)
	deps.Router.With(apikeys.RequireAllScopes(
		apikeys.ScopeAuditRead,
		apikeys.ScopeAuditReadPII,
		apikeys.ScopeAuditConfigureSinks,
	)).
		Post("/api/v1/audit/export-schedules", audit.CreateExportSchedule)
	deps.Router.With(apikeys.RequireAllScopes(
		apikeys.ScopeAuditRead,
		apikeys.ScopeAuditReadPII,
		apikeys.ScopeAuditConfigureSinks,
	)).
		Delete("/api/v1/audit/export-schedules/{id}", audit.DeleteExportSchedule)
	deps.Router.With(gates.raw, gates.meta(middleware.AuditReadList)).Get("/api/v1/audit/events", audit.EventsByIDs)
	deps.Router.Post("/api/v1/audit/access-requests", audit.CreateAccessRequest)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/access-requests", audit.ListAccessRequests)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/audit/access-requests/{id}", audit.ResolveAccessRequest)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/portal/sessions", portal.CreateSession)
	deps.Router.With(gates.raw).Get("/api/v1/audit/portal/sessions", portal.ListSessions)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/audit/portal/sessions/{id}", portal.RevokeSession)
}

// MountAuditOperationsSurface registers the complete authenticated audit read,
// RBAC, proof, investigation, evidence-export, and portal-administration
// surface in the exact order formerly embedded in main.go.
func MountAuditOperationsSurface(deps Deps) {
	if deps.Router == nil || deps.Pool == nil || deps.AuditOperations == nil ||
		deps.AuditOperations.Handlers == nil || deps.AuditOperations.Portal == nil {
		return
	}

	gates := newAuditRouteGates(deps)
	mountAuditCoreRoutes(deps.Router, deps.AuditOperations.Handlers, gates)
	mountAuditInvestigationRoutes(deps, gates)
	mountAuditEvidenceRoutes(deps, gates)
}
