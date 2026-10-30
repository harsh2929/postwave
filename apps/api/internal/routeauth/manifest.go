// SPDX-License-Identifier: AGPL-3.0-only
// Package routeauth enforces the generated route-to-capability contract.
package routeauth

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

const (
	ExposureAuthenticated = "authenticated"
	ExposureCredentialed  = "credentialed"
	ExposureInternal      = "internal"
	ExposurePublic        = "public"
	ExposureReleaseHeld   = "release-held"

	RoleNotApplicable = "not_applicable"

	ScopeModeAll           = "all"
	ScopeModeAny           = "any"
	ScopeModeAuthenticated = "authenticated"
	ScopeModeNotApplicable = "not_applicable"
)

// Policy is the complete authorization decision for one reachable gateway
// method/path template. Fields remain explicit even when they do not apply so
// a new exposure cannot inherit a permissive zero value.
type Policy struct {
	Method             string   `json:"method"`
	Path               string   `json:"path"`
	Exposure           string   `json:"exposure"`
	AuthMethods        []string `json:"auth_methods"`
	SessionMinimumRole string   `json:"session_minimum_role"`
	APIKeyScopes       []string `json:"api_key_scopes"`
	APIKeyScopeMode    string   `json:"api_key_scope_mode"`
	PolicySource       string   `json:"policy_source"`
	ReviewStatus       string   `json:"review_status"`
	ReleaseHoldCode    string   `json:"release_hold_code,omitempty"`
}

type manifestDocument struct {
	SchemaVersion int      `json:"schema_version"`
	Routes        []Policy `json:"routes"`
}

//go:embed manifest.json
var embeddedManifest []byte

var defaultManifest = mustParseManifest(embeddedManifest)

type Manifest struct {
	routes  []Policy
	exact   map[string]*Policy
	matcher *routeMatcher
}

func mustParseManifest(raw []byte) *Manifest {
	manifest, err := ParseManifest(raw)
	if err != nil {
		panic(fmt.Sprintf("invalid embedded route authorization manifest: %v", err))
	}
	return manifest
}

// ParseManifest validates and compiles a generated manifest. It is exported
// for startup validation tests and for tooling that wants the same fail-closed
// semantics as the embedded production document.
func ParseManifest(raw []byte) (*Manifest, error) {
	var document manifestDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if document.SchemaVersion != 1 {
		return nil, fmt.Errorf("schema_version = %d, want 1", document.SchemaVersion)
	}
	if len(document.Routes) == 0 {
		return nil, fmt.Errorf("manifest contains zero routes")
	}

	routes := append([]Policy(nil), document.Routes...)
	exact := make(map[string]*Policy, len(routes))
	matcher := newRouteMatcher()
	for index := range routes {
		policy := &routes[index]
		if err := validatePolicy(*policy); err != nil {
			return nil, fmt.Errorf("route %d (%s %s): %w", index, policy.Method, policy.Path, err)
		}
		key := policyKey(policy.Method, policy.Path)
		if _, exists := exact[key]; exists {
			return nil, fmt.Errorf("duplicate route policy %s", key)
		}
		exact[key] = policy
		if err := matcher.insert(policy); err != nil {
			return nil, fmt.Errorf("compile %s: %w", key, err)
		}
	}
	return &Manifest{routes: routes, exact: exact, matcher: matcher}, nil
}

func validatePolicy(policy Policy) error {
	if policy.Method == "" || strings.ToUpper(policy.Method) != policy.Method {
		return fmt.Errorf("method must be uppercase")
	}
	if !strings.HasPrefix(policy.Path, "/api/") {
		return fmt.Errorf("path must start with /api/")
	}
	if policy.PolicySource == "" || policy.ReviewStatus == "" {
		return fmt.Errorf("policy_source and review_status are required")
	}

	switch policy.Exposure {
	case ExposureReleaseHeld:
		if policy.ReleaseHoldCode == "" {
			return fmt.Errorf("release-held route has no stable code")
		}
		return validateBoundaryPolicy(policy, "pre_auth_release_hold")
	case ExposurePublic:
		return validateBoundaryPolicy(policy, "anonymous_or_route_credential")
	case ExposureInternal:
		return validateBoundaryPolicy(policy, "internal_token_or_provider_signature")
	case ExposureCredentialed:
		return validateCredentialedPolicy(policy)
	case ExposureAuthenticated:
		return validateAuthenticatedPolicy(policy)
	default:
		return fmt.Errorf("unknown exposure %q", policy.Exposure)
	}
}

func validateCredentialedPolicy(policy Policy) error {
	if len(policy.AuthMethods) == 0 {
		return fmt.Errorf("credentialed route has no explicit auth method")
	}
	for _, method := range policy.AuthMethods {
		if strings.TrimSpace(method) == "" || method == "session" || method == "api_key" {
			return fmt.Errorf("invalid handler credential auth method %q", method)
		}
	}
	if policy.SessionMinimumRole != RoleNotApplicable {
		return fmt.Errorf("credentialed route session role must be not_applicable")
	}
	if len(policy.APIKeyScopes) != 0 || policy.APIKeyScopeMode != ScopeModeNotApplicable {
		return fmt.Errorf("credentialed route API-key scope must be not_applicable")
	}
	return nil
}

