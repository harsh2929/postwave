// SPDX-License-Identifier: AGPL-3.0-only
//
// Region-to-endpoint routing for outbound ESPs + IaaS APIs.
//
// The data-plane question: when a tenant in EU sends an email, which
// Postmark / Mailgun / AWS SES endpoint do we POST to? For services
// with regional endpoints, sending through the matching region keeps
// the data on-shore (GDPR sovereignty) and reduces latency.
//
// Coverage:
//   * Postmark — single global endpoint; account-level EU placement
//     handled by Postmark itself (no client-side switching).
//   * Mailgun  — explicit EU endpoint (api.eu.mailgun.net).
//   * AWS SES  — region-pinned (email.<region>.amazonaws.com).
//   * AWS SNS  — region-pinned (sns.<region>.amazonaws.com) for
//     deliverability webhook signing-cert validation.
//
// Adding a new region: add the constant in regions.go, list the
// region's matching ESP endpoint here (or accept the defaults — most
// non-AWS providers serve all regions from one URL).

package regions

import (
	"fmt"
	"strings"
)

// ESPEndpoints bundles the per-ESP base URLs a region implies. Empty
// strings mean "use the provider's default global endpoint".
type ESPEndpoints struct {
	// PostmarkBaseURL is the URL the PostmarkClient should be built
	// against. Postmark itself is single-global; we expose this for
	// symmetry + future EU-specific behaviour.
	PostmarkBaseURL string

	// MailgunBaseURL is the Mailgun API base; EU tenants route through
	// api.eu.mailgun.net per Mailgun docs.
	MailgunBaseURL string

	// SESRegion is the AWS region string passed to the SES SDK
	// (e.g. "us-east-1", "eu-west-1"). Empty means use the platform
	// default (controlled by AWS_REGION).
	SESRegion string

	// SNSValidatorRegion is the AWS SNS region whose signing-cert URL
	// pattern (sns.<region>.amazonaws.com) deliverability_ses uses to
	// validate inbound bounce webhooks. Tracks SESRegion in normal
	// operation; broken out in case a deployment routes SES + SNS to
	// different regions.
	SNSValidatorRegion string
}

// Defaults is the fallback used when a region has no override (or when
// regions.Current() returns an unrecognised value). Mirrors the
// pre-multi-region wiring so behaviour is unchanged for single-region
// deployments.
var Defaults = ESPEndpoints{
	PostmarkBaseURL:    "https://api.postmarkapp.com",
	MailgunBaseURL:     "https://api.mailgun.net",
	SESRegion:          "us-east-1",
	SNSValidatorRegion: "us-east-1",
}

// EndpointsFor returns the ESP endpoints for the given region. Unknown
// regions return Defaults — the operator decides whether to fail-closed
// at boot (via regions.Validate) or accept the pass-through.
func EndpointsFor(r Region) ESPEndpoints {
	switch r {
	case USEast1:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.mailgun.net",
			SESRegion:          "us-east-1",
			SNSValidatorRegion: "us-east-1",
		}
	case USWest2:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.mailgun.net",
			SESRegion:          "us-west-2",
			SNSValidatorRegion: "us-west-2",
		}
	case EUCentral1:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.eu.mailgun.net",
			SESRegion:          "eu-central-1",
			SNSValidatorRegion: "eu-central-1",
		}
	case EUWest1:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.eu.mailgun.net",
			SESRegion:          "eu-west-1",
			SNSValidatorRegion: "eu-west-1",
		}
	case APSoutheast1:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.mailgun.net",
			SESRegion:          "ap-southeast-1",
			SNSValidatorRegion: "ap-southeast-1",
		}
	case APNortheast1:
		return ESPEndpoints{
			PostmarkBaseURL:    "https://api.postmarkapp.com",
			MailgunBaseURL:     "https://api.mailgun.net",
			SESRegion:          "ap-northeast-1",
			SNSValidatorRegion: "ap-northeast-1",
		}
	default:
		return Defaults
	}
}

// CurrentEndpoints is a convenience for the wiring sites in main.go
// that read the deployment region's endpoints at boot.
func CurrentEndpoints() ESPEndpoints {
	return EndpointsFor(Current())
}

// IsEURegion reports whether r is in the EU group. Used by handlers
// that need to apply EU-only constraints (e.g. mandatory GDPR consent
// re-confirmation prompts) regardless of which specific EU region the
// tenant lives in.
func IsEURegion(r Region) bool {
	return strings.HasPrefix(string(r), "eu-")
}

// IsUSRegion mirrors IsEURegion for the US.
func IsUSRegion(r Region) bool {
	return strings.HasPrefix(string(r), "us-")
}

// InheritedRegionFor resolves the EFFECTIVE data region for a single
// subscriber given an optional per-subscriber override and the owning
// tenant's region (SUB-052). A subscriber row may carry its own
// `data_region` (e.g. an EU resident inside a US-pinned tenant); when
// that override is empty the subscriber inherits the tenant's region.
//
// Resolution order:
//  1. subscriberRegion when non-empty AND a supported region;
//  2. otherwise tenantRegion when non-empty;
//  3. otherwise the deployment default (regions.Current()).
//
// An unsupported subscriberRegion is ignored (falls through to the
// tenant region) rather than erroring — the column has a CHECK
// constraint at the DB layer, so an unsupported value here can only come
// from a stale row written before a region was retired, and the safest
// behaviour is to fall back to the tenant's region rather than fail the
// backup/sub-processor selection that calls this.
func InheritedRegionFor(subscriberRegion, tenantRegion Region) Region {
	if subscriberRegion != "" && Validate(string(subscriberRegion)) == nil {
		return subscriberRegion
	}
	if tenantRegion != "" {
		return tenantRegion
	}
	return Current()
}

// EnsureMatchesDeployment is a defence-in-depth check the request-path
// handlers can call before a side-effectful write: re-confirm the
// tenant's region matches the deployment region. The EnforceRegion
// middleware already does this at the edge, but handlers that bypass
// the middleware (background jobs, internal API calls) can use this to
// stay honest.
func EnsureMatchesDeployment(tenantRegion Region) error {
	if tenantRegion == "" {
		return fmt.Errorf("regions: tenant region not set")
	}
	if tenantRegion != Current() {
		return fmt.Errorf("regions: tenant pinned to %s but this instance is %s",
			tenantRegion, Current())
	}
	return nil
}
