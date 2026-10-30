// SPDX-License-Identifier: MIT

// Package activecampaign implements the ActiveCampaign source adapter.
//
// Auth: API token + account API URL. Base URL example:
// https://example.api-us1.com/api/3
package activecampaign

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	pageSize           = 100
	maxRetries         = 4
	initialBackoff     = time.Second
	backoffCap         = 20 * time.Second
	retryAfterFallback = 5 * time.Second

	sourceEventReplayOverlap = time.Second

	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20
)

func init() {
	adapter.Register(canonical.SourceActiveCampaign, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for ActiveCampaign.
type Adapter struct {
	HTTPClient *http.Client
	// limiter is an optional test override. Runtime requests use the shared
	// account-keyed limiter so separate adapters/jobs cannot each consume 5 RPS.
	limiter *adapter.TokenBucket
	now     func() time.Time
	BaseURL string // test override; otherwise read from Session.Extra["api_url"].

	fieldNames               map[string]string
	fieldNamesCache          string
	tagNames                 map[string]string
	tagNamesCache            string
	listChannels             map[string]activeCampaignMarketingChannel
	listChannelsCache        string
	listChannelsLoaded       bool
	listChannelsComplete     bool
	loadListChannelsForTests bool
}

// New constructs an adapter with a conservative 5 req/sec client-side cap.
func New() *Adapter {
	return &Adapter{
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceActiveCampaign,
		AuthMethod: "api_key",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = true
	c.Supports.AutomationMode = "rebuild_review"
	c.Supports.CampaignArchive = true
	c.Supports.PaidSubs = false
	// ActiveCampaign list subscription dates are provenance, not proof of
	// channel-specific consent. They are retained in audit evidence only.
	c.Supports.ConsentTimestamps = false
	c.Supports.Templates = false
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = true
	c.Supports.Forms = true
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = true
	c.Supports.CRM = true
	c.Supports.CustomObjects = true
	c.Supports.SMS = true
	return c
}

// Authenticate validates the API token and stores the normalized API URL in the
// resumable session. ActiveCampaign exposes the account API URL separately from
// the token, so callers pass it as AccountID or an Extra URL alias.
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if strings.TrimSpace(creds.APIKey) == "" {
		return adapter.Session{}, fmt.Errorf("activecampaign: missing API token: %w", adapter.ErrAuth)
	}
	apiURL, err := normalizeAPIURL(activeCampaignAPIURLFromCredentials(creds))
	if err != nil {
		return adapter.Session{}, fmt.Errorf("activecampaign: %w: %w", err, adapter.ErrAuth)
	}
	if err := validateAPIURLForRequest(apiURL); err != nil {
		return adapter.Session{}, fmt.Errorf("activecampaign: %w: %w", err, adapter.ErrAuth)
	}
	sess := adapter.Session{
		AccessToken: strings.TrimSpace(creds.APIKey),
		AccountID:   accountHostFromAPIURL(apiURL),
		Source:      canonical.SourceActiveCampaign,
		Extra:       cloneMap(creds.Extra),
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	sess.Extra["api_url"] = apiURL
	if err := a.establishAuthenticatedAccount(ctx, &sess); err != nil {
		return adapter.Session{}, err
	}
	return sess, nil
}

func activeCampaignAPIURLFromCredentials(creds adapter.Credentials) string {
	return firstNonEmpty(
		creds.Extra["api_url"],
		creds.Extra["account_api_url"],
		creds.Extra["account_url"],
		creds.Extra["base_url"],
		creds.AccountID,
	)
}

func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport
	var err error
	rep.SubscribersTotal, err = a.countCollection(ctx, sess, "/contacts?limit=1&offset=0", "contacts")
	if err != nil {
		return rep, fmt.Errorf("activecampaign: discover contacts: %w", err)
	}
	rep.CustomFields = a.listOptionalCustomFieldNames(ctx, sess, &rep)
	rep.GroupsTotal = a.countOptionalCollection(ctx, sess, "/tags?limit=1&offset=0", "tags", "tags", &rep)
	rep.SegmentsTotal = a.countOptionalCollection(ctx, sess, "/lists?limit=1&offset=0", "lists", "lists", &rep)
	if segments, segmentErr := a.listSavedSegmentsV2(ctx, sess); segmentErr != nil {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("saved segments inventory unavailable: %v", segmentErr))
	} else {
		rep.SegmentsTotal += len(segments)
	}
	rep.AutomationsTotal = a.countOptionalCollection(ctx, sess, "/automations?limit=1&offset=0", "automations", "automations", &rep)
	rep.ArchiveTotal = a.countOptionalSentCampaigns(ctx, sess, &rep)
	rep.CampaignsTotal = rep.ArchiveTotal
	rep.ReportsTotal = rep.ArchiveTotal
	rep.TemplatesTotal = a.countOptionalCollection(ctx, sess, "/messages?limit=1&offset=0", "messages", "messages/templates", &rep)
	rep.FormsTotal = a.countOptionalCollection(ctx, sess, "/forms?limit=1&offset=0", "forms", "forms", &rep)
	rep.DealsTotal = a.countOptionalCollection(ctx, sess, "/deals?limit=1&offset=0", "deals", "deals", &rep)
	rep.PipelinesTotal = a.countOptionalCollection(ctx, sess, "/dealGroups?limit=1&offset=0", "dealGroups", "pipelines", &rep)
	rep.CRMTotal = rep.DealsTotal + rep.PipelinesTotal
	rep.CustomObjectsTotal = a.countOptionalCollection(ctx, sess, "/customObjects/schemas?limit=1&offset=0&showFields=all", "schemas", "custom object schemas", &rep)
	rep.EcommerceTotal = a.countOptionalCollection(ctx, sess, "/ecomOrders?limit=1&offset=0", "ecomOrders", "ecommerce orders", &rep)
	rep.SMSCampaignsTotal = a.countOptionalCollection(ctx, sess, "/sms/broadcasts?filters%5Bstatus%5D=sent&limit=1&offset=0", "broadcasts", "sent SMS broadcasts", &rep)
	if evidence, channelErr := a.ensureListChannels(ctx, sess); channelErr != nil {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("email/SMS list-channel inventory unavailable: %v", channelErr))
	} else if !evidence.ListChannelInventoryComplete {
		rep.Warnings = append(rep.Warnings, "SMS list-channel inventory is unavailable; affected contacts remain unconfirmed")
	}
	return rep, nil
}

