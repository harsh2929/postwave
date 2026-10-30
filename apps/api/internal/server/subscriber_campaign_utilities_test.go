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
	"github.com/postwave/postwave/apps/api/internal/campaign_clone"
	"github.com/postwave/postwave/apps/api/internal/control_group"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dedupeinfo"
	"github.com/postwave/postwave/apps/api/internal/email_validator"
	"github.com/postwave/postwave/apps/api/internal/feature_flags"
	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/html2text"
	"github.com/postwave/postwave/apps/api/internal/recipient_tz_send"
	"github.com/postwave/postwave/apps/api/internal/soft_bounce_recovery"
	"github.com/postwave/postwave/apps/api/internal/spam_trap_guard"
	"github.com/postwave/postwave/apps/api/internal/subscriber_dedupe"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/utm_tagging"
)

func TestSubscriberCampaignUtilitiesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSubscriberCampaignUtilitiesDeps(actualRouter)
	MountSubscriberProtectionUtilities(actualDeps)
	MountCampaignDeliveryUtilities(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSubscriberCampaignUtilitiesDeps(referenceRouter)
	mountLegacySubscriberCampaignUtilities(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 38 {
		t.Fatalf("subscriber/campaign utility route count = %d, want 38", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadSubscribers},
			{apikeys.ScopeWriteSubscribers},
			{apikeys.ScopeWriteCampaigns},
			{apikeys.ScopeAdmin},
			{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers, apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin},
		} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestSubscriberProtectionPreservesWorkerAndSharedDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newSubscriberCampaignUtilitiesDeps(chi.NewRouter())
	surface := MountSubscriberProtectionUtilities(deps)
	if surface.SpamTrapWorker == nil || surface.SpamTrapWorker.Pool != deps.Pool ||
		surface.SpamTrapWorker.Logger != deps.Logger || surface.SpamTrapWorker.Suppressions != deps.Suppressions {
		t.Fatal("spam-trap worker changed route-shared dependency identity")
	}
	for _, incomplete := range []SubscriberCampaignUtilitiesDeps{
		{Pool: deps.Pool},
		{Router: chi.NewRouter()},
	} {
		surface := MountSubscriberProtectionUtilities(incomplete)
		MountCampaignDeliveryUtilities(incomplete)
		if surface.SpamTrapWorker != nil {
			t.Fatal("structurally incomplete dependencies returned a worker")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete dependencies registered partial routes")
		}
	}
}

func TestSubscriberCampaignUtilityRegistrationOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("subscriber_campaign_utilities.go")
	if err != nil {
		t.Fatalf("read subscriber_campaign_utilities.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"email_validator.MountRoutes(",
		"holdout.MountRoutes(",
		"control_group.MountRoutes(",
		"subscriber_dedupe.MountRoutes(",
		"dedupeinfo.MountRoutes(",
		"soft_bounce_recovery.MountRoutes(",
		"spam_trap_guard.MountRoutes(",
		"utm_tagging.MountRoutes(",
		"recipient_tz_send.MountRoutes(",
		"campaign_clone.MountRoutes(",
		"html2text.MountRoutes(",
		"feature_flags.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiworkers.StartSupportIntegrationBackfills(",
		"apiserver.MountSubscriberProtectionUtilities(",
		"apiworkers.StartSpamTrapGuard(",
		"apiserver.MountCampaignDeliveryUtilities(",
		"apiserver.MountDeliverabilitySurface(",
	})
	for _, forbidden := range []string{
		"email_validator.MountRoutes(r,",
		"spam_trap_guard.MountRoutes(r,",
		"spamTrapWorker :=",
		"utm_tagging.MountRoutes(r,",
		"feature_flags.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated subscriber/campaign utility composition %q", forbidden)
		}
	}
}

func newSubscriberCampaignUtilitiesDeps(router chi.Router) SubscriberCampaignUtilitiesDeps {
	pool := &db.Pool{}
	return SubscriberCampaignUtilitiesDeps{
		Router:       router,
		Pool:         pool,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Suppressions: &suppressions.Store{Pool: pool},
	}
}

func mountLegacySubscriberCampaignUtilities(deps SubscriberCampaignUtilitiesDeps) {
	email_validator.MountRoutes(deps.Router, &email_validator.Deps{})
	holdout.MountRoutes(deps.Router, &holdout.Deps{Pool: deps.Pool})
	control_group.MountRoutes(deps.Router, &control_group.Deps{Repo: &control_group.Repo{Pool: deps.Pool}})
	subscriber_dedupe.MountRoutes(deps.Router, &subscriber_dedupe.Deps{Pool: deps.Pool})
	dedupeinfo.MountRoutes(deps.Router, &dedupeinfo.Deps{Repo: &dedupeinfo.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	soft_bounce_recovery.MountRoutes(deps.Router, &soft_bounce_recovery.Deps{Pool: deps.Pool})
	spam_trap_guard.MountRoutes(deps.Router, &spam_trap_guard.Deps{Pool: deps.Pool, Suppressions: deps.Suppressions})
	utm_tagging.MountRoutes(deps.Router, &utm_tagging.Deps{Pool: deps.Pool})
	recipient_tz_send.MountRoutes(deps.Router, &recipient_tz_send.Deps{Pool: deps.Pool})
	campaign_clone.MountRoutes(deps.Router, &campaign_clone.Deps{Pool: deps.Pool})
	html2text.MountRoutes(deps.Router, &html2text.Deps{})
	feature_flags.MountRoutes(deps.Router, &feature_flags.Deps{Pool: deps.Pool})
}
