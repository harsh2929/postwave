package postwave

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const campaignDirectAttributionPageFixture = `{
  "campaign_id":"11111111-1111-4111-8111-111111111111",
  "summary":{
    "code_allocations":6,"code_redemptions":1,"code_linked_outcomes":0,
    "no_click_redemptions":0,"with_click_redemptions":0,
    "click_evidence_unavailable":1,"vanity_visits":0,
    "vanity_linked_outcomes":0
  },
  "items":[{
    "kind":"code_allocation","evidence_id":"22222222-2222-4222-8222-222222222222",
    "occurred_at":"2026-08-30T12:00:00Z","status":"redeemed",
    "expires_at":null,"redeemed_at":"2026-08-30T12:05:00Z",
    "redemption_id":41,"conversion_id":null,"amount_cents":null,"currency":"",
    "attributed_via":"code_redemption","attribution_scope":"campaign_assignment",
    "linked_without_recorded_assignment_click":null,"readership_proven":false
  }],
  "page_info":{"limit":17,"offset":4,"total":6,"has_more":true}
}`

func TestCampaignsListDirectAttributionEvidenceIsOneEncodedRead(t *testing.T) {
	var calls atomic.Int32
	var seenMethod, seenURI, seenBody string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		seenMethod = request.Method
		seenURI = request.RequestURI
		body, _ := io.ReadAll(request.Body)
		seenBody = string(body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(campaignDirectAttributionPageFixture))
	}))
	defer server.Close()

	client := New(
		"pw_f04",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithMaxRetries(0),
	)
	page, err := client.Campaigns.ListDirectAttributionEvidence(
		context.Background(),
		"campaign/a b",
		CampaignDirectAttributionEvidenceListOptions{Limit: 17, Offset: 4},
	)
	if err != nil {
		t.Fatalf("ListDirectAttributionEvidence: %v", err)
	}
	if calls.Load() != 1 || seenMethod != http.MethodGet || seenBody != "" {
		t.Fatalf("request = calls %d, method %q, body %q", calls.Load(), seenMethod, seenBody)
	}
	wantURI := "/api/v1/campaigns/campaign%2Fa%20b/direct-attribution-evidence?limit=17&offset=4"
	if seenURI != wantURI {
		t.Fatalf("request URI = %q, want %q", seenURI, wantURI)
	}
	if page.Items[0].LinkedWithoutRecordedAssignmentClick != nil {
		t.Fatal("nullable event-time click observation was not preserved")
	}
	if page.Items[0].ReadershipProven {
		t.Fatal("readership_proven must remain false")
	}
	occurredAt, _ := time.Parse(time.RFC3339, "2026-08-30T12:00:00Z")
	redeemedAt, _ := time.Parse(time.RFC3339, "2026-08-30T12:05:00Z")
	redemptionID := int64(41)
	want := CampaignDirectAttributionEvidencePage{
		CampaignID: "11111111-1111-4111-8111-111111111111",
		Summary: CampaignDirectAttributionEvidenceSummary{
			CodeAllocations: 6, CodeRedemptions: 1, CodeLinkedOutcomes: 0,
			NoClickRedemptions: 0, WithClickRedemptions: 0,
			ClickEvidenceUnavailable: 1, VanityVisits: 0, VanityLinkedOutcomes: 0,
		},
		Items: []CampaignDirectAttributionEvidenceItem{{
			Kind: "code_allocation", EvidenceID: "22222222-2222-4222-8222-222222222222",
			OccurredAt: occurredAt, Status: "redeemed", ExpiresAt: nil, RedeemedAt: &redeemedAt,
			RedemptionID: &redemptionID, ConversionID: nil, AmountCents: nil, Currency: "",
			AttributedVia: "code_redemption", AttributionScope: "campaign_assignment",
			LinkedWithoutRecordedAssignmentClick: nil, ReadershipProven: false,
		}},
		PageInfo: CampaignDirectAttributionEvidencePageInfo{Limit: 17, Offset: 4, Total: 6, HasMore: true},
	}
	if !reflect.DeepEqual(*page, want) {
		t.Fatalf("decoded page = %#v, want %#v", *page, want)
	}
}

