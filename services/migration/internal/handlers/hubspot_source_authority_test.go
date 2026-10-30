package handlers

import (
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestHubSpotSourceEventsReplaceCompleteContactProjectionAndGuardEmailMoves(t *testing.T) {
	policy := sourceEventSubscriberAuthority(
		canonical.MigrationJob{Source: canonical.SourceHubSpot},
		canonical.SourceEvent{SourcePlatform: canonical.SourceHubSpot},
	)

	require.True(t, policy.status)
	require.True(t, policy.tags)
	require.True(t, policy.fields)
	require.True(t, policy.guardSourceEmailMove)
	require.False(t, policy.preserveSourceAudiences)
}
