// SPDX-License-Identifier: MIT

package klaviyo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"sort"
	"strings"
	"unicode"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	profilePageSize    = 50
	membershipPageSize = 100
	listPageSize       = 10
	segmentPageSize    = 10
	flowPageSize       = 50
	campaignPageSize   = 100
	formPageSize       = 100
	templatePageSize   = 10
)

type klaviyoSnapshot struct {
	Lists                 []kvResource
	Segments              []kvResource
	Flows                 []kvResource
	Forms                 []kvResource
	NonSentCampaigns      []campaignRebuildEvidence
	NonEmailSentCampaigns []campaignRebuildEvidence
	TagsByProfile         map[string][]string
	SuppressedListTags    map[string]map[string]struct{}
	MembershipCounts      map[string]int
	EmailProfileIDs       map[string]struct{}
	AllProfileIDs         map[string]struct{}
	EmailProfiles         int
	ProfilesWithoutEmail  int
	SentCampaigns         int
	SentSMSCampaigns      int
	SentPushCampaigns     int
	SentCampaignIDs       map[string]struct{}
	Templates             int
	EditableTemplateIDs   map[string]struct{}
	RebuildTemplates      []kvTemplate
	CustomFields          []string
	Warnings              []string
	CampaignTagsPresent   bool
}

