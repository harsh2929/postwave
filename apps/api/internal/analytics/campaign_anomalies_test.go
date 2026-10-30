// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import "testing"

func bkt(hour string, opens, clicks, unsubs int) HourBucket {
	return HourBucket{Hour: hr(hour), Opens: opens, Clicks: clicks, Unsubs: unsubs}
}

func TestDetectCampaignAnomalies(t *testing.T) {
	t.Run("too few samples => none", func(t *testing.T) {
		got := detectCampaignAnomalies([]HourBucket{
			bkt("2026-06-01T00:00:00Z", 1, 0, 0),
			bkt("2026-06-01T01:00:00Z", 200, 0, 0),
		})
		if len(got) != 0 {
			t.Fatalf("expected none below min samples, got %d", len(got))
		}
	})

	t.Run("flat series => none", func(t *testing.T) {
		buckets := make([]HourBucket, 8)
		for i := range buckets {
			buckets[i] = HourBucket{Hour: hr("2026-06-01T00:00:00Z").Add(0), Opens: 10}
		}
		if got := detectCampaignAnomalies(buckets); len(got) != 0 {
			t.Fatalf("flat series should have no anomalies, got %d", len(got))
		}
	})

	t.Run("spike flagged", func(t *testing.T) {
		// Seven calm hours of opens=10 then a huge spike.
		buckets := []HourBucket{
			bkt("2026-06-01T00:00:00Z", 10, 1, 0),
			bkt("2026-06-01T01:00:00Z", 10, 1, 0),
			bkt("2026-06-01T02:00:00Z", 10, 1, 0),
			bkt("2026-06-01T03:00:00Z", 10, 1, 0),
			bkt("2026-06-01T04:00:00Z", 10, 1, 0),
			bkt("2026-06-01T05:00:00Z", 10, 1, 0),
			bkt("2026-06-01T06:00:00Z", 10, 1, 0),
			bkt("2026-06-01T07:00:00Z", 300, 1, 0),
		}
		got := detectCampaignAnomalies(buckets)
		var found *CampaignAnomaly
		for i := range got {
			if got[i].Metric == "opens" && got[i].Direction == "spike" {
				found = &got[i]
			}
		}
		if found == nil {
			t.Fatalf("expected an opens spike anomaly, got %+v", got)
		}
		if found.Value != 300 || found.ZScore <= anomalyZThreshold {
			t.Errorf("spike anomaly malformed: %+v", *found)
		}
	})
}
