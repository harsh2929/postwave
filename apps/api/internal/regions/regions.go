// SPDX-License-Identifier: AGPL-3.0-only
//
// Package regions encodes Moosewave's data-residency model: each tenant
// is pinned to exactly one region (set at provisioning, see migration
// 0055) and every API instance knows which region IT is running in
// (env POSTWAVE_DEPLOYMENT_REGION). Requests whose tenant region does
// not match the instance region are rejected with 421 Misdirected
// Request and a Location header steering the SDK to the correct host.
//
// Splitting this into its own package (rather than a few helpers in
// middleware/) keeps the type — Region — sharable with any other
// subsystem that needs to validate a region string (provisioning,
// admin tooling, etc) without dragging the chi middleware in.
package regions

import (
	"context"
	"fmt"
	"os"
)

// Region is a typed string for the small enum of regions Moosewave
// physically deploys into. Keep this list in lockstep with the CHECK
// constraint on tenants.data_region (migration 0055) — adding a region
// is a coordinated rollout: new constants here, new migration to
// extend the CHECK, new infra in that region, then enabling sales.
type Region string

const (
	USEast1      Region = "us-east-1"
	USWest2      Region = "us-west-2"
	EUCentral1   Region = "eu-central-1"
	EUWest1      Region = "eu-west-1"
	APSoutheast1 Region = "ap-southeast-1"
	APNortheast1 Region = "ap-northeast-1"
)

// defaultRegion is what Current() returns when POSTWAVE_DEPLOYMENT_REGION
// is unset. We default to us-east-1 to match the column default and
// keep dev / single-region deploys boring.
const defaultRegion = USEast1

// envDeploymentRegion is the env var the deployment reads to learn
// which region IT is running in. Set per-instance by the orchestrator
// (Terraform / k8s manifest), never per-tenant.
const envDeploymentRegion = "POSTWAVE_DEPLOYMENT_REGION"

// Allowed returns the canonical list of regions Moosewave supports.
// Order matches the rollout / SLA priority for marketing — if you
// reorder, double-check the settings UI which renders this list as-is.
func Allowed() []Region {
	return []Region{
		USEast1,
		USWest2,
		EUCentral1,
		EUWest1,
		APSoutheast1,
		APNortheast1,
	}
}

// Validate returns nil when r names a Region we deploy into. The
// error path returns the candidate echoed back so the caller can
// surface it in a structured error envelope without re-formatting.
func Validate(r string) error {
	for _, a := range Allowed() {
		if string(a) == r {
			return nil
		}
	}
	return fmt.Errorf("regions: %q is not a supported region", r)
}

// Current returns the region this API instance is deployed into. The
// value is read from POSTWAVE_DEPLOYMENT_REGION (defaults to us-east-1
// when unset). If the env var is set to something we don't recognise
// we still return it as a Region — failing closed at startup is the
// orchestrator's job, not the request hot path's.
func Current() Region {
	v := os.Getenv(envDeploymentRegion)
	if v == "" {
		return defaultRegion
	}
	return Region(v)
}

// Provisioning returns a database-safe region for newly created tenants.
// Production startup rejects an invalid deployment region before serving, but
// local development historically used the sentinel value "local". Falling
// back here keeps dev signup and background auto-provisioning aligned with the
// tenants.data_region CHECK constraint instead of turning that configuration
// mismatch into an opaque 500 response.
func Provisioning() Region {
	current := Current()
	if Validate(string(current)) != nil {
		return defaultRegion
	}
	return current
}

// HostFor returns the canonical SDK host for a given region. The SDK
// reads this out of the Location header on a 421 response and retries
// against it. If we ever change the public DNS scheme, change it here
// — it's the single source of truth.
func HostFor(r Region) string {
	return fmt.Sprintf("https://%s.api.moosewave.com", string(r))
}

// regionCtxKey is the context key the middleware uses to attach the
// resolved tenant region to ctx. Mirrors the unexported-int idiom in
// middleware/keyratelimit.go so cross-package collisions are impossible.
type regionCtxKey int

const ctxKeyRegion regionCtxKey = 1

// WithRegion attaches r to ctx so downstream handlers can inspect the
// tenant's pinned region without a second DB hit.
func WithRegion(ctx context.Context, r Region) context.Context {
	return context.WithValue(ctx, ctxKeyRegion, r)
}

// RegionFromContext returns the region attached by EnforceRegion, or
// the empty string + false when the request was not region-enforced
// (e.g. public health endpoints).
func RegionFromContext(ctx context.Context) (Region, bool) {
	r, ok := ctx.Value(ctxKeyRegion).(Region)
	return r, ok && r != ""
}
