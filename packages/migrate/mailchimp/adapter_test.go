// SPDX-License-Identifier: MIT

package mailchimp

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
)

func TestMapMember_StatusAndConsent(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    canonical.SubscriberStatus
		wantTag string
	}{
		{
			name:    "subscribed enabled",
			raw:     `{"id":"abc","email_address":"a@b.com","status":"subscribed","timestamp_opt":"2024-03-01 10:00:00","tags":[{"name":"vip"}]}`,
			want:    canonical.StatusEnabled,
			wantTag: "vip",
		},
		{
			name: "unsubscribed disabled",
			raw:  `{"id":"abc","email_address":"a@b.com","status":"unsubscribed"}`,
			want: canonical.StatusDisabled,
		},
		{
			name: "pending unconfirmed",
			raw:  `{"id":"abc","email_address":"a@b.com","status":"pending"}`,
			want: canonical.StatusUnconfirmed,
		},
		{
			name: "non subscribed unconfirmed",
			raw:  `{"id":"abc","email_address":"a@b.com","status":"non_subscribed"}`,
			want: canonical.StatusUnconfirmed,
		},
		{
			name: "transactional disabled",
			raw:  `{"id":"abc","email_address":"a@b.com","status":"transactional"}`,
			want: canonical.StatusDisabled,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var m mcMember
			require.NoError(t, json.Unmarshal([]byte(tc.raw), &m))
			got := mapMember(m)
			require.Equal(t, tc.want, got.Status)
			require.Equal(t, m.Status, got.CustomFields["postwave_mailchimp_status"])
			require.Equal(t, canonical.SourceMailchimp, got.SourcePlatform)
			require.Equal(t, "abc", got.SourceID)
			if tc.wantTag != "" {
				require.Contains(t, got.Tags, tc.wantTag)
				require.NotNil(t, got.ConsentTimestamp)
			}
		})
	}
}

func TestCapabilities_AdvertisesParityMetadata(t *testing.T) {
	caps := New().Capabilities()
	require.True(t, caps.Supports.Campaigns)
	require.True(t, caps.Supports.Reports)
	require.True(t, caps.Supports.Groups)
	require.True(t, caps.Supports.Templates)
	require.True(t, caps.Supports.Forms)
	require.True(t, caps.Supports.LandingPages)
	require.True(t, caps.Supports.Ecommerce)
	require.Equal(t, "runtime", caps.Supports.AutomationMode, "Classic Automations are executable; Customer Journeys are an explicit parity gap")
}