func (a *Adapter) ensureSnapshot(ctx context.Context, sess adapter.Session) (*klaviyoSnapshot, error) {
	if err := validateSession(sess); err != nil {
		return nil, err
	}
	key := AccountFingerprint(sess)
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	if cached := a.snapshots[key]; cached != nil {
		return cached, nil
	}

	snapshot := &klaviyoSnapshot{
		TagsByProfile:       make(map[string][]string),
		SuppressedListTags:  make(map[string]map[string]struct{}),
		MembershipCounts:    make(map[string]int),
		EmailProfileIDs:     make(map[string]struct{}),
		AllProfileIDs:       make(map[string]struct{}),
		SentCampaignIDs:     make(map[string]struct{}),
		EditableTemplateIDs: make(map[string]struct{}),
	}
	profiles, err := listAllJSONAPI[kvProfile](ctx, a, sess, "profiles", "/profiles", url.Values{
		"additional-fields[profile]": {"subscriptions,predictive_analytics"},
		"sort":                       {"id"},
	}, profilePageSize, func(profile kvProfile) (string, error) {
		if profile.Type != "profile" || !validProviderID(profile.ID) {
			return "", fmt.Errorf("klaviyo profiles returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
		}
		return profile.ID, nil
	})
	if err != nil {
		return nil, fmt.Errorf("klaviyo discover profiles: %w", err)
	}
	customFields := map[string]struct{}{"klaviyo": {}}
	for _, profile := range profiles {
		snapshot.AllProfileIDs[profile.ID] = struct{}{}
		email := strings.TrimSpace(profile.Attributes.Email)
		if email == "" {
			snapshot.ProfilesWithoutEmail++
			continue
		}
		if _, err := mapProfile(profile, nil); err != nil {
			return nil, fmt.Errorf("klaviyo discover profile %q: %w", profile.ID, err)
		}
		suppressed, suppressErr := profileSuppressedListTags(profile)
		if suppressErr != nil {
			return nil, fmt.Errorf("klaviyo discover profile %q list suppressions: %w", profile.ID, suppressErr)
		}
		if len(suppressed) > 0 {
			snapshot.SuppressedListTags[profile.ID] = suppressed
		}
		snapshot.EmailProfiles++
		snapshot.EmailProfileIDs[profile.ID] = struct{}{}
		for key, value := range map[string]string{
			"first_name":   profile.Attributes.FirstName,
			"last_name":    profile.Attributes.LastName,
			"phone":        profile.Attributes.Phone,
			"organization": profile.Attributes.Organization,
		} {
			if strings.TrimSpace(value) != "" {
				customFields[key] = struct{}{}
			}
		}
		if strings.TrimSpace(profile.Attributes.FirstName+profile.Attributes.LastName) != "" {
			customFields["name"] = struct{}{}
		}
	}
	if snapshot.ProfilesWithoutEmail > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf(
			"%d Klaviyo profiles have no email address and are excluded from the email-subscriber import; their phone, push, or external-ID identities require a separate channel migration.",
			snapshot.ProfilesWithoutEmail,
		))
	}
	for field := range customFields {
		snapshot.CustomFields = append(snapshot.CustomFields, field)
	}
	sort.Strings(snapshot.CustomFields)

	snapshot.Lists, err = a.listResources(ctx, sess, "lists", "/lists", listPageSize, "list")
	if err != nil {
		return nil, err
	}
	snapshot.Segments, err = a.listResources(ctx, sess, "segments", "/segments", segmentPageSize, "segment")
	if err != nil {
		return nil, err
	}

	evidence := 0
	for _, audience := range snapshot.Lists {
		tag := listMembershipTag(audience.ID)
		count, membershipErr := a.snapshotAudienceMembership(ctx, sess, "list", audience.ID, tag, snapshot, &evidence)
		if membershipErr != nil {
			return nil, membershipErr
		}
		snapshot.MembershipCounts[tag] = count
	}
	for _, audience := range snapshot.Segments {
		tag := segmentMembershipTag(audience.ID)
		count, membershipErr := a.snapshotAudienceMembership(ctx, sess, "segment", audience.ID, tag, snapshot, &evidence)
		if membershipErr != nil {
			return nil, membershipErr
		}
		snapshot.MembershipCounts[tag] = count
	}
	for id, tags := range snapshot.TagsByProfile {
		snapshot.TagsByProfile[id] = uniqueStrings(tags)
	}

	// Flow names are nullable in Klaviyo's stable schema. Preserve unnamed
	// flows by identity and assign a deterministic display fallback later.
	snapshot.Flows, err = a.listResourcesWithSort(ctx, sess, "flows", "/flows", flowPageSize, "flow", "id", false)
	if err != nil {
		return nil, err
	}
	for i, flow := range snapshot.Flows {
		detail, detailErr := a.getFlowDefinition(ctx, sess, flow.ID)
		if detailErr != nil {
			return nil, detailErr
		}
		snapshot.Flows[i] = detail
	}
	// The Forms API does not accept sort=id. Use its documented stable
	// chronological sort instead of the ID sort supported by lists, segments,
	// and flows.
	snapshot.Forms, err = a.listResourcesWithSort(ctx, sess, "forms", "/forms", formPageSize, "form", "created_at", true)
	if err != nil {
		return nil, err
	}
	templates, err := listAllJSONAPI[kvTemplate](ctx, a, sess, "templates", "/templates", url.Values{
		"additional-fields[template]": {"definition"},
		"sort":                        {"id"},
	}, templatePageSize, func(template kvTemplate) (string, error) {
		if template.Type != "template" || !validProviderID(template.ID) || strings.TrimSpace(template.Attributes.Name) == "" {
			return "", fmt.Errorf("klaviyo templates returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
		}
		return template.ID, nil
	})
	if err != nil {
		return nil, fmt.Errorf("klaviyo discover templates: %w", err)
	}
	for _, template := range templates {
		if strings.TrimSpace(template.Attributes.HTML) == "" {
			snapshot.RebuildTemplates = append(snapshot.RebuildTemplates, template)
			continue
		}
		snapshot.Templates++
		snapshot.EditableTemplateIDs[template.ID] = struct{}{}
	}

	seenCampaigns := map[string]struct{}{}
	for _, channel := range []string{"email", "sms", "mobile_push"} {
		campaigns, campaignErr := listAllJSONAPI[kvCampaign](ctx, a, sess, "campaigns ("+channel+")", "/campaigns", url.Values{
			"filter": {"equals(messages.channel,'" + channel + "')"},
			"sort":   {"id"},
		}, campaignPageSize, func(campaign kvCampaign) (string, error) {
			if campaign.Type != "campaign" || !validProviderID(campaign.ID) || strings.TrimSpace(campaign.Attributes.Name) == "" || strings.TrimSpace(campaign.Attributes.Status) == "" {
				return "", fmt.Errorf("klaviyo campaigns returned an incomplete identity: %w", adapter.ErrSourceUnavailable)
			}
			return campaign.ID, nil
		})
		if campaignErr != nil {
			return nil, fmt.Errorf("klaviyo discover %s campaigns: %w", channel, campaignErr)
		}
		for _, campaign := range campaigns {
			if err := validateCampaignTagRelationships(campaign); err != nil {
				return nil, err
			}
			if len(campaign.Relationships.Tags.Data) > 0 {
				snapshot.CampaignTagsPresent = true
			}
			if _, duplicate := seenCampaigns[campaign.ID]; duplicate {
				return nil, fmt.Errorf("klaviyo campaign %q appeared in multiple channel inventories: %w", campaign.ID, adapter.ErrSourceUnavailable)
			}
			seenCampaigns[campaign.ID] = struct{}{}
			if campaignIsSent(campaign) {
				if channel == "email" {
					snapshot.SentCampaigns++
					snapshot.SentCampaignIDs[campaign.ID] = struct{}{}
					continue
				}
				messages, messageErr := a.getCampaignMessages(ctx, sess, campaign, channel)
				if messageErr != nil {
					return nil, fmt.Errorf("klaviyo preserve sent %s campaign %q: %w", channel, campaign.ID, messageErr)
				}
				snapshot.NonEmailSentCampaigns = append(snapshot.NonEmailSentCampaigns, campaignRebuildEvidence{
					Campaign: campaign,
					Channel:  channel,
					Messages: messages,
				})
				if channel == "sms" {
					snapshot.SentSMSCampaigns++
				} else {
					snapshot.SentPushCampaigns++
				}
			} else {
				messages, messageErr := a.getCampaignMessages(ctx, sess, campaign, channel)
				if messageErr != nil {
					return nil, fmt.Errorf("klaviyo preserve non-sent campaign %q: %w", campaign.ID, messageErr)
				}
				snapshot.NonSentCampaigns = append(snapshot.NonSentCampaigns, campaignRebuildEvidence{
					Campaign: campaign,
					Channel:  channel,
					Messages: messages,
				})
			}
		}
	}

	a.snapshots[key] = snapshot
	return snapshot, nil
}

