package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCampaignReportIncludesCampaignMetadata(t *testing.T) {
	sentAt := time.Date(2026, 7, 10, 8, 30, 0, 0, time.UTC)
	payload, err := json.Marshal(CampaignReport{
		CampaignID:   "campaign-1",
		CampaignName: "July newsletter",
		SentAt:       &sentAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	jsonText := string(payload)
	for _, expected := range []string{
		`"campaign_name":"July newsletter"`,
		`"sent_at":"2026-07-10T08:30:00Z"`,
	} {
		if !strings.Contains(jsonText, expected) {
			t.Fatalf("campaign report JSON %s does not contain %s", jsonText, expected)
		}
	}
}
