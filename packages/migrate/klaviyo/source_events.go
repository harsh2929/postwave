// SPDX-License-Identifier: MIT

// source_events.go — Klaviyo incremental (delta) sync.
//
// Implements adapter.SourceEventAdapter so a continuous migration keeps pulling
// profile changes after the initial backfill. Klaviyo exposes incremental reads
// via the profiles endpoint's `filter=greater-than(updated,<iso8601>)` + a
// `sort=updated` ordering; cursor pagination (page[cursor]) carries the filter
// context across pages, so the filter is only set on the first page. Each
// changed profile maps to an upsert SourceEvent stamped with its `updated` time
// (the high-watermark the monitor advances on).

package klaviyo

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// ListSourceEvents pulls one page of profiles changed since `since` (or after
// `cursor`) as upsert events. IMPORTANT: the sort is `updated` ASCENDING
// (oldest-first) — the monitor advances its high-watermark to this batch's max
// OccurredAt, which is only correct-and-monotonic when the terminal page holds
// the newest rows. Do NOT switch to `sort=-updated`: that would make the
// watermark regress and re-pull forever.
func (a *Adapter) ListSourceEvents(ctx context.Context, sess adapter.Session, since time.Time, cursor string, limit int) (canonical.SourceEventBatch, error) {
	if err := validateSession(sess); err != nil {
		return canonical.SourceEventBatch{}, err
	}
	if limit <= 0 || limit > 100 {
		limit = profilePageSize
	}
	cursor = strings.TrimSpace(cursor)
	if len(cursor) > maxProviderCursorBytes {
		return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source-event cursor is too large: %w", adapter.ErrSourceUnavailable)
	}
	query := url.Values{
		"sort":                       {"updated"},
		"additional-fields[profile]": {"subscriptions,predictive_analytics"},
		"page[size]":                 {strconv.Itoa(limit)},
	}
	if cursor != "" {
		// The cursor already encodes the sort + filter context.
		query.Set("page[cursor]", cursor)
	} else if !since.IsZero() {
		// Re-read a bounded overlap because the source filter is strictly
		// greater-than and multiple updates can share one timestamp. Durable
		// SourceEvent IDs deduplicate the overlap safely.
		overlap := since.UTC().Add(-5 * time.Minute)
		query.Set("filter", "greater-than(updated,"+overlap.Format(time.RFC3339)+")")
	}

	var resp struct {
		Data  []kvProfile `json:"data"`
		Links kvLinks     `json:"links"`
	}
	if err := a.do(ctx, sess, http.MethodGet, "/profiles?"+query.Encode(), nil, &resp); err != nil {
		return canonical.SourceEventBatch{}, err
	}
	if len(resp.Data) > limit {
		return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source events returned more than %d profiles: %w", limit, adapter.ErrSourceUnavailable)
	}

	batch := canonical.SourceEventBatch{Events: make([]canonical.SourceEvent, 0, len(resp.Data))}
	seen := map[string]struct{}{}
	for _, p := range resp.Data {
		if p.Type != "profile" || !validProviderID(p.ID) {
			return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source event returned an incomplete profile identity: %w", adapter.ErrSourceUnavailable)
		}
		if _, duplicate := seen[p.ID+"\x00"+p.Attributes.Updated]; duplicate {
			return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source events returned a duplicate profile version: %w", adapter.ErrSourceUnavailable)
		}
		seen[p.ID+"\x00"+p.Attributes.Updated] = struct{}{}
		occurred := parseKlaviyoTime(p.Attributes.Updated)
		if occurred.IsZero() {
			return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source-event profile %q has an invalid updated timestamp %q: %w", p.ID, p.Attributes.Updated, adapter.ErrSourceUnavailable)
		}
		// The source monitor must advance across non-email profiles as well. A
		// page may contain only SMS/push identities and therefore emit no
		// subscriber events, but its provider cursor and updated watermark still
		// represent durable traversal progress.
		if occurred.After(batch.HighWatermark) {
			batch.HighWatermark = occurred
		}
		if strings.TrimSpace(p.Attributes.Email) == "" {
			// Non-email channel identities remain outside the subscriber replay.
			continue
		}
		// Profile polling does not prove current list/segment membership. Tags
		// are therefore left untouched by replay; the mandatory final full
		// snapshot is authoritative for audience membership.
		sub, mapErr := mapProfile(p, nil)
		if mapErr != nil {
			return canonical.SourceEventBatch{}, mapErr
		}
		sourceID := "klaviyo:profile:" + p.ID
		sourceID += ":" + occurred.UTC().Format(time.RFC3339Nano)
		batch.Events = append(batch.Events, canonical.SourceEvent{
			SourceID:     sourceID,
			ResourceType: "subscriber",
			Action:       "upsert",
			OccurredAt:   occurred,
			Subscriber:   &sub,
			Payload: map[string]interface{}{
				"profile_id":   p.ID,
				"email":        sub.Email,
				"updated":      p.Attributes.Updated,
				"event_type":   "profile_changed",
				"api_revision": apiRevision,
			},
			SourcePlatform: canonical.SourceKlaviyo,
		})
	}
	next, nextErr := nextCursor(resp.Links.Next, cursor, "source events")
	if nextErr != nil {
		return canonical.SourceEventBatch{}, nextErr
	}
	batch.NextCursor = next
	if batch.NextCursor != "" && len(resp.Data) == 0 {
		return canonical.SourceEventBatch{}, fmt.Errorf("klaviyo source events returned an empty non-terminal page: %w", adapter.ErrSourceUnavailable)
	}
	return batch, nil
}

// parseKlaviyoTime parses a Klaviyo ISO-8601 timestamp. Callers that use the
// value for replay or consent evidence fail closed when it returns zero.
func parseKlaviyoTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
