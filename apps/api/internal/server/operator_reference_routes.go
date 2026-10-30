// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/accounts"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit_alerts"
	"github.com/postwave/postwave/apps/api/internal/brand_voice"
	"github.com/postwave/postwave/apps/api/internal/collections"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/subscriber_import"
)

type ImportAuditAlertRouteDeps struct {
	Router  chi.Router
	Pool    *db.Pool
	Logger  *slog.Logger
	Storage subscriber_import.Storage
	// Verification, when set, adds the credit-cost + list-quality
	// projection to the import dry-run preview.
	Verification subscriber_import.ImportProjector
	// ExecutionVerification enforces the frozen policy during confirmed imports.
	ExecutionVerification subscriber_import.ImportExecutionVerifier
}

type ImportAuditAlertSurface struct {
	Imports  *subscriber_import.Deps
	Alerts   *audit_alerts.Deps
	Channels *handlers.AuditAlertChannelHandlers
}

func MountImportAuditAlertRoutes(deps ImportAuditAlertRouteDeps) ImportAuditAlertSurface {
	if deps.Router == nil || deps.Pool == nil || deps.Storage == nil {
		return ImportAuditAlertSurface{}
	}
	// Logger is deliberately NOT passed: TestOperatorReferenceSurfacesPreserveDependencyIdentity
	// pins it nil for this surface (unlike Alerts, which does receive one).
	// The verification projection degrades silently anyway — it nil-guards
	// its own logging and omits the preview section on failure.
	imports := &subscriber_import.Deps{
		Pool: deps.Pool, Storage: deps.Storage, Verification: deps.Verification,
		ExecutionVerification: deps.ExecutionVerification,
	}
	subscriber_import.MountRoutes(deps.Router, imports)
	alerts := &audit_alerts.Deps{Pool: deps.Pool, Logger: deps.Logger}
	audit_alerts.MountRoutes(deps.Router, alerts)
	channels := &handlers.AuditAlertChannelHandlers{Pool: deps.Pool}
	configure := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/servicenow/auth", channels.VerifyServiceNow)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/jira/auth", channels.VerifyJira)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/pagerduty/auth", channels.VerifyPagerDuty)
	return ImportAuditAlertSurface{Imports: imports, Alerts: alerts, Channels: channels}
}

type CRMReferenceRouteDeps struct {
	Router chi.Router
	Pool   *db.Pool
	Logger *slog.Logger
}

type CRMReferenceSurface struct {
	Accounts    *accounts.Deps
	Collections *collections.Deps
}

func MountCRMReferenceRoutes(deps CRMReferenceRouteDeps) CRMReferenceSurface {
	if deps.Router == nil || deps.Pool == nil {
		return CRMReferenceSurface{}
	}
	accountRoutes := &accounts.Deps{Repo: &accounts.Repo{Pool: deps.Pool}, Logger: deps.Logger}
	accounts.MountRoutes(deps.Router, accountRoutes)
	collectionRoutes := &collections.Deps{Repo: &collections.Repo{Pool: deps.Pool}, Logger: deps.Logger}
	collections.MountRoutes(deps.Router, collectionRoutes)
	return CRMReferenceSurface{Accounts: accountRoutes, Collections: collectionRoutes}
}

type BrandVoiceRouteDeps struct {
	Router chi.Router
	Pool   *db.Pool
}

func MountBrandVoiceRoutes(deps BrandVoiceRouteDeps) *brand_voice.Deps {
	if deps.Router == nil || deps.Pool == nil {
		return nil
	}
	brandVoice := &brand_voice.Deps{Pool: deps.Pool}
	brand_voice.MountRoutes(deps.Router, brandVoice)
	return brandVoice
}
