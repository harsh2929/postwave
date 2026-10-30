// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type ProfileSink interface {
	UpsertCRMContact(ctx context.Context, tenantID string, integration Integration, contact ContactInput) (string, error)
}

type ProfileLifecycleSink interface {
	ReconcileCRMContactState(
		ctx context.Context,
		tenantID string,
		integration Integration,
		sourceID, state string,
		metadata map[string]any,
	) (subscriberID string, found bool, err error)
}

type EventSink interface {
	TrackCRMEvent(ctx context.Context, tenantID, provider string, event EventInput) (int64, error)
}

type ListMembershipSink interface {
	AddCRMContactToList(ctx context.Context, tenantID, listID, subscriberID, email string) error
}

type ListMembershipRemovalSink interface {
	RemoveCRMContactFromList(ctx context.Context, tenantID, listID, subscriberID, email string) (bool, error)
}

type ProviderListMembershipSink interface {
	AddProviderCRMContactToList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) error
	RemoveProviderCRMContactFromList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) (bool, error)
	BeginProviderCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMNativeListMembershipScan) error
	CompleteProviderCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMNativeListMembershipScan) (int, error)
}

type ProviderContactMembershipLifecycleSink interface {
	RemoveProviderCRMContactMemberships(
		ctx context.Context,
		tenantID, integrationID, provider, subscriberID string,
	) (int, error)
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type subscriberIdentifier interface {
	Identify(context.Context, string, subscribers.IdentifyInput) (*subscribers.IdentifyResult, error)
}

type crmContactProfileBindingStore interface {
	WithCRMContactProfileBindingLock(
		context.Context,
		string, string, string, string,
		func() error,
	) error
	ResolveCRMContactProfileBinding(
		context.Context,
		string, string, string, string,
	) (*CRMContactProfileBinding, error)
	BindCRMContactProfileBinding(
		context.Context,
		string, string, string, string,
		string, string, string, time.Time, string,
	) (*CRMContactProfileBinding, error)
	TransitionCRMContactProfileBinding(
		context.Context,
		string, string, string, string, string, map[string]any,
	) (*CRMContactProfileBinding, error)
}

type listEmailAdder interface {
	AddEmailToList(context.Context, string, string, string, string) error
}

type listEmailRemover interface {
	RemoveEmailFromList(context.Context, string, string, string, string) (bool, error)
}

type listOwnedMembershipRepo interface {
	AddEmailToListOwned(context.Context, string, string, string, lists.ListMembershipOwner) (string, error)
	RemoveEmailFromListOwned(context.Context, string, string, string, string) (bool, error)
	BeginCRMListMembershipScan(context.Context, string, lists.CRMListMembershipScan) error
	CompleteCRMListMembershipScan(context.Context, string, lists.CRMListMembershipScan) (int, error)
}

type crmContactMembershipRemover interface {
	RemoveCRMContactMemberships(context.Context, string, string, string, string) (int, error)
}

type SubscriberProfileSink struct {
	Repo       subscriberUpserter
	Identities crmContactProfileBindingStore
}

type NativeListMembershipSink struct {
	Repo listEmailAdder
}

func (s NativeListMembershipSink) AddCRMContactToList(ctx context.Context, tenantID, listID, subscriberID, email string) error {
	if s.Repo == nil {
		return fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	return skipErasedListMember(s.Repo.AddEmailToList(ctx, tenantID, listID, email, "integration"))
}

// skipErasedListMember treats an erased address as nothing to materialize,
// the way the contact path skips a privacy-deleted contact: a CRM still
// holding the person must not recreate them here, and a sync must not report
// a failure for honouring the erasure.
func skipErasedListMember(err error) error {
	if errors.Is(err, lists.ErrErasureBlocked) {
		return nil
	}
	return err
}

func (s NativeListMembershipSink) RemoveCRMContactFromList(ctx context.Context, tenantID, listID, subscriberID, email string) (bool, error) {
	if s.Repo == nil {
		return false, fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	remover, ok := s.Repo.(listEmailRemover)
	if !ok {
		return false, fmt.Errorf("crm_integrations: list membership removal sink unavailable")
	}
	return remover.RemoveEmailFromList(ctx, tenantID, listID, email, "integration")
}

func (s NativeListMembershipSink) AddProviderCRMContactToList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) error {
	if s.Repo == nil {
		return fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	repo, ok := s.Repo.(listOwnedMembershipRepo)
	if !ok {
		return s.AddCRMContactToList(ctx, tenantID, seen.NativeListID, seen.SubscriberID, seen.Email)
	}
	_, err := repo.AddEmailToListOwned(ctx, tenantID, seen.NativeListID, seen.Email, lists.ListMembershipOwner{
		Source:              "integration",
		OwnerKey:            crmNativeListMembershipOwnerKey(seen),
		Provider:            seen.Provider,
		IntegrationID:       seen.IntegrationID,
		ProviderSegmentType: seen.ProviderSegmentType,
		ProviderSegmentID:   seen.ProviderListID,
		ProviderMemberID:    seen.ProviderMemberID,
		SourceRef:           seen.ProviderMemberID,
		Metadata:            seen.Metadata,
	})
	return skipErasedListMember(err)
}

func (s NativeListMembershipSink) RemoveProviderCRMContactFromList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) (bool, error) {
	if s.Repo == nil {
		return false, fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	repo, ok := s.Repo.(listOwnedMembershipRepo)
	if !ok {
		return s.RemoveCRMContactFromList(ctx, tenantID, seen.NativeListID, seen.SubscriberID, seen.Email)
	}
	return repo.RemoveEmailFromListOwned(ctx, tenantID, seen.NativeListID, seen.Email, crmNativeListMembershipOwnerKey(seen))
}

func (s NativeListMembershipSink) BeginProviderCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMNativeListMembershipScan) error {
	if s.Repo == nil {
		return fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	repo, ok := s.Repo.(listOwnedMembershipRepo)
	if !ok {
		return nil
	}
	return repo.BeginCRMListMembershipScan(ctx, tenantID, lists.CRMListMembershipScan{
		IntegrationID:       scan.IntegrationID,
		Provider:            scan.Provider,
		ProviderSegmentType: scan.ProviderSegmentType,
		ProviderSegmentID:   scan.ProviderListID,
		NativeListID:        scan.NativeListID,
		Start:               scan.Start,
		Complete:            scan.Complete,
	})
}

func (s NativeListMembershipSink) CompleteProviderCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMNativeListMembershipScan) (int, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	repo, ok := s.Repo.(listOwnedMembershipRepo)
	if !ok {
		return 0, nil
	}
	return repo.CompleteCRMListMembershipScan(ctx, tenantID, lists.CRMListMembershipScan{
		IntegrationID:       scan.IntegrationID,
		Provider:            scan.Provider,
		ProviderSegmentType: scan.ProviderSegmentType,
		ProviderSegmentID:   scan.ProviderListID,
		NativeListID:        scan.NativeListID,
		Start:               scan.Start,
		Complete:            scan.Complete,
	})
}

func (s NativeListMembershipSink) RemoveProviderCRMContactMemberships(
	ctx context.Context,
	tenantID, integrationID, provider, subscriberID string,
) (int, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	repo, ok := s.Repo.(crmContactMembershipRemover)
	if !ok {
		return 0, fmt.Errorf("crm_integrations: CRM contact membership removal sink unavailable")
	}
	return repo.RemoveCRMContactMemberships(ctx, tenantID, integrationID, provider, subscriberID)
}

func crmNativeListMembershipOwnerKey(seen CRMNativeListMembershipSeen) string {
	member := firstString(seen.ProviderMemberID, seen.SubscriberID, strings.ToLower(strings.TrimSpace(seen.Email)))
	parts := []string{
		"crm",
		strings.TrimSpace(seen.IntegrationID),
		strings.TrimSpace(seen.Provider),
		strings.TrimSpace(seen.ProviderSegmentType),
		strings.TrimSpace(seen.ProviderListID),
		strings.TrimSpace(member),
	}
	return strings.Join(parts, ":")
}

func (s SubscriberProfileSink) UpsertCRMContact(ctx context.Context, tenantID string, integration Integration, contact ContactInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("crm_integrations: subscriber sink unavailable")
	}
	provider := integration.Provider
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	phone := strings.TrimSpace(contact.Phone)
	if provider == ProviderHubSpot {
		// HubSpot contacts have a provider-stable object ID while their primary
		// email can change. Resolve it through an integration-scoped binding,
		// then use Moosewave's stable profile_id. This avoids claiming the
		// tenant-wide external_id, which may belong to another source system.
		identifier, ok := s.Repo.(subscriberIdentifier)
		if !ok {
			return "", fmt.Errorf("hubspot identity sink unavailable")
		}
		if s.Identities == nil {
			return "", fmt.Errorf("hubspot contact identity store unavailable")
		}
		objectID := hubSpotContactObjectID(contact.SourceID)
		if objectID == "" {
			return "", fmt.Errorf("hubspot contact source_id is required")
		}
		if email == "" {
			return "", fmt.Errorf("email is required")
		}
		providerContactID := "hubspot://contact/" + objectID
		sourceRevisionAt := crmContactSourceRevision(contact)
		var subscriberID string
		err := s.Identities.WithCRMContactProfileBindingLock(
			ctx,
			tenantID,
			integration.ID,
			provider,
			providerContactID,
			func() error {
				binding, err := s.Identities.ResolveCRMContactProfileBinding(
					ctx,
					tenantID,
					integration.ID,
					provider,
					providerContactID,
				)
				if err != nil {
					return err
				}
				expectedProfileID := ""
				if binding != nil {
					expectedProfileID = binding.SubscriberProfileID
					if binding.State == "privacy_deleted" {
						return ErrCRMContactPrivacyDeleted
					}
					if binding.SourceRevisionAt != nil &&
						sourceRevisionAt.Before(*binding.SourceRevisionAt) {
						return ErrCRMContactSourceRevisionStale
					}
				}
				out, err := identifier.Identify(ctx, tenantID, subscribers.IdentifyInput{
					ProfileID: expectedProfileID,
					Email:     email,
					Traits:    crmContactProperties(provider, contact),
				})
				if err != nil {
					return err
				}
				if out == nil || out.Subscriber == nil {
					return fmt.Errorf("hubspot identity returned no subscriber")
				}
				if _, err := s.Identities.BindCRMContactProfileBinding(
					ctx,
					tenantID,
					integration.ID,
					provider,
					providerContactID,
					out.Subscriber.ID,
					out.Subscriber.ProfileID,
					out.Subscriber.Email,
					sourceRevisionAt,
					expectedProfileID,
				); err != nil {
					return err
				}
				subscriberID = out.Subscriber.ID
				return nil
			},
		)
		return subscriberID, err
	}
	if phone != "" && crmProviderUsesPhoneIdentity(provider) {
		identifier, ok := s.Repo.(subscriberIdentifier)
		if !ok {
			return "", fmt.Errorf("phone identity sink unavailable")
		}
		normalizedPhone, err := normalizeCRMPhoneE164(phone)
		if err != nil {
			return "", err
		}
		props := crmContactProperties(provider, contact)
		props["phone"] = normalizedPhone
		out, err := identifier.Identify(ctx, tenantID, subscribers.IdentifyInput{
			ExternalID: contact.SourceID,
			Email:      email,
			Phone:      normalizedPhone,
			Traits:     props,
		})
		if err != nil {
			return "", err
		}
		if out == nil || out.Subscriber == nil {
			return "", fmt.Errorf("phone identity returned no subscriber")
		}
		return out.Subscriber.ID, nil
	}
	if email == "" {
		return "", fmt.Errorf("email is required")
	}
	props := crmContactProperties(provider, contact)
	tags := append([]string(nil), contact.Tags...)
	if !containsFold(tags, provider) {
		tags = append(tags, provider)
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                email,
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             contact.SourceID,
		SourcePlatform:       provider,
		FirstName:            contact.FirstName,
		LastName:             contact.LastName,
		FullName:             contact.FullName,
		DisplayName:          firstString(contact.FullName, strings.TrimSpace(contact.FirstName+" "+contact.LastName)),
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_crm_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

func crmContactSourceRevision(contact ContactInput) time.Time {
	if contact.UpdatedAt != nil && !contact.UpdatedAt.IsZero() {
		return contact.UpdatedAt.UTC()
	}
	return time.Now().UTC()
}

func (s SubscriberProfileSink) ReconcileCRMContactState(
	ctx context.Context,
	tenantID string,
	integration Integration,
	sourceID, state string,
	metadata map[string]any,
) (string, bool, error) {
	if integration.Provider != ProviderHubSpot {
		return "", false, fmt.Errorf("crm contact lifecycle reconciliation is not supported for %s", integration.Provider)
	}
	if s.Identities == nil {
		return "", false, fmt.Errorf("hubspot contact identity store unavailable")
	}
	objectID := hubSpotContactObjectID(sourceID)
	if objectID == "" {
		return "", false, fmt.Errorf("hubspot contact source_id is required")
	}
	var binding *CRMContactProfileBinding
	err := s.Identities.WithCRMContactProfileBindingLock(
		ctx,
		tenantID,
		integration.ID,
		integration.Provider,
		"hubspot://contact/"+objectID,
		func() error {
			var transitionErr error
			binding, transitionErr = s.Identities.TransitionCRMContactProfileBinding(
				ctx,
				tenantID,
				integration.ID,
				integration.Provider,
				"hubspot://contact/"+objectID,
				state,
				metadata,
			)
			return transitionErr
		},
	)
	if err != nil {
		return "", false, err
	}
	if binding == nil {
		return "", false, nil
	}
	return binding.SubscriberID, true, nil
}

type trackRepo interface {
	ResolveSubscriberIdentity(context.Context, string, string, string) (track.SubscriberIdentity, error)
	Insert(context.Context, string, string, string, []byte, time.Time, string) (int64, error)
}

type phoneTrackRepo interface {
	ResolveSubscriberIdentityByPhone(context.Context, string, string) (track.SubscriberIdentity, error)
}

type TrackEventSink struct {
	Repo trackRepo
}

func (s TrackEventSink) TrackCRMEvent(ctx context.Context, tenantID, provider string, event EventInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("crm_integrations: event sink unavailable")
	}
	if strings.TrimSpace(event.EventName) == "" {
		return 0, fmt.Errorf("event_name is required")
	}
	email := strings.ToLower(strings.TrimSpace(event.Email))
	phone := strings.TrimSpace(event.Phone)
	var (
		sub track.SubscriberIdentity
		err error
	)
	switch {
	case email != "":
		sub, err = s.Repo.ResolveSubscriberIdentity(ctx, tenantID, "", email)
		if err != nil && phone != "" {
			if resolver, ok := s.Repo.(phoneTrackRepo); ok {
				if normalizedPhone, nerr := normalizeCRMPhoneE164(phone); nerr == nil {
					sub, err = resolver.ResolveSubscriberIdentityByPhone(ctx, tenantID, normalizedPhone)
				}
			}
		}
	case phone != "":
		resolver, ok := s.Repo.(phoneTrackRepo)
		if !ok {
			return 0, fmt.Errorf("phone identity sink unavailable")
		}
		normalizedPhone, nerr := normalizeCRMPhoneE164(phone)
		if nerr != nil {
			return 0, nerr
		}
		sub, err = resolver.ResolveSubscriberIdentityByPhone(ctx, tenantID, normalizedPhone)
	default:
		return 0, fmt.Errorf("email or phone is required")
	}
	if err != nil {
		return 0, err
	}
	props := map[string]any{}
	for k, v := range event.Properties {
		props[k] = v
	}
	props["crm_provider"] = provider
	if event.SourceID != "" {
		props["crm_source_id"] = event.SourceID
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if event.OccurredAt != nil {
		occurred = event.OccurredAt.UTC()
	}
	return s.Repo.Insert(ctx, tenantID, sub.ID, event.EventName, raw, occurred, "")
}

func crmContactProperties(provider string, contact ContactInput) map[string]any {
	props := map[string]any{}
	for k, v := range contact.Properties {
		props[k] = v
	}
	props["crm_provider"] = provider
	if contact.SourceID != "" {
		props["crm_source_id"] = contact.SourceID
	}
	if contact.FirstName != "" {
		props["first_name"] = contact.FirstName
	}
	if contact.LastName != "" {
		props["last_name"] = contact.LastName
	}
	if contact.FullName != "" {
		props["full_name"] = contact.FullName
	}
	if contact.Company != "" {
		props["company"] = contact.Company
	}
	if contact.LifecycleStage != "" {
		props["lifecycle_stage"] = contact.LifecycleStage
	}
	if len(contact.ListIDs) > 0 {
		props["crm_list_ids"] = contact.ListIDs
	}
	if len(contact.Tags) > 0 {
		props["crm_tags"] = contact.Tags
	}
	if contact.Phone != "" {
		props["phone"] = contact.Phone
	}
	return props
}

func crmProviderUsesPhoneIdentity(provider string) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderPostscript, ProviderAttentive:
		return true
	default:
		return false
	}
}

func normalizeCRMPhoneE164(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	var b strings.Builder
	for i, r := range raw {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' && i == 0:
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '(' || r == ')' || r == '.':
		default:
			return "", fmt.Errorf("phone contains invalid characters; expected E.164")
		}
	}
	cleaned := b.String()
	if !strings.HasPrefix(cleaned, "+") {
		return "", fmt.Errorf("phone must be E.164 (include the leading + and country code)")
	}
	digits := cleaned[1:]
	if len(digits) < 1 || len(digits) > 15 {
		return "", fmt.Errorf("phone must be E.164 with 1..15 digits")
	}
	return cleaned, nil
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(needle)) {
			return true
		}
	}
	return false
}
