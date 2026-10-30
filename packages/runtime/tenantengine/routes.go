// Package tenantengine resolves operator-provisioned, tenant-dedicated email
// engines. It contains no engine implementation and communicates no credentials
// to clients. Both migration and the application use this same routing contract.
package tenantengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/google/uuid"
)

const RoutesEnv = "LISTMONK_TENANT_ROUTES"

var ErrUnavailable = errors.New("tenant email destination is not configured")
var ErrBindingChanged = errors.New("tenant email destination differs from its persistent binding")

type tenantKey struct{}

func WithTenant(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantKey{}, strings.TrimSpace(tenantID))
}

func Tenant(ctx context.Context) string {
	tenant, _ := ctx.Value(tenantKey{}).(string)
	return tenant
}

// Route is deployment configuration. Admin credentials must be injected from
// the deployment's secret store, never supplied by an end-user request.
type Route struct {
	TenantID      string `json:"tenant_id"`
	DestinationID string `json:"destination_id"`
	BaseURL       string `json:"base_url"`
	AdminUser     string `json:"admin_user"`
	AdminPassword string `json:"admin_password"`
}

// EndpointHash binds the address as well as the operator's instance identity.
// Credential rotation is allowed; silently repointing existing database IDs at
// another instance is not. Moving an instance requires an explicit data move.
func (r Route) EndpointHash() string {
	sum := sha256.Sum256([]byte(r.BaseURL))
	return hex.EncodeToString(sum[:])
}

type Registry struct{ routes map[string]Route }

func FromEnv() (*Registry, error) { return Parse(os.Getenv(RoutesEnv)) }

// Parse returns nil for an absent registry, preserving explicit legacy wiring.
// A present but empty/malformed registry is an error, never a legacy fallback.
func Parse(raw string) (*Registry, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	if len(raw) > 1<<20 {
		return nil, errors.New("tenant email routing configuration exceeds 1 MiB")
	}
	var routes []Route
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&routes); err != nil {
		return nil, errors.New("invalid tenant email routing JSON")
	}
	if err := dec.Decode(new(any)); err != io.EOF || len(routes) == 0 {
		return nil, errors.New("tenant email routing requires a nonempty array")
	}
	reg := &Registry{routes: make(map[string]Route, len(routes))}
	ids, endpoints := map[string]bool{}, map[string]bool{}
	for i, route := range routes {
		tenant, terr := uuid.Parse(route.TenantID)
		dest, derr := uuid.Parse(route.DestinationID)
		if terr != nil || derr != nil || tenant == uuid.Nil || dest == uuid.Nil {
			return nil, fmt.Errorf("tenant email route %d requires tenant and destination UUIDs", i)
		}
		route.TenantID, route.DestinationID = tenant.String(), dest.String()
		u, err := url.Parse(strings.TrimSpace(route.BaseURL))
		if err != nil || u == nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || strings.Contains(u.Path, "\\") {
			return nil, fmt.Errorf("tenant email route %d has an invalid endpoint", i)
		}
		for _, part := range strings.Split(u.Path, "/") {
			if part == "." || part == ".." {
				return nil, fmt.Errorf("tenant email route %d has an invalid endpoint path", i)
			}
		}
		u.Host = strings.ToLower(u.Host)
		if (u.Scheme == "http" && u.Port() == "80") || (u.Scheme == "https" && u.Port() == "443") {
			u.Host = strings.TrimSuffix(u.Host, ":"+u.Port())
		}
		u.Path = strings.TrimRight(u.Path, "/")
		route.BaseURL = u.String()
		if strings.TrimSpace(route.AdminUser) == "" || strings.TrimSpace(route.AdminPassword) == "" {
			return nil, fmt.Errorf("tenant email route %d has incomplete credentials", i)
		}
		if _, exists := reg.routes[route.TenantID]; exists || ids[route.DestinationID] || endpoints[route.EndpointHash()] {
			return nil, errors.New("tenant email routing reuses a tenant, destination or endpoint")
		}
		reg.routes[route.TenantID] = route
		ids[route.DestinationID], endpoints[route.EndpointHash()] = true, true
	}
	return reg, nil
}

func (r *Registry) Resolve(tenantID string) (Route, error) {
	if r == nil {
		return Route{}, ErrUnavailable
	}
	id, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return Route{}, ErrUnavailable
	}
	route, ok := r.routes[id.String()]
	if !ok {
		return Route{}, ErrUnavailable
	}
	return route, nil
}
