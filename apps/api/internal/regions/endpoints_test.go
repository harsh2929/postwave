// SPDX-License-Identifier: AGPL-3.0-only
package regions

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEndpointsFor_EUUsesEUMailgun(t *testing.T) {
	for _, r := range []Region{EUCentral1, EUWest1} {
		ep := EndpointsFor(r)
		require.Equal(t, "https://api.eu.mailgun.net", ep.MailgunBaseURL, r)
		require.Equal(t, string(r), ep.SESRegion, r)
		require.Equal(t, string(r), ep.SNSValidatorRegion, r)
	}
}

func TestEndpointsFor_USUsesGlobalMailgun(t *testing.T) {
	for _, r := range []Region{USEast1, USWest2} {
		ep := EndpointsFor(r)
		require.Equal(t, "https://api.mailgun.net", ep.MailgunBaseURL, r)
	}
}

func TestEndpointsFor_UnknownRegionFallsBackToDefaults(t *testing.T) {
	ep := EndpointsFor(Region("xx-fake-1"))
	require.Equal(t, Defaults, ep)
}

func TestEndpointsFor_PostmarkIsAlwaysGlobal(t *testing.T) {
	for _, r := range Allowed() {
		ep := EndpointsFor(r)
		require.Equal(t, "https://api.postmarkapp.com", ep.PostmarkBaseURL, r)
	}
}

func TestIsEURegion(t *testing.T) {
	require.True(t, IsEURegion(EUCentral1))
	require.True(t, IsEURegion(EUWest1))
	require.False(t, IsEURegion(USEast1))
	require.False(t, IsEURegion(APNortheast1))
}

func TestEnsureMatchesDeployment(t *testing.T) {
	// Current() reads env; deployment-region not set in tests defaults
	// to us-east-1.
	require.NoError(t, EnsureMatchesDeployment(USEast1))
	err := EnsureMatchesDeployment(EUWest1)
	require.Error(t, err)
	require.Contains(t, err.Error(), "eu-west-1")
	require.Contains(t, err.Error(), "us-east-1")
}

func TestEnsureMatchesDeployment_EmptyRegion(t *testing.T) {
	err := EnsureMatchesDeployment("")
	require.Error(t, err)
	require.Contains(t, err.Error(), "not set")
}

// TestInheritedRegionFor pins the SUB-052 effective-region resolution:
// a per-subscriber override wins when supported; an empty override
// inherits the tenant region; an unsupported override falls back to the
// tenant region; and an empty tenant region degrades to the deployment
// default.
func TestInheritedRegionFor(t *testing.T) {
	// Deployment default is us-east-1 when the env var is unset.
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "")

	cases := []struct {
		name       string
		subscriber Region
		tenant     Region
		want       Region
	}{
		{"override wins over tenant", EUWest1, USEast1, EUWest1},
		{"empty override inherits tenant", "", EUCentral1, EUCentral1},
		{"unsupported override falls back to tenant", Region("mars-1"), USWest2, USWest2},
		{"both empty degrades to deployment default", "", "", USEast1},
		{"empty override + empty tenant uses Current()", "", "", USEast1},
		{"override equals tenant is idempotent", APNortheast1, APNortheast1, APNortheast1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := InheritedRegionFor(tc.subscriber, tc.tenant)
			require.Equal(t, tc.want, got)
		})
	}
}
