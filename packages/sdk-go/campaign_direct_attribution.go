package postwave

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var campaignDirectAttributionUUID = regexp.MustCompile(
	`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
)
var campaignDirectAttributionCurrency = regexp.MustCompile(`^[A-Z]{3}$`)
var campaignDirectAttributionTimestamp = regexp.MustCompile(
	`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$`,
)

// CampaignDirectAttributionEvidenceListOptions selects exactly one bounded
// offset page. Omitting options uses the API default of 25; Offset zero is valid.
type CampaignDirectAttributionEvidenceListOptions struct {
	Limit  int
	Offset int
}

// CampaignDirectAttributionEvidenceSummary reconciles non-monetary counts for
// both campaign-linked evidence families without exposing a recipient, email
// address, code, or an invalid cross-currency money total.
type CampaignDirectAttributionEvidenceSummary struct {
	CodeAllocations          int64 `json:"code_allocations"`
	CodeRedemptions          int64 `json:"code_redemptions"`
	CodeLinkedOutcomes       int64 `json:"code_linked_outcomes"`
	NoClickRedemptions       int64 `json:"no_click_redemptions"`
	WithClickRedemptions     int64 `json:"with_click_redemptions"`
	ClickEvidenceUnavailable int64 `json:"click_evidence_unavailable"`
	VanityVisits             int64 `json:"vanity_visits"`
	VanityLinkedOutcomes     int64 `json:"vanity_linked_outcomes"`
}

func (summary *CampaignDirectAttributionEvidenceSummary) UnmarshalJSON(data []byte) error {
	if err := campaignDirectAttributionExactObject(data, "summary",
		"code_allocations", "code_redemptions", "code_linked_outcomes",
		"no_click_redemptions", "with_click_redemptions", "click_evidence_unavailable",
		"vanity_visits", "vanity_linked_outcomes",
	); err != nil {
		return err
	}
	type wire struct {
		CodeAllocations          *int64 `json:"code_allocations"`
		CodeRedemptions          *int64 `json:"code_redemptions"`
		CodeLinkedOutcomes       *int64 `json:"code_linked_outcomes"`
		NoClickRedemptions       *int64 `json:"no_click_redemptions"`
		WithClickRedemptions     *int64 `json:"with_click_redemptions"`
		ClickEvidenceUnavailable *int64 `json:"click_evidence_unavailable"`
		VanityVisits             *int64 `json:"vanity_visits"`
		VanityLinkedOutcomes     *int64 `json:"vanity_linked_outcomes"`
	}
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence summary: %w", err)
	}
	if decoded.CodeAllocations == nil || decoded.CodeRedemptions == nil ||
		decoded.CodeLinkedOutcomes == nil || decoded.NoClickRedemptions == nil ||
		decoded.WithClickRedemptions == nil || decoded.ClickEvidenceUnavailable == nil ||
		decoded.VanityVisits == nil || decoded.VanityLinkedOutcomes == nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence summary fields")
	}
	*summary = CampaignDirectAttributionEvidenceSummary{
		CodeAllocations:          *decoded.CodeAllocations,
		CodeRedemptions:          *decoded.CodeRedemptions,
		CodeLinkedOutcomes:       *decoded.CodeLinkedOutcomes,
		NoClickRedemptions:       *decoded.NoClickRedemptions,
		WithClickRedemptions:     *decoded.WithClickRedemptions,
		ClickEvidenceUnavailable: *decoded.ClickEvidenceUnavailable,
		VanityVisits:             *decoded.VanityVisits,
		VanityLinkedOutcomes:     *decoded.VanityLinkedOutcomes,
	}
	return nil
}

// CampaignDirectAttributionEvidenceItem is one opaque allocation or visit
// receipt. A nil LinkedWithoutRecordedAssignmentClick is retained historical
// uncertainty and must never be interpreted as false.
type CampaignDirectAttributionEvidenceItem struct {
	Kind                                 string     `json:"kind"`
	EvidenceID                           string     `json:"evidence_id"`
	OccurredAt                           time.Time  `json:"occurred_at"`
	Status                               string     `json:"status"`
	ExpiresAt                            *time.Time `json:"expires_at"`
	RedeemedAt                           *time.Time `json:"redeemed_at"`
	RedemptionID                         *int64     `json:"redemption_id"`
	ConversionID                         *int64     `json:"conversion_id"`
	AmountCents                          *int64     `json:"amount_cents"`
	Currency                             string     `json:"currency"`
	AttributedVia                        string     `json:"attributed_via"`
	AttributionScope                     string     `json:"attribution_scope"`
	LinkedWithoutRecordedAssignmentClick *bool      `json:"linked_without_recorded_assignment_click"`
	ReadershipProven                     bool       `json:"readership_proven"`
}

// UnmarshalJSON requires the literal false claim boundary and refuses unknown
// fields, including any accidental recipient/email/code projection.
func (item *CampaignDirectAttributionEvidenceItem) UnmarshalJSON(data []byte) error {
	if err := campaignDirectAttributionExactObject(data, "item",
		"kind", "evidence_id", "occurred_at", "status", "expires_at",
		"redeemed_at", "redemption_id", "conversion_id", "amount_cents",
		"currency", "attributed_via", "attribution_scope",
		"linked_without_recorded_assignment_click", "readership_proven",
	); err != nil {
		return err
	}
	type wire struct {
		Kind                                 *string    `json:"kind"`
		EvidenceID                           *string    `json:"evidence_id"`
		OccurredAt                           *time.Time `json:"occurred_at"`
		Status                               *string    `json:"status"`
		ExpiresAt                            *time.Time `json:"expires_at"`
		RedeemedAt                           *time.Time `json:"redeemed_at"`
		RedemptionID                         *int64     `json:"redemption_id"`
		ConversionID                         *int64     `json:"conversion_id"`
		AmountCents                          *int64     `json:"amount_cents"`
		Currency                             *string    `json:"currency"`
		AttributedVia                        *string    `json:"attributed_via"`
		AttributionScope                     *string    `json:"attribution_scope"`
		LinkedWithoutRecordedAssignmentClick *bool      `json:"linked_without_recorded_assignment_click"`
		ReadershipProven                     *bool      `json:"readership_proven"`
	}
	var decoded wire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	if decoded.Kind == nil || decoded.EvidenceID == nil || decoded.OccurredAt == nil ||
		decoded.Status == nil || decoded.Currency == nil || decoded.AttributedVia == nil ||
		decoded.AttributionScope == nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item fields")
	}
	if err := campaignDirectAttributionTimestampField(data, "occurred_at", false); err != nil {
		return err
	}
	if err := campaignDirectAttributionTimestampField(data, "expires_at", true); err != nil {
		return err
	}
	if err := campaignDirectAttributionTimestampField(data, "redeemed_at", true); err != nil {
		return err
	}
	if decoded.ReadershipProven == nil || *decoded.ReadershipProven {
		return fmt.Errorf("postwave: campaign direct-attribution evidence cannot prove readership")
	}
	*item = CampaignDirectAttributionEvidenceItem{
		Kind:                                 *decoded.Kind,
		EvidenceID:                           *decoded.EvidenceID,
		OccurredAt:                           *decoded.OccurredAt,
		Status:                               *decoded.Status,
		ExpiresAt:                            decoded.ExpiresAt,
		RedeemedAt:                           decoded.RedeemedAt,
		RedemptionID:                         decoded.RedemptionID,
		ConversionID:                         decoded.ConversionID,
		AmountCents:                          decoded.AmountCents,
		Currency:                             *decoded.Currency,
		AttributedVia:                        *decoded.AttributedVia,
		AttributionScope:                     *decoded.AttributionScope,
		LinkedWithoutRecordedAssignmentClick: decoded.LinkedWithoutRecordedAssignmentClick,
		ReadershipProven:                     false,
	}
	return nil
}

type CampaignDirectAttributionEvidencePageInfo struct {
	Limit   int   `json:"limit"`
	Offset  int   `json:"offset"`
	Total   int64 `json:"total"`
	HasMore bool  `json:"has_more"`
}

func (pageInfo *CampaignDirectAttributionEvidencePageInfo) UnmarshalJSON(data []byte) error {
	if err := campaignDirectAttributionExactObject(
		data, "page_info", "limit", "offset", "total", "has_more",
	); err != nil {
		return err
	}
	type wire struct {
		Limit   *int   `json:"limit"`
		Offset  *int   `json:"offset"`
		Total   *int64 `json:"total"`
		HasMore *bool  `json:"has_more"`
	}
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence page_info: %w", err)
	}
	if decoded.Limit == nil || decoded.Offset == nil || decoded.Total == nil || decoded.HasMore == nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence page_info fields")
	}
	*pageInfo = CampaignDirectAttributionEvidencePageInfo{
		Limit: *decoded.Limit, Offset: *decoded.Offset,
		Total: *decoded.Total, HasMore: *decoded.HasMore,
	}
	return nil
}

type CampaignDirectAttributionEvidencePage struct {
	CampaignID string                                    `json:"campaign_id"`
	Summary    CampaignDirectAttributionEvidenceSummary  `json:"summary"`
	Items      []CampaignDirectAttributionEvidenceItem   `json:"items"`
	PageInfo   CampaignDirectAttributionEvidencePageInfo `json:"page_info"`
}

func (page *CampaignDirectAttributionEvidencePage) UnmarshalJSON(data []byte) error {
	if err := campaignDirectAttributionExactObject(
		data, "page", "campaign_id", "summary", "items", "page_info",
	); err != nil {
		return err
	}
	type wire struct {
		CampaignID *string                                    `json:"campaign_id"`
		Summary    *CampaignDirectAttributionEvidenceSummary  `json:"summary"`
		Items      *[]CampaignDirectAttributionEvidenceItem   `json:"items"`
		PageInfo   *CampaignDirectAttributionEvidencePageInfo `json:"page_info"`
	}
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence page: %w", err)
	}
	if decoded.CampaignID == nil || decoded.Summary == nil || decoded.Items == nil || decoded.PageInfo == nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence page fields")
	}
	*page = CampaignDirectAttributionEvidencePage{
		CampaignID: *decoded.CampaignID, Summary: *decoded.Summary,
		Items: *decoded.Items, PageInfo: *decoded.PageInfo,
	}
	return nil
}

func campaignDirectAttributionExactObject(data []byte, label string, fields ...string) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence %s: %w", label, err)
	}
	if raw == nil || len(raw) != len(fields) {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence %s fields", label)
	}
	for _, field := range fields {
		if _, exists := raw[field]; !exists {
			return fmt.Errorf("postwave: invalid campaign direct-attribution evidence %s fields", label)
		}
	}
	return nil
}

func campaignDirectAttributionTimestampField(
	data []byte, field string, nullable bool,
) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence item timestamp: %w", err)
	}
	value := raw[field]
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		if nullable {
			return nil
		}
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
	}
	match := campaignDirectAttributionTimestamp.FindStringSubmatch(text)
	if match == nil || match[1] == "0000" {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
	}
	month, monthErr := strconv.Atoi(match[2])
	day, dayErr := strconv.Atoi(match[3])
	hour, hourErr := strconv.Atoi(match[4])
	minute, minuteErr := strconv.Atoi(match[5])
	second, secondErr := strconv.Atoi(match[6])
	if monthErr != nil || dayErr != nil || hourErr != nil || minuteErr != nil || secondErr != nil ||
		month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
	}
	if match[7] != "" {
		offsetHour, offsetHourErr := strconv.Atoi(match[7])
		offsetMinute, offsetMinuteErr := strconv.Atoi(match[8])
		if offsetHourErr != nil || offsetMinuteErr != nil || offsetHour > 23 || offsetMinute > 59 {
			return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %s", field)
	}
	return nil
}

// ListDirectAttributionEvidence returns one page and never allocates,
// redeems, or automatically walks subsequent pages.
func (r *CampaignsResource) ListDirectAttributionEvidence(
	ctx context.Context,
	campaignID string,
	options ...CampaignDirectAttributionEvidenceListOptions,
) (*CampaignDirectAttributionEvidencePage, error) {
	if r == nil || r.client == nil {
		return nil, fmt.Errorf("postwave: campaign direct-attribution evidence client is unavailable")
	}
	if strings.TrimSpace(campaignID) == "" {
		return nil, fmt.Errorf("postwave: campaign direct-attribution evidence campaign ID is required")
	}
	if len(options) > 1 {
		return nil, fmt.Errorf("postwave: campaign direct-attribution evidence accepts at most one options value")
	}
	input := CampaignDirectAttributionEvidenceListOptions{Limit: 25}
	if len(options) == 1 {
		input = options[0]
	}
	if input.Limit < 1 || input.Limit > 100 {
		return nil, fmt.Errorf("postwave: campaign direct-attribution evidence limit must be from 1 to 100")
	}
	if input.Offset < 0 || input.Offset > 10_000 {
		return nil, fmt.Errorf("postwave: campaign direct-attribution evidence offset must be from 0 to 10000")
	}
	query := url.Values{}
	query.Set("limit", fmt.Sprintf("%d", input.Limit))
	query.Set("offset", fmt.Sprintf("%d", input.Offset))
	path := "/api/v1/campaigns/" + url.PathEscape(campaignID) +
		"/direct-attribution-evidence?" + query.Encode()

	var raw json.RawMessage
	if err := r.client.request(ctx, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	var out CampaignDirectAttributionEvidencePage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&out); err != nil {
		return nil, fmt.Errorf("postwave: decode campaign direct-attribution evidence: %w", err)
	}
	if err := ensureCampaignDirectAttributionJSONEOF(decoder); err != nil {
		return nil, err
	}
	if err := validateCampaignDirectAttributionEvidencePage(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func ensureCampaignDirectAttributionJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("postwave: campaign direct-attribution evidence contains trailing JSON")
		}
		return fmt.Errorf("postwave: decode campaign direct-attribution evidence: %w", err)
	}
	return nil
}

func validateCampaignDirectAttributionEvidencePage(
	page *CampaignDirectAttributionEvidencePage,
) error {
	if page == nil || !campaignDirectAttributionUUID.MatchString(page.CampaignID) {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence campaign ID")
	}
	if page.Summary.CodeAllocations < 0 || page.Summary.CodeRedemptions < 0 ||
		page.Summary.CodeLinkedOutcomes < 0 || page.Summary.NoClickRedemptions < 0 ||
		page.Summary.WithClickRedemptions < 0 || page.Summary.ClickEvidenceUnavailable < 0 ||
		page.Summary.VanityVisits < 0 || page.Summary.VanityLinkedOutcomes < 0 {
		return fmt.Errorf("postwave: invalid campaign direct-attribution evidence summary")
	}
	remainingClickStates := page.Summary.CodeRedemptions
	if page.Summary.CodeRedemptions > page.Summary.CodeAllocations ||
		page.Summary.CodeLinkedOutcomes > page.Summary.CodeAllocations ||
		page.Summary.NoClickRedemptions > remainingClickStates {
		return fmt.Errorf("postwave: inconsistent campaign direct-attribution evidence summary")
	}
	remainingClickStates -= page.Summary.NoClickRedemptions
	if page.Summary.WithClickRedemptions > remainingClickStates {
		return fmt.Errorf("postwave: inconsistent campaign direct-attribution evidence summary")
	}
	remainingClickStates -= page.Summary.WithClickRedemptions
	if page.Summary.ClickEvidenceUnavailable != remainingClickStates ||
		page.Summary.VanityLinkedOutcomes > page.Summary.VanityVisits {
		return fmt.Errorf("postwave: inconsistent campaign direct-attribution evidence summary")
	}
	if page.PageInfo.Limit < 1 || page.PageInfo.Limit > 100 ||
		page.PageInfo.Offset < 0 || page.PageInfo.Offset > 10_000 ||
		page.PageInfo.Total < 0 || len(page.Items) > page.PageInfo.Limit ||
		len(page.Items) > 100 ||
		page.Summary.CodeAllocations > page.PageInfo.Total ||
		page.Summary.VanityVisits != page.PageInfo.Total-page.Summary.CodeAllocations ||
		page.PageInfo.HasMore != (int64(page.PageInfo.Offset+len(page.Items)) < page.PageInfo.Total) {
		return fmt.Errorf("postwave: inconsistent campaign direct-attribution evidence page info")
	}
	for index := range page.Items {
		item := &page.Items[index]
		if !campaignDirectAttributionUUID.MatchString(item.EvidenceID) ||
			item.OccurredAt.IsZero() || strings.TrimSpace(item.Status) == "" ||
			item.ReadershipProven ||
			(item.Currency != "" && !campaignDirectAttributionCurrency.MatchString(item.Currency)) {
			return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %d", index)
		}
		if item.RedemptionID != nil && *item.RedemptionID < 1 ||
			item.ConversionID != nil && *item.ConversionID < 1 {
			return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %d identifiers", index)
		}
		expectedVia, expectedScope := "code_redemption", "campaign_assignment"
		if item.Kind == "vanity_visit" {
			expectedVia, expectedScope = "campaign_vanity_path", "campaign"
		} else if item.Kind != "code_allocation" {
			return fmt.Errorf("postwave: invalid campaign direct-attribution evidence item %d kind", index)
		}
		if item.AttributedVia != expectedVia || item.AttributionScope != expectedScope {
			return fmt.Errorf("postwave: inconsistent campaign direct-attribution evidence item %d provenance", index)
		}
	}
	return nil
}