func TestMapMember_PreservesNameStatusAndConsentEvidenceWithoutInventingDoubleOptIn(t *testing.T) {
	var m mcMember
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"member_1",
		"email_address":"ada@example.com",
		"full_name":"Ada Lovelace",
		"status":"subscribed",
		"source":"Hosted Form",
		"timestamp_opt":"2026-01-02T03:04:05Z",
		"timestamp_signup":"2026-01-02T03:00:00Z",
		"ip_opt":"192.0.2.2",
		"ip_signup":"192.0.2.1",
		"last_changed":"2026-01-03T03:00:00Z",
		"merge_fields":{"FNAME":"Ada","LNAME":"Lovelace"},
		"interests":{"group_2":true,"group_1":true,"off":false},
		"marketing_permissions":[{"marketing_permission_id":"gdpr_email","text":"Email","enabled":true}],
		"stats":{"avg_open_rate":0.75},
		"unsubscribe_reason":""
	}`), &m))

	got := mapMember(m, "aud_1")
	require.Equal(t, canonical.ConsentUnknown, got.ConsentSource, "timestamp_opt alone is not proof of double opt-in")
	require.NotNil(t, got.ConsentTimestamp)
	require.Equal(t, "Ada Lovelace", got.CustomFields["name"])
	require.Equal(t, "subscribed", got.CustomFields["postwave_mailchimp_status"])
	require.Equal(t, "192.0.2.1", got.CustomFields["postwave_mailchimp_signup_ip"])
	require.Equal(t, []map[string]interface{}{
		{"id": "group_1", "source_id": "group_1", "name": "group_1", "source_platform": "mailchimp"},
		{"id": "group_2", "source_id": "group_2", "name": "group_2", "source_platform": "mailchimp"},
	}, got.CustomFields["postwave_mailchimp_groups"])
	require.Len(t, got.CustomFields["postwave_mailchimp_marketing_permissions"], 1)
	require.Equal(t, map[string]interface{}{"FNAME": "Ada", "LNAME": "Lovelace"}, got.CustomFields["postwave_mailchimp_merge_fields"])
	proof := got.CustomFields["postwave_mailchimp_consent_proof"].(map[string]interface{})
	require.Equal(t, "192.0.2.2", proof["ip_opt"])
	require.Equal(t, "2026-01-02T03:00:00Z", proof["timestamp_signup"])
}

func TestMapMember_InterestsCollapsedToTags(t *testing.T) {
	raw := `{"id":"x","email_address":"a@b.com","status":"subscribed","interests":{"abc":true,"def":false}}`
	var m mcMember
	require.NoError(t, json.Unmarshal([]byte(raw), &m))
	got := mapMember(m)
	require.Contains(t, got.Tags, "interest:abc")
	require.NotContains(t, got.Tags, "interest:def")
}

func TestMapMember_ListContextAddsAudienceTagAndNamespacedSource(t *testing.T) {
	raw := `{"id":"x","email_address":"a@b.com","status":"subscribed","tags":[{"name":"vip"},{"name":"VIP"},{"name":""}]}`
	var m mcMember
	require.NoError(t, json.Unmarshal([]byte(raw), &m))
	got := mapMember(m, "aud_7")
	require.Equal(t, "list:aud_7:member:x", got.SourceID)
	require.ElementsMatch(t, []string{"mailchimp:list:aud_7", "vip"}, got.Tags)
}

func TestTranslateSegment_AnyAllConditions(t *testing.T) {
	any := mcSegment{Name: "Any segment"}
	any.Options.Match = "any"
	any.Options.Conditions = []map[string]interface{}{
		{"field": "EMAIL", "op": "contains", "value": "@gmail.com"},
		{"field": "FNAME", "op": "is", "value": "Alice"},
	}
	got := translateSegment(any)
	require.Equal(t, "or", got.QueryAST.Op)
	require.Len(t, got.QueryAST.Children, 2)
	require.Equal(t, "email", got.QueryAST.Children[0].Field)
	require.Equal(t, "contains", got.QueryAST.Children[0].Comparator)
	require.Equal(t, "custom.FNAME", got.QueryAST.Children[1].Field)
	require.Equal(t, "equals", got.QueryAST.Children[1].Comparator)

	all := mcSegment{Name: "All segment"}
	all.Options.Match = "all"
	all.Options.Conditions = []map[string]interface{}{
		{"field": "EMAIL", "op": "contains", "value": "x"},
	}
	got2 := translateSegment(all)
	require.Equal(t, "and", got2.QueryAST.Op)
}

func TestTranslateSegment_UnsupportedFallsThrough(t *testing.T) {
	s := mcSegment{Name: "weird"}
	s.Options.Match = "any"
	s.Options.Conditions = []map[string]interface{}{
		{"field": "EMAIL", "op": "weird-mailchimp-op", "value": 1},
	}
	got := translateSegment(s)
	require.NotEmpty(t, got.SourceDefinition, "unsupported condition should be preserved")
	require.Equal(t, "unsupported", got.QueryAST.Op, "partial predicates must never compile as an executable segment")
	require.Contains(t, got.Description, "could not be translated")
}

func TestTranslateSegment_OnlyUsesPersistedSubscriberSemantics(t *testing.T) {
	s := mcSegment{Name: "Executable membership"}
	s.Options.Match = "all"
	s.Options.Conditions = []map[string]interface{}{
		{"field": "status", "op": "is", "value": "subscribed"},
		{"field": "interests-category", "condition_type": "Interests", "op": "interestcontains", "value": "interest_7"},
	}
	got := translateSegment(s, "aud_1")
	require.Equal(t, "and", got.QueryAST.Op)
	require.Equal(t, "custom.postwave_mailchimp_status", got.QueryAST.Children[0].Field)
	require.Equal(t, "subscribed", got.QueryAST.Children[0].Value)
	require.Equal(t, "tag", got.QueryAST.Children[1].Field)
	require.Equal(t, "interest:interest_7", got.QueryAST.Children[1].Value)

	s.Options.Conditions = append(s.Options.Conditions, map[string]interface{}{
		"field": "aim", "condition_type": "Aim", "op": "open", "value": "campaign_1",
	})
	got = translateSegment(s, "aud_1")
	require.Equal(t, "unsupported", got.QueryAST.Op, "engagement data is not persisted on subscribers")
}

func TestTranslateSegment_PreservesNestedNotSemantics(t *testing.T) {
	s := mcSegment{Name: "Exclude unsubscribed"}
	s.Options.Match = "all"
	s.Options.Conditions = []map[string]interface{}{{
		"op": "not",
		"conditions": []interface{}{
			map[string]interface{}{"field": "status", "op": "is", "value": "unsubscribed"},
		},
	}}
	got := translateSegment(s, "aud_1")
	require.Equal(t, "and", got.QueryAST.Op)
	require.Len(t, got.QueryAST.Children, 1)
	require.Equal(t, "not", got.QueryAST.Children[0].Op)
	require.Equal(t, "custom.postwave_mailchimp_status", got.QueryAST.Children[0].Children[0].Children[0].Field)
}

func TestTranslateSegment_StaticUsesExactAudienceScopedMembershipTag(t *testing.T) {
	s := mcSegment{ID: 222, Name: "Static Buyers", Type: "static"}
	got := translateSegment(s, "list_a")
	require.Equal(t, "Static Buyers [list_a]", got.Name)
	require.Equal(t, "condition", got.QueryAST.Op)
	require.Equal(t, "tag", got.QueryAST.Field)
	require.Equal(t, "equals", got.QueryAST.Comparator)
	require.Equal(t, "mailchimp:list:list_a:segment:222", got.QueryAST.Value)
}

func TestTranslateAutomation_BuildsAlternatingChain(t *testing.T) {
	au := mcAutomation{ID: "auto-1", Status: "sending"}
	au.TriggerSettings.WorkflowType = "welcomeSeries"
	au.TriggerSettings.ListID = "list-1"
	au.Settings.Title = "Welcome"
	emails := []mcAutomationEmail{
		{ID: "e1"}, // Delay.Type "" => waits 0s
		{ID: "e2"},
	}
	emails[0].Delay.Type = "now"
	emails[0].Settings.TemplateID = 42
	emails[1].Delay.Amount = 2
	emails[1].Delay.Type = "day"

	got := translateAutomation(au, emails)
	require.Equal(t, "paused", got.Status)
	require.Len(t, got.Triggers, 1)
	require.Equal(t, "subscriber_added_to_list", got.Triggers[0].Type)

	// Expect: send-0, wait-1, send-1
	types := []string{}
	for _, n := range got.Nodes {
		types = append(types, n.Type)
	}
	require.Equal(t, []string{"send_email", "wait", "send_email"}, types)
	require.Empty(t, got.Nodes[0].TemplateID)
	require.Equal(t, "42", got.Nodes[0].Metadata["source_template_id"])
	require.Equal(t, "mailchimp:classic-automation:auto-1:email:e1", got.Nodes[0].Metadata["source_content_id"])
	require.Empty(t, got.Nodes[2].TemplateID, "source automation/template IDs must not be misused as destination IDs")
	require.Equal(t, int64(2*86400), got.Nodes[1].DurationSeconds)
}

func TestTranslateAutomation_UsesProductionRecipientsAudience(t *testing.T) {
	var au mcAutomation
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"auto-production",
		"status":"sending",
		"recipients":{"list_id":"audience-production"},
		"trigger_settings":{"workflow_type":"welcomeSeries"},
		"settings":{"title":"Production-shaped welcome"}
	}`), &au))
	require.Equal(t, "audience-production", automationAudienceID(au))

	email := mcAutomationEmail{ID: "email-production"}
	email.Delay.Type = "now"
	got := translateAutomation(au, []mcAutomationEmail{email})
	require.Len(t, got.Triggers, 1)
	require.Equal(t, "subscriber_added_to_list", got.Triggers[0].Type)
	require.Equal(t, "audience-production", got.Triggers[0].ListID)

	// recipients.list_id is authoritative; trigger_settings.list_id remains a
	// compatibility fallback for older fixtures/exports only.
	au.TriggerSettings.ListID = "legacy-other"
	require.Equal(t, "audience-production", automationAudienceID(au))
}

