// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	maxErrorResponseBodyBytes int64 = 64 << 10
	maxJSONResponseBodyBytes  int64 = 8 << 20
	SelectedAudiencesExtraKey       = "mailchimp_selected_audience_ids"
)

func init() {
	adapter.Register(canonical.SourceMailchimp, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for Mailchimp.
type Adapter struct {
	http *http.Client
	mu   sync.Mutex
	// BaseURL overrides the per-DC URL Mailchimp normally constructs. When
	// non-empty it short-circuits sess.AccountID-derived URL construction. Used
	// only by tests; production code leaves it zero.
	BaseURL string

	staticSegmentTagsByList map[string]map[string][]string
	interestDefsByList      map[string]map[string]mailchimpInterestDefinition
}

// New constructs a Mailchimp adapter. Mailchimp's documented maximum of 10
// simultaneously processing requests per user is enforced by a process-wide,
// account-keyed semaphore in do so separately constructed adapters share it.
func New() *Adapter {
	return &Adapter{
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

// Capabilities advertises Mailchimp's feature support. Mailchimp does not
// natively own paid subs (publishers use Stripe directly outside Mailchimp's
// data model), so paid_subs is false and routed through the Stripe pathway.
func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceMailchimp,
		AuthMethod: "oauth2",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = true
	c.Supports.Automations = true
	c.Supports.AutomationMode = "runtime"
	c.Supports.CampaignArchive = true
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = true
	c.Supports.Campaigns = true
	c.Supports.Reports = true
	c.Supports.Groups = true
	c.Supports.Forms = true
	c.Supports.LandingPages = true
	c.Supports.Ecommerce = true
	return c
}

// Authenticate exchanges an OAuthCode (or trusts an existing AccessToken).
func (a *Adapter) Authenticate(ctx context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.AccessToken != "" && creds.AccountID != "" {
		dc, err := mailchimpDataCenter(creds.AccountID, "")
		if err != nil {
			return adapter.Session{}, err
		}
		sess := adapter.Session{
			AccessToken: creds.AccessToken,
			AccountID:   dc,
			Source:      canonical.SourceMailchimp,
			Extra:       cloneMap(creds.Extra),
		}
		// A caller-supplied fingerprint has not been authenticated yet. Use the
		// hashed credential/data-center fallback for the identity lookup itself;
		// the verified account fingerprint below governs subsequent requests.
		delete(sess.Extra, AccountFingerprintExtraKey)
		rootURL, err := adapter.BuildURL(a.baseURL(sess), "/")
		if err != nil {
			return adapter.Session{}, fmt.Errorf("mailchimp: build account identity URL: %w", err)
		}
		fingerprint, err := fetchMailchimpAccountFingerprint(ctx, a.http, rootURL, sess)
		if err != nil {
			return adapter.Session{}, fmt.Errorf("mailchimp: validate account identity: %w", err)
		}
		if sess.Extra == nil {
			sess.Extra = map[string]string{}
		}
		sess.Extra[AccountFingerprintExtraKey] = fingerprint
		return sess, nil
	}
	if creds.OAuthCode == "" {
		return adapter.Session{}, fmt.Errorf("mailchimp: missing oauth code: %w", adapter.ErrAuth)
	}
	redirect := ""
	if creds.Extra != nil {
		redirect = creds.Extra["redirect_uri"]
	}
	sess, err := ExchangeCode(ctx, creds.OAuthCode, redirect)
	if err != nil {
		return adapter.Session{}, err
	}
	for key, value := range creds.Extra {
		// The account fingerprint is derived from Mailchimp's authenticated API
		// root. It is an identity boundary, not caller-supplied session metadata.
		// Never allow a request extra to replace the value ExchangeCode proved.
		if key == AccountFingerprintExtraKey {
			continue
		}
		if sess.Extra == nil {
			sess.Extra = map[string]string{}
		}
		sess.Extra[key] = value
	}
	return sess, nil
}

// Discover aggregates totals from /lists, /automations, /campaigns.
func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	var rep adapter.DiscoveryReport

	lists, err := a.listAllAudiences(ctx, sess, "lists.id,lists.name,lists.stats.member_count")
	if err != nil {
		return rep, err
	}
	selected := selectedAudienceSet(sess)
	filteredLists, err := filterDiscoveredAudiences(lists, selected)
	if err != nil {
		return rep, err
	}
	for _, l := range filteredLists {
		membersTotal, err := a.discoverCount(ctx, sess, fmt.Sprintf("/lists/%s/members?count=1&fields=total_items", url.PathEscape(l.ID)))
		if err != nil {
			return rep, fmt.Errorf("mailchimp: count all contact states for audience %s: %w", l.ID, err)
		}
		rep.SubscribersTotal += membersTotal
		rep.Audiences = append(rep.Audiences, adapter.DiscoveryAudience{
			ID:               l.ID,
			Name:             l.Name,
			SubscribersTotal: membersTotal,
		})
	}

	// Segments per list.
	for _, l := range filteredLists {
		var segResp struct {
			TotalItems int `json:"total_items"`
		}
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/lists/%s/segments?count=1&fields=total_items", l.ID), nil, &segResp); err == nil {
			rep.SegmentsTotal += segResp.TotalItems
		} else {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Could not count Mailchimp segments for audience %s: %v", l.ID, err))
		}
		if groups, err := a.discoverCount(ctx, sess, fmt.Sprintf("/lists/%s/interest-categories?count=1&fields=total_items", l.ID)); err == nil {
			rep.GroupsTotal += groups
		} else {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Could not count Mailchimp interest categories for audience %s: %v", l.ID, err))
		}
		if fields, err := a.discoverMergeFields(ctx, sess, l.ID); err == nil {
			rep.CustomFields = appendUniqueStrings(rep.CustomFields, fields...)
		} else {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Could not inventory Mailchimp merge fields for audience %s; subscriber values are still preserved as profile attributes during import.", l.ID))
		}
		if forms, err := a.discoverSignupForms(ctx, sess, l.ID); err == nil {
			rep.FormsTotal += forms
		} else {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Could not count Mailchimp signup forms for audience %s; form rebuild scope may be understated.", l.ID))
		}
	}

	var autResp struct {
		TotalItems int `json:"total_items"`
	}
	if len(selected) > 0 {
		if n, unscoped, err := a.discoverSelectedAutomations(ctx, sess, selected); err == nil {
			rep.AutomationsTotal = n
			if unscoped > 0 {
				rep.Warnings = append(rep.Warnings, fmt.Sprintf("Excluded %d Mailchimp Classic Automation(s) without an audience list_id because their ownership could not be proven to match the selected audience(s); review those automations manually before cutover.", unscoped))
			}
		} else {
			rep.Warnings = append(rep.Warnings, "Could not inventory Mailchimp Classic Automations: "+err.Error())
		}
	} else if err := a.do(ctx, sess, http.MethodGet, "/automations?count=1&fields=total_items", nil, &autResp); err == nil {
		rep.AutomationsTotal = autResp.TotalItems
	} else {
		rep.Warnings = append(rep.Warnings, "Could not count Mailchimp Classic Automations: "+err.Error())
	}

	if len(selected) > 0 {
		if n, err := a.discoverSelectedCampaignCount(ctx, sess, selected, "sent"); err == nil {
			rep.ArchiveTotal = n
			rep.ReportsTotal = n
		} else {
			rep.Warnings = append(rep.Warnings, "Could not count sent Mailchimp campaigns for the selected audience(s): "+err.Error())
		}
		if n, err := a.discoverSelectedCampaignCount(ctx, sess, selected, ""); err == nil {
			rep.CampaignsTotal = n
		} else {
			rep.Warnings = append(rep.Warnings, "Could not count Mailchimp campaigns for the selected audience(s): "+err.Error())
		}
		rep.Warnings = append(rep.Warnings,
			"Campaign archives, aggregate reports, and recipient-level report details are restricted to the selected Mailchimp audience(s).",
			"Mailchimp templates, landing pages, and ecommerce stores are account-wide APIs and cannot be filtered by audience; imported objects from those surfaces are explicitly marked for manual review.",
		)
	} else {
		var campResp struct {
			TotalItems int `json:"total_items"`
		}
		if err := a.do(ctx, sess, http.MethodGet, "/campaigns?count=1&status=sent&fields=total_items", nil, &campResp); err == nil {
			rep.ArchiveTotal = campResp.TotalItems
		} else {
			rep.Warnings = append(rep.Warnings, "Could not count sent Mailchimp campaigns: "+err.Error())
		}
		if n, err := a.discoverCount(ctx, sess, "/campaigns?count=1&fields=total_items"); err == nil {
			rep.CampaignsTotal = n
		} else {
			rep.Warnings = append(rep.Warnings, "Could not count Mailchimp campaigns: "+err.Error())
		}
	}
	if n, err := a.discoverCount(ctx, sess, "/templates?count=1&fields=total_items"); err == nil {
		rep.TemplatesTotal = n
	} else {
		rep.Warnings = append(rep.Warnings, "Could not count Mailchimp templates: "+err.Error())
	}
	if len(selected) == 0 {
		if n, err := a.discoverCount(ctx, sess, "/reports?count=1&fields=total_items"); err == nil {
			rep.ReportsTotal = n
		} else {
			rep.Warnings = append(rep.Warnings, "Could not count Mailchimp reports: "+err.Error())
		}
	}
	if n, err := a.discoverCount(ctx, sess, "/landing-pages?count=1&fields=total_items"); err == nil {
		rep.LandingPagesTotal = n
	} else {
		rep.Warnings = append(rep.Warnings, "Could not count Mailchimp landing pages: "+err.Error())
	}
	if n, err := a.discoverCount(ctx, sess, "/ecommerce/stores?count=1&fields=total_items"); err == nil {
		rep.EcommerceTotal = n
	} else {
		rep.Warnings = append(rep.Warnings, "Could not count Mailchimp ecommerce stores: "+err.Error())
	}
	rep.Warnings = append(rep.Warnings,
		"Mailchimp Customer Journeys (Automation Flows) cannot be listed/exported by the Marketing API. One generic, non-detected manual-review gap is emitted; it is not Journey inventory, and only Classic Automations are counted here.",
		"Mailchimp collection pagination is offset-based and is not a transactionally consistent account snapshot. Pause audience, segment, campaign, template, landing-page, and ecommerce changes during the reviewed dry-run and commit, or run and review a fresh dry-run before cutover.",
	)
	return rep, nil
}

// ListSubscribers paginates members across every list. Legacy
// "<list_id>:<offset>" cursors remain accepted; newly emitted cursors carry a
// previous-page checkpoint so a provider that ignores offset cannot loop.
func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	const pageSize = 1000
	const cursorResource = "subscribers"

	// Resolve the cursor.
	listIDs, err := a.listAudienceIDs(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	if len(listIDs) == 0 {
		return nil, "", nil
	}

	curList, curOff := listIDs[0], 0
	pageCursor := mailchimpPageCursor{Version: 1, Resource: cursorResource, Scope: curList}
	if cursor != "" {
		decoded, encoded, decodeErr := decodeMailchimpPageCursor(cursor, cursorResource)
		if decodeErr != nil {
			return nil, "", decodeErr
		}
		if encoded {
			pageCursor = decoded
			curList, curOff = decoded.Scope, decoded.Offset
		} else {
			parts := strings.SplitN(cursor, ":", 2)
			if len(parts) != 2 {
				return nil, "", fmt.Errorf("mailchimp: bad subscriber cursor %q", cursor)
			}
			curList = parts[0]
			curOff, err = strconv.Atoi(parts[1])
			pageCursor.Scope, pageCursor.Offset = curList, curOff
		}
		if err != nil || curOff < 0 || indexOf(listIDs, curList) < 0 {
			return nil, "", fmt.Errorf("mailchimp: bad subscriber cursor %q", cursor)
		}
	}

	var page struct {
		Members    []mcMember `json:"members"`
		TotalItems int        `json:"total_items"`
	}
	endpoint := fmt.Sprintf("/lists/%s/members?count=%d&offset=%d", curList, pageSize, curOff)
	if err := a.do(ctx, sess, http.MethodGet, endpoint, nil, &page); err != nil {
		return nil, "", err
	}
	if err := validatePageCursor("members for audience "+curList, pageCursor, page.Members); err != nil {
		return nil, "", err
	}

	staticTags, err := a.staticSegmentMemberTags(ctx, sess, curList)
	if err != nil {
		return nil, "", err
	}
	var interestDefs map[string]mailchimpInterestDefinition
	if membersHaveActiveInterests(page.Members) {
		interestDefs, err = a.interestDefinitions(ctx, sess, curList)
		if err != nil {
			return nil, "", err
		}
	}

	subs := make([]canonical.Subscriber, 0, len(page.Members))
	for _, m := range page.Members {
		sub := mapMember(m, curList)
		enrichMailchimpMemberGroups(&sub, curList, interestDefs)
		sub.Tags = append(sub.Tags, staticTags[mailchimpMemberKey(m)]...)
		sub.Tags = normalizeTags(sub.Tags)
		subs = append(subs, sub)
	}

	// Decide next cursor.
	next := ""
	done, err := paginationFinished("members for audience "+curList, curOff, len(page.Members), page.TotalItems, pageSize)
	if err != nil {
		return nil, "", err
	}
	if !done {
		next = encodeMailchimpPageCursor(cursorResource, curList, curOff+pageSize, page.Members)
	} else {
		// Move to the next list.
		idx := indexOf(listIDs, curList)
		if idx >= 0 && idx+1 < len(listIDs) {
			next = encodeMailchimpPageCursor(cursorResource, listIDs[idx+1], 0, nil)
		}
	}
	return subs, next, nil
}

// ListSegments returns translated segments across every list.
func (a *Adapter) ListSegments(ctx context.Context, sess adapter.Session) ([]canonical.Segment, error) {
	listIDs, err := a.listAudienceIDs(ctx, sess)
	if err != nil {
		return nil, err
	}
	var out []canonical.Segment
	for _, lid := range listIDs {
		segments, err := a.listAllSegments(ctx, sess, lid)
		if err != nil {
			return nil, err
		}
		for _, s := range segments {
			out = append(out, translateSegment(s, lid))
		}
	}
	return out, nil
}

func (a *Adapter) staticSegmentMemberTags(ctx context.Context, sess adapter.Session, listID string) (map[string][]string, error) {
	a.mu.Lock()
	if a.staticSegmentTagsByList != nil {
		if cached, ok := a.staticSegmentTagsByList[listID]; ok {
			a.mu.Unlock()
			return cached, nil
		}
	}
	a.mu.Unlock()

	tags, err := a.fetchStaticSegmentMemberTags(ctx, sess, listID)
	if err != nil {
		return nil, err
	}

	a.mu.Lock()
	if a.staticSegmentTagsByList == nil {
		a.staticSegmentTagsByList = map[string]map[string][]string{}
	}
	a.staticSegmentTagsByList[listID] = tags
	a.mu.Unlock()
	return tags, nil
}

type mailchimpInterestDefinition struct {
	ID                   string
	Name                 string
	AudienceID           string
	CategoryID           string
	CategoryName         string
	CategoryType         string
	SourceCategoryType   string
	CategoryDisplayOrder int
}

func membersHaveActiveInterests(members []mcMember) bool {
	for _, member := range members {
		for _, active := range member.Interests {
			if active {
				return true
			}
		}
	}
	return false
}

func (a *Adapter) interestDefinitions(ctx context.Context, sess adapter.Session, listID string) (map[string]mailchimpInterestDefinition, error) {
	a.mu.Lock()
	if cached, ok := a.interestDefsByList[listID]; ok {
		a.mu.Unlock()
		return cached, nil
	}
	a.mu.Unlock()

	categories, err := a.listAllInterestCategories(ctx, sess, listID)
	if err != nil {
		return nil, err
	}
	definitions := map[string]mailchimpInterestDefinition{}
	for _, category := range categories {
		interests, err := a.listAllInterests(ctx, sess, listID, category.ID)
		if err != nil {
			return nil, err
		}
		for _, interest := range interests {
			definitions[interest.ID] = mailchimpInterestDefinition{
				ID:                   interest.ID,
				Name:                 interest.Name,
				AudienceID:           listID,
				CategoryID:           category.ID,
				CategoryName:         category.Title,
				CategoryType:         normalizeMailchimpInterestCategoryType(category.Type),
				SourceCategoryType:   strings.TrimSpace(category.Type),
				CategoryDisplayOrder: category.DisplayOrder,
			}
		}
	}

	a.mu.Lock()
	if a.interestDefsByList == nil {
		a.interestDefsByList = map[string]map[string]mailchimpInterestDefinition{}
	}
	a.interestDefsByList[listID] = definitions
	a.mu.Unlock()
	return definitions, nil
}

func enrichMailchimpMemberGroups(sub *canonical.Subscriber, listID string, definitions map[string]mailchimpInterestDefinition) {
	if sub == nil {
		return
	}
	groups, ok := sub.CustomFields["postwave_mailchimp_groups"].([]map[string]interface{})
	if !ok {
		return
	}
	for _, group := range groups {
		if strings.TrimSpace(listID) != "" {
			group["audience_id"] = listID
		}
		id, _ := group["source_id"].(string)
		definition, exists := definitions[id]
		if !exists {
			group["definition_missing"] = true
			continue
		}
		if strings.TrimSpace(definition.Name) != "" {
			group["name"] = definition.Name
		}
		if strings.TrimSpace(definition.CategoryID) != "" {
			group["category_id"] = definition.CategoryID
		}
		if strings.TrimSpace(definition.CategoryName) != "" {
			group["category"] = definition.CategoryName
		}
		if strings.TrimSpace(definition.CategoryType) != "" {
			group["type"] = definition.CategoryType
		}
		if strings.TrimSpace(definition.SourceCategoryType) != "" {
			group["source_category_type"] = definition.SourceCategoryType
		}
		group["display_order"] = definition.CategoryDisplayOrder
		group["category_display_order"] = definition.CategoryDisplayOrder
	}
}

func (a *Adapter) fetchStaticSegmentMemberTags(ctx context.Context, sess adapter.Session, listID string) (map[string][]string, error) {
	segments, err := a.listAllSegments(ctx, sess, listID)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, seg := range segments {
		if !strings.EqualFold(seg.Type, "static") {
			continue
		}
		segmentTag := mailchimpSegmentTag(listID, seg.ID)
		lastSignature := ""
		for offset := 0; ; offset += 1000 {
			var membersResp struct {
				Members    []mcMember `json:"members"`
				TotalItems int        `json:"total_items"`
			}
			path := fmt.Sprintf("/lists/%s/segments/%d/members?count=1000&offset=%d", listID, seg.ID, offset)
			if err := a.do(ctx, sess, http.MethodGet, path, nil, &membersResp); err != nil {
				return nil, fmt.Errorf("mailchimp: list static segment %d members for list %s: %w", seg.ID, listID, err)
			}
			if err := ensurePaginationAdvanced(fmt.Sprintf("static segment %d members for audience %s", seg.ID, listID), offset, len(membersResp.Members), mailchimpMaxPageSize, membersResp.Members, &lastSignature); err != nil {
				return nil, err
			}
			for _, member := range membersResp.Members {
				key := mailchimpMemberKey(member)
				if key == "" {
					continue
				}
				out[key] = append(out[key], segmentTag)
			}
			done, err := paginationFinished(fmt.Sprintf("static segment %d members for audience %s", seg.ID, listID), offset, len(membersResp.Members), membersResp.TotalItems, mailchimpMaxPageSize)
			if err != nil {
				return nil, err
			}
			if done {
				break
			}
		}
	}
	for key, tags := range out {
		out[key] = normalizeTags(tags)
	}
	return out, nil
}

// ListAutomations returns translated Mailchimp Classic Automations. The
// Marketing API does not expose Customer Journey/Automation Flow graph export;
// that limitation is emitted explicitly by ListSourceArchive instead of
// probing undocumented endpoints or pretending a Journey was imported.
func (a *Adapter) ListAutomations(ctx context.Context, sess adapter.Session) ([]canonical.Automation, error) {
	automations, err := a.listAllClassicAutomations(ctx, sess)
	if err != nil {
		return nil, err
	}
	selected := selectedAudienceSet(sess)
	out := make([]canonical.Automation, 0, len(automations))
	for _, au := range automations {
		if len(selected) > 0 && !automationMatchesSelectedAudience(au, selected) {
			continue
		}
		// Pull the email steps for each automation.
		emails, err := a.listAllClassicAutomationEmails(ctx, sess, au.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, translateAutomation(au, emails))
	}
	return out, nil
}

// ListCampaignArchive paginates sent campaigns. When audiences were selected,
// it traverses each audience with Mailchimp's list_id filter and only then
// fetches campaign content/report PII. Legacy numeric cursors remain accepted;
// new cursors include audience scope and a repeated-page checkpoint.
func (a *Adapter) ListCampaignArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.CampaignArchive, string, error) {
	const pageSize = 1000
	const cursorResource = "campaign_archive"
	scopes := selectedAudienceIDs(sess)
	if len(scopes) == 0 {
		scopes = []string{""}
	}
	currentScope := scopes[0]
	offset := 0
	pageCursor := mailchimpPageCursor{Version: 1, Resource: cursorResource, Scope: currentScope}
	if cursor != "" {
		decoded, encoded, err := decodeMailchimpPageCursor(cursor, cursorResource)
		if err != nil {
			return nil, "", err
		}
		if encoded {
			pageCursor, currentScope, offset = decoded, decoded.Scope, decoded.Offset
		} else {
			offset, err = strconv.Atoi(cursor)
			pageCursor.Offset = offset
		}
		if err != nil || offset < 0 || indexOf(scopes, currentScope) < 0 {
			return nil, "", fmt.Errorf("mailchimp: bad campaign archive cursor %q", cursor)
		}
	}
	var page struct {
		Campaigns  []mcCampaign `json:"campaigns"`
		TotalItems int          `json:"total_items"`
	}
	path := fmt.Sprintf("/campaigns?count=%d&offset=%d&status=sent", pageSize, offset)
	if currentScope != "" {
		path += "&list_id=" + url.QueryEscape(currentScope)
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
		return nil, "", err
	}
	if err := validatePageCursor("sent campaigns for audience "+firstNonEmpty(currentScope, "account-wide"), pageCursor, page.Campaigns); err != nil {
		return nil, "", err
	}

	out := make([]canonical.CampaignArchive, 0, len(page.Campaigns))
	seenPageIDs := map[string]struct{}{}
	for _, c := range page.Campaigns {
		if _, duplicate := seenPageIDs[c.ID]; duplicate {
			continue
		}
		seenPageIDs[c.ID] = struct{}{}
		if currentScope != "" && strings.TrimSpace(c.Recipients.ListID) != currentScope {
			// Never follow an out-of-scope campaign ID into content or report
			// endpoints, even if Mailchimp returns it despite list_id filtering.
			continue
		}
		warnings := []string{}
		var content struct {
			HTML      string `json:"html"`
			PlainText string `json:"plain_text"`
		}
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/campaigns/%s/content", c.ID), nil, &content); err != nil {
			warnings = append(warnings, "campaign content fetch failed: "+err.Error())
		} else if strings.TrimSpace(content.HTML) == "" && strings.TrimSpace(content.PlainText) == "" {
			warnings = append(warnings, "campaign content response was empty")
		}

		var report mcCampaignReport
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/reports/%s", c.ID), nil, &report); err != nil {
			warnings = append(warnings, "campaign aggregate report fetch failed: "+err.Error())
		} else if len(report.Raw) == 0 {
			warnings = append(warnings, "campaign aggregate report response was empty")
		}
		if report.Raw == nil {
			report.Raw = map[string]interface{}{}
		}
		if currentScope != "" {
			report.Raw["postwave_mailchimp_audience_scope"] = currentScope
		}
		warnings = append(warnings, a.enrichCampaignReport(ctx, sess, c.ID, report.Raw)...)
		if len(warnings) > 0 {
			report.Raw["postwave_warnings"] = warnings
		}

		sentAt := parseMailchimpTime(c.SendTime)
		out = append(out, canonical.CampaignArchive{
			SourceID:        c.ID,
			Subject:         c.Settings.SubjectLine,
			HTML:            content.HTML,
			Text:            content.PlainText,
			SentAt:          sentAt,
			RecipientsCount: c.EmailsSent,
			Opens:           report.Opens.UniqueOpens,
			Clicks:          report.Clicks.UniqueClicks,
			Report:          report.Raw,
			Warnings:        warnings,
			SourcePlatform:  canonical.SourceMailchimp,
		})
	}

	done, err := paginationFinished("sent campaigns", offset, len(page.Campaigns), page.TotalItems, pageSize)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if !done {
		next = encodeMailchimpPageCursor(cursorResource, currentScope, offset+pageSize, page.Campaigns)
	} else if scopeIndex := indexOf(scopes, currentScope); scopeIndex >= 0 && scopeIndex+1 < len(scopes) {
		next = encodeMailchimpPageCursor(cursorResource, scopes[scopeIndex+1], 0, nil)
	}
	return out, next, nil
}

