package klaviyo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestDiscoverBuildsExactKlaviyoSnapshotAndHonorsListSuppressions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/profiles":
			if r.URL.Query().Get("page[cursor]") == "profile-next" {
				_, _ = w.Write([]byte(`{
					"data":[
						{"id":"p2","type":"profile","attributes":{"email":"two@example.com","first_name":"Grace","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","consent_timestamp":"2026-07-01T00:00:00Z","double_optin":true,"suppression":[],"list_suppressions":[]}}}}},
						{"id":"p3","type":"profile","attributes":{"phone_number":"+15550000003"}}
					],
					"links":{"next":""}
				}`))
				return
			}
			_, _ = w.Write([]byte(`{
				"data":[{"id":"p1","type":"profile","attributes":{"email":"one@example.com","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","consent_timestamp":"2026-07-01T00:00:00Z","double_optin":false,"suppression":[],"list_suppressions":[{"list_id":"L1","reason":"UNSUBSCRIBE","timestamp":"2026-07-02T00:00:00Z"}]}}}}}],
				"links":{"next":"https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=profile-next"}
			}`))
		case "/lists":
			_, _ = w.Write([]byte(`{"data":[{"id":"L1","type":"list","attributes":{"name":null}}],"links":{"next":""}}`))
		case "/segments":
			_, _ = w.Write([]byte(`{"data":[{"id":"S1","type":"segment","attributes":{"name":null}}],"links":{"next":""}}`))
		case "/lists/L1/profiles":
			require.Equal(t, "100", r.URL.Query().Get("page[size]"))
			_, _ = w.Write([]byte(`{"data":[{"id":"p1","type":"profile"},{"id":"p2","type":"profile"},{"id":"p3","type":"profile"}],"links":{"next":""}}`))
		case "/segments/S1/profiles":
			require.Equal(t, "100", r.URL.Query().Get("page[size]"))
			_, _ = w.Write([]byte(`{"data":[{"id":"p2","type":"profile"}],"links":{"next":""}}`))
		case "/flows":
			_, _ = w.Write([]byte(`{"data":[{"id":"F1","type":"flow","attributes":{"name":null}}],"links":{"next":""}}`))
		case "/flows/F1":
			_, _ = w.Write([]byte(`{"data":{"id":"F1","type":"flow","attributes":{"name":null,"status":"live","definition":{"triggers":[],"actions":[]}}}}`))
		case "/forms":
			require.Equal(t, "created_at", r.URL.Query().Get("sort"), "Klaviyo Forms rejects sort=id")
			_, _ = w.Write([]byte(`{"data":[{"id":"FORM1","type":"form","attributes":{"name":"Popup"}}],"links":{"next":""}}`))
		case "/templates":
			_, _ = w.Write([]byte(`{
				"data":[
					{"id":"T1","type":"template","attributes":{"name":"Editable","html":"<p>Hello</p>","text":"Hello"}},
					{"id":"T2","type":"template","attributes":{"name":"Structured","editor_type":"SYSTEM_DRAGGABLE","definition":{"rows":[]}}}
				],
				"links":{"next":""}
			}`))
		case "/campaigns":
			require.Empty(t, r.URL.Query().Get("include"), "campaign included resources must not be fetched and silently discarded")
			switch r.URL.Query().Get("filter") {
			case "equals(messages.channel,'email')":
				_, _ = w.Write([]byte(`{
					"data":[
						{"id":"C1","type":"campaign","attributes":{"name":"Sent email","status":"Sent","channel":"email","send_time":"2026-06-01T00:00:00Z"}},
						{"id":"C2","type":"campaign","attributes":{"name":"Draft email","status":"Draft","channel":"email"},"relationships":{"campaign-messages":{"data":[{"id":"M2","type":"campaign-message"}]}}}
					],"links":{"next":""}
				}`))
			case "equals(messages.channel,'sms')":
				_, _ = w.Write([]byte(`{"data":[{"id":"C3","type":"campaign","attributes":{"name":"Sent SMS","status":"Sent","channel":"sms","send_time":"2026-06-02T00:00:00Z"},"relationships":{"campaign-messages":{"data":[{"id":"M3","type":"campaign-message"}]},"tags":{"data":[{"id":"TAG-SMS","type":"tag"}]}}}],"links":{"next":""}}`))
			case "equals(messages.channel,'mobile_push')":
				_, _ = w.Write([]byte(`{"data":[],"links":{"next":""}}`))
			default:
				t.Fatalf("unexpected campaign filter: %q", r.URL.Query().Get("filter"))
			}
		case "/campaign-messages/M2":
			require.Equal(t, "template", r.URL.Query().Get("include"))
			_, _ = w.Write([]byte(`{"data":{"id":"M2","type":"campaign-message","attributes":{"definition":{"channel":"email","content":{"subject":"Draft subject"}}},"relationships":{"template":{"data":{"id":"T-DRAFT","type":"template"}}}},"included":[{"id":"T-DRAFT","type":"template","attributes":{"name":"Draft template","html":"<p>Draft body</p>","text":"Draft body"}}]}`))
		case "/campaign-messages/M3":
			require.Equal(t, "template", r.URL.Query().Get("include"))
			_, _ = w.Write([]byte(`{"data":{"id":"M3","type":"campaign-message","attributes":{"created_at":"2026-05-01T00:00:00Z","updated_at":"2026-05-02T00:00:00Z","definition":{"channel":"sms","content":{"body":"SMS archive body"},"send_options":{"shorten_links":true}}}},"included":[]}`))
		default:
			t.Fatalf("unexpected Klaviyo request: %s", r.URL.String())
		}
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := inventoryTestSession("account_inventory")
	discovery, err := a.Discover(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, 2, discovery.SubscribersTotal)
	require.Equal(t, 1, discovery.ProfilesWithoutEmailTotal)
	require.Equal(t, 2, discovery.SegmentsTotal)
	require.Equal(t, 1, discovery.AutomationsTotal)
	require.Equal(t, 1, discovery.ArchiveTotal)
	require.Equal(t, 3, discovery.CampaignsTotal)
	require.Equal(t, 1, discovery.TemplatesTotal)
	require.Equal(t, 1, discovery.FormsTotal)
	require.Equal(t, 1, discovery.SMSCampaignsTotal)
	require.Equal(t, 0, discovery.PushCampaignsTotal)
	require.Equal(t, 13, discovery.SourceArchiveTotal)
	require.Equal(t, 1, discovery.SnapshotMembershipCounts["klaviyo:list:L1"], "list-level suppression must reduce the send-targetable membership total")
	require.Equal(t, 1, discovery.SnapshotMembershipCounts["klaviyo:segment:S1"])
	require.Len(t, discovery.Audiences, 2)
	require.Equal(t, "Klaviyo list L1", discovery.Audiences[0].Name)
	require.Equal(t, "Klaviyo segment S1", discovery.Audiences[1].Name)

	segments, err := a.ListSegments(context.Background(), sess)
	require.NoError(t, err)
	require.Len(t, segments, 2)
	require.Equal(t, "Klaviyo list L1", segments[0].Name)
	require.Equal(t, "Klaviyo segment S1", segments[1].Name)

	first, next, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, first, 1)
	require.Empty(t, first[0].Tags, "a list-suppressed profile must not retain its list tag")
	require.Equal(t, "profile-next", next)
	second, next, err := a.ListSubscribers(context.Background(), sess, next)
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, second, 1, "the email-less profile must be excluded from email subscribers")
	require.ElementsMatch(t, []string{"klaviyo:list:L1", "klaviyo:segment:S1"}, second[0].Tags)

	templates, next, err := a.ListTemplates(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, templates, 1)
	require.Equal(t, "T1", templates[0].SourceID)

	automations, err := a.ListAutomations(context.Background(), sess)
	require.NoError(t, err)
	require.Len(t, automations, 1)
	require.Equal(t, "Klaviyo flow F1", automations[0].Name)
	require.Equal(t, "draft", automations[0].Status)
	require.Empty(t, automations[0].Nodes)

	archiveTypes := map[string]int{}
	cursor := ""
	archiveCount := 0
	for {
		items, next, err := a.ListSourceArchive(context.Background(), sess, cursor)
		require.NoError(t, err)
		archiveCount += len(items)
		for _, item := range items {
			archiveTypes[item.ResourceType]++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	require.Equal(t, discovery.SourceArchiveTotal, archiveCount)
	require.Equal(t, 1, archiveTypes["klaviyo_form"])
	require.Equal(t, 1, archiveTypes["klaviyo_flow_rebuild"])
	require.Equal(t, 1, archiveTypes["klaviyo_non_email_campaign_archive"])
	require.Equal(t, 1, archiveTypes["klaviyo_campaign_rebuild"])
	require.Equal(t, 1, archiveTypes["klaviyo_template_rebuild"])

	var rebuildItem canonical.SourceArchiveItem
	for cursor := ""; ; {
		items, next, err := a.ListSourceArchive(context.Background(), sess, cursor)
		require.NoError(t, err)
		for _, item := range items {
			if item.ResourceType == "klaviyo_campaign_rebuild" {
				rebuildItem = item
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	require.NotEmpty(t, rebuildItem.SourceID)
	preserved, err := json.Marshal(rebuildItem.Payload)
	require.NoError(t, err)
	require.Contains(t, string(preserved), "Draft subject")
	require.Contains(t, string(preserved), "Draft body")

	var flowItem canonical.SourceArchiveItem
	for cursor := ""; ; {
		items, next, err := a.ListSourceArchive(context.Background(), sess, cursor)
		require.NoError(t, err)
		for _, item := range items {
			if item.ResourceType == "klaviyo_flow_rebuild" {
				flowItem = item
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	require.Equal(t, "Klaviyo flow F1", flowItem.Name)
	require.Equal(t, true, flowItem.Payload["definition_available"])
	preserved, err = json.Marshal(flowItem.Payload)
	require.NoError(t, err)
	require.Contains(t, string(preserved), "definition")
}

func TestDiscoverFailsClosedWhenLaterProfilePageFails(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"data":[{"id":"p1","type":"profile","attributes":{"email":"one@example.com","subscriptions":{"email":{"marketing":{"can_receive_email_marketing":true,"consent":"SUBSCRIBED","consent_timestamp":"2026-07-01T00:00:00Z","double_optin":true,"suppression":[],"list_suppressions":[]}}}}}],"links":{"next":"https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=second"}}`))
			return
		}
		http.Error(w, "later page unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	_, err := a.Discover(context.Background(), inventoryTestSession("account_later_page"))
	require.Error(t, err)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Equal(t, 2, calls)
}

func TestKlaviyoSourceArchiveRejectsPreFlowOrderingCursor(t *testing.T) {
	_, err := parseKlaviyoArchiveCursor("klv17:7")
	require.Error(t, err)
	require.Contains(t, err.Error(), "bad source archive cursor")
	idx, err := parseKlaviyoArchiveCursor("klv18:7")
	require.NoError(t, err)
	require.Equal(t, 7, idx)
}

func TestGetFlowDefinitionPreservesExplicitNullAsIncompleteEvidence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/flows/FNULL", r.URL.Path)
		require.Equal(t, "definition", r.URL.Query().Get("additional-fields[flow]"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":"FNULL","type":"flow","attributes":{"name":null,"definition":null}}}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	flow, err := a.getFlowDefinition(context.Background(), inventoryTestSession("account_null_flow"), "FNULL")
	require.NoError(t, err)
	item := klaviyoFlowArchiveItem(flow)
	require.Equal(t, false, item.Payload["definition_available"])
	require.Contains(t, item.Payload["loss_reason"], "not rebuild-complete")
}

func inventoryTestSession(accountID string) adapter.Session {
	return adapter.Session{
		Source:      canonical.SourceKlaviyo,
		AccessToken: "test-token",
		AccountID:   accountID,
		Extra: map[string]string{
			AccountIDExtraKey:          accountID,
			AccountFingerprintExtraKey: accountFingerprint(accountID),
			"auth_scheme":              "private_api_key",
		},
	}
}