func (a *Adapter) getFlowDefinition(ctx context.Context, sess adapter.Session, id string) (kvResource, error) {
	query := url.Values{"additional-fields[flow]": {"definition"}}
	var response struct {
		Data kvResource `json:"data"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/flows/"+url.PathEscape(id)+"?"+query.Encode(), nil, &response); err != nil {
		return kvResource{}, fmt.Errorf("klaviyo preserve flow %q definition: %w", id, err)
	}
	if response.Data.Type != "flow" || response.Data.ID != id {
		return kvResource{}, fmt.Errorf("klaviyo flow %q detail returned a mismatched identity: %w", id, adapter.ErrSourceUnavailable)
	}
	attributes := rawMap(response.Data.Attributes)
	if _, present := attributes["definition"]; !present {
		return kvResource{}, fmt.Errorf("klaviyo flow %q detail omitted the requested graph definition: %w", id, adapter.ErrSourceUnavailable)
	}
	return response.Data, nil
}

func (a *Adapter) listResources(ctx context.Context, sess adapter.Session, resource, path string, pageSize int, typ string) ([]kvResource, error) {
	// List and segment names are nullable in Klaviyo's stable schema. Their
	// provider IDs remain the durable identities; callers assign deterministic
	// display-name fallbacks when a name is absent.
	return a.listResourcesWithSort(ctx, sess, resource, path, pageSize, typ, "id", false)
}

func (a *Adapter) listResourcesWithSort(ctx context.Context, sess adapter.Session, resource, path string, pageSize int, typ, sortField string, requireName bool) ([]kvResource, error) {
	values := url.Values{}
	if sortField = strings.TrimSpace(sortField); sortField != "" {
		values.Set("sort", sortField)
	}
	items, err := listAllJSONAPI[kvResource](ctx, a, sess, resource, path, values, pageSize, func(item kvResource) (string, error) {
		if item.Type != typ || !validProviderID(item.ID) || (requireName && strings.TrimSpace(resourceName(item)) == "") {
			return "", fmt.Errorf("klaviyo %s returned an incomplete identity: %w", resource, adapter.ErrSourceUnavailable)
		}
		return item.ID, nil
	})
	if err != nil {
		return nil, fmt.Errorf("klaviyo discover %s: %w", resource, err)
	}
	return items, nil
}

func (a *Adapter) snapshotAudienceMembership(ctx context.Context, sess adapter.Session, kind, id, tag string, snapshot *klaviyoSnapshot, evidence *int) (int, error) {
	// Klaviyo exposes audience membership through the profiles collection for
	// each list or segment. There is no stable profiles relationship endpoint.
	path := "/" + kind + "s/" + url.PathEscape(id) + "/profiles"
	members, err := listAllJSONAPI[kvResource](ctx, a, sess, kind+" membership "+id, path, nil, membershipPageSize, func(profile kvResource) (string, error) {
		if profile.Type != "profile" || !validProviderID(profile.ID) {
			return "", fmt.Errorf("klaviyo %s %q returned an invalid profile identity: %w", kind, id, adapter.ErrSourceUnavailable)
		}
		return profile.ID, nil
	})
	if err != nil {
		return 0, fmt.Errorf("klaviyo snapshot %s %q membership: %w", kind, id, err)
	}
	if *evidence > maxMembershipEvidence-len(members) {
		return 0, fmt.Errorf("klaviyo audience membership evidence exceeds the safe %d-link worker limit: %w", maxMembershipEvidence, adapter.ErrUnsupported)
	}
	*evidence += len(members)
	count := 0
	for _, member := range members {
		if _, known := snapshot.AllProfileIDs[member.ID]; !known {
			return 0, fmt.Errorf("klaviyo %s %q references profile %q outside the discovery snapshot: %w", kind, id, member.ID, adapter.ErrSourceUnavailable)
		}
		if _, addressable := snapshot.EmailProfileIDs[member.ID]; !addressable {
			continue
		}
		if kind == "list" {
			if _, suppressed := snapshot.SuppressedListTags[member.ID][tag]; suppressed {
				continue
			}
		}
		snapshot.TagsByProfile[member.ID] = append(snapshot.TagsByProfile[member.ID], tag)
		count++
	}
	return count, nil
}

type jsonAPIPage[T any] struct {
	Data  []T     `json:"data"`
	Links kvLinks `json:"links"`
}

func listAllJSONAPI[T any](ctx context.Context, a *Adapter, sess adapter.Session, resource, path string, values url.Values, pageSize int, identity func(T) (string, error)) ([]T, error) {
	if pageSize <= 0 || pageSize > 100 || identity == nil {
		return nil, fmt.Errorf("klaviyo %s traversal is misconfigured", resource)
	}
	var out []T
	cursor := ""
	seenCursors := map[string]struct{}{}
	seenIDs := map[string]struct{}{}
	for page := 1; page <= maxTraversalPages; page++ {
		query := cloneValues(values)
		query.Set("page[size]", fmt.Sprintf("%d", pageSize))
		if cursor != "" {
			query.Set("page[cursor]", cursor)
		}
		var response jsonAPIPage[T]
		if err := a.do(ctx, sess, http.MethodGet, path+"?"+query.Encode(), nil, &response); err != nil {
			return nil, err
		}
		if len(response.Data) > pageSize {
			return nil, fmt.Errorf("klaviyo %s returned %d rows for page size %d: %w", resource, len(response.Data), pageSize, adapter.ErrSourceUnavailable)
		}
		for _, item := range response.Data {
			id, err := identity(item)
			if err != nil {
				return nil, err
			}
			id = strings.TrimSpace(id)
			if _, duplicate := seenIDs[id]; duplicate {
				return nil, fmt.Errorf("klaviyo %s returned duplicate identity %q across pages: %w", resource, id, adapter.ErrSourceUnavailable)
			}
			seenIDs[id] = struct{}{}
			out = append(out, item)
		}
		next, err := nextCursor(response.Links.Next, cursor, resource)
		if err != nil {
			return nil, err
		}
		if next == "" {
			return out, nil
		}
		if len(response.Data) == 0 {
			return nil, fmt.Errorf("klaviyo %s returned an empty non-terminal page: %w", resource, adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seenCursors[next]; duplicate {
			return nil, fmt.Errorf("klaviyo %s cursor cycle detected: %w", resource, adapter.ErrSourceUnavailable)
		}
		seenCursors[next] = struct{}{}
		cursor = next
	}
	return nil, fmt.Errorf("klaviyo %s traversal exceeded %d pages: %w", resource, maxTraversalPages, adapter.ErrUnsupported)
}

func nextCursor(raw, current, resource string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("klaviyo %s returned an invalid next link: %w", resource, adapter.ErrSourceUnavailable)
	}
	value := strings.TrimSpace(parsed.Query().Get("page[cursor]"))
	if value == "" || len(value) > maxProviderCursorBytes || value == current {
		return "", fmt.Errorf("klaviyo %s returned an invalid next cursor: %w", resource, adapter.ErrSourceUnavailable)
	}
	return value, nil
}

func cloneValues(values url.Values) url.Values {
	out := make(url.Values, len(values))
	for key, entries := range values {
		out[key] = append([]string(nil), entries...)
	}
	return out
}

func validateSession(sess adapter.Session) error {
	accountID := strings.TrimSpace(sess.AccountID)
	if strings.TrimSpace(sess.AccessToken) == "" || sess.Source != canonical.SourceKlaviyo || !validProviderID(accountID) ||
		strings.TrimSpace(sess.Extra[AccountIDExtraKey]) != accountID || AccountFingerprint(sess) != accountFingerprint(accountID) {
		return fmt.Errorf("klaviyo session has no valid account binding: %w", adapter.ErrAuth)
	}
	return nil
}

func accountFingerprint(accountID string) string {
	digest := sha256Sum("klaviyo-account-v1\x00" + strings.TrimSpace(accountID))
	return digest
}

func sha256Sum(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func validProviderID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 512 {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

func validEmail(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 320 || strings.ContainsAny(value, "\r\n") {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Contains(value, "@")
}

func resourceName(resource kvResource) string {
	return firstString(rawMap(resource.Attributes), "name")
}

func listDisplayName(resource kvResource) string {
	return firstNonEmpty(resourceName(resource), "Klaviyo list "+strings.TrimSpace(resource.ID))
}

func segmentDisplayName(resource kvResource) string {
	return firstNonEmpty(resourceName(resource), "Klaviyo segment "+strings.TrimSpace(resource.ID))
}

func listMembershipTag(id string) string {
	return "klaviyo:list:" + strings.TrimSpace(id)
}

func segmentMembershipTag(id string) string {
	return "klaviyo:segment:" + strings.TrimSpace(id)
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