func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	cur, err := parseContactCursor(cursor)
	if err != nil {
		return nil, "", fmt.Errorf("activecampaign: bad cursor %q: %w", cursor, err)
	}
	if err := a.ensureFieldNames(ctx, sess); err != nil {
		return nil, "", fmt.Errorf("activecampaign: load custom field metadata: %w", err)
	}
	if err := a.ensureTagNames(ctx, sess); err != nil {
		return nil, "", fmt.Errorf("activecampaign: load tag metadata: %w", err)
	}
	safetyEvidence, err := a.ensureListChannels(ctx, sess)
	if err != nil {
		return nil, "", fmt.Errorf("activecampaign: load email/SMS list-channel inventory: %w", err)
	}

	values := url.Values{}
	values.Set("limit", strconv.Itoa(pageSize))
	if cur.Mode == contactCursorModeOffset {
		values.Set("offset", strconv.Itoa(cur.Value))
	} else {
		values.Set("orders[id]", "ASC")
		if cur.Value > 0 {
			values.Set("id_greater", strconv.Itoa(cur.Value))
		}
	}
	path := "/contacts?" + values.Encode()
	contacts, providerTotal, err := listCollectionPage[acContact](a, ctx, sess, path, "contacts")
	if err != nil {
		return nil, "", err
	}
	if cur.Mode == contactCursorModeID {
		if _, err := validateAscendingActiveCampaignContactIDs(contacts, cur.Value); err != nil {
			return nil, "", err
		}
	}

	out := make([]canonical.Subscriber, 0, len(contacts))
	for _, c := range contacts {
		detail, err := a.fetchContactDetail(ctx, sess, c)
		if err != nil {
			return nil, "", err
		}
		sub, err := mapContactToCanonical(detail, a.fieldNames, a.tagNames, safetyEvidence)
		if err != nil {
			if errors.Is(err, ErrNonEmailContact) {
				continue
			}
			return nil, "", err
		}
		out = append(out, sub)
	}

	next := ""
	if activeCampaignContactsHaveNextPage(contacts, providerTotal, cur, pageSize) {
		next, err = nextContactCursor(contacts, cur)
		if err != nil {
			return nil, "", err
		}
	}
	return out, next, nil
}

func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	var out []canonical.Segment
	offset := 0
	for {
		lists, providerTotal, err := listCollectionPage[acList](a, ctx, sess, fmt.Sprintf("/lists?limit=%d&offset=%d", pageSize, offset), "lists")
		if err != nil {
			return out, err
		}
		if err := validateActiveCampaignOffsetPage(len(lists), providerTotal, offset); err != nil {
			return out, fmt.Errorf("activecampaign: list pagination: %w", err)
		}
		for _, l := range lists {
			out = append(out, mapListToSegment(l))
		}
		nextOffset := nextActiveCampaignPageOffset(len(lists), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			break
		}
		offset = nextOffset
	}

	savedSegments, err := a.listSavedSegmentsV2(ctx, sess)
	if err != nil {
		return out, fmt.Errorf("activecampaign: list saved segments: %w", err)
	}
	for _, segment := range savedSegments {
		out = append(out, mapSavedSegmentToCanonical(segment))
	}
	return out, nil
}

func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	var out []canonical.Automation
	offset := 0
	for {
		automations, providerTotal, err := a.listAutomationPage(ctx, sess, offset)
		if err != nil {
			return out, err
		}
		if err := validateActiveCampaignOffsetPage(len(automations), providerTotal, offset); err != nil {
			return out, fmt.Errorf("activecampaign: automation pagination: %w", err)
		}
		for _, au := range automations {
			hydrated, err := a.hydrateAutomationDefinition(ctx, sess, au)
			if err != nil {
				return out, err
			}
			out = append(out, mapAutomationToCanonical(hydrated))
		}
		nextOffset := nextActiveCampaignPageOffset(len(automations), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			break
		}
		offset = nextOffset
	}
	return out, nil
}

func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	offset, err := parseOffset(cursor)
	if err != nil {
		return nil, "", fmt.Errorf("activecampaign: bad campaign cursor %q: %w", cursor, err)
	}
	path := fmt.Sprintf("/campaigns?limit=%d&offset=%d", pageSize, offset)
	campaigns, providerTotal, err := listCollectionPage[acCampaign](a, ctx, sess, path, "campaigns")
	if err != nil {
		return nil, "", err
	}
	if err := validateActiveCampaignOffsetPage(len(campaigns), providerTotal, offset); err != nil {
		return nil, "", fmt.Errorf("activecampaign: campaign pagination: %w", err)
	}
	out := make([]canonical.CampaignArchive, 0, len(campaigns))
	for _, c := range campaigns {
		if !campaignWasSent(c) {
			continue
		}
		hydrated, err := a.hydrateCampaignArchiveItem(ctx, sess, c)
		if err != nil {
			return nil, "", err
		}
		item, err := mapCampaignToCanonical(hydrated)
		if err != nil {
			return nil, "", err
		}
		out = append(out, item)
	}
	next := ""
	if nextOffset := nextActiveCampaignPageOffset(len(campaigns), providerTotal, offset, pageSize); nextOffset > 0 {
		next = strconv.Itoa(nextOffset)
	}
	return out, next, nil
}

