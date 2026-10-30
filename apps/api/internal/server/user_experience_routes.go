// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/activitycursor"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/contact_rating"
	"github.com/postwave/postwave/apps/api/internal/contact_ratings"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/editorcheckpoint"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/mandate"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/operation"
	"github.com/postwave/postwave/apps/api/internal/userprefs"
	"github.com/postwave/postwave/apps/api/internal/webpush"
	"net/http"
)

type UserNotificationRouteDeps struct {
	Router           chi.Router
	Logger           *slog.Logger
	NotificationRepo *notification_feed.Repo
	WebPush          *webpush.Deps
	MobilePush       *mobilepush.Deps
}

type UserNotificationSurface struct {
	Feed       *notification_feed.Deps
	WebPush    *webpush.Deps
	MobilePush *mobilepush.Deps
}

func MountUserNotificationRoutes(deps UserNotificationRouteDeps) UserNotificationSurface {
	if deps.Router == nil || deps.NotificationRepo == nil || deps.WebPush == nil || deps.MobilePush == nil {
		return UserNotificationSurface{}
	}
	feed := &notification_feed.Deps{Repo: deps.NotificationRepo, Logger: deps.Logger}
	feed.MountRoutes(deps.Router)
	deps.WebPush.MountRoutes(deps.Router)
	deps.Router.Group(func(router chi.Router) {
		router.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodSession))
		deps.MobilePush.MountRoutes(router)
	})
	return UserNotificationSurface{Feed: feed, WebPush: deps.WebPush, MobilePush: deps.MobilePush}
}

// ContinuitySurface is the pair that answers "resume where you left off".
type ContinuitySurface struct {
	// Cursor: WHICH entity the person was last on.
	Cursor *activitycursor.Deps
	// Checkpoint: WHAT they had written into it but not saved.
	Checkpoint *editorcheckpoint.Deps
}

// MountContinuityRoutes wires cross-device continuity (Apple-level integration
// Phase 1).
//
// WHY ONE FUNCTION AND NOT TWO. The cursor and the checkpoint are two halves of
// a single answer: the cursor says "you were editing the Spring Sale campaign",
// the checkpoint holds the subject line you had half-typed into it. Mounted
// separately, a later edit can wire one and forget the other, and the failure is
// silent and specific — "Continue — Spring Sale" opens, and the form is empty.
// That is worse than no resume offer at all, because the person believes their
// draft is gone. Pairing them here makes forgetting structurally harder.
//
// Both are per-PERSON signals, so both are gated to session auth. A shared API
// key has no single "last-viewed" entity, and no single owner whose unfinished
// draft it would be reading.
func MountContinuityRoutes(router chi.Router, pool *db.Pool, logger *slog.Logger) ContinuitySurface {
	if router == nil || pool == nil {
		return ContinuitySurface{}
	}
	cursor := &activitycursor.Deps{Repo: &activitycursor.Repo{Pool: pool}, Logger: logger}
	checkpoint := &editorcheckpoint.Deps{Repo: &editorcheckpoint.Repo{Pool: pool}, Logger: logger}
	router.Group(func(r chi.Router) {
		r.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodSession))
		cursor.MountRoutes(r)
		checkpoint.MountRoutes(r)
	})
	return ContinuitySurface{Cursor: cursor, Checkpoint: checkpoint}
}

