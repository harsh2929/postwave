package klaviyo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMapCampaignEvidencePreservesEmailContentVariantsWithoutInventingReports(t *testing.T) {
	var campaign kvCampaign
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"campaign_sent","type":"campaign",
		"attributes":{"name":"Fallback name","status":"Sent","send_time":"2026-07-01T10:00:00Z"}
	}`), &campaign))
	var primary kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"message_primary","type":"campaign-message",
		"attributes":{"definition":{"channel":"email","content":{"subject":"Primary subject"}}}
	}`), &primary))
	var variant kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"message_variant","type":"campaign-message",
		"attributes":{"definition":{"channel":"email","content":{"subject":"Variant subject"}}}
	}`), &variant))
	var template kvTemplate
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"template_primary","type":"template",
		"attributes":{"name":"Primary","html":"<p>Hello</p>","text":"Hello"}
	}`), &template))

	got, err := mapCampaignEvidence(campaign, "email", []campaignMessageEvidence{
		{Message: primary, Templates: []kvTemplate{template}},
		{Message: variant},
	})
	require.NoError(t, err)
	require.Equal(t, "campaign_sent", got.SourceID)
	require.Equal(t, "Primary subject", got.Subject)
	require.Equal(t, "<p>Hello</p>", got.HTML)
	require.Equal(t, "Hello", got.Text)
	require.Equal(t, time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC), got.SentAt)
	require.Equal(t, false, got.Report["reporting_api_imported"])
	require.Len(t, got.Report["messages"], 2)
	require.Contains(t, got.Warnings[0], "Reporting API")
	require.Contains(t, got.Warnings[1], "2 message variants")
	require.Contains(t, got.Warnings[1], "first returned variant")
	require.NotContains(t, got.Warnings[1], "primary rendering")
}

func TestCampaignMessageEvidencePreservesFullDefinitionTimestampsAndCampaignTags(t *testing.T) {
	var message kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"push-message","type":"campaign-message",
		"attributes":{
			"created_at":"2026-07-01T01:00:00Z","updated_at":"2026-07-02T02:00:00Z",
			"definition":{"channel":"mobile_push","notification_type":"silent","content":{"title":"Hello"},"kv_pairs":{"account_id":"42"},"options":{"on_open":"deep_link","deep_link":"moosewave://inbox","badge":3,"sound":"chime"}}
		},
		"relationships":{"campaign":{"data":{"id":"campaign-tagged","type":"campaign"}},"image":{"data":{"id":"image-1","type":"image"}}}
	}`), &message))
	payload, err := json.Marshal(campaignMessagePayloads([]campaignMessageEvidence{{Message: message}}))
	require.NoError(t, err)
	for _, want := range []string{"notification_type", "silent", "kv_pairs", "deep_link", "badge", "sound", "created_at", "updated_at", "campaign-tagged", "image-1"} {
		require.Contains(t, string(payload), want)
	}

	var campaign kvCampaign
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"campaign-tagged","type":"campaign",
		"attributes":{"name":"Tagged","status":"Sent","updated_at":"2026-07-03T03:00:00Z"},
		"relationships":{"tags":{"data":[{"id":"tag-1","type":"tag"}]}}
	}`), &campaign))
	payload, err = json.Marshal(structToMap(campaign))
	require.NoError(t, err)
	require.Contains(t, string(payload), "2026-07-03T03:00:00Z")
	require.Contains(t, string(payload), "tag-1")
}

