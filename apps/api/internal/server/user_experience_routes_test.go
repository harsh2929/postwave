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
	"github.com/postwave/postwave/apps/api/internal/contact_rating"
	"github.com/postwave/postwave/apps/api/internal/contact_ratings"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/userprefs"
	"github.com/postwave/postwave/apps/api/internal/webpush"
)

func TestUserNotificationRoutesMatchEveryLegacyRouteAndBoundary(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newUserNotificationRouteDeps(actualRouter)
	MountUserNotificationRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newUserNotificationRouteDeps(referenceRouter)
	mountLegacyUserNotificationRoutes(referenceDeps)

	// 15 = 6 feed + 4 web push + 5 mobile push. The mobile group grew by the
	// quiet-hours window (SHELL#12) and the test-send probe (SHELL#13); the feed
	// group grew by the two delivery-visibility reads (ECO-05):
	//
	//   GET /api/v1/notifications/deliveries
	//   GET /api/v1/notifications/{id}/deliveries
	//
	// which answer "why didn't I get that?" — four delivery ledgers existed and
	// nothing read them, so a notification withheld by preference and one that
	// failed at the provider were the same silence. All of them stay inside the
	// session-only group, which is what this test guards.
	//
	// Both sides moved together (15/15), so the parity this test exists for was
	// never in question; only the absolute count needed re-stating. It is
	// asserted rather than derived on purpose — the point is to notice when a
	// route appears, not to accept whatever is there.
	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 15, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
	})
}

func TestSubscriberPersonalizationRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSubscriberPersonalizationRouteDeps(actualRouter)
	MountSubscriberPersonalizationRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSubscriberPersonalizationRouteDeps(referenceRouter)
	mountLegacySubscriberPersonalizationRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 6, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers},
	})
}

func TestUserExperienceSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	notificationDeps := newUserNotificationRouteDeps(chi.NewRouter())
	notifications := MountUserNotificationRoutes(notificationDeps)
	if notifications.Feed == nil || notifications.Feed.Repo != notificationDeps.NotificationRepo ||
		notifications.Feed.Logger != notificationDeps.Logger || notifications.WebPush != notificationDeps.WebPush ||
		notifications.MobilePush != notificationDeps.MobilePush {
		t.Fatal("notification surface changed feed, logger, web-push, or mobile-push identity")
	}

	personalizationDeps := newSubscriberPersonalizationRouteDeps(chi.NewRouter())
	personalization := MountSubscriberPersonalizationRoutes(personalizationDeps)
	if personalization.Preferences == nil || personalization.Preferences.Repo == nil ||
		personalization.Preferences.Repo.Pool != personalizationDeps.Pool || personalization.Preferences.Logger != nil ||
		personalization.ManualRatings == nil || personalization.ManualRatings.Repo == nil ||
		personalization.ManualRatings.Repo.Pool != personalizationDeps.Pool || personalization.ManualRatings.Logger != personalizationDeps.Logger ||
		personalization.HeuristicRating == nil || personalization.HeuristicRating.Repo == nil ||
		personalization.HeuristicRating.Repo.Pool != personalizationDeps.Pool || personalization.HeuristicRating.Logger != personalizationDeps.Logger {
		t.Fatal("subscriber personalization surface changed pool or logger identity")
	}
}

func TestUserExperienceRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	notifications := newUserNotificationRouteDeps(chi.NewRouter())
	for _, incomplete := range []UserNotificationRouteDeps{
		{Logger: notifications.Logger, NotificationRepo: notifications.NotificationRepo, WebPush: notifications.WebPush, MobilePush: notifications.MobilePush},
		{Router: chi.NewRouter(), Logger: notifications.Logger, WebPush: notifications.WebPush, MobilePush: notifications.MobilePush},
		{Router: chi.NewRouter(), Logger: notifications.Logger, NotificationRepo: notifications.NotificationRepo, MobilePush: notifications.MobilePush},
		{Router: chi.NewRouter(), Logger: notifications.Logger, NotificationRepo: notifications.NotificationRepo, WebPush: notifications.WebPush},
	} {
		surface := MountUserNotificationRoutes(incomplete)
		if surface.Feed != nil || surface.WebPush != nil || surface.MobilePush != nil {
			t.Fatal("structurally incomplete notification dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete notification dependencies registered partial routes")
		}
	}

	personalization := newSubscriberPersonalizationRouteDeps(chi.NewRouter())
	for _, incomplete := range []SubscriberPersonalizationRouteDeps{
		{Pool: personalization.Pool, Logger: personalization.Logger},
		{Router: chi.NewRouter(), Logger: personalization.Logger},
	} {
		surface := MountSubscriberPersonalizationRoutes(incomplete)
		if surface.Preferences != nil || surface.ManualRatings != nil || surface.HeuristicRating != nil {
			t.Fatal("structurally incomplete personalization dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete personalization dependencies registered partial routes")
		}
	}
}

func TestUserExperienceRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("user_experience_routes.go")
	if err != nil {
		t.Fatalf("read user_experience_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"feed.MountRoutes(",
		"deps.WebPush.MountRoutes(",
		"RequireAuthMethod(apikeys.AuthMethodSession)",
		"deps.MobilePush.MountRoutes(",
		"func MountSubscriberPersonalizationRoutes",
		"preferences.MountRoutes(",
		"manualRatings.MountRoutes(",
		"contact_rating.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountAuthenticatedAuthRoutes(",
		"apiserver.MountUserNotificationRoutes(",
		"apiserver.MountAdminIPRoutes(",
		"apiserver.MountMergeFieldRoutes(",
		"apiserver.MountSubscriberPersonalizationRoutes(",
		"flowBuilderRepo :=",
	})
	for _, forbidden := range []string{
		"notification_feed.Deps{Repo: notificationFeedRepo",
		"webpushDeps.MountRoutes(r)",
		"mobilePushDeps.MountRoutes(pr)",
		"userPrefsDeps :=",
		"contactRatingsDeps :=",
		"contact_rating.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated user-experience composition %q", forbidden)
		}
	}
}

func newUserNotificationRouteDeps(router chi.Router) UserNotificationRouteDeps {
	return UserNotificationRouteDeps{
		Router: router, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		NotificationRepo: &notification_feed.Repo{Pool: &db.Pool{}}, WebPush: &webpush.Deps{}, MobilePush: &mobilepush.Deps{},
	}
}

func newSubscriberPersonalizationRouteDeps(router chi.Router) SubscriberPersonalizationRouteDeps {
	return SubscriberPersonalizationRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func mountLegacyUserNotificationRoutes(deps UserNotificationRouteDeps) {
	(&notification_feed.Deps{Repo: deps.NotificationRepo, Logger: deps.Logger}).MountRoutes(deps.Router)
	deps.WebPush.MountRoutes(deps.Router)
	deps.Router.Group(func(router chi.Router) {
		router.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodSession))
		deps.MobilePush.MountRoutes(router)
	})
}

func mountLegacySubscriberPersonalizationRoutes(deps SubscriberPersonalizationRouteDeps) {
	(&userprefs.Deps{Repo: &userprefs.Repo{Pool: deps.Pool}}).MountRoutes(deps.Router)
	(&contact_ratings.Deps{Repo: &contact_ratings.Repo{Pool: deps.Pool}, Logger: deps.Logger}).MountRoutes(deps.Router)
	contact_rating.MountRoutes(deps.Router, &contact_rating.Deps{
		Repo: &contact_rating.Repo{Pool: deps.Pool}, Logger: deps.Logger,
	})
}