func (a *Adapter) enrichCampaignReport(ctx context.Context, sess adapter.Session, campaignID string, report map[string]interface{}) []string {
	warnings := []string{}
	type detailEndpoint struct {
		key         string
		path        string
		collections []string
	}
	for _, endpoint := range []detailEndpoint{
		{key: "email_activity", path: "email-activity", collections: []string{"emails"}},
		{key: "click_details", path: "click-details", collections: []string{"urls_clicked", "clicks", "links"}},
		{key: "open_details", path: "open-details", collections: []string{"opens"}},
		{key: "sent_to", path: "sent-to", collections: []string{"sent_to", "members"}},
		{key: "unsubscribed", path: "unsubscribed", collections: []string{"unsubscribes", "unsubscribed"}},
		{key: "abuse_reports", path: "abuse-reports", collections: []string{"abuse_reports"}},
		{key: "locations", path: "locations", collections: []string{"locations"}},
		{key: "domain_performance", path: "domain-performance", collections: []string{"domains"}},
	} {
		payload, err := a.fetchAllMapCollection(ctx, sess, "campaign "+campaignID+" "+endpoint.key, func(offset int) string {
			return fmt.Sprintf("/reports/%s/%s?count=%d&offset=%d", campaignID, endpoint.path, mailchimpMaxPageSize, offset)
		}, endpoint.collections...)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s fetch failed: %v", endpoint.key, err))
			continue
		}
		if len(payload) > 0 {
			report[endpoint.key] = payload
		}
	}
	for _, endpoint := range []detailEndpoint{{key: "advice", path: "advice"}, {key: "eepurl", path: "eepurl"}} {
		var payload map[string]interface{}
		path := fmt.Sprintf("/reports/%s/%s", campaignID, endpoint.path)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &payload); err != nil {
			warnings = append(warnings, fmt.Sprintf("%s fetch failed: %v", endpoint.key, err))
		} else if len(payload) > 0 {
			report[endpoint.key] = payload
		}
	}
	clicks, _ := report["click_details"].(map[string]interface{})
	clickItems := firstAny(clicks, "urls_clicked", "clicks", "links")
	clickList, _ := clickItems.([]interface{})
	memberDetails := map[string]interface{}{}
	for _, item := range clickList {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		linkID := firstString(m, "id", "link_id")
		if linkID == "" {
			continue
		}
		members, err := a.fetchAllMapCollection(ctx, sess, "campaign "+campaignID+" click members "+linkID, func(offset int) string {
			return fmt.Sprintf("/reports/%s/click-details/%s/members?count=%d&offset=%d", campaignID, linkID, mailchimpMaxPageSize, offset)
		}, "members")
		if err == nil && len(members) > 0 {
			memberDetails[linkID] = members
		} else if err != nil {
			warnings = append(warnings, fmt.Sprintf("click_members %s fetch failed: %v", linkID, err))
		}
	}
	if len(memberDetails) > 0 {
		report["click_members"] = memberDetails
	}
	return warnings
}