func TestGetCampaignMessagesPreservesNullableDefinitionForDraftButRejectsSent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/campaign-messages/message-null", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":"message-null","type":"campaign-message","attributes":{"definition":null},"relationships":{"campaign":{"data":{"id":"campaign-null","type":"campaign"}},"template":{"data":null},"image":{"data":{"id":"image-null","type":"image"}}}},"included":[]}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	var campaign kvCampaign
	campaign.ID = "campaign-null"
	campaign.Type = "campaign"
	campaign.Attributes.Name = "Incomplete draft"
	campaign.Attributes.Status = "Draft"
	campaign.Relationships.Messages.Data = []kvResourceIdentifier{{ID: "message-null", Type: "campaign-message"}}

	messages, err := a.getCampaignMessages(context.Background(), inventoryTestSession("account_nullable_draft"), campaign, "email")
	require.NoError(t, err)
	require.Len(t, messages, 1)
	require.Nil(t, messages[0].Message.Attributes.Definition)
	item := klaviyoCampaignRebuildItem(campaignRebuildEvidence{Campaign: campaign, Channel: "email", Messages: messages})
	payload, err := json.Marshal(item.Payload)
	require.NoError(t, err)
	require.Contains(t, string(payload), `"definition":null`)
	require.Contains(t, string(payload), "null campaign-message definition")
	require.Contains(t, string(payload), "image relationship ID")

	campaign.Attributes.Status = "Sent"
	_, err = a.getCampaignMessages(context.Background(), inventoryTestSession("account_nullable_sent"), campaign, "email")
	require.ErrorContains(t, err, "omitted its content definition")
}

func TestGetCampaignMessagesPreservesMessageLessDraftAsIncompleteRebuild(t *testing.T) {
	var campaign kvCampaign
	campaign.ID = "campaign-empty"
	campaign.Type = "campaign"
	campaign.Attributes.Name = "Early draft"
	campaign.Attributes.Status = "Draft"

	messages, err := New().getCampaignMessages(context.Background(), inventoryTestSession("account_empty_draft"), campaign, "email")
	require.NoError(t, err)
	require.Empty(t, messages)
	item := klaviyoCampaignRebuildItem(campaignRebuildEvidence{Campaign: campaign, Channel: "email", Messages: messages})
	payload, err := json.Marshal(item.Payload)
	require.NoError(t, err)
	require.Contains(t, string(payload), "no campaign-message relationship")

	campaign.Attributes.Status = "Sent"
	_, err = New().getCampaignMessages(context.Background(), inventoryTestSession("account_empty_sent"), campaign, "email")
	require.ErrorContains(t, err, "no message relationship")
}

func TestGetCampaignMessagesPreservesDraftEmailDefinitionWithoutTemplate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/campaign-messages/message-no-template", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":"message-no-template","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{"subject":"Unfinished"}}},"relationships":{"campaign":{"data":{"id":"campaign-no-template","type":"campaign"}}}},"included":[]}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	var campaign kvCampaign
	campaign.ID = "campaign-no-template"
	campaign.Type = "campaign"
	campaign.Attributes.Name = "Unfinished draft"
	campaign.Attributes.Status = "Draft"
	campaign.Relationships.Messages.Data = []kvResourceIdentifier{{ID: "message-no-template", Type: "campaign-message"}}

	messages, err := a.getCampaignMessages(context.Background(), inventoryTestSession("account_no_template_draft"), campaign, "email")
	require.NoError(t, err)
	require.Len(t, messages, 1)
	require.NotNil(t, messages[0].Message.Attributes.Definition)
	item := klaviyoCampaignRebuildItem(campaignRebuildEvidence{Campaign: campaign, Channel: "email", Messages: messages})
	payload, err := json.Marshal(item.Payload)
	require.NoError(t, err)
	require.Contains(t, string(payload), "no template relationship")

	campaign.Attributes.Status = "Sent"
	_, err = a.getCampaignMessages(context.Background(), inventoryTestSession("account_no_template_sent"), campaign, "email")
	require.ErrorContains(t, err, "omitted its template relationship")
}

func TestKlaviyoFlowArchiveMarksNullableDefinitionIncomplete(t *testing.T) {
	var flow kvResource
	require.NoError(t, json.Unmarshal([]byte(`{"id":"flow-null","type":"flow","attributes":{"name":"Legacy flow","definition":null}}`), &flow))
	item := klaviyoFlowArchiveItem(flow)
	require.Equal(t, false, item.Payload["definition_available"])
	require.Contains(t, item.Payload["loss_reason"], "not rebuild-complete")
	automation := translateFlow(flow)
	require.Contains(t, automation.SourceDefinition, "not rebuild-complete")
}

func TestKlaviyoTemplateArchiveMarksMissingRenderedAndStructuredContentIncomplete(t *testing.T) {
	var template kvTemplate
	require.NoError(t, json.Unmarshal([]byte(`{"id":"template-null","type":"template","attributes":{"name":"Legacy template","html":null,"definition":null}}`), &template))
	item := klaviyoTemplateRebuildItem(template)
	require.Equal(t, false, item.Payload["definition_available"])
	require.Contains(t, item.Payload["loss_reason"], "no structured definition")
}

