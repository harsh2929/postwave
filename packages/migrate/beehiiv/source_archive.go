// SPDX-License-Identifier: MIT

package beehiiv

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	beehiivArchiveCursorPrefix    = "bhiv2:"
	maxArchiveCursorBytes         = 16 << 10
	maxArchiveProviderCursorBytes = 2 << 10
	maxArchiveChildRecords        = 1_000_000
	// Beehiiv's documented IDs are UUID-derived and fit comfortably within 64
	// bytes. Keeping that bound lets one durable cursor retain a complete
	// maximum-size (100-record) inventory page without exceeding 16 KiB.
	maxArchiveProviderIDBytes     = 64
	newsletterListArchivePageSize = 100
	automationArchivePageSize     = 100

	archivePublication                 = "publication"
	archiveNewsletterLists             = "newsletter_lists"
	archiveNewsletterListSubscriptions = "newsletter_list_subscriptions"
	archiveAutomations                 = "automations"
	archiveAutomationEmails            = "automation_emails"
	archiveAutomationJourneys          = "automation_journeys"
	archiveSegments                    = "segments"
	archiveConditionSets               = "condition_sets"
	archiveCustomFields                = "custom_fields"
	archiveTiers                       = "tiers"
	archiveReferrals                   = "referrals"
	archivePolls                       = "polls"
	archivePollResponses               = "poll_responses"
	archiveTemplates                   = "post_templates"
	archivePosts                       = "non_campaign_posts"
	archiveParityGaps                  = "parity_gaps"
)

type beehiivArchiveState struct {
	Version                         int      `json:"v"`
	Phase                           string   `json:"phase"`
	Page                            int      `json:"page,omitempty"`
	ProviderCursor                  string   `json:"provider_cursor,omitempty"`
	NextProviderCursor              string   `json:"next_provider_cursor,omitempty"`
	PollID                          string   `json:"poll_id,omitempty"`
	SkipPollResponses               bool     `json:"skip_poll_responses,omitempty"`
	NewsletterListIDs               []string `json:"newsletter_list_ids,omitempty"`
	NewsletterListIndex             int      `json:"newsletter_list_index,omitempty"`
	NextNewsletterListPage          int      `json:"next_newsletter_list_page,omitempty"`
	SkipNewsletterListSubscriptions bool     `json:"skip_newsletter_list_subscriptions,omitempty"`
	NewsletterListSubscriptionCount int      `json:"newsletter_list_subscription_count,omitempty"`
	AutomationIDs                   []string `json:"automation_ids,omitempty"`
	AutomationIndex                 int      `json:"automation_index,omitempty"`
	NextAutomationPage              int      `json:"next_automation_page,omitempty"`
	SkipAutomationEmails            bool     `json:"skip_automation_emails,omitempty"`
	AutomationEmailCount            int      `json:"automation_email_count,omitempty"`
	AutomationJourneyCount          int      `json:"automation_journey_count,omitempty"`
	ConditionSetCount               int      `json:"condition_set_count,omitempty"`
	GapIndex                        int      `json:"gap_index,omitempty"`
	ClassificationCutoff            int64    `json:"classification_cutoff"`
}

type optionalArchiveFailure string

type archiveCursorResponse[T any] struct {
	Data       []T     `json:"data"`
	Limit      int     `json:"limit"`
	HasMore    *bool   `json:"has_more"`
	NextCursor *string `json:"next_cursor"`
}

const (
	optionalArchiveForbidden optionalArchiveFailure = "forbidden_or_scope_missing"
	optionalArchiveNotFound  optionalArchiveFailure = "not_found"
)

type beehiivParityGap struct {
	SourceID     string
	ResourceType string
	Name         string
	Detail       string
}

var beehiivParityGaps = []beehiivParityGap{
	{
		SourceID:     "beehiiv:website_settings",
		ResourceType: "parity_gap:website_settings",
		Name:         "Publication website, theme, and capture widgets",
		Detail:       "Beehiiv API v2 does not provide a portable export that can reproduce the publication theme, navigation, custom pages, subscribe forms, popup behavior, domains, or widget styling. Inventory and rebuild these before changing traffic.",
	},
	{
		SourceID:     "beehiiv:referrals_boosts",
		ResourceType: "parity_gap:referrals_boosts",
		Name:         "Boosts and recommendation-network configuration",
		Detail:       "Referral milestones are preserved separately when the API permits access. Boost marketplace relationships, recommendation placements, acquisition history, payout state, and network settings are not reproducible from the migration API and require explicit review.",
	},
	{
		SourceID:     "beehiiv:ad_network",
		ResourceType: "parity_gap:ad_network",
		Name:         "Beehiiv Ad Network configuration and history",
		Detail:       "Ad Network eligibility, placements, advertiser relationships, campaign history, creative approvals, and payout state are not recreated by this migration. Preserve any required exports and assign a cutover owner.",
	},
}

// ListSourceArchive preserves Beehiiv objects that Moosewave cannot execute
// natively. Each invocation fetches at most one resource page so checkpoints
// are durable and retries do not require an unbounded account scan. A denied
// genuinely optional endpoint may trigger one publication probe to distinguish
// a missing scope from an expired credential. Newsletter-list history and
// automation/email inventory are required and always fail closed.
func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	if err := validateSession(sess); err != nil {
		return nil, "", err
	}
	cutoff, err := a.archiveClassificationCutoff(sess)
	if err != nil {
		return nil, "", err
	}
	state, err := parseBeehiivArchiveCursor(cursor, cutoff)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(cursor) != "" && state.ClassificationCutoff != cutoff.Unix() {
		return nil, "", fmt.Errorf("Beehiiv source-archive cursor classification cutoff does not match the bound migration run: %w", adapter.ErrSourceUnavailable)
	}

	switch state.Phase {
	case archivePublication:
		return a.archivePublication(ctx, sess, state)
	case archiveNewsletterLists:
		return a.archiveNewsletterListPage(ctx, sess, state)
	case archiveNewsletterListSubscriptions:
		return a.archiveNewsletterListSubscriptionPage(ctx, sess, state)
	case archiveAutomations:
		return a.archiveAutomationPage(ctx, sess, state)
	case archiveAutomationEmails:
		return a.archiveAutomationEmailPage(ctx, sess, state)
	case archiveAutomationJourneys:
		return a.archiveAutomationJourneyPage(ctx, sess, state)
	case archiveSegments:
		return a.archivePage(ctx, sess, state, archivePageSpec{
			suffix: "/segments", resource: "segment definitions", resourceType: "beehiiv_segment",
			nextPhase: archiveConditionSets, expansions: []string{"stats"}, orderParameter: "direction", orderBy: "created", required: true, mapItem: mapSegmentArchiveItem,
		})
	case archiveConditionSets:
		return a.archiveConditionSetPage(ctx, sess, state)
	case archiveCustomFields:
		return a.archivePage(ctx, sess, state, archivePageSpec{
			suffix: "/custom_fields", resource: "custom-field definitions", resourceType: "beehiiv_custom_field",
			nextPhase: archiveTiers, required: true, mapItem: mapCustomFieldArchiveItem,
		})
	case archiveTiers:
		return a.archivePage(ctx, sess, state, archivePageSpec{
			suffix: "/tiers", resource: "premium tiers", resourceType: "beehiiv_premium_tier",
			nextPhase: archiveReferrals, expansions: []string{"stats", "prices"}, orderParameter: "direction", mapItem: mapTierArchiveItem,
		})
	case archiveReferrals:
		return a.archivePage(ctx, sess, state, archivePageSpec{
			suffix: "/referral_program", resource: "referral milestones", resourceType: "beehiiv_referral_milestone",
			nextPhase: archivePolls, mapItem: mapReferralMilestoneArchiveItem,
		})
	case archivePolls:
		return a.archivePoll(ctx, sess, state)
	case archivePollResponses:
		return a.archivePollResponsePage(ctx, sess, state)
	case archiveTemplates:
		return a.archivePage(ctx, sess, state, archivePageSpec{
			suffix: "/post_templates", resource: "post templates", resourceType: "beehiiv_post_template",
			nextPhase: archivePosts, orderParameter: "order", orderBy: "created", mapItem: mapPostTemplateArchiveItem,
		})
	case archivePosts:
		return a.archiveNonCampaignPostPage(ctx, sess, state)
	case archiveParityGaps:
		return archiveParityGap(state)
	default:
		return nil, "", fmt.Errorf("beehiiv: unknown source archive phase %q", state.Phase)
	}
}

// archiveConditionSetPage preserves the complete cursor-paginated inventory
// of active dynamic-content condition sets. Beehiiv does not expose the saved
// predicate tree through this API, so the durable records are rebuild inputs;
// a completion manifest proves even an empty inventory was authoritatively
// traversed with the required condition_sets:read scope.
func (a *Adapter) archiveConditionSetPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{"limit": {"100"}}
	if state.ProviderCursor != "" {
		values.Set("cursor", state.ProviderCursor)
	}
	path, err := publicationPath(sess.AccountID, "/condition_sets", values)
	if err != nil {
		return nil, "", err
	}
	var response archiveCursorResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve required Beehiiv condition-set definitions: %w", err)
	}
	if response.Limit < 1 || response.Limit > 100 || len(response.Data) > response.Limit {
		return nil, "", fmt.Errorf("Beehiiv condition sets returned invalid limit metadata: %w", adapter.ErrSourceUnavailable)
	}
	hasMore, nextCursor, err := validateArchiveCursorMetadata("condition sets", state.ProviderCursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data)+1)
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapConditionSetArchiveItem(source)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv condition-set definitions: %w", mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv condition sets returned duplicate id %q: %w", item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		items = append(items, item)
	}
	preservedCount, err := boundedArchiveChildCount(state.ConditionSetCount, len(response.Data), "condition-set definitions")
	if err != nil {
		return nil, "", err
	}

	if hasMore {
		nextState := state
		nextState.ProviderCursor = nextCursor
		nextState.ConditionSetCount = preservedCount
		return items, encodeBeehiivArchiveCursor(nextState), nil
	}
	items = append(items, conditionSetInventoryManifest(preservedCount))
	return items, nextBeehiivArchiveCursor(state, archiveCustomFields, 1), nil
}