// ListTemplates imports editable Mailchimp templates by pairing the template
// inventory with each template's default editable section content.
func (a *Adapter) ListTemplates(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.EmailTemplate, string, error) {
	const pageSize = 100
	const cursorResource = "templates"
	offset := 0
	pageCursor := mailchimpPageCursor{Version: 1, Resource: cursorResource}
	if cursor != "" {
		decoded, encoded, err := decodeMailchimpPageCursor(cursor, cursorResource)
		if err != nil {
			return nil, "", err
		}
		if encoded {
			pageCursor, offset = decoded, decoded.Offset
		} else {
			offset, err = strconv.Atoi(cursor)
			pageCursor.Offset = offset
		}
		if err != nil || offset < 0 {
			return nil, "", fmt.Errorf("mailchimp: bad template cursor %q", cursor)
		}
	}
	var page struct {
		Templates  []mcTemplate `json:"templates"`
		TotalItems int          `json:"total_items"`
	}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/templates?count=%d&offset=%d", pageSize, offset), nil, &page); err != nil {
		return nil, "", err
	}
	if err := validatePageCursor("templates", pageCursor, page.Templates); err != nil {
		return nil, "", err
	}

	out := make([]canonical.EmailTemplate, 0, len(page.Templates))
	accountWideWarning := "Mailchimp templates are account-wide and cannot be filtered to the selected audience(s); this template was imported for manual review and must not be assumed audience-scoped."
	hasSelectedAudiences := len(selectedAudienceSet(sess)) > 0
	for _, tpl := range page.Templates {
		var content mcTemplateDefaultContent
		warnings := []string{}
		if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/templates/%d/default-content", tpl.ID), nil, &content); err != nil {
			warnings = append(warnings, "template default content fetch failed: "+err.Error())
		}
		if hasSelectedAudiences {
			warnings = append(warnings, accountWideWarning)
		}
		out = append(out, translateTemplate(tpl, content, warnings...))
	}

	done, err := paginationFinished("templates", offset, len(page.Templates), page.TotalItems, pageSize)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if !done {
		next = encodeMailchimpPageCursor(cursorResource, "", offset+pageSize, page.Templates)
	}
	return out, next, nil
}

