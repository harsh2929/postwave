// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type recordingSubscriberRepo struct {
	upsertIn       *subscribers.CreateInput
	identifyIn     *subscribers.IdentifyInput
	resolveBinding *CRMContactProfileBinding
	resolveKey     string
	bindExpected   string
	bindKey        string
	bindSubscriber string
	bindRevision   time.Time
	lockCalls      int
}

func (r *recordingSubscriberRepo) Upsert(_ context.Context, _ string, in subscribers.CreateInput) (*subscribers.Subscriber, error) {
	r.upsertIn = &in
	return &subscribers.Subscriber{ID: "sub_email", Email: in.Email}, nil
}

func (r *recordingSubscriberRepo) Identify(_ context.Context, _ string, in subscribers.IdentifyInput) (*subscribers.IdentifyResult, error) {
	r.identifyIn = &in
	email := in.Email
	if email == "" {
		email = "tel+15551234567@no-email.invalid"
	}
	return &subscribers.IdentifyResult{Subscriber: &subscribers.Subscriber{
		ID: "sub_phone", ProfileID: "00000000-0000-0000-0000-000000000111", Email: email,
	}, Action: "updated"}, nil
}

func (r *recordingSubscriberRepo) ResolveCRMContactProfileBinding(
	_ context.Context,
	_, _, _, providerContactID string,
) (*CRMContactProfileBinding, error) {
	r.resolveKey = providerContactID
	return r.resolveBinding, nil
}

func (r *recordingSubscriberRepo) WithCRMContactProfileBindingLock(
	_ context.Context,
	_, _, _, _ string,
	fn func() error,
) error {
	r.lockCalls++
	return fn()
}

func (r *recordingSubscriberRepo) BindCRMContactProfileBinding(
	_ context.Context,
	_, _, _, providerContactID, subscriberID, _, _ string,
	sourceRevisionAt time.Time,
	expectedProfileID string,
) (*CRMContactProfileBinding, error) {
	r.bindKey = providerContactID
	r.bindSubscriber = subscriberID
	r.bindExpected = expectedProfileID
	r.bindRevision = sourceRevisionAt
	return &CRMContactProfileBinding{SubscriberID: subscriberID}, nil
}

func (r *recordingSubscriberRepo) TransitionCRMContactProfileBinding(
	_ context.Context,
	_, _, _, _, _ string,
	_ map[string]any,
) (*CRMContactProfileBinding, error) {
	return nil, nil
}

func TestSubscriberProfileSinkUsesPhoneIdentityForSMSContacts(t *testing.T) {
	repo := &recordingSubscriberRepo{}
	sink := SubscriberProfileSink{Repo: repo}

	id, err := sink.UpsertCRMContact(context.Background(), "tenant-1", Integration{Provider: ProviderPostscript}, ContactInput{
		SourceID:  "postscript://subscriber/sub_1",
		Phone:     "+1 (555) 123-4567",
		FirstName: "Ada",
		Tags:      []string{"vip"},
		Properties: map[string]any{
			"sms_channel": "postscript",
		},
	})
	if err != nil {
		t.Fatalf("upsert phone contact: %v", err)
	}
	if id != "sub_phone" {
		t.Fatalf("id=%q", id)
	}
	if repo.upsertIn != nil {
		t.Fatalf("phone SMS contact should use identify, got upsert %+v", repo.upsertIn)
	}
	if repo.identifyIn == nil || repo.identifyIn.Phone != "+15551234567" || repo.identifyIn.ExternalID != "postscript://subscriber/sub_1" {
		t.Fatalf("identify input = %+v", repo.identifyIn)
	}
	if repo.identifyIn.Traits["crm_provider"] != ProviderPostscript || repo.identifyIn.Traits["first_name"] != "Ada" {
		t.Fatalf("traits = %+v", repo.identifyIn.Traits)
	}
}

func TestSubscriberProfileSinkKeepsEmailUpsertForNonSMSContacts(t *testing.T) {
	repo := &recordingSubscriberRepo{}
	sink := SubscriberProfileSink{Repo: repo}

	id, err := sink.UpsertCRMContact(context.Background(), "tenant-1", Integration{Provider: ProviderClose}, ContactInput{
		SourceID: "close://contact/42",
		Email:    "Buyer@Example.com",
		Phone:    "+15551234567",
	})
	if err != nil {
		t.Fatalf("upsert email contact: %v", err)
	}
	if id != "sub_email" {
		t.Fatalf("id=%q", id)
	}
	if repo.identifyIn != nil {
		t.Fatalf("non-SMS contact should not use identify: %+v", repo.identifyIn)
	}
	if repo.upsertIn == nil || repo.upsertIn.Email != "buyer@example.com" || repo.upsertIn.CustomFields["phone"] != "+15551234567" {
		t.Fatalf("upsert input = %+v", repo.upsertIn)
	}
}