func TestTranslateAutomation_OfficialWorkflowTypesFailClosedExceptWelcomeSeries(t *testing.T) {
	officialWorkflowTypes := []string{
		"abandonedBrowse", "abandonedCart", "api", "bestCustomers", "categoryFollowup",
		"dateAdded", "emailFollowup", "emailSeries", "groupAdd", "groupRemove", "mandrill",
		"productFollowup", "purchaseFollowup", "recurringEvent", "specialEvent", "visitUrl",
		"welcomeSeries",
	}
	for _, workflowType := range officialWorkflowTypes {
		t.Run(workflowType, func(t *testing.T) {
			au := mcAutomation{ID: "automation-1", Status: "sending"}
			au.Settings.Title = workflowType
			au.Recipients.ListID = "audience-1"
			au.TriggerSettings.WorkflowType = workflowType
			email := mcAutomationEmail{ID: "email-1"}
			email.Delay.Type = "now"

			got := translateAutomation(au, []mcAutomationEmail{email})
			if workflowType == "welcomeSeries" {
				require.Len(t, got.Triggers, 1)
				require.Equal(t, "subscriber_added_to_list", got.Triggers[0].Type)
				require.Equal(t, "audience-1", got.Triggers[0].ListID)
				require.Len(t, got.Nodes, 1)
				require.NotContains(t, got.SourceDefinition, "postwave_unsupported_reason")
				return
			}
			require.Empty(t, got.Triggers)
			require.Empty(t, got.Nodes, "unsupported trigger semantics must not produce an executable email chain")
			require.Equal(t, "draft", got.Status)
			require.Contains(t, got.SourceDefinition, `"postwave_import_status":"manual_review"`)
			require.Contains(t, got.SourceDefinition, workflowType)
		})
	}
}