// ListPaidSubs returns nothing — Mailchimp does not own Stripe data. The
// Stripe pathway (services/migration/...substack) handles paid subs.
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, nil
}

// --- helpers ---

type mcAudienceSummary struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Stats struct {
		MemberCount int `json:"member_count"`
	} `json:"stats"`
}

func (a *Adapter) baseURL(sess adapter.Session) string {
	if a.BaseURL != "" {
		return a.BaseURL
	}
	return fmt.Sprintf("https://%s.api.mailchimp.com/3.0", sess.AccountID)
}

func (a *Adapter) do(ctx context.Context, sess adapter.Session, method, path string, body io.Reader, out interface{}) error {
	release, err := mailchimpRequestLimiters.acquire(ctx, mailchimpRequestLimiterKey(sess))
	if err != nil {
		return err
	}
	defer release()

	endpoint, err := adapter.BuildURL(a.baseURL(sess), path)
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("mailchimp %s %s: %w: %w", method, path, adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusTooManyRequests {
		retry := parseRetryAfter(resp.Header.Get("X-Retry-After"), resp.Header.Get("Retry-After"))
		return &adapter.ErrRateLimited{RetryAfter: retry}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("mailchimp %s %s: %w", method, path, adapter.ErrAuth)
	}
	if resp.StatusCode >= 500 {
		return fmt.Errorf("mailchimp %s %s status %d: %w", method, path, resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorResponseBodyBytes))
		return fmt.Errorf("mailchimp %s %s status %d: %s", method, path, resp.StatusCode, string(b))
	}
	if out == nil {
		if err := adapter.DiscardResponse(resp, maxJSONResponseBodyBytes); err != nil {
			return fmt.Errorf("mailchimp %s %s: response body: %w", method, path, err)
		}
		return nil
	}
	return adapter.DecodeJSONResponse(resp, maxJSONResponseBodyBytes, out)
}

