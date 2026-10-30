// SPDX-License-Identifier: AGPL-3.0-only
//
// Package server is a thin assembly layer for the API HTTP surface.
//
// Today, apps/api/main.go is a 7000+ LoC monolith that wires every
// internal package against a single chi.Router. The goal of this
// package is to give us a stable seam where route-mount blocks can be
// migrated piece-by-piece out of main.go without ever requiring a "big
// bang" refactor. Each migration moves one self-contained
// `<pkg>.MountRoutes(r, &<pkg>.Deps{...})` group into a Mount* method
// here and deletes the corresponding lines in main.go.
//
// The contract is intentionally minimal:
//   - main.go builds a Deps value (or boot.Init does it later) that
//     carries every dependency the mounted packages need.
//   - server.New(deps) wires those mounts onto deps.Router and returns
//     an *http.Server ready to start.
//   - Workers (long-running goroutines) live in the workers package so
//     they can share Deps but be started independently.
//
// Migration plan: see apps/api/MIGRATION.md.
package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/admin"
	"github.com/postwave/postwave/apps/api/internal/apidocs"
	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/scim"
	"github.com/postwave/postwave/apps/api/internal/segments"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

// Deps is the dependency bag every mounted package draws from.
//
// Fields are added on demand as mount blocks are migrated out of
// main.go. Avoid adding fields speculatively — each new field forces
// every caller (main.go + tests) to populate it. Add the field in the
// same PR as the mount block that needs it.
type Deps struct {
	// Router is the root chi.Router. Mount* methods attach handlers
	// directly onto it (or onto a sub-router) so the public route
	// surface stays identical to the pre-migration main.go.
	Router chi.Router

	// Pool is the shared pgxpool wrapper. All migrated packages take
	// this rather than constructing their own pool — connection
	// budgets are global.
	Pool *db.Pool

	// Bus is the in-process event bus used for cross-package
	// notifications (e.g. deliverability_hub emitting list_health
	// degradation events). Optional — packages should tolerate a nil
	// bus during boot.
	Bus *events.Bus

	// Logger is the structured logger that mounts thread through to
	// their handlers and workers. Defaults to slog.Default() when nil.
	Logger *slog.Logger

	// TagHistory is shared with the canonical tags surface so taxonomy
	// mutations emit through the same webhook and flow-trigger pipeline.
	TagHistory *tags.History

	// Subscribers, Lists, and Segments are the already-assembled dependency
	// graphs shared by their HTTP routes and adjacent workers. Keeping these as
	// typed pointers preserves repository, provider, limiter, and event-emitter
	// identity while their mount calls move out of main.go.
	Subscribers     *subscribers.Deps
	Lists           *lists.Deps
	IdempotentLists *lists.Deps
	Segments        *segments.Deps

	// SegmentDecayStore is shared by the decay HTTP surface and its worker so
	// both observe the same store implementation and connection pool.
	SegmentDecayStore *segments.DecayRepo

	// Campaigns and its companion dependency graphs are assembled in the
	// composition root because they share repositories, late-bound A/B reply
	// counters, warmup gates, suppression stores, and provider clients with
	// workers and adjacent HTTP surfaces.
	Campaigns             *campaigns.Deps
	CampaignTemplates     *campaigntemplates.Deps
	CampaignABTests       *abtests.Deps
	SendTimeOptimization  *send_time_opt.Deps
	CampaignAudienceCount *campaigns.AudienceCountDeps
	CampaignSendPreview   *campaigns.SendPreviewDeps
	CampaignSend          *campaigns.SendDeps

	// Identity and API dependencies are assembled in the composition root so
	// authentication repositories, API-key call recording, OAuth state,
	// encryption, and worker-facing stores keep their process-wide identity.
	// AuthBruteforceMiddleware is the shared distributed limiter applied at the
	// individual token-verification and short-code boundaries.
	Auth                     *auth.Deps
	OAuth                    *auth.OAuthDeps
	AuthBruteforceMiddleware func(http.Handler) http.Handler
	APIKeys                  *apikeys.Deps
	APIKeyCalls              *apikeycalls.Deps
	APIDocs                  *apidocs.Deps
	SCIMAdmin                *scim.Deps
	SCIMPublic               *scim.Deps
	AuditSinkAdmin           *auditsink.AdminDeps
	AdminKMS                 *admin.Deps
	SpamCorpusAdmin          *admin.SpamCorpusDeps

	// AuditOperations retains the read-side audit and portal handler graphs
	// shared with public portal routes, NLQ setup, and background export work.
	// Route-local RBAC, proof, and investigation handlers remain assembled by
	// the server helper from the shared pool.
	AuditOperations *AuditOperationsDeps

	// TenantGovernance is the already-assembled handler graph for workspace
	// policy, privacy/compliance, and commercial administration. Keeping these
	// handlers typed preserves the repositories shared with billing webhooks,
	// privacy workers, and public paid-content routes while their authenticated
	// registrations move out of main.go.
	TenantGovernance *TenantGovernanceDeps

	// AudienceActivation supplies the shared secrets, suppression, transport,
	// and marketing-credential dependencies used to assemble the audience-sync,
	// consent-firewall, and reverse-ETL graph. The mount helper returns the
	// resulting identities for adjacent workers and zero-copy activation.
	AudienceActivation *AudienceActivationDeps

	// SupportIntegrations supplies the process-wide subscriber, secret, and
	// managed-credential dependencies used by the customer-support provider
	// graph. The mount helper returns the exact repos, provider clients, and
	// worker registrations so HTTP and background syncs cannot drift apart.
	SupportIntegrations *SupportIntegrationsDeps

	// CustomerLifecycleIntegrations supplies review-media storage, subscriber
	// identity, flow events, and provider secrets for the review, loyalty, and
	// subscription integration graph shared by HTTP and native backfill workers.
	CustomerLifecycleIntegrations *CustomerLifecycleIntegrationsDeps

	// HTTPAddr is the listen address passed to the returned
	// *http.Server. Defaults to ":9000" when empty (matches main.go).
	HTTPAddr string

	// ReadHeaderTimeout, ReadTimeout, WriteTimeout, IdleTimeout
	// mirror the values main.go sets today; zero values inherit the
	// http.Server zero-value (i.e. no timeout).
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	// MaxHeaderBytes limits request headers before route middleware runs.
	MaxHeaderBytes int
}