func TestSubscriberProfileSinkUsesStableIdentityForHubSpotWithoutReplacementUpsert(t *testing.T) {
	repo := &recordingSubscriberRepo{}
	sink := SubscriberProfileSink{Repo: repo, Identities: repo}
	sourceUpdatedAt := time.Date(2026, 7, 27, 11, 30, 0, 0, time.UTC)

	id, err := sink.UpsertCRMContact(context.Background(), "tenant-1", Integration{ID: "integration-1", Provider: ProviderHubSpot}, ContactInput{
		SourceID:  "42",
		Email:     "Buyer@Example.com",
		FirstName: "Ada",
		UpdatedAt: &sourceUpdatedAt,
		Tags:      []string{"hubspot", "hubspot:list:7"},
		Properties: map[string]any{
			"hubspot_object_id": "42",
		},
	})
	if err != nil {
		t.Fatalf("identify HubSpot contact: %v", err)
	}
	if id != "sub_phone" {
		t.Fatalf("id=%q", id)
	}
	if repo.upsertIn != nil {
		t.Fatalf("HubSpot contact must not use replacement upsert: %+v", repo.upsertIn)
	}
	if repo.identifyIn == nil {
		t.Fatal("HubSpot contact did not use identity graph")
	}
	if repo.identifyIn.ExternalID != "" || repo.identifyIn.ProfileID != "" || repo.identifyIn.Email != "buyer@example.com" {
		t.Fatalf("identify input = %+v", repo.identifyIn)
	}
	if repo.resolveKey != "hubspot://contact/42" ||
		repo.bindKey != "hubspot://contact/42" ||
		repo.bindSubscriber != "sub_phone" ||
		repo.bindExpected != "" ||
		!repo.bindRevision.Equal(sourceUpdatedAt) ||
		repo.lockCalls != 1 {
		t.Fatalf("binding resolve=%q bind=%q subscriber=%q expected=%q revision=%v locks=%d",
			repo.resolveKey, repo.bindKey, repo.bindSubscriber, repo.bindExpected, repo.bindRevision, repo.lockCalls)
	}
	if repo.identifyIn.Traits["crm_source_id"] != "42" ||
		repo.identifyIn.Traits["hubspot_object_id"] != "42" ||
		repo.identifyIn.Traits["first_name"] != "Ada" {
		t.Fatalf("traits = %+v", repo.identifyIn.Traits)
	}
}

func TestSubscriberProfileSinkRejectsStaleHubSpotFetchBeforeIdentify(t *testing.T) {
	currentRevision := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	staleRevision := currentRevision.Add(-time.Minute)
	repo := &recordingSubscriberRepo{
		resolveBinding: &CRMContactProfileBinding{
			SubscriberID:        "sub_current",
			SubscriberProfileID: "00000000-0000-0000-0000-000000000444",
			State:               "deleted",
			SourceRevisionAt:    &currentRevision,
		},
	}
	sink := SubscriberProfileSink{Repo: repo, Identities: repo}

	_, err := sink.UpsertCRMContact(
		context.Background(),
		"tenant-1",
		Integration{ID: "integration-1", Provider: ProviderHubSpot},
		ContactInput{
			SourceID:  "42",
			Email:     "stale@example.com",
			UpdatedAt: &staleRevision,
		},
	)
	if !errors.Is(err, ErrCRMContactSourceRevisionStale) {
		t.Fatalf("stale fetch error=%v, want ErrCRMContactSourceRevisionStale", err)
	}
	if repo.identifyIn != nil || repo.bindKey != "" || repo.lockCalls != 1 {
		t.Fatalf("stale fetch mutated identity: identify=%+v bind=%q locks=%d", repo.identifyIn, repo.bindKey, repo.lockCalls)
	}
}

func TestSubscriberProfileSinkDoesNotReactivatePrivacyDeletedHubSpotBinding(t *testing.T) {
	deletedAt := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	newerRevision := deletedAt.Add(time.Hour)
	repo := &recordingSubscriberRepo{
		resolveBinding: &CRMContactProfileBinding{
			SubscriberID:        "sub_deleted",
			SubscriberProfileID: "00000000-0000-0000-0000-000000000555",
			State:               "privacy_deleted",
			SourceRevisionAt:    &deletedAt,
		},
	}
	sink := SubscriberProfileSink{Repo: repo, Identities: repo}

	_, err := sink.UpsertCRMContact(
		context.Background(),
		"tenant-1",
		Integration{ID: "integration-1", Provider: ProviderHubSpot},
		ContactInput{
			SourceID:  "42",
			Email:     "resurrected@example.com",
			UpdatedAt: &newerRevision,
		},
	)
	if !errors.Is(err, ErrCRMContactPrivacyDeleted) {
		t.Fatalf("privacy-deleted fetch error=%v, want ErrCRMContactPrivacyDeleted", err)
	}
	if repo.identifyIn != nil || repo.bindKey != "" || repo.lockCalls != 1 {
		t.Fatalf("privacy-deleted fetch mutated identity: identify=%+v bind=%q locks=%d", repo.identifyIn, repo.bindKey, repo.lockCalls)
	}
}