func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (a *Adapter) ListSourceEvents(ctx context.Context, sess adapter.Session, since time.Time, cursor string, limit int) (canonical.SourceEventBatch, error) {
	if limit <= 0 || limit > pageSize {
		limit = pageSize
	}
	cur, err := a.newOrResumeDeltaCursor(sess, since, cursor)
	if err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: bad source-event cursor %q: %w", cursor, err)
	}
	if err := a.ensureFieldNames(ctx, sess); err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: load custom field metadata: %w", err)
	}
	if err := a.ensureTagNames(ctx, sess); err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: load tag metadata: %w", err)
	}
	safetyEvidence, err := a.ensureListChannels(ctx, sess)
	if err != nil {
		return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: load email/SMS list-channel inventory: %w", err)
	}

	for {
		values := url.Values{}
		values.Set("limit", strconv.Itoa(limit))
		values.Set("orders[id]", "ASC")
		if cur.LastContactID > 0 {
			values.Set("id_greater", strconv.Itoa(cur.LastContactID))
		}
		if updatedAfter := activeCampaignProviderUpdatedAfter(cur.LowerBound); updatedAfter != "" {
			values.Set("filters[updated_after]", updatedAfter)
		}
		values.Set("filters[updated_before]", activeCampaignProviderUpdatedBefore(cur.UpperBound))
		contacts, providerTotal, err := listCollectionPage[acContact](a, ctx, sess, "/contacts?"+values.Encode(), "contacts")
		if err != nil {
			return canonical.SourceEventBatch{}, err
		}

		out := canonical.SourceEventBatch{Events: make([]canonical.SourceEvent, 0, len(contacts))}
		lastContactID := cur.LastContactID
		for _, c := range contacts {
			contactID, parseErr := strconv.Atoi(strings.TrimSpace(c.ID))
			if parseErr != nil || contactID <= lastContactID {
				return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: contact %s did not advance fixed-window ID pagination after %d", firstNonEmpty(c.ID, "unknown"), lastContactID)
			}
			// Advance across every provider candidate, including conservative
			// date-bound false positives, so an all-skipped page cannot loop.
			lastContactID = contactID

			detail, err := a.fetchContactDetail(ctx, sess, c)
			if err != nil {
				return canonical.SourceEventBatch{}, err
			}
			occurred := contactDeltaUpdatedAt(detail.Contact)
			if occurred.IsZero() {
				return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: contact %s missing provider update timestamp for source event", firstNonEmpty(c.ID, c.Email, "unknown"))
			}
			if !activeCampaignDeltaTimestampInWindow(occurred, cur.LowerBound, cur.UpperBound) {
				continue
			}

			sub, mapErr := mapContactToCanonical(detail, a.fieldNames, a.tagNames, safetyEvidence)
			if mapErr != nil && !errors.Is(mapErr, ErrNonEmailContact) {
				return canonical.SourceEventBatch{}, mapErr
			}
			if errors.Is(mapErr, ErrNonEmailContact) {
				payload, payloadErr := activeCampaignContactDetailPayload(detail)
				if payloadErr != nil {
					return canonical.SourceEventBatch{}, payloadErr
				}
				projection := stableSourceArchiveFallbackID("activecampaign_non_email_contact", payload)
				out.Events = append(out.Events, canonical.SourceEvent{
					SourceID:       "activecampaign:non-email-contact:" + c.ID + ":" + occurred.Format(time.RFC3339Nano) + ":" + projection,
					ResourceType:   "activecampaign_non_email_contact",
					Action:         "manual_review",
					OccurredAt:     occurred,
					Payload:        payload,
					SourcePlatform: canonical.SourceActiveCampaign,
				})
			} else {
				projection := sourceEventProjectionHash(sub)
				out.Events = append(out.Events, canonical.SourceEvent{
					SourceID:       "activecampaign:contact:" + sub.SourceID + ":" + occurred.Format(time.RFC3339Nano) + ":" + projection,
					ResourceType:   "subscriber",
					Action:         "upsert",
					OccurredAt:     occurred,
					Subscriber:     &sub,
					Payload:        map[string]interface{}{"contact_id": sub.SourceID, "email": sub.Email, "projection_hash": projection},
					SourcePlatform: canonical.SourceActiveCampaign,
				})
			}
			if occurred.After(out.HighWatermark) {
				out.HighWatermark = occurred
			}
		}

		hasNext := len(contacts) > 0 && activeCampaignContactsHaveNextPage(contacts, providerTotal, contactCursor{Mode: contactCursorModeID, Value: cur.LastContactID}, limit)
		if hasNext {
			cur.LastContactID = lastContactID
			if len(out.Events) == 0 {
				// The provider's date-only query can produce a page entirely
				// outside the exact timestamp window. Scan through it internally;
				// callers reject empty event batches carrying a continuation cursor.
				continue
			}
			next, err := formatActiveCampaignDeltaCursor(cur)
			if err != nil {
				return canonical.SourceEventBatch{}, fmt.Errorf("activecampaign: encode source-event cursor: %w", err)
			}
			out.NextCursor = next
			return out, nil
		}

		// Advancing to the fixed upper bound only after every page succeeds
		// closes the window atomically. The next poll overlaps this watermark.
		out.HighWatermark = cur.UpperBound
		return out, nil
	}
}

