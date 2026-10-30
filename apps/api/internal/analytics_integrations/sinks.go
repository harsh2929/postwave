// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type ProfileSink interface {
	UpsertAnalyticsProfile(ctx context.Context, tenantID, provider string, profile ProfileInput) (string, error)
}

type EventSink interface {
	TrackAnalyticsEvent(ctx context.Context, tenantID, provider string, event EventInput) (int64, error)
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type SubscriberProfileSink struct {
	Repo subscriberUpserter
}

func (s SubscriberProfileSink) UpsertAnalyticsProfile(ctx context.Context, tenantID, provider string, profile ProfileInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("analytics_integrations: subscriber sink unavailable")
	}
	if strings.TrimSpace(profile.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := map[string]any{}
	for k, v := range profile.Traits {
		if analyticsTraitCustomField(k, v) {
			props[k] = v
		}
	}
	if len(profile.Traits) > 0 {
		// Provider property names and nested values need not satisfy the
		// workspace's custom-field grammar. Preserve the original JSON as
		// system-owned provenance; never let upstream _listmonk_id or other
		// reserved properties become authoritative top-level metadata.
		props["_analytics_traits"] = profile.Traits
	}
	props["analytics_provider"] = provider
	if profile.SourceID != "" {
		props["analytics_source_id"] = profile.SourceID
	}
	if profile.UserID != "" {
		props["analytics_user_id"] = profile.UserID
	}
	if profile.AnonymousID != "" {
		props["analytics_anonymous_id"] = profile.AnonymousID
	}
	if profile.Phone != "" {
		props["phone"] = profile.Phone
	}
	tags := []string{provider, "analytics-profile"}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(profile.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             firstString(profile.SourceID, profile.UserID, profile.AnonymousID),
		SourcePlatform:       provider,
		FirstName:            profile.FirstName,
		LastName:             profile.LastName,
		FullName:             profile.FullName,
		DisplayName:          firstString(profile.FullName, strings.TrimSpace(profile.FirstName+" "+profile.LastName)),
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_analytics_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

func analyticsTraitCustomField(key string, value any) bool {
	if len(key) == 0 || len(key) > customfields.MaxKeyLength || key[0] < 'a' || key[0] > 'z' {
		return false
	}
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	switch value.(type) {
	case nil, string, bool, float64, int, int32, int64, time.Time:
		return true
	default:
		return false
	}
}

type trackRepo interface {
	ResolveSubscriberIdentity(context.Context, string, string, string) (track.SubscriberIdentity, error)
	Insert(context.Context, string, string, string, []byte, time.Time, string) (int64, error)
}

type TrackEventSink struct {
	Repo trackRepo
}

func (s TrackEventSink) TrackAnalyticsEvent(ctx context.Context, tenantID, provider string, event EventInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("analytics_integrations: event sink unavailable")
	}
	if strings.TrimSpace(event.Email) == "" {
		return 0, fmt.Errorf("email is required")
	}
	if strings.TrimSpace(event.EventName) == "" {
		return 0, fmt.Errorf("event_name is required")
	}
	sub, err := s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", strings.ToLower(strings.TrimSpace(event.Email)))
	if err != nil {
		return 0, err
	}
	props := map[string]any{}
	for k, v := range event.Properties {
		props[k] = v
	}
	props["analytics_provider"] = provider
	if event.SourceID != "" {
		props["analytics_source_id"] = event.SourceID
	}
	if event.UserID != "" {
		props["analytics_user_id"] = event.UserID
	}
	if event.AnonymousID != "" {
		props["analytics_anonymous_id"] = event.AnonymousID
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if event.OccurredAt != nil {
		occurred = event.OccurredAt.UTC()
	}
	// The upstream provider's own event id, when it has one, becomes the
	// idempotency key — a replayed webhook from Segment or Amplitude is the
	// same class of duplicate a retried /track call is.
	return s.Repo.Insert(ctx, tenantID, sub.ID, event.EventName, raw, occurred, event.EventID)
}
