// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

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
	UpsertLeadSubmission(ctx context.Context, tenantID, provider string, submission SubmissionInput) (string, error)
}

type EventSink interface {
	TrackLeadSubmission(ctx context.Context, tenantID, provider string, submission SubmissionInput) (int64, error)
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type SubscriberProfileSink struct {
	Repo subscriberUpserter
}

func (s SubscriberProfileSink) UpsertLeadSubmission(ctx context.Context, tenantID, provider string, submission SubmissionInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("lead_integrations: subscriber sink unavailable")
	}
	if strings.TrimSpace(submission.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := map[string]any{}
	for k, v := range submission.Fields {
		props[k] = v
	}
	props["lead_provider"] = provider
	if submission.SourceID != "" {
		props["lead_source_id"] = submission.SourceID
	}
	if submission.FormID != "" {
		props["lead_form_id"] = submission.FormID
	}
	if submission.FormName != "" {
		props["lead_form_name"] = submission.FormName
	}
	if submission.Company != "" {
		props["company"] = submission.Company
	}
	if submission.Phone != "" {
		props["phone"] = submission.Phone
	}
	tags := append([]string(nil), submission.Tags...)
	for _, tag := range []string{provider, "lead-capture"} {
		if !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(submission.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             firstString(submission.SourceID, submission.FormID),
		SourcePlatform:       provider,
		FirstName:            submission.FirstName,
		LastName:             submission.LastName,
		FullName:             submission.FullName,
		DisplayName:          firstString(submission.FullName, strings.TrimSpace(submission.FirstName+" "+submission.LastName)),
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_lead_integration_sync_at": time.Now().UTC().Format(time.RFC3339)},
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

func (s TrackEventSink) TrackLeadSubmission(ctx context.Context, tenantID, provider string, submission SubmissionInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("lead_integrations: event sink unavailable")
	}
	if strings.TrimSpace(submission.Email) == "" {
		return 0, fmt.Errorf("email is required")
	}
	sub, err := s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", strings.ToLower(strings.TrimSpace(submission.Email)))
	if err != nil {
		return 0, err
	}
	props := map[string]any{}
	for k, v := range submission.Fields {
		props[k] = v
	}
	props["lead_provider"] = provider
	if submission.SourceID != "" {
		props["lead_source_id"] = submission.SourceID
	}
	if submission.FormID != "" {
		props["lead_form_id"] = submission.FormID
	}
	if submission.FormName != "" {
		props["lead_form_name"] = submission.FormName
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if submission.SubmittedAt != nil {
		occurred = submission.SubmittedAt.UTC()
	}
	eventName := firstString(submission.EventName, "lead.submitted")
	return s.Repo.Insert(ctx, tenantID, sub.ID, eventName, raw, occurred, "")
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(needle)) {
			return true
		}
	}
	return false
}
