// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type ProfileSink interface {
	UpsertLoyaltyMember(ctx context.Context, tenantID, provider string, member MemberInput) (string, error)
}

type EventSink interface {
	TrackLoyaltyEvent(ctx context.Context, tenantID, provider string, event LoyaltyEventInput) (int64, error)
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type LoyaltyProfileSink struct {
	Repo subscriberUpserter
}

func (s LoyaltyProfileSink) UpsertLoyaltyMember(ctx context.Context, tenantID, provider string, member MemberInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("loyalty_integrations: profile sink unavailable")
	}
	if strings.TrimSpace(member.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := map[string]any{}
	for k, v := range member.Properties {
		props[k] = v
	}
	props["loyalty_provider"] = provider
	if member.SourceID != "" {
		props["loyalty_source_id"] = member.SourceID
	}
	if member.PointsBalance != 0 {
		props["loyalty_points_balance"] = member.PointsBalance
	}
	if member.PointsEarned != 0 {
		props["loyalty_points_earned"] = member.PointsEarned
	}
	if member.VIPTier != "" {
		props["loyalty_vip_tier"] = member.VIPTier
	}
	if member.ReferralCode != "" {
		props["loyalty_referral_code"] = member.ReferralCode
	}
	if member.RewardsCount != 0 {
		props["loyalty_rewards_count"] = member.RewardsCount
	}
	if member.Phone != "" {
		props["phone"] = member.Phone
	}
	tags := []string{provider, "loyalty-member"}
	if member.VIPTier != "" {
		tags = append(tags, "loyalty-tier-"+slugTag(member.VIPTier))
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(member.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             member.SourceID,
		SourcePlatform:       provider,
		FirstName:            member.FirstName,
		LastName:             member.LastName,
		FullName:             member.FullName,
		DisplayName:          firstString(member.FullName, strings.TrimSpace(member.FirstName+" "+member.LastName)),
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_loyalty_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

type trackRepo interface {
	ResolveSubscriberIdentity(context.Context, string, string, string) (track.SubscriberIdentity, error)
	Insert(context.Context, string, string, string, []byte, time.Time, string) (int64, error)
}

type TrackEventSink struct {
	Repo trackRepo
}

func (s TrackEventSink) TrackLoyaltyEvent(ctx context.Context, tenantID, provider string, event LoyaltyEventInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("loyalty_integrations: event sink unavailable")
	}
	if strings.TrimSpace(event.Email) == "" {
		return 0, fmt.Errorf("email is required")
	}
	sub, err := s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", strings.ToLower(strings.TrimSpace(event.Email)))
	if err != nil {
		return 0, err
	}
	props := map[string]any{}
	for k, v := range event.Properties {
		props[k] = v
	}
	props["loyalty_provider"] = provider
	if event.SourceID != "" {
		props["loyalty_source_id"] = event.SourceID
	}
	if event.Points != 0 {
		props["points"] = event.Points
	}
	if event.RewardID != "" {
		props["reward_id"] = event.RewardID
	}
	if event.RewardName != "" {
		props["reward_name"] = event.RewardName
	}
	if event.VIPTier != "" {
		props["vip_tier"] = event.VIPTier
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if event.OccurredAt != nil {
		occurred = event.OccurredAt.UTC()
	}
	eventName := firstString(event.EventName, "loyalty.event")
	return s.Repo.Insert(ctx, tenantID, sub.ID, eventName, raw, occurred, "")
}

func slugTag(value string) string {
	out := strings.Builder{}
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			out.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			out.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(out.String(), "-")
}
