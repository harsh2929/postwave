// SPDX-License-Identifier: MIT

package activecampaign

import (
	"errors"
	"fmt"
	"testing"

	"github.com/postwave/migrate/canonical"
)

func completeActiveCampaignEmailSafetyEvidence(listIDs ...string) activeCampaignSubscriberSafetyEvidence {
	channels := make(map[string]activeCampaignMarketingChannel, len(listIDs))
	for _, listID := range listIDs {
		channels[listID] = activeCampaignChannelEmail
	}
	return activeCampaignSubscriberSafetyEvidence{
		ListChannels:                    channels,
		ListChannelInventoryComplete:    true,
		EmailExclusionInventoryComplete: true,
	}
}

func TestActiveCampaignSubscriberSafetyFailsClosedWithoutChannelAndExclusionEvidence(t *testing.T) {
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{{
			List: "7", Status: "1", SubscribeDate: "2026-02-03T04:05:06Z",
		}},
	}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed", sub.Status)
	}
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, want unknown", sub.ConsentTimestamp, sub.ConsentSource)
	}
	assertNotContains(t, sub.Tags, "list:7")
	safety := interfaceMapField(t, sub, "activecampaign_email_safety")
	if safety["reason"] != "unknown_list_channel" || safety["list_subscription_date_is_consent_proof"] != false {
		t.Fatalf("safety audit = %#v", safety)
	}
	if safety["earliest_active_email_subscription_at"] != nil {
		t.Fatalf("unclassified list supplied email subscription provenance: %#v", safety)
	}
}

func TestActiveCampaignSubscriberSafetySMSOnlyNeverAuthorizesEmail(t *testing.T) {
	evidence := activeCampaignSubscriberSafetyEvidence{
		ListChannels: map[string]activeCampaignMarketingChannel{
			"sms-7": activeCampaignChannelSMS,
		},
		ListChannelInventoryComplete:    true,
		EmailExclusionInventoryComplete: true,
	}
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com", Phone: "+15551234567"},
		ContactLists: []acContactList{{
			List: "sms-7", Status: "1", SubscribeDate: "2026-02-03T04:05:06Z",
		}},
	}, nil, nil, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed for SMS-only contact", sub.Status)
	}
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, want unknown", sub.ConsentTimestamp, sub.ConsentSource)
	}
	assertNotContains(t, sub.Tags, "list:sms-7")
	safety := interfaceMapField(t, sub, "activecampaign_email_safety")
	if safety["reason"] != "sms_only_membership" {
		t.Fatalf("reason = %#v, want sms_only_membership", safety["reason"])
	}
}

func TestActiveCampaignSubscriberSafetyAggregatesEmailAndSMSStatusesByChannel(t *testing.T) {
	tests := []struct {
		name       string
		lists      []acContactList
		channels   map[string]activeCampaignMarketingChannel
		wantStatus canonical.SubscriberStatus
		wantReason string
	}{
		{
			name: "active email list wins over another email list unsubscribe",
			lists: []acContactList{
				{List: "email-old", Status: "2"},
				{List: "email-current", Status: "1"},
				{List: "sms-current", Status: "1"},
			},
			channels: map[string]activeCampaignMarketingChannel{
				"email-old":     activeCampaignChannelEmail,
				"email-current": activeCampaignChannelEmail,
				"sms-current":   activeCampaignChannelSMS,
			},
			wantStatus: canonical.StatusEnabled,
			wantReason: "active_email_list_and_complete_exclusion_check",
		},
		{
			name: "SMS active does not override email unsubscribe",
			lists: []acContactList{
				{List: "email-old", Status: "2"},
				{List: "sms-current", Status: "1"},
			},
			channels: map[string]activeCampaignMarketingChannel{
				"email-old":   activeCampaignChannelEmail,
				"sms-current": activeCampaignChannelSMS,
			},
			wantStatus: canonical.StatusDisabled,
			wantReason: "email_list_unsubscribed",
		},
		{
			name: "conflicting rows for one email list fail closed",
			lists: []acContactList{
				{List: "email-current", Status: "1"},
				{List: "email-current", Status: "2"},
			},
			channels: map[string]activeCampaignMarketingChannel{
				"email-current": activeCampaignChannelEmail,
			},
			wantStatus: canonical.StatusUnconfirmed,
			wantReason: "conflicting_email_list_status",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			decision := evaluateActiveCampaignSubscriberSafety(acContact{}, tc.lists, activeCampaignSubscriberSafetyEvidence{
				ListChannels:                    tc.channels,
				ListChannelInventoryComplete:    true,
				EmailExclusionInventoryComplete: true,
			})
			if decision.Status != tc.wantStatus || decision.Audit["reason"] != tc.wantReason {
				t.Fatalf("decision = %s/%v, want %s/%s", decision.Status, decision.Audit["reason"], tc.wantStatus, tc.wantReason)
			}
		})
	}
}

