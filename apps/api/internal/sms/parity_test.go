package sms

import (
	"testing"
	"time"
)

func TestSMSCreditPreviewUSMMS(t *testing.T) {
	out := smsCreditPreview(SMSCreditPreviewInput{
		Body:           "Sale starts now",
		MediaURL:       "https://cdn.example.com/hero.jpg",
		Country:        "US",
		SenderType:     "10dlc",
		RecipientCount: 500,
	})
	if out.Channel != "mms" {
		t.Fatalf("channel = %q, want mms", out.Channel)
	}
	if !out.MMSSupported {
		t.Fatalf("expected US MMS to be supported")
	}
	if out.PerRecipientCredits != 3 {
		t.Fatalf("per recipient credits = %d, want 3", out.PerRecipientCredits)
	}
	if out.TotalCredits != 1500 {
		t.Fatalf("total credits = %d, want 1500", out.TotalCredits)
	}
	if out.EstimatedDurationSeconds != 500 {
		t.Fatalf("duration = %d, want 500 seconds for 10DLC", out.EstimatedDurationSeconds)
	}
}

func TestSMSCreditPreviewCanadaMMS(t *testing.T) {
	out := smsCreditPreview(SMSCreditPreviewInput{
		Body:           "Your image offer is ready",
		MediaURL:       "https://cdn.example.com/offer.png",
		Country:        "CA",
		SenderType:     "toll_free",
		RecipientCount: 12,
	})
	if out.PerRecipientCredits != 5 {
		t.Fatalf("per recipient credits = %d, want 5", out.PerRecipientCredits)
	}
	if out.TotalCredits != 60 {
		t.Fatalf("total credits = %d, want 60", out.TotalCredits)
	}
	if out.EstimatedDurationSeconds != 4 {
		t.Fatalf("duration = %d, want 4 seconds for toll-free", out.EstimatedDurationSeconds)
	}
}

func TestSMSCreditPreviewPlannedRegionWarns(t *testing.T) {
	out := smsCreditPreview(SMSCreditPreviewInput{
		Body:           "A longer message",
		MediaURL:       "https://cdn.example.com/offer.png",
		Country:        "GB",
		RecipientCount: 1,
	})
	if out.RegionStatus != "planned" {
		t.Fatalf("region status = %q, want planned", out.RegionStatus)
	}
	if out.MMSSupported {
		t.Fatalf("expected GB MMS to be unsupported")
	}
	if len(out.Warnings) < 2 {
		t.Fatalf("expected planned-region and MMS warnings, got %#v", out.Warnings)
	}
}

func TestMMSReadinessRequiresApprovedActiveSender(t *testing.T) {
	smokePassed := time.Now().UTC().Format(time.RFC3339)
	out := mmsReadinessForSenders([]SenderProfile{
		{
			ID:                 "sender_1",
			Provider:           ProviderTwilio,
			Country:            "US",
			SenderType:         "10dlc",
			RegistrationStatus: RegistrationPending,
		},
		{
			ID:                 "sender_2",
			Provider:           ProviderTelnyx,
			Country:            "CA",
			SenderType:         "toll_free",
			RegistrationStatus: RegistrationApproved,
			Metadata:           map[string]any{"mms_smoke_last_passed_at": smokePassed},
		},
	})
	if !out.Ready {
		t.Fatalf("expected one approved US/CA sender to make MMS ready")
	}
	if len(out.Senders) != 2 {
		t.Fatalf("senders = %d, want 2", len(out.Senders))
	}
	if out.Senders[0].Ready {
		t.Fatalf("pending sender should not be MMS ready")
	}
	if !out.Senders[1].Ready {
		t.Fatalf("approved sender should be MMS ready, warnings=%#v", out.Senders[1].Warnings)
	}
	if out.Senders[1].LiveSmokeRequired {
		t.Fatalf("smoked sender should not require another live smoke")
	}
}

func TestMMSReadinessRequiresLiveSmoke(t *testing.T) {
	out := mmsReadinessForSenders([]SenderProfile{{
		ID:                 "sender_1",
		Provider:           ProviderTwilio,
		Country:            "US",
		SenderType:         "10dlc",
		RegistrationStatus: RegistrationApproved,
	}})
	if out.Ready {
		t.Fatalf("approved sender should still require live MMS smoke before cutover")
	}
	if !out.LiveSmokeRequired || !out.Senders[0].LiveSmokeRequired {
		t.Fatalf("expected live smoke requirement: %#v", out)
	}
}

func TestSMSTemplatesIncludeCommerceDiscountMMS(t *testing.T) {
	templates := smsTemplates()
	foundDiscount := false
	foundMMS := false
	for _, item := range templates {
		for _, field := range item.MergeFields {
			if field == "discount_code" {
				foundDiscount = true
			}
		}
		if item.MediaAllowed {
			foundMMS = true
		}
	}
	if !foundDiscount {
		t.Fatalf("expected at least one discount-code template")
	}
	if !foundMMS {
		t.Fatalf("expected at least one MMS-capable template")
	}
}