// MountOperationsRoutes wires the cross-family operations view.
//
// Read-only and tenant-scoped. It reads twenty tables the caller already has
// access to individually — the endpoint adds no reach, only the ability to ask
// one question instead of twenty.
func MountOperationsRoutes(router chi.Router, pool *db.Pool, logger *slog.Logger) *operation.Deps {
	if router == nil || pool == nil {
		return nil
	}
	// Flow runs are ENQUEUED by a reachable path and DRAINED by nothing while
	// the runtime is gated, so `flow_runs` fills with rows correctly stamped
	// `queued` that will never move. In a per-flow view that is unremarkable;
	// here `queued` is the same word every other family uses for work that is
	// about to happen, and a fortnight-old queue reads as a stuck worker there
	// is no point looking for.
	//
	// Registered HERE, at the composition root, rather than from a package
	// `init()`. An init() only runs if something links the package, so the
	// registration would be invisible to any binary that did not happen to
	// import flowbuilder — including the operations package's own tests, where
	// it silently did nothing. A wiring step that depends on linkage is the
	// same "mechanism nothing invokes" failure in a quieter costume.
	//
	// The REASON is read from flowbuilder's own descriptor, not restated, so
	// the day the runtime is switched on this stops claiming otherwise without
	// anyone editing it.
	operation.RegisterBlockedFamily("run.flow", func() *operation.BlockedReason {
		if descriptor := flowbuilder.RuntimeDescriptor(); !descriptor.ExecutionEnabled {
			return &operation.BlockedReason{Code: descriptor.Code, Message: descriptor.Message}
		}
		return nil
	})

	deps := &operation.Deps{Aggregator: &operation.Aggregator{Pool: pool}, Logger: logger}
	deps.MountRoutes(router)
	return deps
}

// MountActionTicketRoutes wires the single-use action-link surface.
//
// UNAUTHENTICATED by design: the ticket IS the credential, because the whole
// point is acting from a place that has no session — an email, a Slack message,
// a push tapped from a lock screen.
//
// `perform` executes an authorised action. Passing nil mounts the routes with
// no executor, which spends a ticket and then reports failure — deliberately
// louder than pretending it worked, and the reason this takes the executor as a
// parameter rather than defaulting it.
func MountActionTicketRoutes(
	router chi.Router, pool *db.Pool, logger *slog.Logger,
	perform func(*http.Request, actionticket.Redeemed) error,
) *actionticket.Deps {
	if router == nil || pool == nil {
		return nil
	}
	deps := &actionticket.Deps{
		Repo:    &actionticket.Repo{Pool: pool},
		Logger:  logger,
		Perform: perform,
	}
	deps.MountRoutes(router)
	return deps
}

// MountAgentMandateRoutes wires the surface a PERSON uses to grant, review and
// withdraw agent authority.
//
// Session-only, enforced in the handlers rather than here: an API key minting
// mandates would let an agent grant itself authority, and a self-issued bound is
// not a bound. The property that makes this governance is that a mandate always
// traces to a person.
func MountAgentMandateRoutes(router chi.Router, pool *db.Pool, logger *slog.Logger) *mandate.Deps {
	if router == nil || pool == nil {
		return nil
	}
	deps := &mandate.Deps{Repo: &mandate.Repo{Pool: pool}, Logger: logger}
	router.Group(func(r chi.Router) {
		r.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodSession))
		deps.MountRoutes(r)
	})
	return deps
}

type SubscriberPersonalizationRouteDeps struct {
	Router chi.Router
	Pool   *db.Pool
	Logger *slog.Logger
}

type SubscriberPersonalizationSurface struct {
	Preferences     *userprefs.Deps
	ManualRatings   *contact_ratings.Deps
	HeuristicRating *contact_rating.Deps
}

func MountSubscriberPersonalizationRoutes(deps SubscriberPersonalizationRouteDeps) SubscriberPersonalizationSurface {
	if deps.Router == nil || deps.Pool == nil {
		return SubscriberPersonalizationSurface{}
	}
	preferences := &userprefs.Deps{Repo: &userprefs.Repo{Pool: deps.Pool}}
	preferences.MountRoutes(deps.Router)
	manualRatings := &contact_ratings.Deps{Repo: &contact_ratings.Repo{Pool: deps.Pool}, Logger: deps.Logger}
	manualRatings.MountRoutes(deps.Router)
	heuristicRating := &contact_rating.Deps{Repo: &contact_rating.Repo{Pool: deps.Pool}, Logger: deps.Logger}
	contact_rating.MountRoutes(deps.Router, heuristicRating)
	return SubscriberPersonalizationSurface{
		Preferences: preferences, ManualRatings: manualRatings, HeuristicRating: heuristicRating,
	}
}