func TestActiveCampaignSubscriberSafetyUsesOnlyEligibleEmailLists(t *testing.T) {
	evidence := activeCampaignSubscriberSafetyEvidence{
		ListChannels: map[string]activeCampaignMarketingChannel{
			"email-current": activeCampaignChannelEmail,
			"email-muted":   activeCampaignChannelEmail,
			"sms-current":   activeCampaignChannelSMS,
		},
		ListChannelInventoryComplete:    true,
		EmailExclusionInventoryComplete: true,
		EmailExclusions: []activeCampaignEmailExclusionEvidence{{
			ListIDs:   []string{"email-muted"},
			Source:    "operator_export",
			Reference: "exclusion-row-9",
		}},
	}
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com", Phone: "+15551234567"},
		ContactLists: []acContactList{
			{List: "email-current", Status: "1", SubscribeDate: "2026-02-03T04:05:06Z"},
			{List: "email-muted", Status: "1", SubscribeDate: "2026-02-04T04:05:06Z"},
			{List: "sms-current", Status: "1", SubscribeDate: "2026-02-05T04:05:06Z"},
		},
	}, nil, nil, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusEnabled {
		t.Fatalf("status = %s, want enabled", sub.Status)
	}
	assertContains(t, sub.Tags, "list:email-current")
	assertNotContains(t, sub.Tags, "list:email-muted")
	assertNotContains(t, sub.Tags, "list:sms-current")
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, list sdate must not be canonical opt-in proof", sub.ConsentTimestamp, sub.ConsentSource)
	}

	safety := interfaceMapField(t, sub, "activecampaign_email_safety")
	if safety["reason"] != "active_email_list_and_complete_exclusion_check" ||
		safety["earliest_active_email_subscription_at"] != "2026-02-03T04:05:06Z" {
		t.Fatalf("safety audit = %#v", safety)
	}
	exclusions, ok := safety["email_exclusions"].([]map[string]interface{})
	if !ok || len(exclusions) != 1 || exclusions[0]["scope"] != "selected_lists" || exclusions[0]["reference"] != "exclusion-row-9" {
		t.Fatalf("exclusion evidence = %#v", safety["email_exclusions"])
	}
}

func TestActiveCampaignSubscriberSafetyRequiresCompleteExclusionCheck(t *testing.T) {
	evidence := completeActiveCampaignEmailSafetyEvidence("email-current")
	evidence.EmailExclusionInventoryComplete = false
	sub, err := mapContactToCanonical(acContactDetail{
		Contact:      acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{{List: "email-current", Status: "1"}},
	}, nil, nil, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed", sub.Status)
	}
	assertContains(t, sub.Tags, "list:email-current")
	safety := interfaceMapField(t, sub, "activecampaign_email_safety")
	if safety["reason"] != "incomplete_email_exclusion_evidence" {
		t.Fatalf("reason = %#v", safety["reason"])
	}
	memberships, ok := sub.CustomFields["activecampaign_list_memberships"].([]map[string]interface{})
	if !ok || len(memberships) != 1 || memberships[0]["segment_member"] != true || memberships[0]["email_eligible"] != false {
		t.Fatalf("list membership audit = %#v", sub.CustomFields["activecampaign_list_memberships"])
	}
	segment := mapListToSegment(acList{ID: "email-current", Name: "Current"})
	if segment.QueryAST.Value != sub.Tags[0] {
		t.Fatalf("list segment predicate %q does not match subscriber tags %#v", segment.QueryAST.Value, sub.Tags)
	}
}

