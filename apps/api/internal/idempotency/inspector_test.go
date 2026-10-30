// SPDX-License-Identifier: AGPL-3.0-only
package idempotency

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInferState(t *testing.T) {
	now := time.Now().UTC()
	future := now.Add(1 * time.Hour)
	past := now.Add(-1 * time.Hour)
	status200 := 200

	require.Equal(t, "expired", inferState(nil, past))
	require.Equal(t, "expired", inferState(&status200, past))
	require.Equal(t, "pending", inferState(nil, future))
	require.Equal(t, "completed", inferState(&status200, future))
}

func TestParseLimit_Bounds(t *testing.T) {
	cases := map[string]int{
		"":      defaultListLimit,
		"50":    50,
		"-1":    defaultListLimit,
		"foo":   defaultListLimit,
		"99999": maxListLimit,
		"200":   200,
	}
	for in, want := range cases {
		require.Equal(t, want, parseLimit(in), in)
	}
}

func TestInspectorWithholdsRevealOnceIngestSecretIssueRoute(t *testing.T) {
	require.False(t, inspectorRouteVisible(revealOnceIngestSecretIssueRoute))
	require.True(t, inspectorRouteVisible("GET /api/v1/conversions/ingest-secrets"))
	require.True(t, inspectorRouteVisible("POST /api/v1/conversions/ingest-secrets/key/revoke"))
	require.True(t, inspectorRouteVisible("POST /api/v1/conversions/ingest-secrets/"))
}
