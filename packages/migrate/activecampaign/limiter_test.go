// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"testing"
	"time"
)

func TestSharedActiveCampaignLimiterUsesOneBucketPerAccount(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	primary := sharedActiveCampaignLimiter("https://tenant.api-us1.com/api/3")
	secondAdapter := sharedActiveCampaignLimiter("https://tenant.api-us1.com/api/3")
	providerAlias := sharedActiveCampaignLimiter("https://tenant.activehosted.com/api/3")
	otherAccount := sharedActiveCampaignLimiter("https://other.api-us1.com/api/3")

	if primary != secondAdapter {
		t.Fatal("separate adapter instances received separate rate-limit buckets")
	}
	if primary != providerAlias {
		t.Fatal("provider host aliases for one account received separate rate-limit buckets")
	}
	if primary == otherAccount {
		t.Fatal("different ActiveCampaign accounts shared a rate-limit bucket")
	}
}

func TestActiveCampaignRateLimitKeyRejectsUnrecognizedHosts(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	if got := activeCampaignRateLimitKey("https://attacker.example/api/3"); got != "invalid:attacker.example" {
		t.Fatalf("rate-limit key = %q", got)
	}
}

func TestSharedActiveCampaignLimiterUsesExactConfiguredHostIdentity(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "tenant.provider.example,other.provider.example")

	primary := sharedActiveCampaignLimiter("https://TENANT.PROVIDER.EXAMPLE:443/api/3")
	sameHost := sharedActiveCampaignLimiter("https://tenant.provider.example/api/3")
	otherHost := sharedActiveCampaignLimiter("https://other.provider.example/api/3")

	if primary != sameHost {
		t.Fatal("canonical forms of one configured host received separate rate-limit buckets")
	}
	if primary == otherHost {
		t.Fatal("different configured hosts shared a rate-limit bucket")
	}
	if got := activeCampaignRateLimitKey("https://tenant.provider.example/api/3"); got != "host:tenant.provider.example" {
		t.Fatalf("rate-limit key = %q", got)
	}
}

func TestSharedActiveCampaignLimiterDoesNotAllowProductionBurst(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "rolling-window.provider.example")
	limiter := sharedActiveCampaignLimiter("https://rolling-window.provider.example/api/3")
	if err := limiter.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := limiter.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed < 150*time.Millisecond {
		t.Fatalf("second production request waited only %s; limiter allowed an unsafe burst", elapsed)
	}
}