func (a *Adapter) discoverCount(ctx context.Context, sess adapter.Session, path string) (int, error) {
	var resp struct {
		TotalItems int `json:"total_items"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &resp); err != nil {
		return 0, err
	}
	return resp.TotalItems, nil
}

func (a *Adapter) discoverMergeFields(ctx context.Context, sess adapter.Session, listID string) ([]string, error) {
	type mergeField struct {
		Tag  string `json:"tag"`
		Name string `json:"name"`
	}
	var fields []string
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			MergeFields []mergeField `json:"merge_fields"`
			Fields      []mergeField `json:"fields"`
			TotalItems  int          `json:"total_items"`
		}
		path := fmt.Sprintf("/lists/%s/merge-fields?count=%d&offset=%d&fields=total_items,merge_fields.tag,merge_fields.name", listID, mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, err
		}
		items := append(page.MergeFields, page.Fields...)
		for _, f := range items {
			name := strings.TrimSpace(f.Tag)
			if name == "" {
				name = strings.TrimSpace(f.Name)
			}
			if name == "" {
				continue
			}
			fields = appendUniqueStrings(fields, name)
		}
		done, err := paginationFinished("merge fields for audience "+listID, offset, len(items), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return fields, nil
		}
	}
}

func (a *Adapter) discoverSignupForms(ctx context.Context, sess adapter.Session, listID string) (int, error) {
	var resp struct {
		Forms      []map[string]interface{} `json:"forms"`
		TotalItems int                      `json:"total_items"`
	}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/lists/%s/signup-forms", listID), nil, &resp); err != nil {
		return 0, err
	}
	if resp.TotalItems > 0 {
		return resp.TotalItems, nil
	}
	return len(resp.Forms), nil
}

func appendUniqueStrings(dst []string, values ...string) []string {
	seen := make(map[string]struct{}, len(dst)+len(values))
	for _, existing := range dst {
		seen[existing] = struct{}{}
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		dst = append(dst, value)
	}
	return dst
}

// parseMailchimpTime tolerates the handful of timestamp formats Mailchimp's
// API has shipped over the years (RFC3339 with and without fractional
// seconds, plus the older "YYYY-MM-DD HH:MM:SS" used in member endpoints).
func parseMailchimpTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func parseRetryAfter(values ...string) time.Duration {
	for _, v := range values {
		if v == "" {
			continue
		}
		if secs, err := strconv.Atoi(v); err == nil {
			return time.Duration(secs) * time.Second
		}
		if t, err := http.ParseTime(v); err == nil {
			d := time.Until(t)
			if d > 0 {
				return d
			}
		}
	}
	return 5 * time.Second
}

func (a *Adapter) listAllAudiences(ctx context.Context, sess adapter.Session, fields string) ([]mcAudienceSummary, error) {
	var out []mcAudienceSummary
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Lists      []mcAudienceSummary `json:"lists"`
			TotalItems int                 `json:"total_items"`
		}
		path := fmt.Sprintf("/lists?count=%d", mailchimpMaxPageSize)
		if strings.TrimSpace(fields) != "" {
			path += "&fields=" + fields
		}
		path += fmt.Sprintf("&offset=%d", offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list audiences page at offset %d: %w", offset, err)
		}
		if err := ensurePaginationAdvanced("audiences", offset, len(page.Lists), mailchimpMaxPageSize, page.Lists, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Lists...)
		done, err := paginationFinished("audiences", offset, len(page.Lists), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

func (a *Adapter) listAllSegments(ctx context.Context, sess adapter.Session, listID string) ([]mcSegment, error) {
	var out []mcSegment
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Segments   []mcSegment `json:"segments"`
			TotalItems int         `json:"total_items"`
		}
		path := fmt.Sprintf("/lists/%s/segments?count=%d&offset=%d", listID, mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list segments for audience %s at offset %d: %w", listID, offset, err)
		}
		if err := ensurePaginationAdvanced("segments for audience "+listID, offset, len(page.Segments), mailchimpMaxPageSize, page.Segments, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Segments...)
		done, err := paginationFinished("segments for audience "+listID, offset, len(page.Segments), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

type mcInterestCategory struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Type         string `json:"type"`
	DisplayOrder int    `json:"display_order"`
}

func normalizeMailchimpInterestCategoryType(categoryType string) string {
	switch strings.ToLower(strings.TrimSpace(categoryType)) {
	case "checkbox", "checkboxes":
		return "checkbox"
	case "radio", "dropdown", "hidden":
		return strings.ToLower(strings.TrimSpace(categoryType))
	default:
		return "checkbox"
	}
}

type mcInterest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (a *Adapter) listAllInterestCategories(ctx context.Context, sess adapter.Session, listID string) ([]mcInterestCategory, error) {
	var out []mcInterestCategory
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Categories []mcInterestCategory `json:"categories"`
			TotalItems int                  `json:"total_items"`
		}
		path := fmt.Sprintf("/lists/%s/interest-categories?count=%d&offset=%d", listID, mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list interest categories for audience %s at offset %d: %w", listID, offset, err)
		}
		if err := ensurePaginationAdvanced("interest categories for audience "+listID, offset, len(page.Categories), mailchimpMaxPageSize, page.Categories, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Categories...)
		done, err := paginationFinished("interest categories for audience "+listID, offset, len(page.Categories), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

func (a *Adapter) listAllInterests(ctx context.Context, sess adapter.Session, listID, categoryID string) ([]mcInterest, error) {
	var out []mcInterest
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Interests  []mcInterest `json:"interests"`
			TotalItems int          `json:"total_items"`
		}
		path := fmt.Sprintf("/lists/%s/interest-categories/%s/interests?count=%d&offset=%d", listID, categoryID, mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list interests for audience %s category %s at offset %d: %w", listID, categoryID, offset, err)
		}
		if err := ensurePaginationAdvanced("interests for audience "+listID+" category "+categoryID, offset, len(page.Interests), mailchimpMaxPageSize, page.Interests, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Interests...)
		done, err := paginationFinished("interests for audience "+listID+" category "+categoryID, offset, len(page.Interests), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

func (a *Adapter) listAllClassicAutomations(ctx context.Context, sess adapter.Session) ([]mcAutomation, error) {
	var out []mcAutomation
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Automations []mcAutomation `json:"automations"`
			TotalItems  int            `json:"total_items"`
		}
		path := fmt.Sprintf("/automations?count=%d&offset=%d", mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list Classic Automations page at offset %d: %w", offset, err)
		}
		if err := ensurePaginationAdvanced("Classic Automations", offset, len(page.Automations), mailchimpMaxPageSize, page.Automations, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Automations...)
		done, err := paginationFinished("Classic Automations", offset, len(page.Automations), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

func (a *Adapter) listAllClassicAutomationEmails(ctx context.Context, sess adapter.Session, automationID string) ([]mcAutomationEmail, error) {
	var out []mcAutomationEmail
	lastSignature := ""
	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page struct {
			Emails     []mcAutomationEmail `json:"emails"`
			TotalItems int                 `json:"total_items"`
		}
		path := fmt.Sprintf("/automations/%s/emails?count=%d&offset=%d", automationID, mailchimpMaxPageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: list email steps for Classic Automation %s at offset %d: %w", automationID, offset, err)
		}
		if err := ensurePaginationAdvanced("email steps for Classic Automation "+automationID, offset, len(page.Emails), mailchimpMaxPageSize, page.Emails, &lastSignature); err != nil {
			return nil, err
		}
		out = append(out, page.Emails...)
		done, err := paginationFinished("email steps for Classic Automation "+automationID, offset, len(page.Emails), page.TotalItems, mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			return out, nil
		}
	}
}

func (a *Adapter) listAudienceIDs(ctx context.Context, sess adapter.Session) ([]string, error) {
	lists, err := a.listAllAudiences(ctx, sess, "lists.id")
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(lists))
	for i, l := range lists {
		ids[i] = l.ID
	}
	ids, err = filterAudienceIDs(ids, selectedAudienceSet(sess))
	if err != nil {
		return nil, err
	}
	sort.Strings(ids)
	return ids, nil
}

func selectedAudienceSet(sess adapter.Session) map[string]struct{} {
	if len(sess.Extra) == 0 {
		return nil
	}
	raw := sess.Extra[SelectedAudiencesExtraKey]
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	set := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		set[id] = struct{}{}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

func selectedAudienceIDs(sess adapter.Session) []string {
	selected := selectedAudienceSet(sess)
	ids := make([]string, 0, len(selected))
	for id := range selected {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func filterDiscoveredAudiences(lists []mcAudienceSummary, selected map[string]struct{}) ([]mcAudienceSummary, error) {
	if len(selected) == 0 {
		return lists, nil
	}
	out := make([]mcAudienceSummary, 0, len(selected))
	seen := map[string]struct{}{}
	for _, list := range lists {
		if _, ok := selected[list.ID]; !ok {
			continue
		}
		out = append(out, list)
		seen[list.ID] = struct{}{}
	}
	if len(seen) != len(selected) {
		return nil, fmt.Errorf("mailchimp: selected audience id(s) not found: %s", missingAudienceIDs(selected, seen))
	}
	return out, nil
}

func filterAudienceIDs(ids []string, selected map[string]struct{}) ([]string, error) {
	if len(selected) == 0 {
		return ids, nil
	}
	out := make([]string, 0, len(selected))
	seen := map[string]struct{}{}
	for _, id := range ids {
		if _, ok := selected[id]; !ok {
			continue
		}
		out = append(out, id)
		seen[id] = struct{}{}
	}
	if len(seen) != len(selected) {
		return nil, fmt.Errorf("mailchimp: selected audience id(s) not found: %s", missingAudienceIDs(selected, seen))
	}
	return out, nil
}

func missingAudienceIDs(want, seen map[string]struct{}) string {
	missing := make([]string, 0, len(want))
	for id := range want {
		if _, ok := seen[id]; !ok {
			missing = append(missing, id)
		}
	}
	sort.Strings(missing)
	return strings.Join(missing, ", ")
}

func (a *Adapter) discoverSelectedAutomations(ctx context.Context, sess adapter.Session, selected map[string]struct{}) (int, int, error) {
	const pageSize = 1000
	total := 0
	unscoped := 0
	lastSignature := ""
	for offset := 0; ; offset += pageSize {
		var page struct {
			Automations []mcAutomation `json:"automations"`
			TotalItems  int            `json:"total_items"`
		}
		path := fmt.Sprintf("/automations?count=%d&offset=%d&fields=automations.id,automations.recipients.list_id,automations.trigger_settings.list_id", pageSize, offset)
		if err := a.do(ctx, sess, http.MethodGet, path, nil, &page); err != nil {
			return 0, 0, err
		}
		if err := ensurePaginationAdvanced("selected Classic Automations", offset, len(page.Automations), pageSize, page.Automations, &lastSignature); err != nil {
			return 0, 0, err
		}
		for _, au := range page.Automations {
			if automationAudienceID(au) == "" {
				unscoped++
				continue
			}
			if automationMatchesSelectedAudience(au, selected) {
				total++
			}
		}
		done, err := paginationFinished("selected Classic Automations", offset, len(page.Automations), page.TotalItems, pageSize)
		if err != nil {
			return 0, 0, err
		}
		if done {
			return total, unscoped, nil
		}
	}
}

func (a *Adapter) discoverSelectedCampaignCount(ctx context.Context, sess adapter.Session, selected map[string]struct{}, status string) (int, error) {
	ids := make([]string, 0, len(selected))
	for id := range selected {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	total := 0
	for _, listID := range ids {
		path := "/campaigns?count=1&list_id=" + url.QueryEscape(listID) + "&fields=total_items"
		if status != "" {
			path += "&status=" + url.QueryEscape(status)
		}
		count, err := a.discoverCount(ctx, sess, path)
		if err != nil {
			return 0, fmt.Errorf("audience %s: %w", listID, err)
		}
		total += count
	}
	return total, nil
}

func automationMatchesSelectedAudience(au mcAutomation, selected map[string]struct{}) bool {
	if len(selected) == 0 {
		return true
	}
	lid := automationAudienceID(au)
	if lid == "" {
		return false
	}
	_, ok := selected[lid]
	return ok
}

func automationAudienceID(au mcAutomation) string {
	if listID := strings.TrimSpace(au.Recipients.ListID); listID != "" {
		return listID
	}
	return strings.TrimSpace(au.TriggerSettings.ListID)
}

func indexOf(xs []string, s string) int {
	for i, x := range xs {
		if x == s {
			return i
		}
	}
	return -1
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
