// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

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

func TestImportAuditAlertRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newImportAuditAlertRouteDeps(actualRouter)
	MountImportAuditAlertRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newImportAuditAlertRouteDeps(referenceRouter)
	mountLegacyImportAuditAlertRoutes(referenceDeps)

	// 19 since GET /api/v1/subscriber-imports/{id}/errors — both the migrated
	// and reference mounts carry it; only this literal was stale.
	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 19, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeAdmin},
		{apikeys.ScopeAuditRead},
		{apikeys.ScopeAuditConfigureSinks},
		{apikeys.ScopeAdmin, apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureSinks},
	})
}

func TestCRMReferenceAndBrandVoiceRoutesMatchEveryLegacyScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCRMReferenceRouteDeps(actualRouter)
	MountCRMReferenceRoutes(actualDeps)
	MountBrandVoiceRoutes(BrandVoiceRouteDeps{Router: actualRouter, Pool: actualDeps.Pool})

	referenceRouter := chi.NewRouter()
	referenceDeps := newCRMReferenceRouteDeps(referenceRouter)
	mountLegacyCRMReferenceAndBrandVoiceRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 12, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeAdmin},
	})
}

func TestOperatorReferenceSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	importDeps := newImportAuditAlertRouteDeps(chi.NewRouter())
	importSurface := MountImportAuditAlertRoutes(importDeps)
	if importSurface.Imports == nil || importSurface.Imports.Pool != importDeps.Pool ||
		importSurface.Imports.Storage != importDeps.Storage || importSurface.Imports.Logger != nil ||
		importSurface.Imports.ExecutionVerification != importDeps.ExecutionVerification ||
		importSurface.Alerts == nil || importSurface.Alerts.Pool != importDeps.Pool || importSurface.Alerts.Logger != importDeps.Logger ||
		importSurface.Channels == nil || importSurface.Channels.Pool != importDeps.Pool {
		t.Fatal("import/audit-alert surface changed pool, storage, or logger identity")
	}

	referenceDeps := newCRMReferenceRouteDeps(chi.NewRouter())
	references := MountCRMReferenceRoutes(referenceDeps)
	if references.Accounts == nil || references.Accounts.Repo == nil || references.Accounts.Repo.Pool != referenceDeps.Pool ||
		references.Accounts.Logger != referenceDeps.Logger || references.Collections == nil || references.Collections.Repo == nil ||
		references.Collections.Repo.Pool != referenceDeps.Pool || references.Collections.Logger != referenceDeps.Logger {
		t.Fatal("CRM reference surface changed pool or logger identity")
	}
	brand := MountBrandVoiceRoutes(BrandVoiceRouteDeps{Router: chi.NewRouter(), Pool: referenceDeps.Pool})
	if brand == nil || brand.Pool != referenceDeps.Pool || brand.Logger != nil {
		t.Fatal("brand-voice surface changed pool or former nil-logger wiring")
	}
}

func TestOperatorReferenceRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	imports := newImportAuditAlertRouteDeps(chi.NewRouter())
	for _, incomplete := range []ImportAuditAlertRouteDeps{
		{Pool: imports.Pool, Logger: imports.Logger, Storage: imports.Storage},
		{Router: chi.NewRouter(), Logger: imports.Logger, Storage: imports.Storage},
		{Router: chi.NewRouter(), Pool: imports.Pool, Logger: imports.Logger},
	} {
		surface := MountImportAuditAlertRoutes(incomplete)
		if surface.Imports != nil || surface.Alerts != nil || surface.Channels != nil {
			t.Fatal("structurally incomplete import/audit dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete import/audit dependencies registered partial routes")
		}
	}

	references := newCRMReferenceRouteDeps(chi.NewRouter())
	for _, incomplete := range []CRMReferenceRouteDeps{
		{Pool: references.Pool, Logger: references.Logger},
		{Router: chi.NewRouter(), Logger: references.Logger},
	} {
		surface := MountCRMReferenceRoutes(incomplete)
		if surface.Accounts != nil || surface.Collections != nil {
			t.Fatal("structurally incomplete CRM reference dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete CRM reference dependencies registered partial routes")
		}
	}
	if got := MountBrandVoiceRoutes(BrandVoiceRouteDeps{Pool: references.Pool}); got != nil {
		t.Fatal("routerless brand-voice dependencies returned a surface")
	}
	brandRouter := chi.NewRouter()
	if got := MountBrandVoiceRoutes(BrandVoiceRouteDeps{Router: brandRouter}); got != nil || routeCount(t, brandRouter) != 0 {
		t.Fatal("poolless brand-voice dependencies returned a surface or registered routes")
	}
}

func TestOperatorReferenceRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("operator_reference_routes.go")
	if err != nil {
		t.Fatalf("read operator_reference_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"subscriber_import.MountRoutes(",
		"audit_alerts.MountRoutes(",
		`Post("/api/v1/audit-alerts/servicenow/auth"`,
		`Post("/api/v1/audit-alerts/jira/auth"`,
		`Post("/api/v1/audit-alerts/pagerduty/auth"`,
		"func MountCRMReferenceRoutes",
		"accounts.MountRoutes(",
		"collections.MountRoutes(",
		"func MountBrandVoiceRoutes",
		"brand_voice.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountSendingIdentityRoutes(",
		"apiserver.MountImportAuditAlertRoutes(",
		"apiserver.MountEditorQueueRoutes(",
		"customfields.MountSettingsRoutes(",
		"apiserver.MountCRMReferenceRoutes(",
		"tenantHeaders :=",
		`Get("/api/v1/voice/profile"`,
		"apiserver.MountBrandVoiceRoutes(",
		`Get("/api/v1/voice/templates"`,
	})
	for _, forbidden := range []string{
		"subscriber_import.MountRoutes(r,",
		"audit_alerts.MountRoutes(r,",
		"auditAlertCh :=",
		"accounts.MountRoutes(r,",
		"collections.MountRoutes(r,",
		"brand_voice.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated operator/reference composition %q", forbidden)
		}
	}
}

type importAuditStorage struct{}

type importExecutionVerifierStub struct{}

func (*importExecutionVerifierStub) CurrentImportVerificationMode(context.Context, string) (string, error) {
	return subscriber_import.ImportVerificationModeOff, nil
}
func (*importExecutionVerifierStub) EnsureImportVerification(context.Context, string, string, string, []string) (subscriber_import.ImportVerificationRun, error) {
	return subscriber_import.ImportVerificationRun{}, nil
}
func (*importExecutionVerifierStub) GetImportVerification(context.Context, string, string, string, string) (subscriber_import.ImportVerificationRun, error) {
	return subscriber_import.ImportVerificationRun{}, nil
}
func (*importExecutionVerifierStub) ActivateImportVerification(context.Context, string, string, string, string) error {
	return nil
}
func (*importExecutionVerifierStub) CancelImportVerification(context.Context, string, string) error {
	return nil
}

func (importAuditStorage) Put(context.Context, string, string, []byte) (string, error) {
	return "https://storage.invalid/object", nil
}

func (importAuditStorage) Open(context.Context, string) (io.ReadCloser, string, error) {
	return io.NopCloser(strings.NewReader("")), "text/csv", nil
}

func (importAuditStorage) Delete(context.Context, string) error { return nil }

func newImportAuditAlertRouteDeps(router chi.Router) ImportAuditAlertRouteDeps {
	return ImportAuditAlertRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Storage: importAuditStorage{},
		ExecutionVerification: &importExecutionVerifierStub{},
	}
}

func newCRMReferenceRouteDeps(router chi.Router) CRMReferenceRouteDeps {
	return CRMReferenceRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func mountLegacyImportAuditAlertRoutes(deps ImportAuditAlertRouteDeps) {
	subscriber_import.MountRoutes(deps.Router, &subscriber_import.Deps{Pool: deps.Pool, Storage: deps.Storage})
	audit_alerts.MountRoutes(deps.Router, &audit_alerts.Deps{Pool: deps.Pool, Logger: deps.Logger})
	channels := &handlers.AuditAlertChannelHandlers{Pool: deps.Pool}
	configure := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/servicenow/auth", channels.VerifyServiceNow)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/jira/auth", channels.VerifyJira)
	deps.Router.With(configure).Post("/api/v1/audit-alerts/pagerduty/auth", channels.VerifyPagerDuty)
}

func mountLegacyCRMReferenceAndBrandVoiceRoutes(deps CRMReferenceRouteDeps) {
	accounts.MountRoutes(deps.Router, &accounts.Deps{Repo: &accounts.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	collections.MountRoutes(deps.Router, &collections.Deps{Repo: &collections.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	brand_voice.MountRoutes(deps.Router, &brand_voice.Deps{Pool: deps.Pool})
}