func (a *Adapter) archivePublication(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{"expand": {"stats"}}
	path := "/publications/" + url.PathEscape(sess.AccountID) + "?" + values.Encode()
	var response struct {
		Data map[string]interface{} `json:"data"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", err
	}
	id, err := requiredArchiveString(response.Data, "publication", "id")
	if err != nil {
		return nil, "", err
	}
	if id != sess.AccountID {
		return nil, "", fmt.Errorf("Beehiiv publication response id %q does not match the bound publication: %w", id, adapter.ErrSourceUnavailable)
	}
	item := canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_publication",
		Name:           firstNonEmpty(archiveString(response.Data, "name"), id),
		Status:         "preserved",
		OccurredAt:     archiveUnixTime(response.Data, "created"),
		Payload:        rawPayload(response.Data),
		SourcePlatform: canonical.SourceBeehiiv,
	}
	next := nextBeehiivArchiveCursor(state, archiveNewsletterLists, 1)
	return []canonical.SourceArchiveItem{item}, next, nil
}

func (a *Adapter) archiveNewsletterListPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{
		"limit":     {strconv.Itoa(newsletterListArchivePageSize)},
		"page":      {strconv.Itoa(state.Page)},
		"direction": {"asc"},
	}
	path, err := publicationPath(sess.AccountID, "/newsletter_lists", values)
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve Beehiiv newsletter-list definitions: %w", err)
	}
	if len(response.Data) > newsletterListArchivePageSize {
		return nil, "", fmt.Errorf("Beehiiv newsletter lists returned %d records for limit=%d: %w", len(response.Data), newsletterListArchivePageSize, adapter.ErrSourceUnavailable)
	}
	more, err := validateArchivePageWithLimit("newsletter lists", state.Page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), newsletterListArchivePageSize)
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	listIDs := make([]string, 0, len(response.Data))
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapNewsletterListArchiveItem(source)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv newsletter lists: %w", mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv newsletter lists returned duplicate id %q: %w", item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		listIDs = append(listIDs, item.SourceID)
		items = append(items, item)
	}

	nextPage := 0
	if more {
		nextPage = state.Page + 1
	}
	if len(listIDs) == 0 {
		nextState := transitionBeehiivArchiveState(state, archiveAutomations, 1)
		if nextPage > 0 {
			nextState = transitionBeehiivArchiveState(state, archiveNewsletterLists, nextPage)
		}
		return items, encodeBeehiivArchiveCursor(nextState), nil
	}

	nextState := transitionBeehiivArchiveState(state, archiveNewsletterListSubscriptions, 0)
	nextState.NewsletterListIDs = listIDs
	nextState.NextNewsletterListPage = nextPage
	if err := validateBeehiivArchiveState(nextState); err != nil {
		return nil, "", fmt.Errorf("Beehiiv newsletter-list archive checkpoint is invalid: %w", adapter.ErrSourceUnavailable)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archiveNewsletterListSubscriptionPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	listID := state.NewsletterListIDs[state.NewsletterListIndex]
	values := url.Values{"limit": {"100"}, "direction": {"asc"}}
	if state.ProviderCursor != "" {
		values.Set("cursor", state.ProviderCursor)
	}
	path, err := publicationPath(sess.AccountID, "/newsletter_lists/"+url.PathEscape(listID)+"/subscriptions", values)
	if err != nil {
		return nil, "", err
	}
	var response archiveCursorResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve Beehiiv newsletter-list subscription history for %s: %w", listID, err)
	}
	if len(response.Data) > 100 {
		return nil, "", fmt.Errorf("Beehiiv newsletter-list subscriptions for %s returned %d records for limit=100: %w", listID, len(response.Data), adapter.ErrSourceUnavailable)
	}
	hasMore, nextCursor, err := validateArchiveCursorMetadata("newsletter-list subscriptions for "+listID, state.ProviderCursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapNewsletterListSubscriptionArchiveItem(source, listID)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv newsletter-list subscriptions for %s: %w", listID, mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv newsletter-list subscriptions for %s returned duplicate id %q: %w", listID, item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		items = append(items, item)
	}
	preservedCount, err := boundedArchiveChildCount(state.NewsletterListSubscriptionCount, len(items), "newsletter-list subscription history")
	if err != nil {
		return nil, "", err
	}

	nextState := state
	if hasMore {
		nextState.ProviderCursor = nextCursor
		nextState.NewsletterListSubscriptionCount = preservedCount
	} else {
		items = append(items, newsletterListHistoryManifest(listID, preservedCount))
		nextState = afterNewsletterListSubscriptions(state)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archiveAutomationPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{
		"limit":    {strconv.Itoa(automationArchivePageSize)},
		"page":     {strconv.Itoa(state.Page)},
		"expand[]": {"stats"},
	}
	path, err := publicationPath(sess.AccountID, "/automations", values)
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve Beehiiv automation definitions: %w", err)
	}
	if len(response.Data) > automationArchivePageSize {
		return nil, "", fmt.Errorf("Beehiiv automations returned %d records for limit=%d: %w", len(response.Data), automationArchivePageSize, adapter.ErrSourceUnavailable)
	}
	more, err := validateArchivePageWithLimit("automations", state.Page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), automationArchivePageSize)
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	automationIDs := make([]string, 0, len(response.Data))
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapAutomationArchiveItem(source)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv automations: %w", mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv automations returned duplicate id %q: %w", item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		automationIDs = append(automationIDs, item.SourceID)
		items = append(items, item)
	}

	nextPage := 0
	if more {
		nextPage = state.Page + 1
	}
	if len(automationIDs) == 0 {
		nextState := transitionBeehiivArchiveState(state, archiveSegments, 1)
		if nextPage > 0 {
			nextState = transitionBeehiivArchiveState(state, archiveAutomations, nextPage)
		}
		return items, encodeBeehiivArchiveCursor(nextState), nil
	}

	nextState := transitionBeehiivArchiveState(state, archiveAutomationEmails, 0)
	nextState.AutomationIDs = automationIDs
	nextState.NextAutomationPage = nextPage
	if err := validateBeehiivArchiveState(nextState); err != nil {
		return nil, "", fmt.Errorf("Beehiiv automation archive checkpoint is invalid: %w", adapter.ErrSourceUnavailable)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archiveAutomationEmailPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	automationID := state.AutomationIDs[state.AutomationIndex]
	values := url.Values{"limit": {"100"}}
	if state.ProviderCursor != "" {
		values.Set("cursor", state.ProviderCursor)
	}
	path, err := publicationPath(sess.AccountID, "/automations/"+url.PathEscape(automationID)+"/emails", values)
	if err != nil {
		return nil, "", err
	}
	var response archiveCursorResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve Beehiiv automation email inventory for %s: %w", automationID, err)
	}
	if len(response.Data) > 100 {
		return nil, "", fmt.Errorf("Beehiiv automation emails for %s returned %d records for limit=100: %w", automationID, len(response.Data), adapter.ErrSourceUnavailable)
	}
	hasMore, nextCursor, err := validateArchiveCursorMetadata("automation emails for "+automationID, state.ProviderCursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapAutomationEmailArchiveItem(source, automationID)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv automation emails for %s: %w", automationID, mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv automation emails for %s returned duplicate id %q: %w", automationID, item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		items = append(items, item)
	}
	preservedCount, err := boundedArchiveChildCount(state.AutomationEmailCount, len(items), "automation email inventory")
	if err != nil {
		return nil, "", err
	}

	nextState := state
	if hasMore {
		nextState.ProviderCursor = nextCursor
		nextState.AutomationEmailCount = preservedCount
	} else {
		items = append(items, automationEmailInventoryManifest(automationID, preservedCount))
		nextState = afterAutomationEmails(state)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archiveAutomationJourneyPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	automationID := state.AutomationIDs[state.AutomationIndex]
	values := url.Values{
		"limit":  {"100"},
		"page":   {strconv.Itoa(state.Page)},
		"status": {"all"},
	}
	path, err := publicationPath(sess.AccountID, "/automations/"+url.PathEscape(automationID)+"/journeys", values)
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", fmt.Errorf("preserve Beehiiv automation journey inventory for %s: %w", automationID, err)
	}
	more, err := validateArchivePageWithLimit("automation journeys for "+automationID, state.Page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
	if err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data)+1)
	seen := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := mapAutomationJourneyArchiveItem(source, automationID)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv automation journeys for %s: %w", automationID, mapErr)
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv automation journeys for %s returned duplicate id %q: %w", automationID, item.SourceID, adapter.ErrSourceUnavailable)
		}
		seen[item.SourceID] = struct{}{}
		items = append(items, item)
	}
	preservedCount, err := boundedArchiveChildCount(state.AutomationJourneyCount, len(response.Data), "automation journey inventory")
	if err != nil {
		return nil, "", err
	}
	if more {
		nextState := state
		nextState.Page++
		nextState.AutomationJourneyCount = preservedCount
		return items, encodeBeehiivArchiveCursor(nextState), nil
	}
	items = append(items, automationJourneyInventoryManifest(automationID, preservedCount))
	return items, encodeBeehiivArchiveCursor(afterAutomationJourneys(state)), nil
}

type archivePageSpec struct {
	suffix         string
	resource       string
	resourceType   string
	nextPhase      string
	expansions     []string
	orderParameter string
	orderBy        string
	required       bool
	mapItem        func(map[string]interface{}) (canonical.SourceArchiveItem, error)
}

func (a *Adapter) archivePage(ctx context.Context, sess adapter.Session, state beehiivArchiveState, spec archivePageSpec) ([]canonical.SourceArchiveItem, string, error) {
	page := state.Page
	if page == 0 {
		page = 1
	}
	values := url.Values{"limit": {"100"}, "page": {strconv.Itoa(page)}}
	if spec.orderParameter != "" {
		values.Set(spec.orderParameter, "asc")
	}
	if spec.orderBy != "" {
		values.Set("order_by", spec.orderBy)
	}
	for _, expansion := range spec.expansions {
		values.Add("expand[]", expansion)
	}
	path, err := publicationPath(sess.AccountID, spec.suffix, values)
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		if spec.required {
			return nil, "", fmt.Errorf("preserve required Beehiiv %s: %w", spec.resource, err)
		}
		failure, optional := a.classifyOptionalArchiveError(ctx, sess, err)
		if !optional {
			return nil, "", err
		}
		warning := optionalSourceArchiveWarning(spec.resource, spec.resourceType, failure)
		return []canonical.SourceArchiveItem{warning}, nextBeehiivArchiveCursor(state, spec.nextPhase, 1), nil
	}
	more, err := validateArchivePageWithLimit(spec.resource, page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
	if err != nil {
		return nil, "", err
	}
	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	seenIDs := make(map[string]struct{}, len(response.Data))
	for _, source := range response.Data {
		item, mapErr := spec.mapItem(source)
		if mapErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv %s: %w", spec.resource, mapErr)
		}
		if _, duplicate := seenIDs[item.SourceID]; duplicate {
			return nil, "", fmt.Errorf("Beehiiv %s returned duplicate id %q: %w", spec.resource, item.SourceID, adapter.ErrSourceUnavailable)
		}
		seenIDs[item.SourceID] = struct{}{}
		items = append(items, item)
	}
	nextState := state
	if more {
		nextState.Page = page + 1
	} else {
		nextState = transitionBeehiivArchiveState(state, spec.nextPhase, 1)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archivePoll(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{
		"limit": {"1"}, "order_by": {"created"}, "direction": {"asc"},
		"expand[]": {"stats", "trivia_answer"},
	}
	if state.ProviderCursor != "" {
		values.Set("cursor", state.ProviderCursor)
	}
	path, err := publicationPath(sess.AccountID, "/polls", values)
	if err != nil {
		return nil, "", err
	}
	var response archiveCursorResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		failure, optional := a.classifyOptionalArchiveError(ctx, sess, err)
		if !optional {
			return nil, "", err
		}
		warning := optionalSourceArchiveWarning("polls", "beehiiv_poll", failure)
		return []canonical.SourceArchiveItem{warning}, nextBeehiivArchiveCursor(state, archiveTemplates, 1), nil
	}
	if len(response.Data) > 1 {
		return nil, "", fmt.Errorf("Beehiiv polls returned %d records for limit=1: %w", len(response.Data), adapter.ErrSourceUnavailable)
	}
	_, nextPollCursor, err := validateArchiveCursorMetadata("polls", state.ProviderCursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}
	if len(response.Data) == 0 {
		return nil, nextBeehiivArchiveCursor(state, archiveTemplates, 1), nil
	}
	poll := response.Data[0]
	item, err := mapPollArchiveItem(poll)
	if err != nil {
		return nil, "", err
	}
	pollID := item.SourceID

	var nextState beehiivArchiveState
	if state.SkipPollResponses {
		nextState = afterPollResponses(state, nextPollCursor)
	} else {
		nextState = state
		nextState.Phase = archivePollResponses
		nextState.Page = 0
		nextState.ProviderCursor = ""
		nextState.NextProviderCursor = nextPollCursor
		nextState.PollID = pollID
	}
	return []canonical.SourceArchiveItem{item}, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archivePollResponsePage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{
		"limit": {"100"}, "order_by": {"created"}, "direction": {"asc"}, "expand[]": {"post"},
	}
	if state.ProviderCursor != "" {
		values.Set("cursor", state.ProviderCursor)
	}
	path, err := publicationPath(sess.AccountID, "/polls/"+url.PathEscape(state.PollID)+"/responses", values)
	if err != nil {
		return nil, "", err
	}
	var response archiveCursorResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		failure, optional := a.classifyOptionalArchiveError(ctx, sess, err)
		if !optional {
			return nil, "", err
		}
		warning := optionalSourceArchiveWarning("poll responses for "+state.PollID, "beehiiv_poll_response", failure)
		nextState := afterPollResponses(state, state.NextProviderCursor)
		if failure == optionalArchiveForbidden && nextState.Phase == archivePolls {
			nextState.SkipPollResponses = true
		}
		return []canonical.SourceArchiveItem{warning}, encodeBeehiivArchiveCursor(nextState), nil
	}
	hasMore, nextResponseCursor, err := validateArchiveCursorMetadata("poll responses", state.ProviderCursor, response.HasMore, response.NextCursor, len(response.Data))
	if err != nil {
		return nil, "", err
	}
	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	for _, source := range response.Data {
		responseID, itemErr := requiredArchiveString(source, "poll response", "id")
		if itemErr != nil {
			return nil, "", itemErr
		}
		payload := rawPayload(source)
		payload["poll_id"] = state.PollID
		items = append(items, canonical.SourceArchiveItem{
			SourceID:        responseID,
			ResourceType:    "beehiiv_poll_response",
			Name:            firstNonEmpty(archiveString(source, "poll_choice_label"), "Response to "+state.PollID),
			Status:          "preserved",
			LinkedContactID: archiveString(source, "subscription_id"),
			OccurredAt:      archiveUnixTime(source, "created_at"),
			Payload:         payload,
			SourcePlatform:  canonical.SourceBeehiiv,
		})
	}
	nextState := state
	if hasMore {
		nextState.ProviderCursor = nextResponseCursor
	} else {
		nextState = afterPollResponses(state, state.NextProviderCursor)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func (a *Adapter) archiveNonCampaignPostPage(ctx context.Context, sess adapter.Session, state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	page := state.Page
	if page == 0 {
		page = 1
	}
	path, err := publicationPath(sess.AccountID, "/posts", postListValues(page))
	if err != nil {
		return nil, "", err
	}
	var response pageResponse[map[string]interface{}]
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", err
	}
	more, err := validateArchivePageWithLimit("posts", page, response.Page, response.TotalPages, response.TotalResults, response.Limit, len(response.Data), 100)
	if err != nil {
		return nil, "", err
	}
	cutoff := time.Unix(state.ClassificationCutoff, 0).UTC()
	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	for _, summaryPayload := range response.Data {
		encoded, marshalErr := json.Marshal(summaryPayload)
		if marshalErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv post: marshal source payload: %w", marshalErr)
		}
		var post bhPost
		if unmarshalErr := json.Unmarshal(encoded, &post); unmarshalErr != nil {
			return nil, "", fmt.Errorf("preserve Beehiiv post: decode source payload: %w", unmarshalErr)
		}
		if postIsSentNewsletter(post, cutoff) {
			continue
		}
		if !validBoundedArchiveID(strings.TrimSpace(post.ID), "post_") {
			return nil, "", fmt.Errorf("Beehiiv post response is missing id: %w", adapter.ErrSourceUnavailable)
		}
		expanded, payload, detailErr := a.getPost(ctx, sess, post.ID)
		if detailErr != nil {
			return nil, "", fmt.Errorf("load expanded Beehiiv source post %q: %w", post.ID, detailErr)
		}
		if postIsSentNewsletter(expanded, cutoff) {
			return nil, "", fmt.Errorf("Beehiiv post %q changed classification while its source-archive page was being read: %w", post.ID, adapter.ErrSourceUnavailable)
		}
		post = expanded
		payload["postwave_archive_classification"] = classifyNonCampaignPost(post, cutoff)
		payload["postwave_classification_cutoff"] = cutoff.Format(time.RFC3339)
		items = append(items, canonical.SourceArchiveItem{
			SourceID:       post.ID,
			ResourceType:   "beehiiv_non_campaign_post",
			Name:           firstNonEmpty(post.Title, post.SubjectLine, post.ID),
			Status:         firstNonEmpty(post.Status, "preserved"),
			OccurredAt:     unixTimePointer(post.Created),
			Payload:        payload,
			SourcePlatform: canonical.SourceBeehiiv,
		})
	}
	nextState := state
	if more {
		nextState.Page = page + 1
	} else {
		nextState = transitionBeehiivArchiveState(state, archiveParityGaps, 0)
	}
	return items, encodeBeehiivArchiveCursor(nextState), nil
}

func mapNewsletterListArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "newsletter list", "id", "nl_list_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "newsletter list", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredArchiveString(source, "newsletter list", "slug"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status := strings.ToLower(archiveString(source, "status"))
	switch status {
	case "draft", "active", "archived":
	default:
		return canonical.SourceArchiveItem{}, fmt.Errorf("newsletter list %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	if _, ok := source["auto_subscribe"].(bool); !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv newsletter list response has invalid or missing auto_subscribe: %w", adapter.ErrSourceUnavailable)
	}
	if err := validateArchiveNonnegativeInteger(source, "newsletter list", "subscriber_count"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	createdAt, err := requiredArchiveUnixTime(source, "newsletter list", "created_at")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredArchiveUnixTime(source, "newsletter list", "updated_at"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_newsletter_list",
		Name:           name,
		Status:         status,
		OccurredAt:     createdAt,
		Payload:        rawPayload(source),
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func mapNewsletterListSubscriptionArchiveItem(source map[string]interface{}, expectedListID string) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "newsletter-list subscription", "id", "nl_list_sub_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	listID, err := requiredBoundedArchiveID(source, "newsletter-list subscription", "newsletter_list_id", "nl_list_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if listID != expectedListID {
		return canonical.SourceArchiveItem{}, fmt.Errorf("newsletter_list_id %q does not match requested list %q: %w", listID, expectedListID, adapter.ErrSourceUnavailable)
	}
	contactID, err := requiredBoundedArchiveID(source, "newsletter-list subscription", "subscription_id", "sub_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status := strings.ToLower(archiveString(source, "status"))
	switch status {
	case "pending", "active", "inactive", "paused":
	default:
		return canonical.SourceArchiveItem{}, fmt.Errorf("newsletter-list subscription %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	createdAt, err := requiredArchiveUnixTime(source, "newsletter-list subscription", "created_at")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	for _, key := range []string{"subscribed_at", "unsubscribed_at"} {
		if err := validateOptionalArchiveUnixTime(source, "newsletter-list subscription", key); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
	}
	return canonical.SourceArchiveItem{
		SourceID:        id,
		ResourceType:    "beehiiv_newsletter_list_subscription",
		Name:            id,
		Status:          status,
		LinkedContactID: contactID,
		OccurredAt:      createdAt,
		Payload:         rawPayload(source),
		SourcePlatform:  canonical.SourceBeehiiv,
	}, nil
}

func newsletterListHistoryManifest(listID string, preserved int) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:     listID,
		ResourceType: "beehiiv_newsletter_list_history_manifest",
		Name:         "Newsletter-list history traversal: " + listID,
		Status:       "preserved",
		Payload: map[string]interface{}{
			"newsletter_list_id": listID,
			"records_preserved":  preserved,
			"traversal_complete": true,
			"pagination":         "cursor",
		},
		SourcePlatform: canonical.SourceBeehiiv,
	}
}

func mapAutomationArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "automation", "id", "aut_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "automation", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status, err := requiredArchiveString(source, "automation", "status")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if err := validateAutomationTriggerEvents(source); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	stats, ok := source["stats"].(map[string]interface{})
	if !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv automation %q omitted requested stats expansion: %w", id, adapter.ErrSourceUnavailable)
	}
	if err := validateAutomationStats(stats, "automation "+id); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["migration_mode"] = "rebuild_review"
	payload["executable_graph_exported"] = false
	payload["message_bodies_exported"] = false
	payload["limitation"] = "Beehiiv API v2 exposes automation metadata, trigger-event labels, statistics, email inventory, and journey history, but not the executable step graph or message bodies. Email metadata/statistics and subscriber journey state are preserved as linked source-archive records."
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_automation",
		Name:           name,
		Status:         status,
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func mapAutomationEmailArchiveItem(source map[string]interface{}, automationID string) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveToken(source, "automation email", "id")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredBoundedArchiveToken(source, "automation email", "automation_step_id"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	subjectLine, err := requiredArchiveStringField(source, "automation email", "subject_line")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredArchiveStringField(source, "automation email", "preview_text"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status, err := requiredArchiveString(source, "automation email", "status")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	createdAt, err := requiredArchiveUnixTime(source, "automation email", "created_at")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	for _, key := range []string{"first_sent_at", "last_sent_at"} {
		if err := validateOptionalArchiveUnixTime(source, "automation email", key); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
	}
	stats, ok := source["stats"].(map[string]interface{})
	if !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv automation email %q omitted engagement statistics: %w", id, adapter.ErrSourceUnavailable)
	}
	if err := validateAutomationEmailStats(stats, id); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["automation_id"] = automationID
	payload["preservation_scope"] = "metadata_and_stats_only"
	payload["message_body_exported"] = false
	payload["limitation"] = "Beehiiv API v2 does not expose the automation email body through this endpoint."
	return canonical.SourceArchiveItem{
		SourceID:       automationID + ":email:" + id,
		ResourceType:   "beehiiv_automation_email",
		Name:           firstNonEmpty(subjectLine, id),
		Status:         status,
		OccurredAt:     createdAt,
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func automationEmailInventoryManifest(automationID string, preserved int) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:     automationID,
		ResourceType: "beehiiv_automation_email_inventory_manifest",
		Name:         "Automation email inventory traversal: " + automationID,
		Status:       "preserved",
		Payload: map[string]interface{}{
			"automation_id":      automationID,
			"records_preserved":  preserved,
			"traversal_complete": true,
			"pagination":         "cursor",
		},
		SourcePlatform: canonical.SourceBeehiiv,
	}
}

func mapAutomationJourneyArchiveItem(source map[string]interface{}, expectedAutomationID string) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "automation journey", "id", "aj_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	automationID, err := requiredBoundedArchiveID(source, "automation journey", "automation_id", "aut_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if automationID != expectedAutomationID {
		return canonical.SourceArchiveItem{}, fmt.Errorf("automation journey %q belongs to %q, not requested automation %q: %w", id, automationID, expectedAutomationID, adapter.ErrSourceUnavailable)
	}
	contactID := ""
	if raw, present := source["subscription_id"]; present && raw != nil {
		contactID = archiveString(source, "subscription_id")
		if !validBoundedArchiveID(contactID, "sub_") {
			return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv automation journey %q has invalid subscription_id: %w", id, adapter.ErrSourceUnavailable)
		}
	}
	if raw, present := source["email"]; present && raw != nil {
		email := archiveString(source, "email")
		if email == "" || len(email) > 320 || containsArchiveControlCharacter(email) {
			return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv automation journey %q has invalid email: %w", id, adapter.ErrSourceUnavailable)
		}
	}
	status := strings.ToLower(archiveString(source, "status"))
	switch status {
	case "in_progress", "completed", "exited_early", "manually_removed":
	default:
		return canonical.SourceArchiveItem{}, fmt.Errorf("automation journey %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	if err := validateOptionalArchiveUnixTime(source, "automation journey", "started_at"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if err := validateOptionalArchiveUnixTime(source, "automation journey", "completed_at"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["preservation_scope"] = "subscriber_journey_state"
	payload["runtime_replayed"] = false
	payload["cutover_handling"] = "Review every in-progress journey before activating the rebuilt Moosewave automation to prevent duplicate or skipped sends."
	return canonical.SourceArchiveItem{
		SourceID:        automationID + ":journey:" + id,
		ResourceType:    "beehiiv_automation_journey",
		Name:            id,
		Status:          status,
		LinkedContactID: contactID,
		OccurredAt:      archiveUnixTime(source, "started_at"),
		Payload:         payload,
		SourcePlatform:  canonical.SourceBeehiiv,
	}, nil
}

func automationJourneyInventoryManifest(automationID string, preserved int) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:     automationID,
		ResourceType: "beehiiv_automation_journey_inventory_manifest",
		Name:         "Automation journey inventory traversal: " + automationID,
		Status:       "preserved",
		Payload: map[string]interface{}{
			"automation_id":      automationID,
			"records_preserved":  preserved,
			"traversal_complete": true,
			"pagination":         "offset_with_exact_totals",
			"required_scope":     "automations:read",
		},
		SourcePlatform: canonical.SourceBeehiiv,
	}
}

func boundedArchiveChildCount(previous, pageCount int, resource string) (int, error) {
	if previous < 0 || previous > maxArchiveChildRecords || pageCount < 0 || pageCount > maxArchiveChildRecords-previous {
		return 0, fmt.Errorf("Beehiiv %s exceeded the preservation bound of %d records: %w", resource, maxArchiveChildRecords, adapter.ErrUnsupported)
	}
	return previous + pageCount, nil
}

func mapSegmentArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "segment", "id", "seg_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "segment", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	segmentType := strings.ToLower(archiveString(source, "type"))
	switch segmentType {
	case "dynamic", "static", "manual", "all":
	default:
		return canonical.SourceArchiveItem{}, fmt.Errorf("segment %q has invalid type %q: %w", id, segmentType, adapter.ErrSourceUnavailable)
	}
	status := strings.ToLower(archiveString(source, "status"))
	switch status {
	case "pending", "processing", "completed", "failed":
	default:
		return canonical.SourceArchiveItem{}, fmt.Errorf("segment %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	if err := validateArchiveNonnegativeInteger(source, "segment", "total_results"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, ok := source["active"].(bool); !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("Beehiiv segment response has invalid or missing active: %w", adapter.ErrSourceUnavailable)
	}
	if err := validateOptionalArchiveUnixTime(source, "segment", "last_calculated"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["preservation_scope"] = "metadata_and_stats"
	payload["saved_predicates_exported"] = false
	payload["membership_snapshot_handling"] = "completed memberships up to the API offset ceiling are imported separately as frozen tag-backed segments; all others require manual rebuild"
	payload["limitation"] = "Beehiiv API v2 does not expose a saved segment's predicate tree. This record preserves the definition metadata, calculation state, totals, and returned statistics for audit and rebuild."
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_segment",
		Name:           name,
		Status:         status,
		OccurredAt:     archiveUnixTime(source, "last_calculated"),
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func mapConditionSetArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "condition set", "id", "")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "condition set", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status := strings.ToLower(archiveString(source, "status"))
	if status != "active" {
		return canonical.SourceArchiveItem{}, fmt.Errorf("condition set %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	purpose := strings.ToLower(archiveString(source, "purpose"))
	if purpose != "dynamic_content" {
		return canonical.SourceArchiveItem{}, fmt.Errorf("condition set %q has invalid purpose %q: %w", id, purpose, adapter.ErrSourceUnavailable)
	}
	created, err := requiredArchiveUnixTime(source, "condition set", "created")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredArchiveUnixTime(source, "condition set", "updated"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["preservation_scope"] = "definition_metadata"
	payload["saved_predicates_exported"] = false
	payload["migration_scope"] = "active dynamic-content audience definition preserved for explicit rebuild or retirement review"
	payload["limitation"] = "Beehiiv's condition-set API exposes identity, lifecycle metadata, purpose, and optional aggregate statistics, but not the saved predicate tree."
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_condition_set",
		Name:           name,
		Status:         status,
		OccurredAt:     created,
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func conditionSetInventoryManifest(preservedCount int) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:     "beehiiv:condition_sets:manifest",
		ResourceType: "beehiiv_condition_set_inventory_manifest",
		Name:         "Beehiiv condition-set inventory traversal",
		Status:       "traversal_complete",
		Payload: map[string]interface{}{
			"records_preserved":         preservedCount,
			"traversal_complete":        true,
			"pagination":                "cursor",
			"required_scope":            "condition_sets:read",
			"saved_predicates_exported": false,
			"manual_rebuild_review":     true,
		},
		SourcePlatform: canonical.SourceBeehiiv,
	}
}

func mapCustomFieldArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	raw, err := json.Marshal(source)
	if err != nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("marshal Beehiiv custom-field definition: %w", err)
	}
	var field bhCustomFieldDefinition
	if err := json.Unmarshal(raw, &field); err != nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("decode Beehiiv custom-field definition: %w", adapter.ErrSourceUnavailable)
	}
	if err := validateCustomFieldDefinition(field); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["preservation_scope"] = "schema_definition"
	payload["values_imported_with_subscribers"] = true
	payload["migration_scope"] = "field id, display name, kind, creation timestamp, and list options are source-preserved; subscriber values are imported on each contact"
	return canonical.SourceArchiveItem{
		SourceID:       strings.TrimSpace(field.ID),
		ResourceType:   "beehiiv_custom_field",
		Name:           strings.TrimSpace(field.Display),
		Status:         "schema_preserved",
		OccurredAt:     unixTimePointerValue(field.Created),
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func unixTimePointerValue(seconds *int64) *time.Time {
	if seconds == nil {
		return nil
	}
	return unixTimePointer(*seconds)
}

func mapPollArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "poll", "id", "poll_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "poll", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, err := requiredArchiveString(source, "poll", "question"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	pollType := strings.ToLower(archiveString(source, "poll_type"))
	if !oneOfArchive(pollType, "voting", "trivia") {
		return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has invalid poll_type %q: %w", id, pollType, adapter.ErrSourceUnavailable)
	}
	status := strings.ToLower(archiveString(source, "status"))
	if !oneOfArchive(status, "draft", "published") {
		return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	createdAt, err := requiredArchiveUnixTime(source, "poll", "created_at")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	choices, ok := source["poll_choices"].([]interface{})
	if !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has invalid or missing poll_choices: %w", id, adapter.ErrSourceUnavailable)
	}
	for _, rawChoice := range choices {
		choice, ok := rawChoice.(map[string]interface{})
		if !ok {
			return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has an invalid poll choice: %w", id, adapter.ErrSourceUnavailable)
		}
		if _, err := requiredBoundedArchiveID(choice, "poll choice", "id", ""); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
		if _, err := requiredArchiveString(choice, "poll choice", "label"); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
	}
	stats, ok := source["stats"].(map[string]interface{})
	if !ok || stats == nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q omitted requested stats expansion: %w", id, adapter.ErrSourceUnavailable)
	}
	if err := validateArchiveNonnegativeInteger(stats, "poll stats", "completions"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	voteCounts, ok := stats["vote_counts"].(map[string]interface{})
	if !ok || voteCounts == nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has invalid or missing vote_counts: %w", id, adapter.ErrSourceUnavailable)
	}
	for label := range voteCounts {
		if strings.TrimSpace(label) == "" || containsArchiveControlCharacter(label) {
			return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q has an invalid vote-count label: %w", id, adapter.ErrSourceUnavailable)
		}
		if err := validateArchiveNonnegativeInteger(voteCounts, "poll vote counts", label); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
	}
	if pollType == "trivia" {
		if _, err := requiredArchiveString(source, "trivia poll", "trivia_answer"); err != nil {
			return canonical.SourceArchiveItem{}, fmt.Errorf("poll %q omitted requested trivia answer expansion: %w", id, adapter.ErrSourceUnavailable)
		}
	}
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_poll",
		Name:           name,
		Status:         status,
		OccurredAt:     createdAt,
		Payload:        rawPayload(source),
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func oneOfArchive(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func mapTierArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "premium tier", "id", "tier_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "premium tier", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	status := strings.ToLower(archiveString(source, "status"))
	if status != "active" && status != "archived" {
		return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q has invalid status %q: %w", id, status, adapter.ErrSourceUnavailable)
	}
	stats, ok := source["stats"].(map[string]interface{})
	if !ok || stats == nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q omitted requested stats expansion: %w", id, adapter.ErrSourceUnavailable)
	}
	if err := validateArchiveNonnegativeInteger(stats, "premium tier stats", "active_subscriptions"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	prices, ok := source["prices"].([]interface{})
	if !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q omitted requested prices expansion: %w", id, adapter.ErrSourceUnavailable)
	}
	for _, rawPrice := range prices {
		price, ok := rawPrice.(map[string]interface{})
		if !ok {
			return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q returned an invalid price record: %w", id, adapter.ErrSourceUnavailable)
		}
		if raw, present := price["id"]; present && raw != nil {
			if _, err := requiredBoundedArchiveID(price, "tier price", "id", "price_"); err != nil {
				return canonical.SourceArchiveItem{}, err
			}
		}
		if raw, present := price["amount_cents"]; present && raw != nil {
			if err := validateArchiveNonnegativeInteger(price, "tier price", "amount_cents"); err != nil {
				return canonical.SourceArchiveItem{}, err
			}
		}
		if raw, present := price["enabled"]; present && raw != nil {
			if _, ok := raw.(bool); !ok {
				return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q returned an invalid price enabled flag: %w", id, adapter.ErrSourceUnavailable)
			}
		}
		if raw, present := price["currency"]; present && raw != nil {
			currency := strings.ToLower(archiveString(price, "currency"))
			if !oneOfArchive(currency, "usd", "aud", "cad", "eur", "gbp", "inr", "brl", "mxn", "nzd", "dkk") {
				return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q returned an invalid price currency: %w", id, adapter.ErrSourceUnavailable)
			}
		}
		if raw, present := price["interval"]; present && raw != nil {
			interval := strings.ToLower(archiveString(price, "interval"))
			if !oneOfArchive(interval, "month", "quarter", "year", "one_time", "donation") {
				return canonical.SourceArchiveItem{}, fmt.Errorf("premium tier %q returned an invalid price interval: %w", id, adapter.ErrSourceUnavailable)
			}
		}
	}
	payload := rawPayload(source)
	payload["migration_scope"] = "tier_and_price_configuration_preserved; billing_objects_not_materialized"
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_premium_tier",
		Name:           name,
		Status:         status,
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func mapReferralMilestoneArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "referral milestone", "id", "mile_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	if _, ok := source["auto_fulfill"].(bool); !ok {
		return canonical.SourceArchiveItem{}, fmt.Errorf("referral milestone %q has invalid or missing auto_fulfill: %w", id, adapter.ErrSourceUnavailable)
	}
	if err := validateArchiveNonnegativeInteger(source, "referral milestone", "num_referrals"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	reward, ok := source["reward"].(map[string]interface{})
	if !ok || reward == nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("referral milestone %q has invalid or missing reward: %w", id, adapter.ErrSourceUnavailable)
	}
	if _, err := requiredBoundedArchiveID(reward, "referral reward", "id", "rew_"); err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(reward, "referral reward", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	for _, key := range []string{"description", "image_url"} {
		if _, err := requiredArchiveStringField(reward, "referral reward", key); err != nil {
			return canonical.SourceArchiveItem{}, err
		}
	}
	rewardType := strings.ToLower(archiveString(reward, "type"))
	if !oneOfArchive(rewardType, "physical", "promo_code", "digital", "premium_gift") {
		return canonical.SourceArchiveItem{}, fmt.Errorf("referral milestone %q has invalid reward type: %w", id, adapter.ErrSourceUnavailable)
	}
	payload := rawPayload(source)
	payload["migration_scope"] = "configuration_preserved_for_manual_rebuild"
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_referral_milestone",
		Name:           name,
		Status:         "rebuild_task",
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func mapPostTemplateArchiveItem(source map[string]interface{}) (canonical.SourceArchiveItem, error) {
	id, err := requiredBoundedArchiveID(source, "post template", "id", "post_template_")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	name, err := requiredArchiveString(source, "post template", "name")
	if err != nil {
		return canonical.SourceArchiveItem{}, err
	}
	payload := rawPayload(source)
	payload["preservation_scope"] = "metadata_only"
	payload["template_body_exported"] = false
	payload["limitation"] = "Beehiiv API v2 lists post-template IDs and names but does not expose the template body through this endpoint."
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "beehiiv_post_template",
		Name:           name,
		Status:         "metadata_only",
		Payload:        payload,
		SourcePlatform: canonical.SourceBeehiiv,
	}, nil
}

func archiveParityGap(state beehiivArchiveState) ([]canonical.SourceArchiveItem, string, error) {
	if state.GapIndex < 0 || state.GapIndex >= len(beehiivParityGaps) {
		return nil, "", nil
	}
	gap := beehiivParityGaps[state.GapIndex]
	item := canonical.SourceArchiveItem{
		SourceID:     gap.SourceID,
		ResourceType: gap.ResourceType,
		Name:         gap.Name,
		Status:       "manual_review",
		Payload: map[string]interface{}{
			"detail":              gap.Detail,
			"detected":            false,
			"detection_available": false,
			"rebuild_status":      "not_started",
		},
		SourcePlatform: canonical.SourceBeehiiv,
	}
	if state.GapIndex+1 >= len(beehiivParityGaps) {
		return []canonical.SourceArchiveItem{item}, "", nil
	}
	nextState := state
	nextState.GapIndex++
	return []canonical.SourceArchiveItem{item}, encodeBeehiivArchiveCursor(nextState), nil
}

func optionalSourceArchiveWarning(resource, targetResourceType string, failure optionalArchiveFailure) canonical.SourceArchiveItem {
	detail := "the optional endpoint was not found (404)"
	if failure == optionalArchiveForbidden {
		detail = "the credential does not have access to the optional endpoint (403 or missing scope)"
	}
	warning := fmt.Sprintf("Beehiiv %s could not be preserved because %s; no records from the unavailable response were imported", resource, detail)
	resourceKey := strings.NewReplacer(" ", "_", "/", "_", ":", "_").Replace(strings.ToLower(resource))
	return canonical.SourceArchiveItem{
		SourceID:     "source_archive_warning:beehiiv:" + resourceKey,
		ResourceType: targetResourceType,
		Name:         "Unavailable Beehiiv " + resource,
		Status:       "manual_review",
		Payload: map[string]interface{}{
			"resource":                              resource,
			"target_resource_type":                  targetResourceType,
			"error_code":                            string(failure),
			"unavailable_response_records_imported": false,
		},
		Warnings:       []string{warning},
		SourcePlatform: canonical.SourceBeehiiv,
	}
}

func (a *Adapter) classifyOptionalArchiveError(ctx context.Context, sess adapter.Session, err error) (optionalArchiveFailure, bool) {
	if strings.Contains(err.Error(), "status 404") {
		return optionalArchiveNotFound, true
	}
	if !errors.Is(err, adapter.ErrAuth) {
		return "", false
	}
	// Adapter.do deliberately merges 401 and 403. Re-check the already-bound
	// publication before treating ErrAuth as an endpoint-specific scope gap, so
	// an expired/revoked credential still fails the migration rather than being
	// mislabeled as optional missing data.
	path := "/publications/" + url.PathEscape(sess.AccountID)
	var response struct {
		Data map[string]interface{} `json:"data"`
	}
	if verifyErr := a.do(ctx, sess, http.MethodGet, path, nil, &response); verifyErr != nil {
		return "", false
	}
	if archiveString(response.Data, "id") != sess.AccountID {
		return "", false
	}
	return optionalArchiveForbidden, true
}

func validateArchivePageWithLimit(resource string, requestedPage int, responsePage, totalPages, totalResults, responseLimit *int, count, requestedLimit int) (bool, error) {
	if requestedPage < 1 || requestedPage > maxOffsetPages || requestedLimit < 1 || count < 0 {
		return false, fmt.Errorf("Beehiiv %s returned invalid pagination metadata: %w", resource, adapter.ErrSourceUnavailable)
	}
	if responsePage != nil && (*responsePage < 1 || *responsePage != requestedPage) {
		return false, fmt.Errorf("Beehiiv %s returned page %d for requested page %d: %w", resource, *responsePage, requestedPage, adapter.ErrSourceUnavailable)
	}
	effectiveLimit := requestedLimit
	if responseLimit != nil {
		if *responseLimit < 1 || *responseLimit > requestedLimit {
			return false, fmt.Errorf("Beehiiv %s returned invalid limit=%d for requested limit=%d: %w", resource, *responseLimit, requestedLimit, adapter.ErrSourceUnavailable)
		}
		effectiveLimit = *responseLimit
	}
	if count > effectiveLimit {
		return false, fmt.Errorf("Beehiiv %s returned %d records for effective limit=%d: %w", resource, count, effectiveLimit, adapter.ErrSourceUnavailable)
	}

	pagesKnown := totalPages != nil
	resultsKnown := totalResults != nil
	pages := 0
	results := 0
	if pagesKnown {
		pages = *totalPages
		if pages < 0 {
			return false, fmt.Errorf("Beehiiv %s returned invalid total_pages=%d: %w", resource, pages, adapter.ErrSourceUnavailable)
		}
		if pages > maxOffsetPages {
			return false, fmt.Errorf("Beehiiv %s require %d pages, exceeding the API v2 offset-pagination limit of %d: %w", resource, pages, maxOffsetPages, adapter.ErrUnsupported)
		}
		if pages > 0 && requestedPage > pages {
			return false, fmt.Errorf("Beehiiv %s returned data beyond total_pages=%d: %w", resource, pages, adapter.ErrSourceUnavailable)
		}
	}
	if resultsKnown {
		results = *totalResults
		if results < 0 {
			return false, fmt.Errorf("Beehiiv %s returned invalid total_results=%d: %w", resource, results, adapter.ErrSourceUnavailable)
		}
	}

	if pagesKnown && resultsKnown {
		expectedPages := 0
		if results > 0 {
			expectedPages = (results + effectiveLimit - 1) / effectiveLimit
		}
		// Beehiiv may represent an empty collection as either zero pages or
		// one empty page. Every non-empty collection has one exact page count.
		if results == 0 {
			if pages > 1 || count != 0 {
				return false, fmt.Errorf("Beehiiv %s returned inconsistent empty pagination totals: %w", resource, adapter.ErrSourceUnavailable)
			}
		} else if pages != expectedPages {
			return false, fmt.Errorf("Beehiiv %s returned total_pages=%d, but total_results=%d and limit=%d require %d pages: %w", resource, pages, results, effectiveLimit, expectedPages, adapter.ErrSourceUnavailable)
		}
	}

	if resultsKnown {
		seenBefore := (requestedPage - 1) * effectiveLimit
		if seenBefore > results {
			return false, fmt.Errorf("Beehiiv %s returned page %d beyond total_results=%d: %w", resource, requestedPage, results, adapter.ErrSourceUnavailable)
		}
		expectedCount := results - seenBefore
		if expectedCount > effectiveLimit {
			expectedCount = effectiveLimit
		}
		if count != expectedCount {
			return false, fmt.Errorf("Beehiiv %s returned %d records on page %d; total_results=%d and limit=%d require %d: %w", resource, count, requestedPage, results, effectiveLimit, expectedCount, adapter.ErrSourceUnavailable)
		}
	}

	more := false
	switch {
	case pagesKnown:
		more = requestedPage < pages
	case resultsKnown:
		more = requestedPage*effectiveLimit < results
	default:
		if count == effectiveLimit {
			if requestedPage >= maxOffsetPages {
				return false, fmt.Errorf("Beehiiv %s pagination may exceed the API v2 offset-pagination limit of %d pages: %w", resource, maxOffsetPages, adapter.ErrUnsupported)
			}
			return false, fmt.Errorf("Beehiiv %s returned a full page without total_pages or total_results, so completeness cannot be proven: %w", resource, adapter.ErrSourceUnavailable)
		}
	}
	if more && requestedPage >= maxOffsetPages {
		return false, fmt.Errorf("Beehiiv %s pagination exceeds the API v2 offset-pagination limit of %d pages: %w", resource, maxOffsetPages, adapter.ErrUnsupported)
	}
	return more, nil
}

func validateArchiveCursorMetadata(resource, current string, hasMore *bool, nextCursor *string, count int) (bool, string, error) {
	if hasMore == nil {
		return false, "", fmt.Errorf("Beehiiv %s omitted cursor-pagination metadata: %w", resource, adapter.ErrSourceUnavailable)
	}
	next := ""
	if nextCursor != nil {
		next = *nextCursor
	}
	validated, err := validateArchiveProviderCursor(resource, current, *hasMore, next, count)
	if err != nil {
		return false, "", err
	}
	return *hasMore, validated, nil
}

func validateArchiveProviderCursor(resource, current string, hasMore bool, next string, count int) (string, error) {
	next = strings.TrimSpace(next)
	if count == 0 && hasMore {
		return "", fmt.Errorf("Beehiiv %s returned an empty page while reporting more data: %w", resource, adapter.ErrSourceUnavailable)
	}
	if !hasMore {
		if next != "" {
			return "", fmt.Errorf("Beehiiv %s returned next_cursor while reporting no more data: %w", resource, adapter.ErrSourceUnavailable)
		}
		return "", nil
	}
	if next == "" {
		return "", fmt.Errorf("Beehiiv %s report more data without next_cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	if len(next) > maxArchiveProviderCursorBytes || containsArchiveControlCharacter(next) {
		return "", fmt.Errorf("Beehiiv %s returned an invalid next_cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	if next == current {
		return "", fmt.Errorf("Beehiiv %s returned a repeated cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	return next, nil
}

func parseBeehiivArchiveCursor(raw string, now time.Time) (beehiivArchiveState, error) {
	if strings.TrimSpace(raw) == "" {
		return beehiivArchiveState{Version: 1, Phase: archivePublication, ClassificationCutoff: now.Unix()}, nil
	}
	if !strings.HasPrefix(raw, beehiivArchiveCursorPrefix) || len(raw) > maxArchiveCursorBytes {
		return beehiivArchiveState{}, fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, beehiivArchiveCursorPrefix))
	if err != nil || len(decoded) == 0 || len(decoded) > maxArchiveCursorBytes {
		return beehiivArchiveState{}, fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	var state beehiivArchiveState
	decoder := json.NewDecoder(strings.NewReader(string(decoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return beehiivArchiveState{}, fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return beehiivArchiveState{}, fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	if err := validateBeehiivArchiveState(state); err != nil {
		return beehiivArchiveState{}, err
	}
	return state, nil
}

func validateBeehiivArchiveState(state beehiivArchiveState) error {
	if state.Version != 1 || state.ClassificationCutoff <= 0 || len(state.ProviderCursor) > maxArchiveProviderCursorBytes || len(state.NextProviderCursor) > maxArchiveProviderCursorBytes || strings.TrimSpace(state.ProviderCursor) != state.ProviderCursor || strings.TrimSpace(state.NextProviderCursor) != state.NextProviderCursor || containsArchiveControlCharacter(state.ProviderCursor) || containsArchiveControlCharacter(state.NextProviderCursor) || state.SkipNewsletterListSubscriptions || state.SkipAutomationEmails || state.NewsletterListSubscriptionCount < 0 || state.NewsletterListSubscriptionCount > maxArchiveChildRecords || state.AutomationEmailCount < 0 || state.AutomationEmailCount > maxArchiveChildRecords || state.AutomationJourneyCount < 0 || state.AutomationJourneyCount > maxArchiveChildRecords || state.ConditionSetCount < 0 || state.ConditionSetCount > maxArchiveChildRecords {
		return fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	newsletterCheckpoint := len(state.NewsletterListIDs) > 0 || state.NewsletterListIndex != 0 || state.NextNewsletterListPage != 0 || state.NewsletterListSubscriptionCount != 0
	automationCheckpoint := len(state.AutomationIDs) > 0 || state.AutomationIndex != 0 || state.NextAutomationPage != 0 || state.AutomationEmailCount != 0 || state.AutomationJourneyCount != 0
	conditionSetCheckpoint := state.ConditionSetCount != 0
	pollCheckpoint := state.PollID != "" || state.NextProviderCursor != ""
	providerCheckpoint := state.ProviderCursor != ""
	switch state.Phase {
	case archivePublication:
		if state.Page != 0 || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archiveNewsletterLists:
		if state.Page < 1 || state.Page > maxOffsetPages || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || len(state.NewsletterListIDs) != 0 || state.NewsletterListIndex != 0 || state.NextNewsletterListPage != 0 || state.NewsletterListSubscriptionCount != 0 || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archiveNewsletterListSubscriptions:
		if state.Page != 0 || pollCheckpoint || state.SkipPollResponses || state.SkipNewsletterListSubscriptions || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 || len(state.NewsletterListIDs) == 0 || len(state.NewsletterListIDs) > newsletterListArchivePageSize || state.NewsletterListIndex < 0 || state.NewsletterListIndex >= len(state.NewsletterListIDs) || (state.NextNewsletterListPage != 0 && (state.NextNewsletterListPage < 2 || state.NextNewsletterListPage > maxOffsetPages)) {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
		seen := make(map[string]struct{}, len(state.NewsletterListIDs))
		for _, id := range state.NewsletterListIDs {
			if !validBoundedArchiveID(id, "nl_list_") {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			if _, duplicate := seen[id]; duplicate {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			seen[id] = struct{}{}
		}
	case archiveAutomations:
		if state.Page < 1 || state.Page > maxOffsetPages || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || len(state.AutomationIDs) != 0 || state.AutomationIndex != 0 || state.NextAutomationPage != 0 || state.AutomationEmailCount != 0 || conditionSetCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archiveAutomationEmails:
		if state.Page != 0 || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || state.SkipAutomationEmails || state.AutomationJourneyCount != 0 || conditionSetCheckpoint || state.GapIndex != 0 || len(state.AutomationIDs) == 0 || len(state.AutomationIDs) > automationArchivePageSize || state.AutomationIndex < 0 || state.AutomationIndex >= len(state.AutomationIDs) || (state.NextAutomationPage != 0 && (state.NextAutomationPage < 2 || state.NextAutomationPage > maxOffsetPages)) {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
		seen := make(map[string]struct{}, len(state.AutomationIDs))
		for _, id := range state.AutomationIDs {
			if !validBoundedArchiveID(id, "aut_") {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			if _, duplicate := seen[id]; duplicate {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			seen[id] = struct{}{}
		}
	case archiveAutomationJourneys:
		if state.Page < 1 || state.Page > maxOffsetPages || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || state.SkipAutomationEmails || state.AutomationEmailCount != 0 || conditionSetCheckpoint || state.GapIndex != 0 || len(state.AutomationIDs) == 0 || len(state.AutomationIDs) > automationArchivePageSize || state.AutomationIndex < 0 || state.AutomationIndex >= len(state.AutomationIDs) || (state.NextAutomationPage != 0 && (state.NextAutomationPage < 2 || state.NextAutomationPage > maxOffsetPages)) {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
		seen := make(map[string]struct{}, len(state.AutomationIDs))
		for _, id := range state.AutomationIDs {
			if !validBoundedArchiveID(id, "aut_") {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			if _, duplicate := seen[id]; duplicate {
				return fmt.Errorf("beehiiv: invalid source archive cursor")
			}
			seen[id] = struct{}{}
		}
	case archiveSegments, archiveCustomFields, archiveTiers, archiveReferrals, archiveTemplates, archivePosts:
		if state.Page < 1 || state.Page > maxOffsetPages || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archiveConditionSets:
		if (state.Page != 0 && state.Page != 1) || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || automationCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archivePolls:
		if (state.Page != 0 && state.Page != 1) || pollCheckpoint || newsletterCheckpoint || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archivePollResponses:
		if state.Page != 0 || state.SkipPollResponses || newsletterCheckpoint || automationCheckpoint || conditionSetCheckpoint || state.GapIndex != 0 || !validPrefixedID(state.PollID, "poll_") {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	case archiveParityGaps:
		if state.Page != 0 || providerCheckpoint || pollCheckpoint || state.SkipPollResponses || newsletterCheckpoint || automationCheckpoint || conditionSetCheckpoint || state.GapIndex < 0 || state.GapIndex >= len(beehiivParityGaps) {
			return fmt.Errorf("beehiiv: invalid source archive cursor")
		}
	default:
		return fmt.Errorf("beehiiv: invalid source archive cursor")
	}
	return nil
}

func encodeBeehiivArchiveCursor(state beehiivArchiveState) string {
	raw, err := json.Marshal(state)
	if err != nil {
		panic(fmt.Sprintf("marshal Beehiiv source archive cursor: %v", err))
	}
	return beehiivArchiveCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextBeehiivArchiveCursor(state beehiivArchiveState, phase string, page int) string {
	return encodeBeehiivArchiveCursor(transitionBeehiivArchiveState(state, phase, page))
}

func transitionBeehiivArchiveState(state beehiivArchiveState, phase string, page int) beehiivArchiveState {
	state.Phase = phase
	state.Page = page
	state.ProviderCursor = ""
	state.NextProviderCursor = ""
	state.PollID = ""
	state.SkipPollResponses = false
	state.NewsletterListIDs = nil
	state.NewsletterListIndex = 0
	state.NextNewsletterListPage = 0
	state.SkipNewsletterListSubscriptions = false
	state.NewsletterListSubscriptionCount = 0
	state.AutomationIDs = nil
	state.AutomationIndex = 0
	state.NextAutomationPage = 0
	state.SkipAutomationEmails = false
	state.AutomationEmailCount = 0
	state.AutomationJourneyCount = 0
	state.ConditionSetCount = 0
	state.GapIndex = 0
	return state
}

func afterNewsletterListSubscriptions(state beehiivArchiveState) beehiivArchiveState {
	if state.NewsletterListIndex+1 < len(state.NewsletterListIDs) {
		state.NewsletterListIndex++
		state.ProviderCursor = ""
		state.NewsletterListSubscriptionCount = 0
		return state
	}
	if state.NextNewsletterListPage > 0 {
		nextPage := state.NextNewsletterListPage
		return transitionBeehiivArchiveState(state, archiveNewsletterLists, nextPage)
	}
	return transitionBeehiivArchiveState(state, archiveAutomations, 1)
}

func afterAutomationEmails(state beehiivArchiveState) beehiivArchiveState {
	if state.AutomationIndex+1 < len(state.AutomationIDs) {
		state.AutomationIndex++
		state.ProviderCursor = ""
		state.AutomationEmailCount = 0
		return state
	}
	state.Phase = archiveAutomationJourneys
	state.Page = 1
	state.ProviderCursor = ""
	state.AutomationIndex = 0
	state.AutomationEmailCount = 0
	state.AutomationJourneyCount = 0
	return state
}

func afterAutomationJourneys(state beehiivArchiveState) beehiivArchiveState {
	if state.AutomationIndex+1 < len(state.AutomationIDs) {
		state.AutomationIndex++
		state.Page = 1
		state.AutomationJourneyCount = 0
		return state
	}
	if state.NextAutomationPage > 0 {
		nextPage := state.NextAutomationPage
		return transitionBeehiivArchiveState(state, archiveAutomations, nextPage)
	}
	return transitionBeehiivArchiveState(state, archiveSegments, 1)
}

func afterPollResponses(state beehiivArchiveState, nextPollCursor string) beehiivArchiveState {
	if nextPollCursor == "" {
		return transitionBeehiivArchiveState(state, archiveTemplates, 1)
	}
	state.Phase = archivePolls
	state.Page = 0
	state.ProviderCursor = nextPollCursor
	state.NextProviderCursor = ""
	state.PollID = ""
	return state
}

func requiredArchiveString(source map[string]interface{}, resource, key string) (string, error) {
	value := archiveString(source, key)
	if value == "" {
		return "", fmt.Errorf("Beehiiv %s response is missing %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	return value, nil
}

func requiredArchiveStringField(source map[string]interface{}, resource, key string) (string, error) {
	raw, exists := source[key]
	if !exists {
		return "", fmt.Errorf("Beehiiv %s response is missing %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	value, ok := raw.(string)
	if !ok || containsArchiveControlCharacter(value) {
		return "", fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	return value, nil
}

func validateArchiveNonnegativeInteger(source map[string]interface{}, resource, key string) error {
	raw, exists := source[key]
	if !exists {
		return fmt.Errorf("Beehiiv %s response is missing %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	valid := false
	switch value := raw.(type) {
	case float64:
		valid = value >= 0 && value <= 1<<53 && float64(int64(value)) == value
	case json.Number:
		parsed, err := value.Int64()
		valid = err == nil && parsed >= 0
	case int:
		valid = value >= 0
	case int64:
		valid = value >= 0
	}
	if !valid {
		return fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	return nil
}

func validateAutomationStats(stats map[string]interface{}, resource string) error {
	if len(stats) == 0 {
		return fmt.Errorf("Beehiiv %s omitted requested statistics: %w", resource, adapter.ErrSourceUnavailable)
	}
	meaningful := false
	if raw, present := stats["journeys"]; present {
		journeys, ok := raw.(map[string]interface{})
		if !ok || journeys == nil {
			return fmt.Errorf("Beehiiv %s returned invalid journey statistics: %w", resource, adapter.ErrSourceUnavailable)
		}
		for _, field := range []string{"running", "completed", "total"} {
			if err := validateArchiveNonnegativeInteger(journeys, resource+" journey stats", field); err != nil {
				return err
			}
		}
		meaningful = true
	}
	if raw, present := stats["email"]; present {
		email, ok := raw.(map[string]interface{})
		if !ok || email == nil {
			return fmt.Errorf("Beehiiv %s returned invalid aggregate email statistics: %w", resource, adapter.ErrSourceUnavailable)
		}
		if err := validateAutomationEmailCounterStats(email, resource+" aggregate email stats"); err != nil {
			return err
		}
		meaningful = true
	}
	if !meaningful {
		return fmt.Errorf("Beehiiv %s returned no documented journey or aggregate email statistics: %w", resource, adapter.ErrSourceUnavailable)
	}
	return nil
}

func validateAutomationEmailStats(stats map[string]interface{}, emailID string) error {
	if len(stats) == 0 {
		return fmt.Errorf("Beehiiv automation email %s omitted requested statistics: %w", emailID, adapter.ErrSourceUnavailable)
	}
	email, ok := stats["email"].(map[string]interface{})
	if !ok || email == nil {
		return fmt.Errorf("Beehiiv automation email %q returned invalid email statistics: %w", emailID, adapter.ErrSourceUnavailable)
	}
	return validateAutomationEmailCounterStats(email, "automation email "+emailID+" stats")
}

func validateAutomationEmailCounterStats(email map[string]interface{}, resource string) error {
	for _, field := range []string{
		"recipients",
		"delivered",
		"opens",
		"unique_opens",
		"clicks",
		"unique_clicks",
		"unsubscribes",
		"spam_reports",
	} {
		if err := validateArchiveNonnegativeInteger(email, resource, field); err != nil {
			return err
		}
	}
	for _, field := range []string{"open_rate", "click_rate"} {
		if value, present := email[field]; present && !validArchiveFiniteNumber(value) {
			return fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, field, adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func validArchiveFiniteNumber(value interface{}) bool {
	switch number := value.(type) {
	case float64:
		return !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		converted := float64(number)
		return !math.IsNaN(converted) && !math.IsInf(converted, 0)
	case json.Number:
		converted, err := number.Float64()
		return err == nil && !math.IsNaN(converted) && !math.IsInf(converted, 0)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	default:
		return false
	}
}

func requiredBoundedArchiveID(source map[string]interface{}, resource, key, prefix string) (string, error) {
	id, err := requiredArchiveString(source, resource, key)
	if err != nil {
		return "", err
	}
	if !validBoundedArchiveID(id, prefix) {
		return "", fmt.Errorf("Beehiiv %s response has invalid %s %q: %w", resource, key, id, adapter.ErrSourceUnavailable)
	}
	return id, nil
}

func requiredBoundedArchiveToken(source map[string]interface{}, resource, key string) (string, error) {
	value, err := requiredArchiveString(source, resource, key)
	if err != nil {
		return "", err
	}
	if len(value) > maxArchiveProviderIDBytes {
		return "", fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return "", fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, key, adapter.ErrSourceUnavailable)
		}
	}
	return value, nil
}

func validateAutomationTriggerEvents(source map[string]interface{}) error {
	raw, ok := source["trigger_events"]
	if !ok {
		return fmt.Errorf("Beehiiv automation response is missing trigger_events: %w", adapter.ErrSourceUnavailable)
	}
	events, ok := raw.([]interface{})
	if !ok {
		return fmt.Errorf("Beehiiv automation response has invalid trigger_events: %w", adapter.ErrSourceUnavailable)
	}
	for _, event := range events {
		value, ok := event.(string)
		if !ok || strings.TrimSpace(value) == "" || len(value) > maxArchiveProviderIDBytes || containsArchiveControlCharacter(value) {
			return fmt.Errorf("Beehiiv automation response has invalid trigger_events: %w", adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func validBoundedArchiveID(value, prefix string) bool {
	return len(value) <= maxArchiveProviderIDBytes && validPrefixedID(value, prefix)
}

func containsArchiveControlCharacter(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func archiveString(source map[string]interface{}, key string) string {
	if source == nil {
		return ""
	}
	value, _ := source[key].(string)
	return strings.TrimSpace(value)
}

func archiveNumberString(source map[string]interface{}, key string) string {
	if source == nil {
		return ""
	}
	switch value := source[key].(type) {
	case float64:
		return strconv.FormatInt(int64(value), 10)
	case json.Number:
		return value.String()
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	default:
		return ""
	}
}

func archiveUnixTime(source map[string]interface{}, key string) *time.Time {
	if source == nil {
		return nil
	}
	switch value := source[key].(type) {
	case float64:
		return unixTimePointer(int64(value))
	case json.Number:
		seconds, err := value.Int64()
		if err == nil {
			return unixTimePointer(seconds)
		}
	case int64:
		return unixTimePointer(value)
	case int:
		return unixTimePointer(int64(value))
	}
	return nil
}

func requiredArchiveUnixTime(source map[string]interface{}, resource, key string) (*time.Time, error) {
	value := archiveUnixTime(source, key)
	if value == nil {
		return nil, fmt.Errorf("Beehiiv %s response has invalid or missing %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	return value, nil
}

func validateOptionalArchiveUnixTime(source map[string]interface{}, resource, key string) error {
	raw, exists := source[key]
	if !exists || raw == nil {
		return nil
	}
	if archiveUnixTime(source, key) == nil {
		return fmt.Errorf("Beehiiv %s response has invalid %s: %w", resource, key, adapter.ErrSourceUnavailable)
	}
	return nil
}

func unixTimePointer(seconds int64) *time.Time {
	if seconds <= 0 {
		return nil
	}
	value := time.Unix(seconds, 0).UTC()
	return &value
}

func classifyNonCampaignPost(post bhPost, cutoff time.Time) string {
	status := strings.ToLower(strings.TrimSpace(post.Status))
	platform := strings.ToLower(strings.TrimSpace(post.Platform))
	switch {
	case status == "draft":
		return "draft"
	case platform == "web":
		return "web_only"
	case post.PublishDate == nil || *post.PublishDate <= 0:
		return "unscheduled"
	case time.Unix(*post.PublishDate, 0).After(cutoff):
		return "scheduled"
	default:
		return "non_campaign"
	}
}

func maxIntArchive(a, b int) int {
	if a > b {
		return a
	}
	return b
}