func TestCampaignsListDirectAttributionEvidenceStrictlyRejectsIdentityAndClaims(t *testing.T) {
	for name, body := range map[string]string{
		"identity field": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"readership_proven":false`,
			`"recipient_email":"person@example.com","readership_proven":false`,
			1,
		),
		"readership claim": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"readership_proven":false`,
			`"readership_proven":true`,
			1,
		),
		"non-boolean readership claim": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"readership_proven":false`,
			`"readership_proven":0`,
			1,
		),
		"provenance mismatch": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"attribution_scope":"campaign_assignment"`,
			`"attribution_scope":"campaign"`,
			1,
		),
		"removed aggregate": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"code_linked_outcomes":0,`,
			`"code_linked_outcomes":0,"code_revenue_cents":-25,`,
			1,
		),
		"missing summary field": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_allocations":6,`, ``, 1,
		),
		"missing nullable item field": strings.Replace(
			campaignDirectAttributionPageFixture, `"expires_at":null,`, ``, 1,
		),
		"missing page field": strings.Replace(
			campaignDirectAttributionPageFixture, `,"has_more":true`, ``, 1,
		),
		"invalid calendar date": strings.Replace(
			campaignDirectAttributionPageFixture,
			`2026-08-30T12:00:00Z`, `2026-02-30T12:00:00Z`, 1,
		),
		"invalid timezone offset": strings.Replace(
			campaignDirectAttributionPageFixture,
			`2026-08-30T12:00:00Z`, `2026-08-30T12:00:00+24:00`, 1,
		),
		"invalid clock hour": strings.Replace(
			campaignDirectAttributionPageFixture,
			`2026-08-30T12:00:00Z`, `2026-08-30T24:00:00Z`, 1,
		),
		"invalid evidence UUID": strings.Replace(
			campaignDirectAttributionPageFixture,
			`22222222-2222-4222-8222-222222222222`, `not-a-uuid`, 1,
		),
		"blank status": strings.Replace(
			campaignDirectAttributionPageFixture, `"status":"redeemed"`, `"status":"   "`, 1,
		),
		"negative summary": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_allocations":6`, `"code_allocations":-1`, 1,
		),
		"null summary integer": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_allocations":6`, `"code_allocations":null`, 1,
		),
		"overflow summary": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_allocations":6`, `"code_allocations":9223372036854775808`, 1,
		),
		"zero conversion id": strings.Replace(
			campaignDirectAttributionPageFixture, `"conversion_id":null`, `"conversion_id":0`, 1,
		),
		"non-boolean click state": strings.Replace(
			campaignDirectAttributionPageFixture,
			`"linked_without_recorded_assignment_click":null`,
			`"linked_without_recorded_assignment_click":0`, 1,
		),
		"dishonest currency": strings.Replace(
			campaignDirectAttributionPageFixture, `"currency":""`, `"currency":"usd"`, 1,
		),
		"null currency": strings.Replace(
			campaignDirectAttributionPageFixture, `"currency":""`, `"currency":null`, 1,
		),
		"redemptions exceed allocations": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_redemptions":1`, `"code_redemptions":7`, 1,
		),
		"linked outcomes exceed allocations": strings.Replace(
			campaignDirectAttributionPageFixture, `"code_linked_outcomes":0`, `"code_linked_outcomes":7`, 1,
		),
		"click states do not reconcile": strings.Replace(
			campaignDirectAttributionPageFixture, `"no_click_redemptions":0`, `"no_click_redemptions":1`, 1,
		),
		"vanity outcomes exceed visits": strings.Replace(
			strings.Replace(
				campaignDirectAttributionPageFixture, `"vanity_visits":0`, `"vanity_visits":1`, 1,
			),
			`"vanity_linked_outcomes":0`, `"vanity_linked_outcomes":2`, 1,
		),
		"total does not reconcile": strings.Replace(
			campaignDirectAttributionPageFixture, `"total":6`, `"total":7`, 1,
		),
		"has_more contradiction": strings.Replace(
			campaignDirectAttributionPageFixture, `"has_more":true`, `"has_more":false`, 1,
		),
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write([]byte(body))
			}))
			defer server.Close()
			client := New("pw_f04", WithBaseURL(server.URL), WithHTTPClient(server.Client()), WithMaxRetries(0))
			_, err := client.Campaigns.ListDirectAttributionEvidence(
				context.Background(), "campaign", CampaignDirectAttributionEvidenceListOptions{Limit: 17, Offset: 4},
			)
			if err == nil {
				t.Fatal("hostile evidence response must fail closed")
			}
		})
	}
}

func TestCampaignDirectAttributionDecoderRejectsNullItemsArray(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(campaignDirectAttributionPageFixture), &payload); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	payload["items"] = nil
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	var decoded CampaignDirectAttributionEvidencePage
	if err := json.Unmarshal(body, &decoded); err == nil {
		t.Fatal("null items must fail the closed response decoder")
	}
}

func TestCampaignsListDirectAttributionEvidencePreservesUnspecifiedCurrency(t *testing.T) {
	body := strings.Replace(
		campaignDirectAttributionPageFixture, `"amount_cents":null`, `"amount_cents":125`, 1,
	)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(body))
	}))
	defer server.Close()
	client := New("pw_f04", WithBaseURL(server.URL), WithHTTPClient(server.Client()), WithMaxRetries(0))
	page, err := client.Campaigns.ListDirectAttributionEvidence(
		context.Background(), "campaign", CampaignDirectAttributionEvidenceListOptions{Limit: 17, Offset: 4},
	)
	if err != nil {
		t.Fatalf("ListDirectAttributionEvidence: %v", err)
	}
	if page.Items[0].AmountCents == nil || *page.Items[0].AmountCents != 125 || page.Items[0].Currency != "" {
		t.Fatalf("money = (%v, %q), want (125, unspecified)", page.Items[0].AmountCents, page.Items[0].Currency)
	}
	withCurrency := strings.Replace(
		campaignDirectAttributionPageFixture, `"currency":""`, `"currency":"USD"`, 1,
	)
	var decoded CampaignDirectAttributionEvidencePage
	if err := json.Unmarshal([]byte(withCurrency), &decoded); err != nil {
		t.Fatalf("decode non-monetary item with currency provenance: %v", err)
	}
	if err := validateCampaignDirectAttributionEvidencePage(&decoded); err != nil {
		t.Fatalf("validate non-monetary item with currency provenance: %v", err)
	}
	if decoded.Items[0].AmountCents != nil || decoded.Items[0].Currency != "USD" {
		t.Fatalf("money = (%v, %q), want (nil, USD)", decoded.Items[0].AmountCents, decoded.Items[0].Currency)
	}
}

func TestCampaignsListDirectAttributionEvidenceValidatesBoundsBeforeTransport(t *testing.T) {
	client := New("pw_f04", WithBaseURL("http://127.0.0.1:1"), WithMaxRetries(0))
	for _, options := range []CampaignDirectAttributionEvidenceListOptions{
		{Limit: 0}, {Limit: -1}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 10_001},
	} {
		t.Run(fmt.Sprintf("%d-%d", options.Limit, options.Offset), func(t *testing.T) {
			_, err := client.Campaigns.ListDirectAttributionEvidence(context.Background(), "campaign", options)
			if err == nil || !strings.Contains(err.Error(), "campaign direct-attribution evidence") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}