func activeCampaignContactsHaveNextPage(contacts []acContact, total int, cur contactCursor, limit int) bool {
	if len(contacts) == 0 {
		return false
	}
	if cur.Mode == contactCursorModeOffset {
		return nextActiveCampaignPageOffset(len(contacts), total, cur.Value, limit) > 0
	}
	if total > 0 && len(contacts) < total {
		return true
	}
	return len(contacts) == limit
}

func validateAscendingActiveCampaignContactIDs(contacts []acContact, after int) (int, error) {
	last := after
	for _, contact := range contacts {
		id, err := strconv.Atoi(strings.TrimSpace(contact.ID))
		if err != nil || id <= last {
			return 0, fmt.Errorf("activecampaign: contact %s did not advance ascending ID pagination after %d", firstNonEmpty(contact.ID, "unknown"), last)
		}
		last = id
	}
	return last, nil
}

func sourceEventUpdatedAfter(since time.Time) time.Time {
	if since.IsZero() {
		return time.Time{}
	}
	return since.UTC().Add(-sourceEventReplayOverlap)
}

func sourceEventProjectionHash(sub canonical.Subscriber) string {
	raw, err := json.Marshal(sub)
	if err != nil {
		raw = []byte(fmt.Sprintf("%s:%s", sub.SourceID, sub.Email))
	}
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum[:8])
}

func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	resource, offset, err := parseSourceArchiveCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	if parentOffset, parentID, ok := decodeNestedArchiveResource(resource, "custom_object_records"); ok {
		if err := a.revalidateCustomObjectSchemaParent(ctx, sess, parentOffset, parentID); err != nil {
			return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", err, nextCustomObjectSchemaCursor(parentOffset+1))
		}
		return a.listCustomObjectRecordPage(ctx, sess, parentOffset, parentID, offset)
	}
	if parentOffset, parentID, ok := decodeNestedArchiveResource(resource, "ecommerce_order_products"); ok {
		if err := a.revalidateEcommerceOrderParent(ctx, sess, parentOffset, parentID); err != nil {
			return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", err, nextEcommerceOrderCursor(parentOffset+1))
		}
		return a.listEcommerceOrderProductPage(ctx, sess, parentOffset, parentID, offset)
	}
	if parentOffset, parentID, ok := decodeNestedArchiveResource(resource, "sms_broadcast_recipients"); ok {
		if err := a.revalidateSMSBroadcastParent(ctx, sess, parentOffset, parentID); err != nil {
			return sourceArchiveContractWarning("sms_broadcast_recipients", "activecampaign_sms_broadcast_recipient", err, nextSMSBroadcastCursor(parentOffset+1))
		}
		return a.listSMSBroadcastRecipientContinuation(ctx, sess, parentOffset, parentID, offset)
	}
	switch resource {
	case "", nonEmailContactResource:
		return a.listNonEmailContacts(ctx, sess, offset)
	case "deals":
		deals, providerTotal, err := listCollectionPage[acDeal](a, ctx, sess, fmt.Sprintf("/deals?limit=%d&offset=%d", pageSize, offset), "deals")
		if err != nil {
			slog.Warn("activecampaign: deals source archive unavailable", "err", err.Error())
			return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning("deals", "crm_deal", err)}, "deal_groups:0", nil
		}
		if err := validateActiveCampaignOffsetPage(len(deals), providerTotal, offset); err != nil {
			return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning("deals", "crm_deal", err)}, "deal_groups:0", nil
		}
		out := make([]canonical.SourceArchiveItem, 0, len(deals))
		for _, deal := range deals {
			out = append(out, mapDealToSourceArchive(deal))
		}
		next := ""
		if nextOffset := nextSourceArchiveOffset(len(deals), providerTotal, offset, pageSize); nextOffset > 0 {
			next = fmt.Sprintf("deals:%d", nextOffset)
		} else {
			next = "deal_groups:0"
		}
		return out, next, nil
	case "deal_groups":
		dealGroups, providerTotal, err := listCollectionPage[acDealGroup](a, ctx, sess, fmt.Sprintf("/dealGroups?limit=%d&offset=%d", pageSize, offset), "dealGroups")
		if err != nil {
			slog.Warn("activecampaign: deal groups source archive unavailable", "err", err.Error())
			return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning("deal_groups", "crm_pipeline", err)}, "fields:0", nil
		}
		if err := validateActiveCampaignOffsetPage(len(dealGroups), providerTotal, offset); err != nil {
			return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning("deal_groups", "crm_pipeline", err)}, "fields:0", nil
		}
		out := make([]canonical.SourceArchiveItem, 0, len(dealGroups))
		for _, group := range dealGroups {
			out = append(out, mapDealGroupToSourceArchive(group))
		}
		next := ""
		if nextOffset := nextSourceArchiveOffset(len(dealGroups), providerTotal, offset, pageSize); nextOffset > 0 {
			next = fmt.Sprintf("deal_groups:%d", nextOffset)
		} else {
			next = "fields:0"
		}
		return out, next, nil
	case "fields":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "fields",
			Offset:       offset,
			Path:         "/fields",
			ResponseKey:  "fields",
			ResourceType: "activecampaign_custom_field",
			NextResource: "tags",
		})
	case "tags":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "tags",
			Offset:       offset,
			Path:         "/tags",
			ResponseKey:  "tags",
			ResourceType: "activecampaign_tag",
			NextResource: "forms",
		})
	case "forms":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "forms",
			Offset:       offset,
			Path:         "/forms",
			ResponseKey:  "forms",
			ResourceType: "activecampaign_form",
			NextResource: "messages",
		})
	case "messages":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "messages",
			Offset:       offset,
			Path:         "/messages",
			ResponseKey:  "messages",
			ResourceType: "activecampaign_message",
			NextResource: "custom_object_schemas",
		})
	case "custom_object_schemas":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "custom_object_schemas",
			Offset:       offset,
			Path:         "/customObjects/schemas",
			ResponseKey:  "schemas",
			ResourceType: "activecampaign_custom_object_schema",
			NextResource: customObjectRecordSelector,
			Query:        url.Values{"showFields": []string{"all"}},
		})
	case customObjectRecordSelector:
		return a.listCustomObjectRecordSchema(ctx, sess, offset)
	case "ecommerce_connections":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "ecommerce_connections",
			Offset:       offset,
			Path:         "/connections",
			ResponseKey:  "connections",
			ResourceType: "activecampaign_ecommerce_connection",
			NextResource: "ecommerce_customers",
		})
	case "ecommerce_customers":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "ecommerce_customers",
			Offset:       offset,
			Path:         "/ecomCustomers",
			ResponseKey:  "ecomCustomers",
			ResourceType: "activecampaign_ecommerce_customer",
			NextResource: "ecommerce_orders",
		})
	case "ecommerce_orders":
		return a.listGenericSourceArchive(ctx, sess, sourceArchivePageRequest{
			Resource:     "ecommerce_orders",
			Offset:       offset,
			Path:         "/ecomOrders",
			ResponseKey:  "ecomOrders",
			ResourceType: "activecampaign_ecommerce_order",
			NextResource: ecommerceProductSelector,
		})
	case ecommerceProductSelector:
		return a.listEcommerceOrderProductOrder(ctx, sess, offset)
	case smsBroadcastSelector, "sms_messages": // sms_messages keeps old stored cursors resumable.
		return a.listSMSBroadcast(ctx, sess, offset)
	default:
		return nil, "", adapter.ErrUnsupported
	}
}

