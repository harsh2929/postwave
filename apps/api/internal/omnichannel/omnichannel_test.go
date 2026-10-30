package omnichannel

import (
	"strings"
	"testing"
)

func TestValidateRequiresRCSFallbackToSMS(t *testing.T) {
	out := Validate(OmniCampaign{
		Name:                  "Spring launch",
		RecipientSnapshotMode: "send_time",
		Paths: []CampaignPath{
			{PathKey: "rich", Name: "Rich path", Channel: "rcs", Status: "ready", TrafficWeightBasisPoints: 5000},
			{PathKey: "email", Name: "Email", Channel: "email", Status: "ready", TrafficWeightBasisPoints: 5000},
		},
	})
	if out.Valid {
		t.Fatal("expected validation failure")
	}
	joined := strings.Join(out.Errors, "\n")
	if !strings.Contains(joined, "RCS requires fallback_path_key") {
		t.Fatalf("errors = %v, want RCS fallback requirement", out.Errors)
	}
}

func TestValidateAcceptsEmailSMSPaths(t *testing.T) {
	out := Validate(OmniCampaign{
		Name: "Launch",
		SendStrategy: map[string]any{
			"mode": "fixed",
		},
		Paths: []CampaignPath{
			{PathKey: "email", Name: "Email", Channel: "email", Status: "ready", TrafficWeightBasisPoints: 6000},
			{PathKey: "sms", Name: "SMS", Channel: "sms", Status: "ready", TrafficWeightBasisPoints: 4000},
		},
	})
	if !out.Valid {
		t.Fatalf("Validate() errors = %v", out.Errors)
	}
	if out.SupportedPaths != 0 || out.PlannedPaths != 2 {
		t.Fatalf("runtime path counts = supported:%d planned:%d, want 0/2", out.SupportedPaths, out.PlannedPaths)
	}
	if out.Runtime.ExecutionEnabled || out.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("validation runtime = %+v, want unavailable", out.Runtime)
	}
}

func TestValidateLimitsToTenPaths(t *testing.T) {
	paths := make([]CampaignPath, 0, 11)
	for i := 0; i < 11; i++ {
		paths = append(paths, CampaignPath{
			PathKey:                  "path-" + string(rune('a'+i)),
			Name:                     "Path",
			Channel:                  "email",
			Status:                   "ready",
			TrafficWeightBasisPoints: 1000,
		})
	}
	out := Validate(OmniCampaign{Name: "Too many", Paths: paths})
	if out.Valid {
		t.Fatal("expected validation failure")
	}
	if !strings.Contains(strings.Join(out.Errors, "\n"), "at most ten paths") {
		t.Fatalf("errors = %v, want ten path cap", out.Errors)
	}
}

func TestCatalogDeclaresEveryExecutionChannelUnavailable(t *testing.T) {
	catalog := Catalog()
	if catalog.Runtime.ExecutionEnabled || catalog.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("catalog runtime = %+v, want unavailable", catalog.Runtime)
	}
	want := map[string]string{"email": "unavailable", "sms": "unavailable", "whatsapp": "unavailable", "rcs": "unavailable", "push": "unavailable"}
	for key, status := range want {
		got := ""
		for _, item := range catalog.Channels {
			if item.Key == key {
				got = item.RuntimeStatus
			}
		}
		if got != status {
			t.Fatalf("channel %q status = %q, want %q", key, got, status)
		}
	}
}