func validateBoundaryPolicy(policy Policy, requiredMethod string) error {
	if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != requiredMethod {
		return fmt.Errorf("boundary route must explicitly use auth method %q", requiredMethod)
	}
	if policy.SessionMinimumRole != RoleNotApplicable {
		return fmt.Errorf("boundary route session role must be not_applicable")
	}
	if len(policy.APIKeyScopes) != 0 || policy.APIKeyScopeMode != ScopeModeNotApplicable {
		return fmt.Errorf("boundary route API-key scope must be not_applicable")
	}
	return nil
}

func validateAuthenticatedPolicy(policy Policy) error {
	if len(policy.AuthMethods) == 0 {
		return fmt.Errorf("authenticated route has no auth method")
	}
	seen := map[string]struct{}{}
	for _, method := range policy.AuthMethods {
		if method != string(apikeys.AuthMethodSession) && method != string(apikeys.AuthMethodAPIKey) {
			return fmt.Errorf("unknown auth method %q", method)
		}
		if _, duplicate := seen[method]; duplicate {
			return fmt.Errorf("duplicate auth method %q", method)
		}
		seen[method] = struct{}{}
	}

	_, sessionAllowed := seen[string(apikeys.AuthMethodSession)]
	if sessionAllowed {
		switch policy.SessionMinimumRole {
		case "viewer", "editor", "admin", "owner":
		default:
			return fmt.Errorf("invalid session minimum role %q", policy.SessionMinimumRole)
		}
	} else if policy.SessionMinimumRole != RoleNotApplicable {
		return fmt.Errorf("session role must be not_applicable when session auth is disabled")
	}

	_, apiKeyAllowed := seen[string(apikeys.AuthMethodAPIKey)]
	if !apiKeyAllowed {
		if len(policy.APIKeyScopes) != 0 || policy.APIKeyScopeMode != ScopeModeNotApplicable {
			return fmt.Errorf("API-key scope must be not_applicable when API-key auth is disabled")
		}
		return nil
	}
	switch policy.APIKeyScopeMode {
	case ScopeModeAuthenticated:
		if len(policy.APIKeyScopes) != 0 {
			return fmt.Errorf("authenticated API-key mode cannot name scopes")
		}
	case ScopeModeAll:
		if len(policy.APIKeyScopes) < 2 {
			return fmt.Errorf("all API-key scope mode requires at least two scopes")
		}
		for _, scope := range policy.APIKeyScopes {
			if !apikeys.IsValidScope(scope) {
				return fmt.Errorf("unknown API-key scope %q", scope)
			}
		}
	case ScopeModeAny:
		if len(policy.APIKeyScopes) == 0 {
			return fmt.Errorf("any API-key scope mode requires at least one scope")
		}
		for _, scope := range policy.APIKeyScopes {
			if !apikeys.IsValidScope(scope) {
				return fmt.Errorf("unknown API-key scope %q", scope)
			}
		}
	default:
		return fmt.Errorf("invalid API-key scope mode %q", policy.APIKeyScopeMode)
	}
	return nil
}

func policyKey(method, path string) string {
	return strings.ToUpper(strings.TrimSpace(method)) + " " + normalizeTemplate(path)
}

func (m *Manifest) exactPolicy(method, path string) (*Policy, bool) {
	policy, ok := m.exact[policyKey(method, path)]
	return policy, ok
}

// PolicyFor resolves a concrete request path. Method-specific routes win over
// ANY proxy routes and static segments win over parameter/wildcard segments.
func PolicyFor(method, path string) (Policy, bool) {
	policy, ok := defaultManifest.policyFor(method, path)
	if !ok {
		return Policy{}, false
	}
	return clonePolicy(*policy), true
}

func (m *Manifest) policyFor(method, path string) (*Policy, bool) {
	policy := m.matcher.match(strings.ToUpper(method), normalizeRequestPath(path))
	return policy, policy != nil
}

// Policies returns a stable copy for diagnostics without exposing mutable
// pointers owned by the compiled matcher.
func Policies() []Policy {
	out := make([]Policy, len(defaultManifest.routes))
	for index, policy := range defaultManifest.routes {
		out[index] = clonePolicy(policy)
	}
	sort.Slice(out, func(i, j int) bool {
		return policyKey(out[i].Method, out[i].Path) < policyKey(out[j].Method, out[j].Path)
	})
	return out
}

func clonePolicy(policy Policy) Policy {
	policy.AuthMethods = append([]string(nil), policy.AuthMethods...)
	policy.APIKeyScopes = append([]string(nil), policy.APIKeyScopes...)
	return policy
}
