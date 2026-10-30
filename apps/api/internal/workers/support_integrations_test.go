// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
)

func TestSupportIntegrationBackfillRegistrationsAreReleaseHeld(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	repository := &support_integrations.Repo{}
	dependencies := &support_integrations.Deps{Repo: repository, Logger: logger}
	backfillers := []server.SupportIntegrationBackfill{
		{
			Name:       "zendesk",
			Provider:   support_integrations.ProviderZendesk,
			Backfiller: support_integrations.ZendeskRESTBackfiller{},
		},
		{
			Name:       "intercom",
			Provider:   support_integrations.ProviderIntercom,
			Backfiller: support_integrations.IntercomRESTBackfiller{},
		},
	}
	surface := server.SupportIntegrationsSurface{
		Repository:   repository,
		Dependencies: dependencies,
		Backfills:    backfillers,
	}

	if registrations := supportIntegrationBackfillRegistrations(surface); len(registrations) != 0 {
		t.Fatalf("release-held surface returned %d runnable registrations", len(registrations))
	}

	// Starting the held plane must return synchronously and must not recover a
	// worker from the otherwise complete dependency graph.
	StartSupportIntegrationBackfills(context.Background(), logger, surface)
}

func TestSupportIntegrationBackfillRegistrationsRemainHeldForEverySurfaceShape(t *testing.T) {
	t.Parallel()

	for _, surface := range []server.SupportIntegrationsSurface{
		{},
		{Repository: &support_integrations.Repo{}},
		{Dependencies: &support_integrations.Deps{}},
	} {
		if registrations := supportIntegrationBackfillRegistrations(surface); registrations != nil {
			t.Fatalf("incomplete surface returned %d registrations", len(registrations))
		}
	}
}
