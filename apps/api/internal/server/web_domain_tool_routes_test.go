// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/custom_domains"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dmarc"
	"github.com/postwave/postwave/apps/api/internal/email_template"
	"github.com/postwave/postwave/apps/api/internal/link_checker"
)

func TestWebDomainToolRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	pool := &db.Pool{}
	MountWebDomainToolRoutes(WebDomainToolRouteDeps{Router: actualRouter, Pool: pool})

	referenceRouter := chi.NewRouter()
	mountLegacyWebDomainToolRoutes(referenceRouter, pool)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 12, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
	})
}

func TestWebDomainToolSurfacePreservesDependencyShapeAndRejectsStructuralNil(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	surface := MountWebDomainToolRoutes(WebDomainToolRouteDeps{Router: chi.NewRouter(), Pool: pool, Logger: logger})
	if surface.DMARC == nil || surface.DMARC.Pool != pool || surface.DMARC.Logger != logger ||
		surface.EmailTemplate == nil || surface.CustomDomains == nil || surface.CustomDomains.Repo == nil ||
		surface.CustomDomains.Repo.Pool != pool || surface.CustomDomains.Resolver == nil || surface.CustomDomains.Logger != nil ||
		surface.CustomDomains.RegistrationEnabled || surface.CustomDomains.VerificationEnabled || surface.CustomDomains.RemovalEnabled ||
		surface.LinkChecker == nil || surface.LinkChecker.Pool != pool || surface.LinkChecker.Client != nil || surface.LinkChecker.Logger != nil {
		t.Fatal("web/domain tool surface changed pool, resolver, client, or logger wiring")
	}
	if got := MountWebDomainToolRoutes(WebDomainToolRouteDeps{Pool: pool}); got.DMARC != nil {
		t.Fatal("routerless web/domain dependencies returned a surface")
	}
	router := chi.NewRouter()
	if got := MountWebDomainToolRoutes(WebDomainToolRouteDeps{Router: router}); got.DMARC != nil || routeCount(t, router) != 0 {
		t.Fatal("poolless web/domain dependencies returned a surface or registered routes")
	}
}

func TestWebDomainToolRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("web_domain_tool_routes.go")
	if err != nil {
		t.Fatalf("read web_domain_tool_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"dmarcRoutes.MountRoutes(",
		"templateRoutes.MountRoutes(",
		"domainRoutes.MountRoutes(",
		"linkRoutes.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"inboundEmailDeps.MountRouteAdminRoutes(",
		"apiserver.MountWebDomainToolRoutes(",
		"archiveAdminRepo :=",
	})
	for _, forbidden := range []string{
		"dmarc.Deps{Pool: pool}",
		"email_template.Deps{}",
		"custom_domains.Deps{",
		"link_checker.Deps{Pool: pool}",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated web/domain composition %q", forbidden)
		}
	}
}

func mountLegacyWebDomainToolRoutes(router chi.Router, pool *db.Pool) {
	(&dmarc.Deps{Pool: pool}).MountRoutes(router)
	(&email_template.Deps{}).MountRoutes(router)
	(&custom_domains.Deps{
		Repo: &custom_domains.Repo{Pool: pool}, Resolver: custom_domains.DefaultResolver(),
	}).MountRoutes(router)
	(&link_checker.Deps{Pool: pool}).MountRoutes(router)
}