type sourceArchivePageRequest struct {
	Resource     string
	Offset       int
	Path         string
	ResponseKey  string
	ResourceType string
	NextResource string
	Query        url.Values
}

func listCollectionPage[T any](a *Adapter, ctx context.Context, sess adapter.Session, path, key string) ([]T, int, error) {
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		return nil, 0, err
	}
	providerTotal, hasProviderTotal := totalFromRawOK(raw)
	payload := raw[key]
	if len(payload) == 0 {
		if hasProviderTotal && providerTotal == 0 {
			return nil, providerTotal, nil
		}
		return nil, providerTotal, fmt.Errorf(`response missing %q array and numeric zero total`, key)
	}
	var rows []T
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		if hasProviderTotal && providerTotal == 0 {
			return nil, providerTotal, nil
		}
		return nil, providerTotal, fmt.Errorf(`response missing %q array and numeric zero total`, key)
	}
	if err := json.Unmarshal(payload, &rows); err != nil {
		return nil, providerTotal, fmt.Errorf(`decode %q array: %w`, key, err)
	}
	return rows, providerTotal, nil
}

func decodeOptionalArrayField[T any](raw map[string]json.RawMessage, key string, out *[]T) error {
	payload := raw[key]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf(`decode %q array: %w`, key, err)
	}
	return nil
}

func (a *Adapter) listGenericSourceArchive(ctx context.Context, sess adapter.Session, req sourceArchivePageRequest) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	for key, entries := range req.Query {
		for _, entry := range entries {
			values.Add(key, entry)
		}
	}
	values.Set("limit", strconv.Itoa(pageSize))
	values.Set("offset", strconv.Itoa(req.Offset))
	path := req.Path + "?" + values.Encode()
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		slog.Warn("activecampaign: optional source archive unavailable", "resource", req.Resource, "err", err.Error())
		return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning(req.Resource, req.ResourceType, err)}, nextSourceArchiveResource(req.NextResource), nil
	}
	var rows []map[string]interface{}
	providerTotal, hasProviderTotal := totalFromRawOK(raw)
	payload := raw[req.ResponseKey]
	if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		if !(hasProviderTotal && providerTotal == 0) {
			err := fmt.Errorf("activecampaign: decode %s source archive: response missing %q array and numeric zero total", req.Resource, req.ResponseKey)
			return activeCampaignSourceArchivePayloadWarning(req, err)
		}
	} else if err := json.Unmarshal(payload, &rows); err != nil {
		err = fmt.Errorf("activecampaign: decode %s source archive: %w", req.Resource, err)
		return activeCampaignSourceArchivePayloadWarning(req, err)
	}
	if err := validateActiveCampaignOffsetPage(len(rows), providerTotal, req.Offset); err != nil {
		return activeCampaignSourceArchivePayloadWarning(req, fmt.Errorf("activecampaign: decode %s source archive: %w", req.Resource, err))
	}
	out := make([]canonical.SourceArchiveItem, 0, len(rows))
	for _, row := range rows {
		sourceID := firstNonEmpty(sourceMapString(row, "id"), stableSourceArchiveFallbackID(req.ResourceType, row))
		out = append(out, mapGenericSourceArchive(row, sourceID, req.ResourceType))
	}
	next := ""
	if nextOffset := nextSourceArchiveOffset(len(rows), providerTotal, req.Offset, pageSize); nextOffset > 0 {
		next = fmt.Sprintf("%s:%d", req.Resource, nextOffset)
	} else {
		next = nextSourceArchiveResource(req.NextResource)
	}
	return out, next, nil
}

func activeCampaignSourceArchivePayloadWarning(req sourceArchivePageRequest, err error) ([]canonical.SourceArchiveItem, string, error) {
	slog.Warn("activecampaign: optional source archive payload invalid", "resource", req.Resource, "err", err.Error())
	return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning(req.Resource, req.ResourceType, err)}, nextSourceArchiveResource(req.NextResource), nil
}

