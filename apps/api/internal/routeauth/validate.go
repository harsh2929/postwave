// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
)

// ValidateRouter performs the forward half of route validation: every mounted
// API route must have an exact generated policy and every authenticated route
// must sit behind the default-deny middleware boundary. Tests and incremental
// router builders can use this without constructing the production surface.
func ValidateRouter(router chi.Routes) error {
	return validateRouterAgainstManifest(router, defaultManifest, false)
}

// ValidateRouterExact is the production startup contract. In addition to the
// forward checks, every generated policy must resolve to an actually mounted
// chi route. Deliberate ANY wildcard proxies cover their concrete upstream
// routes; no other stale declaration is accepted.
func ValidateRouterExact(router chi.Routes) error {
	return validateRouterAgainstManifest(router, defaultManifest, true)
}

func validateRouterAgainstManifest(router chi.Routes, manifest *Manifest, requireReverse bool) error {
	var failures []string
	mounted := make(map[string]struct{})
	err := walkRoutes(router, "", nil, func(method, path string, middlewares []func(http.Handler) http.Handler) {
		path = normalizeTemplate(path)
		if !strings.HasPrefix(path, "/api/") {
			return
		}
		mounted[policyKey(method, path)] = struct{}{}
		policy, exists := manifest.exactPolicy(method, path)
		if !exists {
			policy, exists = manifest.exactPolicy("ANY", path)
		}
		if !exists {
			failures = append(failures, fmt.Sprintf("%s %s has no exact route capability", method, path))
			return
		}
		if policy.Exposure == ExposureAuthenticated && !containsAuthorizationMiddleware(middlewares) {
			failures = append(failures, fmt.Sprintf("%s %s is authenticated but bypasses routeauth.Middleware", method, path))
		}
	})
	if err != nil {
		return err
	}
	if requireReverse {
		conditional, condErr := loadConditionalMounts()
		if condErr != nil {
			return fmt.Errorf("route authorization conditional mounts: %w", condErr)
		}
		for _, policy := range manifest.routes {
			if manifestPolicyMounted(policy, mounted) {
				continue
			}
			// A route whose deployment gate is OFF is absent by design, not by
			// defect. Excused ONLY while the gate is actually unset: if the gate
			// is on and the route still did not mount, that is a real failure
			// and is reported below.
			if gate, ok := conditional[policyKey(policy.Method, policy.Path)]; ok && !gateEnabled(gate) {
				continue
			}
			failures = append(failures, fmt.Sprintf("manifest route %s %s is not mounted", policy.Method, policy.Path))
		}
	}
	if len(failures) == 0 {
		return nil
	}
	sort.Strings(failures)
	return fmt.Errorf("route authorization validation failed:\n  - %s", strings.Join(failures, "\n  - "))
}

func manifestPolicyMounted(policy Policy, mounted map[string]struct{}) bool {
	if _, ok := mounted[policyKey(policy.Method, policy.Path)]; ok {
		return true
	}
	if _, ok := mounted[policyKey("ANY", policy.Path)]; ok {
		return true
	}
	normalizedPath := normalizeTemplate(policy.Path)
	for key := range mounted {
		space := strings.IndexByte(key, ' ')
		if space < 0 || key[:space] != "ANY" {
			continue
		}
		proxyPath := key[space+1:]
		if !strings.HasSuffix(proxyPath, "/{rest}") {
			continue
		}
		prefix := strings.TrimSuffix(proxyPath, "/{rest}")
		if normalizedPath == prefix || strings.HasPrefix(normalizedPath, prefix+"/") {
			return true
		}
	}
	return false
}

type routeVisitor func(method, path string, middlewares []func(http.Handler) http.Handler)

func walkRoutes(
	router chi.Routes,
	parentPath string,
	parentMiddlewares []func(http.Handler) http.Handler,
	visit routeVisitor,
) error {
	for _, route := range router.Routes() {
		middlewares := append([]func(http.Handler) http.Handler(nil), parentMiddlewares...)
		middlewares = append(middlewares, router.Middlewares()...)
		if route.SubRoutes != nil {
			if err := walkRoutes(route.SubRoutes, parentPath+route.Pattern, middlewares, visit); err != nil {
				return err
			}
			continue
		}
		for method, handler := range route.Handlers {
			leafMiddlewares := append([]func(http.Handler) http.Handler(nil), middlewares...)
			if chain, ok := handler.(*chi.ChainHandler); ok {
				leafMiddlewares = append(leafMiddlewares, chain.Middlewares...)
			}
			if method == "*" {
				method = "ANY"
			}
			fullPath := strings.ReplaceAll(parentPath+route.Pattern, "/*/", "/")
			visit(method, fullPath, leafMiddlewares)
		}
	}
	return nil
}

func containsAuthorizationMiddleware(middlewares []func(http.Handler) http.Handler) bool {
	want := reflect.ValueOf(Middleware).Pointer()
	for _, candidate := range middlewares {
		if candidate != nil && reflect.ValueOf(candidate).Pointer() == want {
			return true
		}
	}
	return false
}

// ── Conditionally-mounted routes ────────────────────────────────────────────
//
// ValidateRouterExact demands an exact router/manifest match. That is right for
// the FORWARD direction — a mounted route without a policy is a security hole —
// but the REVERSE direction is a completeness check, and several manifest routes
// belong to deployment modes the code explicitly supports omitting.
// `MountOAuthRoutes` says so outright: "A nil OAuth graph is the supported
// password-only deployment mode."
//
// Requiring them made those modes unbootable. OAuth in particular needs
// provider-issued credentials, so a public compose file cannot supply them —
// which forces the answer rather than leaving it to taste. The alternative in
// practice was POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1, which disables the whole
// guard and has already hidden one real defect (`activitycursor`, unreachable on
// main for 17 days).
//
// The exemption is deliberately NARROW: a route is excused only while its
// declared gate is unset. Configure the feature and the route must mount, or
// validation fails as before.
//
//go:embed conditional-mounts.json
var conditionalMountsJSON []byte

type conditionalMountRecord struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	GateEnv string `json:"gate_env"`
	Reason  string `json:"reason"`
}

type conditionalMountDocument struct {
	Routes []conditionalMountRecord `json:"routes"`
}

// loadConditionalMounts returns policyKey -> gate env var.
func loadConditionalMounts() (map[string]string, error) {
	var doc conditionalMountDocument
	if err := json.Unmarshal(conditionalMountsJSON, &doc); err != nil {
		return nil, fmt.Errorf("parse conditional-mounts.json: %w", err)
	}
	out := make(map[string]string, len(doc.Routes))
	for _, r := range doc.Routes {
		if r.Method == "" || r.Path == "" || r.GateEnv == "" {
			return nil, fmt.Errorf("conditional mount entry needs method, path and gate_env: %+v", r)
		}
		if strings.TrimSpace(r.Reason) == "" {
			return nil, fmt.Errorf("conditional mount %s %s needs a reason", r.Method, r.Path)
		}
		out[policyKey(r.Method, normalizeTemplate(r.Path))] = r.GateEnv
	}
	return out, nil
}

// gateEnabled reports whether a deployment gate is switched on. An empty value
// is off; anything else (a secret, a client id, or an explicit truthy flag) is
// on. Deliberately permissive about WHAT counts as on: the cost of treating a
// configured gate as enabled is a real validation failure, which is the safe
// direction.
func gateEnabled(env string) bool {
	value := strings.TrimSpace(os.Getenv(env))
	switch strings.ToLower(value) {
	case "", "0", "false", "no", "off":
		return false
	default:
		return true
	}
}
