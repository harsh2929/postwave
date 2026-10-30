package main

import (
	"sort"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestMigrationServiceRegistersEveryPublicSource(t *testing.T) {
	want := []canonical.SourcePlatform{
		canonical.SourceActiveCampaign,
		canonical.SourceAWeber,
		canonical.SourceBeehiiv,
		canonical.SourceBento,
		canonical.SourceBrevo,
		canonical.SourceCampaignMonitor,
		canonical.SourceConstantContact,
		canonical.SourceConvertKit,
		canonical.SourceCSV,
		canonical.SourceCustomerIO,
		canonical.SourceDrip,
		canonical.SourceFlodesk,
		canonical.SourceHubSpot,
		canonical.SourceKlaviyo,
		canonical.SourceLoops,
		canonical.SourceMailchimp,
		canonical.SourceMailerLite,
		canonical.SourceOmnisend,
		canonical.SourceSendy,
		canonical.SourceSubstack,
	}

	got := adapter.Sources()
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	require.Equal(t, want, got)
}