func nextSourceArchiveOffset(rowCount, total, offset, limit int) int {
	return nextActiveCampaignPageOffset(rowCount, total, offset, limit)
}

func stableSourceArchiveFallbackID(resourceType string, payload map[string]interface{}) string {
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = []byte(fmt.Sprint(payload))
	}
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%s:sha256:%x", strings.TrimSpace(resourceType), sum)
}

func nextActiveCampaignPageOffset(rowCount, total, offset, limit int) int {
	if rowCount == 0 {
		return 0
	}
	next := offset + rowCount
	if total > 0 && next < total {
		return next
	}
	if rowCount == limit {
		return next
	}
	return 0
}

func validateActiveCampaignOffsetPage(rowCount, total, offset int) error {
	if rowCount < 0 || total < 0 || offset < 0 {
		return fmt.Errorf("invalid negative pagination metadata")
	}
	if total > 0 && rowCount == 0 && offset < total {
		return fmt.Errorf("empty page at offset %d before provider total %d", offset, total)
	}
	if total > 0 && offset+rowCount > total {
		return fmt.Errorf("page at offset %d with %d rows exceeds provider total %d", offset, rowCount, total)
	}
	return nil
}

func activeCampaignSourceArchiveWarning(resource, targetResourceType string, err error) canonical.SourceArchiveItem {
	resource = strings.TrimSpace(resource)
	if resource == "" {
		resource = "source_archive"
	}
	targetResourceType = strings.TrimSpace(targetResourceType)
	warning := fmt.Sprintf("%s source archive unavailable: %v", resource, err)
	return canonical.SourceArchiveItem{
		SourceID:       "source_archive_warning:" + resource,
		Name:           resource,
		Payload:        map[string]interface{}{"resource": resource, "target_resource_type": targetResourceType, "error": err.Error()},
		Warnings:       []string{warning},
		SourcePlatform: canonical.SourceActiveCampaign,
	}
}

func (a *Adapter) fetchContactDetail(ctx context.Context, sess adapter.Session, c acContact) (acContactDetail, error) {
	detail := acContactDetail{Contact: c}
	requestedID := strings.TrimSpace(c.ID)
	if requestedID == "" {
		return detail, nil
	}
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, "/contacts/"+url.PathEscape(requestedID), nil, &raw); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	contactPayload := raw["contact"]
	if len(contactPayload) == 0 || bytes.Equal(bytes.TrimSpace(contactPayload), []byte("null")) {
		return acContactDetail{}, fmt.Errorf(`activecampaign: fetch contact detail %s: response missing "contact" object`, requestedID)
	}
	var got acContactDetail
	if err := json.Unmarshal(contactPayload, &got.Contact); err != nil {
		return acContactDetail{}, fmt.Errorf(`activecampaign: fetch contact detail %s: decode "contact" object: %w`, requestedID, err)
	}
	if strings.TrimSpace(got.Contact.ID) != requestedID {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: detail identity mismatch", requestedID)
	}
	if err := decodeOptionalArrayField(raw, "contactLists", &got.ContactLists); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	if err := decodeOptionalArrayField(raw, "contactTags", &got.ContactTags); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	if err := decodeOptionalArrayField(raw, "fieldValues", &got.FieldValues); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	if err := decodeOptionalArrayField(raw, "deals", &got.Deals); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	if err := decodeOptionalArrayField(raw, "activities", &got.Activities); err != nil {
		return acContactDetail{}, fmt.Errorf("activecampaign: fetch contact detail %s: %w", requestedID, err)
	}
	detail = got
	detail.Contact = mergeContactFallback(detail.Contact, c)
	if detail.ContactLists == nil && hasContactRelationshipLink(detail.Contact, c, "contactLists") {
		lists, err := a.fetchContactLists(ctx, sess, c.ID)
		if err != nil {
			return acContactDetail{}, err
		}
		detail.ContactLists = lists
	}
	if detail.ContactTags == nil && hasContactRelationshipLink(detail.Contact, c, "contactTags") {
		tags, err := a.fetchContactTags(ctx, sess, c.ID)
		if err != nil {
			return acContactDetail{}, err
		}
		detail.ContactTags = tags
	}
	if detail.FieldValues == nil && hasContactRelationshipLink(detail.Contact, c, "fieldValues") {
		fields, err := a.fetchContactFieldValues(ctx, sess, c.ID)
		if err != nil {
			return acContactDetail{}, err
		}
		detail.FieldValues = fields
	}
	return detail, nil
}

func (a *Adapter) fetchContactLists(ctx context.Context, sess adapter.Session, contactID string) ([]acContactList, error) {
	rows, err := fetchContactRelationshipPages[acContactList](a, ctx, sess, contactID, "contactLists", "contactLists")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: fetch contact %s list memberships: %w", contactID, err)
	}
	return rows, nil
}

func (a *Adapter) fetchContactTags(ctx context.Context, sess adapter.Session, contactID string) ([]acContactTag, error) {
	rows, err := fetchContactRelationshipPages[acContactTag](a, ctx, sess, contactID, "contactTags", "contactTags")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: fetch contact %s tags: %w", contactID, err)
	}
	return rows, nil
}

func (a *Adapter) fetchContactFieldValues(ctx context.Context, sess adapter.Session, contactID string) ([]acFieldValue, error) {
	rows, err := fetchContactRelationshipPages[acFieldValue](a, ctx, sess, contactID, "fieldValues", "fieldValues")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: fetch contact %s field values: %w", contactID, err)
	}
	return rows, nil
}

