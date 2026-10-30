package main

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/ai_agent"
)

type routeMiddleware = func(http.Handler) http.Handler

// authenticatedRouteStack is the invariant security boundary shared by every
// tenant-authenticated route group. Callers cannot reorder or omit the core
// authentication, authorization, impersonation, MFA, and region controls — nor
// the per-key rate limit and call recorder, which used to be caller-supplied
// hooks. The second group silently omitted both (mw-keyratelimit-missing-second-group),
// leaving the whole send/write surface unmetered and unrecorded, so they are
// now required fields of the stack itself.
type authenticatedRouteStack struct {
	authenticateAPIKey routeMiddleware
	// meterAPIKey enforces the per-API-key rate limit. It runs after bearer
	// resolution and before tenant resolution, so a key that has exhausted its
	// budget is refused before it can cost a tenant lookup.
	meterAPIKey    routeMiddleware
	resolveTenant  routeMiddleware
	authorizeRoute routeMiddleware
	// recordAPIKeyCalls run immediately after authorization so the per-call
	// rows describe requests that actually passed the policy gate.
	recordAPIKeyCalls   []routeMiddleware
	applyImpersonation  routeMiddleware
	stampContextEpoch   routeMiddleware
	enforceAdminIP      routeMiddleware
	resolveAuditScopes  routeMiddleware
	requireMFA          routeMiddleware
	enforceTenantRegion routeMiddleware
	// meterCommercialUsage runs last so requests refused by impersonation,
	// admin-IP, audit-scope, MFA, or region controls cannot drain paid usage.
	// The middleware itself bypasses browser sessions.
	meterCommercialUsage routeMiddleware
}

// mountAuthenticatedRoutesBehindAgentHold places the in-app agent release
// boundary on the outer router before any authenticated-route middleware is
// composed. This ordering is security-sensitive: held requests must not parse
// credentials, resolve tenants or sessions, record telemetry, consume an
// idempotency key/body, or reach repositories and providers.
func mountAuthenticatedRoutesBehindAgentHold(router chi.Router, mount func(chi.Router)) {
	if !ai_agent.AgentInteractiveReleased {
		ai_agent.MountAgentReleaseHoldRoutes(router)
	}
	router.Group(mount)
}

func (s authenticatedRouteStack) apply(router chi.Router) {
	s.mustBeComplete()

	router.Use(s.authenticateAPIKey)
	router.Use(s.meterAPIKey)
	router.Use(s.resolveTenant)
	router.Use(s.authorizeRoute)
	router.Use(s.recordAPIKeyCalls...)
	router.Use(s.applyImpersonation)
	// After impersonation, so the epoch describes the identity the request
	// will actually act as rather than the one that authenticated.
	router.Use(s.stampContextEpoch)
	router.Use(s.enforceAdminIP)
	router.Use(s.resolveAuditScopes)
	router.Use(s.requireMFA)
	router.Use(s.enforceTenantRegion)
	router.Use(s.meterCommercialUsage)
}

func (s authenticatedRouteStack) mustBeComplete() {
	required := []struct {
		name       string
		middleware routeMiddleware
	}{
		{name: "authenticateAPIKey", middleware: s.authenticateAPIKey},
		{name: "meterAPIKey", middleware: s.meterAPIKey},
		{name: "resolveTenant", middleware: s.resolveTenant},
		{name: "authorizeRoute", middleware: s.authorizeRoute},
		{name: "applyImpersonation", middleware: s.applyImpersonation},
		{name: "stampContextEpoch", middleware: s.stampContextEpoch},
		{name: "enforceAdminIP", middleware: s.enforceAdminIP},
		{name: "resolveAuditScopes", middleware: s.resolveAuditScopes},
		{name: "requireMFA", middleware: s.requireMFA},
		{name: "enforceTenantRegion", middleware: s.enforceTenantRegion},
		{name: "meterCommercialUsage", middleware: s.meterCommercialUsage},
	}
	for _, item := range required {
		if item.middleware == nil {
			panic(fmt.Sprintf("authenticated route stack: %s middleware is required", item.name))
		}
	}
	if len(s.recordAPIKeyCalls) == 0 {
		panic("authenticated route stack: recordAPIKeyCalls middleware is required")
	}
	for _, mw := range s.recordAPIKeyCalls {
		if mw == nil {
			panic("authenticated route stack: recordAPIKeyCalls middleware is required")
		}
	}
}