// New assembles the HTTP surface from deps and returns a configured
// *http.Server. The server is NOT started here — the caller (main.go
// or boot.Run) owns the lifecycle so it can wire its own graceful
// shutdown.
//
// Complete route groups are added here as their focused mount helpers migrate;
// main.go retains the remaining groups until their incremental migrations.
func New(deps Deps) *http.Server {
	if deps.Router == nil {
		// A nil router is a programmer error — the migration contract
		// requires main.go to pass its existing router so we don't
		// re-create global middleware. Returning a no-op server with
		// a stub router keeps the type honest but the caller will see
		// no routes.
		deps.Router = chi.NewRouter()
	}

	// Migrated mount blocks. Add new ones here, one per migrated
	// grouping. Keep each in its own Mount* method so the diff stays
	// reviewable when migrating from main.go.
	MountDeliverabilitySurface(deps)
	MountSubscriberListSegmentSurface(deps)
	MountCampaignSendingSurface(deps)
	MountIdentityAPISurface(deps)
	MountAuditOperationsSurface(deps)
	MountTenantGovernanceSurface(deps)
	MountAudienceActivationSurface(deps)
	MountSupportIntegrationsSurface(deps)
	MountCustomerLifecycleIntegrationsSurface(deps)

	addr := deps.HTTPAddr
	if addr == "" {
		addr = ":9000"
	}
	maxHeaderBytes := deps.MaxHeaderBytes
	if maxHeaderBytes <= 0 {
		maxHeaderBytes = 64 << 10
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpbody.LimitRequests(httpbody.DefaultRequestMaxBodyBytes, httpbody.ProductionRouteLimits)(deps.Router),
		ReadHeaderTimeout: deps.ReadHeaderTimeout,
		ReadTimeout:       deps.ReadTimeout,
		WriteTimeout:      deps.WriteTimeout,
		IdleTimeout:       deps.IdleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}
	return srv
}

// Logger is a small helper that returns the configured logger or
// slog.Default(). Mount* helpers should prefer this over reaching
// into deps.Logger directly so a nil value never panics.
func (d Deps) Log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// Shutdown is a thin convenience wrapper that performs the standard
// graceful-shutdown dance against an *http.Server returned by New.
// main.go can adopt this once it's done driving its own shutdown.
func Shutdown(ctx context.Context, srv *http.Server) error {
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}