func fetchContactRelationshipPages[T any](a *Adapter, ctx context.Context, sess adapter.Session, contactID, relationship, responseKey string) ([]T, error) {
	var out []T
	offset := 0
	for {
		values := url.Values{}
		values.Set("limit", strconv.Itoa(pageSize))
		values.Set("offset", strconv.Itoa(offset))
		path := "/contacts/" + url.PathEscape(contactID) + "/" + relationship + "?" + values.Encode()
		rows, providerTotal, err := listCollectionPage[T](a, ctx, sess, path, responseKey)
		if err != nil {
			return nil, err
		}
		if err := validateActiveCampaignOffsetPage(len(rows), providerTotal, offset); err != nil {
			return nil, err
		}
		out = append(out, rows...)
		nextOffset := nextActiveCampaignPageOffset(len(rows), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			return out, nil
		}
		offset = nextOffset
	}
}

func (a *Adapter) ensureFieldNames(ctx context.Context, sess adapter.Session) error {
	cacheKey := a.metadataCacheKey(sess)
	if a.fieldNames != nil && a.fieldNamesCache == cacheKey {
		return nil
	}
	fieldNames := map[string]string{}
	seenFieldKeys := map[string]string{}
	offset := 0
	for {
		fields, providerTotal, err := listCollectionPage[acField](a, ctx, sess, fmt.Sprintf("/fields?limit=%d&offset=%d", pageSize, offset), "fields")
		if err != nil {
			return err
		}
		if err := validateActiveCampaignOffsetPage(len(fields), providerTotal, offset); err != nil {
			return err
		}
		for _, f := range fields {
			if f.ID != "" {
				name := strings.TrimSpace(firstNonEmpty(f.Title, f.Perstag))
				if name == "" {
					name = activeCampaignFieldFallbackName(f.ID)
				}
				fieldNames[f.ID] = uniqueActiveCampaignFieldName(name, f.ID, seenFieldKeys)
			}
		}
		nextOffset := nextActiveCampaignPageOffset(len(fields), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			a.fieldNames = fieldNames
			a.fieldNamesCache = cacheKey
			return nil
		}
		offset = nextOffset
	}
}

func uniqueActiveCampaignFieldName(name, id string, seenKeys map[string]string) string {
	name = strings.TrimSpace(name)
	id = strings.TrimSpace(id)
	if seenKeys == nil {
		seenKeys = map[string]string{}
	}
	key := normalizeFieldKey(name)
	if owner := seenKeys[key]; !activeCampaignReservedSubscriberFieldKey(key) && (owner == "" || owner == id) {
		seenKeys[key] = id
		return name
	}
	suffix := id
	if suffix == "" {
		suffix = "field"
	}
	for i := 1; ; i++ {
		candidate := name + " " + suffix
		if i > 1 {
			candidate = fmt.Sprintf("%s %s %d", name, suffix, i)
		}
		key = normalizeFieldKey(candidate)
		if owner := seenKeys[key]; !activeCampaignReservedSubscriberFieldKey(key) && (owner == "" || owner == id) {
			seenKeys[key] = id
			return candidate
		}
	}
}

// ActiveCampaign custom fields share the canonical subscriber attribute map
// with these identity/display fields. Keep source-defined fields distinct so a
// field titled, for example, "Name" cannot replace the contact's real name.
func activeCampaignReservedSubscriberFieldKey(key string) bool {
	switch normalizeFieldKey(key) {
	case "name", "first_name", "last_name", "phone":
		return true
	default:
		return false
	}
}

func (a *Adapter) ensureTagNames(ctx context.Context, sess adapter.Session) error {
	cacheKey := a.metadataCacheKey(sess)
	if a.tagNames != nil && a.tagNamesCache == cacheKey {
		return nil
	}
	tagNames := map[string]string{}
	offset := 0
	for {
		tags, providerTotal, err := listCollectionPage[acTag](a, ctx, sess, fmt.Sprintf("/tags?limit=%d&offset=%d", pageSize, offset), "tags")
		if err != nil {
			return err
		}
		if err := validateActiveCampaignOffsetPage(len(tags), providerTotal, offset); err != nil {
			return err
		}
		for _, t := range tags {
			if t.ID != "" {
				name := strings.TrimSpace(firstNonEmpty(t.Tag, t.Name))
				if name == "" {
					name = activeCampaignTagFallbackName(t.ID)
				}
				tagNames[t.ID] = name
			}
		}
		nextOffset := nextActiveCampaignPageOffset(len(tags), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			a.tagNames = tagNames
			a.tagNamesCache = cacheKey
			return nil
		}
		offset = nextOffset
	}
}

func activeCampaignFieldFallbackName(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "ActiveCampaign field"
	}
	return "ActiveCampaign field " + id
}

func activeCampaignTagFallbackName(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "activecampaign_tag"
	}
	return "activecampaign_tag:" + id
}

func (a *Adapter) metadataCacheKey(sess adapter.Session) string {
	return firstNonEmpty(a.BaseURL, sess.Extra["api_url"], sess.AccountID)
}

func (a *Adapter) countOptionalCollection(ctx context.Context, sess adapter.Session, path, key, label string, rep *adapter.DiscoveryReport) int {
	n, err := a.countCollection(ctx, sess, path, key)
	if err != nil {
		if rep != nil {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s count unavailable: %v", label, err))
		}
		return 0
	}
	return n
}

func (a *Adapter) listOptionalCustomFieldNames(ctx context.Context, sess adapter.Session, rep *adapter.DiscoveryReport) []string {
	names, err := a.listCustomFieldNames(ctx, sess)
	if err != nil {
		if rep != nil {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("custom fields count unavailable: %v", err))
		}
		return nil
	}
	return names
}