func TestTranslateAutomation_RuntimeWindowRequiresManualReview(t *testing.T) {
	au := mcAutomation{ID: "runtime-automation", Status: "sending"}
	au.Settings.Title = "Runtime constrained"
	au.Recipients.ListID = "audience-1"
	au.TriggerSettings.WorkflowType = "welcomeSeries"
	au.TriggerSettings.Runtime = map[string]interface{}{
		"days":  map[string]interface{}{"monday": true, "sunday": false},
		"hours": map[string]interface{}{"send_at": "09:00", "deliver_at": "17:00"},
	}
	email := mcAutomationEmail{ID: "email-1"}
	email.Delay.Type = "now"

	got := translateAutomation(au, []mcAutomationEmail{email})
	require.Empty(t, got.Triggers)
	require.Empty(t, got.Nodes)
	require.Equal(t, "draft", got.Status)
	require.Contains(t, got.SourceDefinition, `"runtime"`)
	require.Contains(t, got.SourceDefinition, `"postwave_import_status":"manual_review"`)
	require.Contains(t, got.SourceDefinition, "send-window restrictions")
}

func TestTranslateAutomation_UnknownOrInvalidDelayRequiresManualReview(t *testing.T) {
	for _, tc := range []struct {
		name   string
		unit   string
		amount int
	}{
		{name: "missing", unit: "", amount: 0},
		{name: "unknown", unit: "fortnight", amount: 1},
		{name: "negative", unit: "day", amount: -1},
		{name: "now_with_amount", unit: "now", amount: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			au := mcAutomation{ID: "delay-automation", Status: "sending"}
			au.Settings.Title = "Delay constrained"
			au.Recipients.ListID = "audience-1"
			au.TriggerSettings.WorkflowType = "welcomeSeries"
			email := mcAutomationEmail{ID: "email-1"}
			email.Delay.Type = tc.unit
			email.Delay.Amount = tc.amount

			got := translateAutomation(au, []mcAutomationEmail{email})
			require.Empty(t, got.Triggers)
			require.Empty(t, got.Nodes)
			require.Equal(t, "draft", got.Status)
			require.Contains(t, got.SourceDefinition, "postwave_unsupported_reason")
		})
	}
}

func TestTranslateTemplate_UsesDefaultContentWhenHTMLMissing(t *testing.T) {
	var content mcTemplateDefaultContent
	require.NoError(t, json.Unmarshal([]byte(`{"sections":{"body":"Hello","footer":"<p>Bye</p>"}}`), &content))
	got := translateTemplate(mcTemplate{ID: 42, Name: "Digest"}, content)
	require.Equal(t, "42", got.SourceID)
	require.Equal(t, "Digest", got.Name)
	require.Contains(t, got.HTML, `data-mailchimp-section="body"`)
	require.Contains(t, got.HTML, "<p>Hello</p>")
	require.Contains(t, got.HTML, "<p>Bye</p>")
	require.NotEmpty(t, got.SourceDefinition)
	require.Contains(t, got.Warnings[0], "template HTML was absent")
}