func TestGetCampaignMessagesRejectsMismatchedOrAmbiguousEmailTemplateEvidence(t *testing.T) {
	tests := map[string]string{
		"mismatched": `{"data":{"id":"message-1","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{"subject":"Hello"}}},"relationships":{"template":{"data":{"id":"template-1","type":"template"}}}},"included":[{"id":"template-2","type":"template","attributes":{"name":"Other"}}]}`,
		"multiple":   `{"data":{"id":"message-1","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{"subject":"Hello"}}},"relationships":{"template":{"data":{"id":"template-1","type":"template"}}}},"included":[{"id":"template-1","type":"template","attributes":{"name":"Expected"}},{"id":"template-2","type":"template","attributes":{"name":"Other"}}]}`,
	}
	for name, response := range tests {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/campaign-messages/message-1", r.URL.Path)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(response))
			}))
			defer srv.Close()
			a := New()
			a.BaseURL = srv.URL
			var campaign kvCampaign
			campaign.ID = "campaign-1"
			campaign.Relationships.Messages.Data = []kvResourceIdentifier{{ID: "message-1", Type: "campaign-message"}}
			_, err := a.getCampaignMessages(context.Background(), inventoryTestSession("account_"+name), campaign, "email")
			require.Error(t, err)
			require.Contains(t, err.Error(), "ambiguous or mismatched template evidence")
		})
	}
}

func TestMapCampaignEvidenceRequiresExactSentTimestamp(t *testing.T) {
	var campaign kvCampaign
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"campaign_without_send","type":"campaign",
		"attributes":{"name":"No exact send","status":"Sent","created_at":"2026-07-01T10:00:00Z","scheduled_at":"2026-07-02T10:00:00Z"}
	}`), &campaign))
	var message kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"message","type":"campaign-message",
		"attributes":{"definition":{"channel":"sms","content":{"body":"hello"}},"send_times":[]}
	}`), &message))
	_, err := mapCampaignEvidence(campaign, "sms", []campaignMessageEvidence{{Message: message}})
	require.Error(t, err)
	require.Contains(t, err.Error(), "no send timestamp")
}

func TestCampaignSentAtPreservesIsLocalAndRejectsRecipientLocalFallback(t *testing.T) {
	var campaign kvCampaign
	require.NoError(t, json.Unmarshal([]byte(`{"id":"campaign-local","type":"campaign","attributes":{"name":"Local send","status":"Sent","send_time":null}}`), &campaign))
	var local kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{"id":"message-local","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{}},"send_times":[{"datetime":"2026-07-01T09:00:00Z","is_local":true}]}}`), &local))
	payload, err := json.Marshal(campaignMessagePayloads([]campaignMessageEvidence{{Message: local}}))
	require.NoError(t, err)
	require.Contains(t, string(payload), `"is_local":true`)
	_, err = campaignSentAt(campaign, []campaignMessageEvidence{{Message: local}})
	require.ErrorContains(t, err, "recipient-local")

	var absolute kvMessage
	require.NoError(t, json.Unmarshal([]byte(`{"id":"message-absolute","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{}},"send_times":[{"datetime":"2026-07-01T09:00:00Z","is_local":false}]}}`), &absolute))
	got, err := campaignSentAt(campaign, []campaignMessageEvidence{{Message: absolute}})
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC), got)
}

func TestCampaignSentAtRejectsRecipientLocalStrategyEvenWithTopLevelSendTime(t *testing.T) {
	var campaign kvCampaign
	require.NoError(t, json.Unmarshal([]byte(`{
		"id":"campaign-local-strategy","type":"campaign",
		"attributes":{"name":"Local strategy","status":"Sent","send_time":"2026-07-01T09:00:00Z","send_strategy":{"method":"static","options":{"is_local":true,"datetime":"2026-07-01T09:00:00"}}}
	}`), &campaign))
	_, err := campaignSentAt(campaign, nil)
	require.ErrorContains(t, err, "recipient-local send strategy")
}