func TestActiveCampaignSubscriberSafetyHonorsGlobalAndListSpecificExclusions(t *testing.T) {
	tests := []struct {
		name       string
		exclusions []activeCampaignEmailExclusionEvidence
		wantStatus canonical.SubscriberStatus
		wantReason string
	}{
		{
			name: "global",
			exclusions: []activeCampaignEmailExclusionEvidence{{
				AllLists: true, Source: "operator_export",
			}},
			wantStatus: canonical.StatusBlocklisted,
			wantReason: "account_wide_email_exclusion",
		},
		{
			name: "only active list excluded",
			exclusions: []activeCampaignEmailExclusionEvidence{{
				ListIDs: []string{"email-current"}, Source: "operator_export",
			}},
			wantStatus: canonical.StatusDisabled,
			wantReason: "all_active_email_lists_excluded",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			evidence := completeActiveCampaignEmailSafetyEvidence("email-current")
			evidence.EmailExclusions = tc.exclusions
			sub, err := mapContactToCanonical(acContactDetail{
				Contact:      acContact{ID: "42", Email: "ada@example.com"},
				ContactLists: []acContactList{{List: "email-current", Status: "1"}},
			}, nil, nil, evidence)
			if err != nil {
				t.Fatal(err)
			}
			if sub.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s", sub.Status, tc.wantStatus)
			}
			assertNotContains(t, sub.Tags, "list:email-current")
			safety := interfaceMapField(t, sub, "activecampaign_email_safety")
			if safety["reason"] != tc.wantReason {
				t.Fatalf("reason = %#v, want %s", safety["reason"], tc.wantReason)
			}
		})
	}
}

func TestActiveCampaignSubscriberSafetyDoesNotTreatSMSBounceAsEmailBounce(t *testing.T) {
	evidence := activeCampaignSubscriberSafetyEvidence{
		ListChannels: map[string]activeCampaignMarketingChannel{
			"email-current": activeCampaignChannelEmail,
			"sms-bounced":   activeCampaignChannelSMS,
		},
		ListChannelInventoryComplete:    true,
		EmailExclusionInventoryComplete: true,
	}
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{
			{List: "email-current", Status: "1"},
			{List: "sms-bounced", Status: "3"},
		},
	}, nil, nil, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusEnabled {
		t.Fatalf("status = %s, want enabled from email list", sub.Status)
	}

	evidence.ListChannels["sms-bounced"] = activeCampaignChannelEmail
	sub, err = mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{
			{List: "email-current", Status: "1"},
			{List: "sms-bounced", Status: "3"},
		},
	}, nil, nil, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusBlocklisted {
		t.Fatalf("status = %s, want blocklisted from email bounce", sub.Status)
	}
}

func TestActiveCampaignSubscriberSafetyReturnsTypedPhoneOnlyError(t *testing.T) {
	_, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Phone: "+15551234567"},
	}, nil, nil)
	if !errors.Is(err, ErrNonEmailContact) {
		t.Fatalf("error = %v, want ErrNonEmailContact", err)
	}
	var typed *NonEmailContactError
	if !errors.As(err, &typed) || typed.SourceID != "42" || !typed.HasPhone {
		t.Fatalf("typed error = %#v", typed)
	}
	if got := fmt.Sprint(err); got != "activecampaign: contact 42 missing email (phone-only contact)" {
		t.Fatalf("error = %q", got)
	}
}