func TestSubscriberProfileSinkUsesMappedProfileIDForHubSpotEmailChange(t *testing.T) {
	repo := &recordingSubscriberRepo{
		resolveBinding: &CRMContactProfileBinding{
			SubscriberID:        "sub_old",
			SubscriberProfileID: "00000000-0000-0000-0000-000000000222",
			State:               "active",
		},
	}
	sink := SubscriberProfileSink{Repo: repo, Identities: repo}

	if _, err := sink.UpsertCRMContact(
		context.Background(),
		"tenant-1",
		Integration{ID: "integration-1", Provider: ProviderHubSpot},
		ContactInput{SourceID: "hubspot:contact:42", Email: "new@example.com"},
	); err != nil {
		t.Fatalf("identify changed HubSpot email: %v", err)
	}
	if repo.identifyIn == nil ||
		repo.identifyIn.ProfileID != "00000000-0000-0000-0000-000000000222" ||
		repo.identifyIn.ExternalID != "" ||
		repo.identifyIn.Email != "new@example.com" {
		t.Fatalf("identify input = %+v", repo.identifyIn)
	}
	if repo.bindExpected != "00000000-0000-0000-0000-000000000222" {
		t.Fatalf("bind expected profile = %q", repo.bindExpected)
	}
}

func TestSubscriberProfileSinkReactivatesDeletedHubSpotBinding(t *testing.T) {
	repo := &recordingSubscriberRepo{
		resolveBinding: &CRMContactProfileBinding{
			SubscriberID:        "sub_old",
			SubscriberProfileID: "00000000-0000-0000-0000-000000000333",
			State:               "deleted",
		},
	}
	sink := SubscriberProfileSink{Repo: repo, Identities: repo}

	if _, err := sink.UpsertCRMContact(
		context.Background(),
		"tenant-1",
		Integration{ID: "integration-1", Provider: ProviderHubSpot},
		ContactInput{SourceID: "42", Email: "restored@example.com"},
	); err != nil {
		t.Fatalf("reactivate HubSpot contact: %v", err)
	}
	if repo.identifyIn == nil ||
		repo.identifyIn.ProfileID != "00000000-0000-0000-0000-000000000333" ||
		repo.bindExpected != "00000000-0000-0000-0000-000000000333" {
		t.Fatalf("identify=%+v bind expected=%q", repo.identifyIn, repo.bindExpected)
	}
}

func TestHubSpotContactObjectIDAcceptsLegacyAndMigrationNamespaces(t *testing.T) {
	for input, want := range map[string]string{
		"42":                   "42",
		"hubspot://contact/42": "42",
		"hubspot:contact:42":   "42",
	} {
		if got := hubSpotContactObjectID(input); got != want {
			t.Fatalf("hubSpotContactObjectID(%q)=%q, want %q", input, got, want)
		}
	}
}

type recordingTrackRepo struct {
	byEmail string
	byPhone string
	insert  struct {
		subscriberID string
		eventName    string
		props        map[string]any
		occurredAt   time.Time
	}
}

func (r *recordingTrackRepo) ResolveSubscriberIdentity(_ context.Context, _ string, _ string, email string) (track.SubscriberIdentity, error) {
	r.byEmail = email
	return track.SubscriberIdentity{ID: "sub_email", Email: email}, nil
}

func (r *recordingTrackRepo) ResolveSubscriberIdentityByPhone(_ context.Context, _ string, phone string) (track.SubscriberIdentity, error) {
	r.byPhone = phone
	return track.SubscriberIdentity{ID: "sub_phone", Email: "tel+15551234567@no-email.invalid"}, nil
}

func (r *recordingTrackRepo) Insert(_ context.Context, _ string, subscriberID string, eventName string, propsJSON []byte, occurredAt time.Time, _ string) (int64, error) {
	r.insert.subscriberID = subscriberID
	r.insert.eventName = eventName
	r.insert.occurredAt = occurredAt
	_ = json.Unmarshal(propsJSON, &r.insert.props)
	return 1, nil
}

func TestTrackEventSinkCanResolvePhoneOnlyCRMEvents(t *testing.T) {
	repo := &recordingTrackRepo{}
	sink := TrackEventSink{Repo: repo}
	when := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)

	if _, err := sink.TrackCRMEvent(context.Background(), "tenant-1", ProviderAttentive, EventInput{
		SourceID:   "attentive://event/evt_1",
		Phone:      "+1 555 123 4567",
		EventName:  "sms.opt_in",
		OccurredAt: &when,
	}); err != nil {
		t.Fatalf("track phone event: %v", err)
	}
	if repo.byEmail != "" || repo.byPhone != "+15551234567" {
		t.Fatalf("lookups email=%q phone=%q", repo.byEmail, repo.byPhone)
	}
	if repo.insert.subscriberID != "sub_phone" || repo.insert.eventName != "sms.opt_in" || repo.insert.props["crm_provider"] != ProviderAttentive {
		t.Fatalf("insert = %+v", repo.insert)
	}
}
