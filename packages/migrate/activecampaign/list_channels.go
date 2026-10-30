// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
)

func (a *Adapter) ensureListChannels(ctx context.Context, sess adapter.Session) (activeCampaignSubscriberSafetyEvidence, error) {
	cacheKey := a.metadataCacheKey(sess)
	if a.listChannelsLoaded && a.listChannelsCache == cacheKey {
		return activeCampaignSubscriberSafetyEvidence{
			ListChannels:                    cloneActiveCampaignChannels(a.listChannels),
			ListChannelInventoryComplete:    a.listChannelsComplete,
			EmailExclusionInventoryComplete: false,
		}, nil
	}
	if allowInsecureActiveCampaignTestLoopback && !a.loadListChannelsForTests {
		if parsed, err := url.Parse(firstNonEmpty(a.BaseURL, sess.Extra["api_url"])); err == nil && isCanonicalLoopbackHost(canonicalAccountHost(parsed)) {
			a.listChannels = nil
			a.listChannelsComplete = false
			a.listChannelsLoaded = true
			a.listChannelsCache = cacheKey
			return activeCampaignSubscriberSafetyEvidence{
				ListChannelInventoryComplete:    false,
				EmailExclusionInventoryComplete: false,
			}, nil
		}
	}

	emailLists, emailErr := a.listAllListIDs(ctx, sess, "/lists", "lists")
	channels := make(map[string]activeCampaignMarketingChannel, len(emailLists))
	complete := emailErr == nil
	if emailErr == nil {
		for listID := range emailLists {
			channels[listID] = activeCampaignChannelEmail
		}
	}

	smsLists, smsErr := a.listAllListIDs(ctx, sess, "/sms/lists", "lists")
	if smsErr != nil {
		// SMS inventory is plan/permission dependent. Its absence means channel
		// classification is incomplete, not that every ordinary list is email.
		complete = false
	} else {
		for listID := range smsLists {
			if channels[listID] == activeCampaignChannelEmail {
				channels[listID] = activeCampaignChannelUnknown
				continue
			}
			channels[listID] = activeCampaignChannelSMS
		}
	}

	a.listChannels = channels
	a.listChannelsComplete = complete
	a.listChannelsLoaded = true
	a.listChannelsCache = cacheKey
	return activeCampaignSubscriberSafetyEvidence{
		ListChannels:                    cloneActiveCampaignChannels(channels),
		ListChannelInventoryComplete:    complete,
		EmailExclusionInventoryComplete: false,
	}, nil
}

func (a *Adapter) listAllListIDs(ctx context.Context, sess adapter.Session, basePath, responseKey string) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	offset := 0
	for {
		values := url.Values{}
		values.Set("limit", strconv.Itoa(pageSize))
		values.Set("offset", strconv.Itoa(offset))
		rows, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, basePath+"?"+values.Encode(), responseKey)
		if err != nil {
			return nil, err
		}
		if err := validateActiveCampaignOffsetPage(len(rows), total, offset); err != nil {
			return nil, fmt.Errorf("%s pagination: %w", strings.TrimSpace(basePath), err)
		}
		for _, row := range rows {
			id := firstNonEmpty(stringFromAny(row["id"]), stringFromAny(row["listid"]), stringFromAny(row["list_id"]))
			if id == "" {
				return nil, fmt.Errorf("%s returned a list without an id", strings.TrimSpace(basePath))
			}
			if _, duplicate := out[id]; duplicate {
				return nil, fmt.Errorf("%s pagination repeated list %s", strings.TrimSpace(basePath), id)
			}
			out[id] = struct{}{}
		}
		next := nextActiveCampaignPageOffset(len(rows), total, offset, pageSize)
		if next == 0 {
			return out, nil
		}
		if next <= offset {
			return nil, fmt.Errorf("%s pagination did not advance", strings.TrimSpace(basePath))
		}
		offset = next
	}
}

func cloneActiveCampaignChannels(in map[string]activeCampaignMarketingChannel) map[string]activeCampaignMarketingChannel {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]activeCampaignMarketingChannel, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