func (a *Adapter) listCustomFieldNames(ctx context.Context, sess adapter.Session) ([]string, error) {
	names := []string{}
	seenFieldKeys := map[string]string{}
	offset := 0
	for {
		fields, providerTotal, err := listCollectionPage[acField](a, ctx, sess, fmt.Sprintf("/fields?limit=%d&offset=%d", pageSize, offset), "fields")
		if err != nil {
			return nil, err
		}
		if err := validateActiveCampaignOffsetPage(len(fields), providerTotal, offset); err != nil {
			return nil, err
		}
		for _, f := range fields {
			name := strings.TrimSpace(firstNonEmpty(f.Title, f.Perstag))
			if name == "" {
				name = activeCampaignFieldFallbackName(f.ID)
			}
			names = append(names, uniqueActiveCampaignFieldName(name, f.ID, seenFieldKeys))
		}
		nextOffset := nextActiveCampaignPageOffset(len(fields), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			sort.Strings(names)
			return names, nil
		}
		offset = nextOffset
	}
}

func (a *Adapter) countOptionalSentCampaigns(ctx context.Context, sess adapter.Session, rep *adapter.DiscoveryReport) int {
	n, err := a.countSentCampaigns(ctx, sess)
	if err != nil {
		if rep != nil {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("campaigns count unavailable: %v", err))
		}
		return 0
	}
	return n
}

func (a *Adapter) countSentCampaigns(ctx context.Context, sess adapter.Session) (int, error) {
	total := 0
	offset := 0
	for {
		campaigns, providerTotal, err := listCollectionPage[acCampaign](a, ctx, sess, fmt.Sprintf("/campaigns?limit=%d&offset=%d", pageSize, offset), "campaigns")
		if err != nil {
			return 0, err
		}
		if err := validateActiveCampaignOffsetPage(len(campaigns), providerTotal, offset); err != nil {
			return 0, err
		}
		for _, campaign := range campaigns {
			if campaignWasSent(campaign) {
				total++
			}
		}
		nextOffset := nextActiveCampaignPageOffset(len(campaigns), providerTotal, offset, pageSize)
		if nextOffset == 0 {
			return total, nil
		}
		offset = nextOffset
	}
}

func (a *Adapter) countCollection(ctx context.Context, sess adapter.Session, path, key string) (int, error) {
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		return 0, err
	}
	if n, ok := totalFromRawOK(raw); ok {
		return n, nil
	}
	v := raw[key]
	if len(v) == 0 {
		return 0, fmt.Errorf("response missing %q array and numeric total", key)
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(v, &arr); err != nil {
		return 0, fmt.Errorf("decode %q array: %w", key, err)
	}
	return len(arr), nil
}

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = io.ReadAll(body)
		if err != nil {
			return fmt.Errorf("activecampaign %s %s: read request body: %w", method, path, err)
		}
	}
	base := a.BaseURL
	if base == "" {
		base = sess.Extra["api_url"]
	}
	if base == "" {
		return fmt.Errorf("activecampaign: missing account API URL: %w", adapter.ErrAuth)
	}
	if err := validateActiveCampaignRequestAccountBinding(sess, base, method, path); err != nil {
		return err
	}

	wait := initialBackoff
	for attempt := 0; attempt <= maxRetries; attempt++ {
		limiter := a.limiter
		if limiter == nil {
			limiter = sharedActiveCampaignLimiter(base)
		}
		if err := limiter.Wait(ctx); err != nil {
			return err
		}
		endpoint, err := adapter.BuildURL(base, path)
		if err != nil {
			return fmt.Errorf("activecampaign: build request URL: %w", err)
		}
		var reqBody io.Reader
		if bodyBytes != nil {
			reqBody = bytes.NewReader(bodyBytes)
		}
		req, err := http.NewRequestWithContext(ctx, method, endpoint, reqBody)
		if err != nil {
			return fmt.Errorf("activecampaign: build request: %w", err)
		}
		req.Header.Set("Api-Token", sess.AccessToken)
		req.Header.Set("Accept", "application/json")
		if bodyBytes != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := activeCampaignHTTPClient(a.HTTPClient).Do(req)
		if err != nil {
			return fmt.Errorf("activecampaign %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			retry := parseRetryAfter(resp.Header.Get("Retry-After"))
			_ = resp.Body.Close()
			if attempt < maxRetries {
				if err := sleepCtx(ctx, retry); err != nil {
					return err
				}
				continue
			}
			return &adapter.ErrRateLimited{RetryAfter: retry}
		}
		if resp.StatusCode >= 500 {
			_ = resp.Body.Close()
			if attempt < maxRetries {
				if err := sleepCtx(ctx, wait); err != nil {
					return err
				}
				wait *= 2
				if wait > backoffCap {
					wait = backoffCap
				}
				continue
			}
			return fmt.Errorf("activecampaign %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
			_ = resp.Body.Close()
			return fmt.Errorf("activecampaign %s %s status %d: %s: %w", method, path, resp.StatusCode, string(b), adapter.ErrAuth)
		}
		if resp.StatusCode >= 400 {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
			_ = resp.Body.Close()
			return fmt.Errorf("activecampaign %s %s status %d: %s", method, path, resp.StatusCode, string(b))
		}
		if out == nil {
			if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
				_ = resp.Body.Close()
				return fmt.Errorf("activecampaign %s %s: response body: %w", method, path, err)
			}
			_ = resp.Body.Close()
			return nil
		}
		err = adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
		_ = resp.Body.Close()
		if err != nil {
			return fmt.Errorf("activecampaign %s %s: decode: %w", method, path, err)
		}
		return nil
	}
	return fmt.Errorf("activecampaign %s %s: exhausted retries: %w", method, path, adapter.ErrSourceUnavailable)
}
