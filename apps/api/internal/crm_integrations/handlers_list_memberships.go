// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// CRM-native list membership materialization during sync: scan bookkeeping and
// the contact/event membership targets derived from provider payloads.

func (d *Deps) providerListMembershipSink() (ProviderListMembershipSink, bool) {
	if d == nil || d.ListMemberships == nil {
		return nil, false
	}
	sink, ok := d.ListMemberships.(ProviderListMembershipSink)
	return sink, ok
}

func (d *Deps) beginCRMNativeListMembershipScans(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) error {
	if !in.nativeListMembershipManaged || len(in.nativeListMembershipScans) == 0 {
		return nil
	}
	sink, ok := d.providerListMembershipSink()
	if !ok {
		return nil
	}
	for _, scan := range uniqueCRMNativeListMembershipScans(in.nativeListMembershipScans) {
		scan.IntegrationID = integration.ID
		if err := sink.BeginProviderCRMListMembershipScan(ctx, tenantID, scan); err != nil {
			return err
		}
	}
	return nil
}

func (d *Deps) completeCRMNativeListMembershipScans(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) error {
	if !in.nativeListMembershipManaged || len(in.nativeListMembershipScans) == 0 {
		return nil
	}
	sink, ok := d.providerListMembershipSink()
	if !ok {
		return nil
	}
	for _, scan := range uniqueCRMNativeListMembershipScans(in.nativeListMembershipScans) {
		if !scan.Complete {
			continue
		}
		scan.IntegrationID = integration.ID
		if _, err := sink.CompleteProviderCRMListMembershipScan(ctx, tenantID, scan); err != nil {
			return err
		}
	}
	return nil
}

func (d *Deps) materializeCRMListMemberships(ctx context.Context, tenantID string, integration *Integration, contact ContactInput, subscriberID string) error {
	targets := crmNativeListMembershipTargets(integration, contact)
	if len(targets) == 0 {
		return nil
	}
	if d.ListMemberships == nil {
		return fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	for _, target := range targets {
		seen := CRMNativeListMembershipSeen{
			IntegrationID:       integration.ID,
			Provider:            integration.Provider,
			ProviderSegmentType: target.ProviderSegmentType,
			ProviderListID:      target.ProviderListID,
			NativeListID:        target.NativeListID,
			ProviderMemberID:    contact.SourceID,
			SubscriberID:        subscriberID,
			Email:               contact.Email,
			Metadata: map[string]any{
				"source_id": contact.SourceID,
				"kind":      "contact",
			},
		}
		if sink, ok := d.providerListMembershipSink(); ok {
			if err := sink.AddProviderCRMContactToList(ctx, tenantID, seen); err != nil {
				return fmt.Errorf("add CRM contact to native list %s: %w", target.NativeListID, err)
			}
			continue
		}
		if err := d.ListMemberships.AddCRMContactToList(ctx, tenantID, target.NativeListID, subscriberID, contact.Email); err != nil {
			return fmt.Errorf("add CRM contact to native list %s: %w", target.NativeListID, err)
		}
	}
	return nil
}

func (d *Deps) materializeCRMEventListMemberships(ctx context.Context, tenantID string, integration *Integration, event EventInput) error {
	targets := crmNativeEventListMembershipTargets(integration, event)
	if len(targets) == 0 {
		return nil
	}
	if d.ListMemberships == nil {
		return fmt.Errorf("crm_integrations: list membership sink unavailable")
	}
	if crmEventRemovesNativeListMembership(integration, event) {
		for _, target := range targets {
			seen := CRMNativeListMembershipSeen{
				IntegrationID:       integration.ID,
				Provider:            integration.Provider,
				ProviderSegmentType: target.ProviderSegmentType,
				ProviderListID:      target.ProviderListID,
				NativeListID:        target.NativeListID,
				ProviderMemberID:    event.SourceID,
				Email:               event.Email,
			}
			if sink, ok := d.providerListMembershipSink(); ok {
				if _, err := sink.RemoveProviderCRMContactFromList(ctx, tenantID, seen); err != nil {
					return fmt.Errorf("remove CRM event identity from native list %s: %w", target.NativeListID, err)
				}
				continue
			}
			remover, ok := d.ListMemberships.(ListMembershipRemovalSink)
			if !ok {
				return fmt.Errorf("crm_integrations: list membership removal sink unavailable")
			}
			if _, err := remover.RemoveCRMContactFromList(ctx, tenantID, target.NativeListID, "", event.Email); err != nil {
				return fmt.Errorf("remove CRM event identity from native list %s: %w", target.NativeListID, err)
			}
		}
		return nil
	}
	for _, target := range targets {
		seen := CRMNativeListMembershipSeen{
			IntegrationID:       integration.ID,
			Provider:            integration.Provider,
			ProviderSegmentType: target.ProviderSegmentType,
			ProviderListID:      target.ProviderListID,
			NativeListID:        target.NativeListID,
			ProviderMemberID:    event.SourceID,
			Email:               event.Email,
			Metadata: map[string]any{
				"source_id":  event.SourceID,
				"event_name": event.EventName,
				"kind":       "event",
			},
		}
		if sink, ok := d.providerListMembershipSink(); ok {
			if err := sink.AddProviderCRMContactToList(ctx, tenantID, seen); err != nil {
				return fmt.Errorf("add CRM event identity to native list %s: %w", target.NativeListID, err)
			}
			continue
		}
		if err := d.ListMemberships.AddCRMContactToList(ctx, tenantID, target.NativeListID, "", event.Email); err != nil {
			return fmt.Errorf("add CRM event identity to native list %s: %w", target.NativeListID, err)
		}
	}
	return nil
}

type crmNativeListMembershipTarget struct {
	ProviderSegmentType string
	ProviderListID      string
	NativeListID        string
}

func crmNativeListMembershipTargets(integration *Integration, contact ContactInput) []crmNativeListMembershipTarget {
	if integration == nil || integration.Provider != ProviderHubSpot {
		return nil
	}
	providerListIDs := crmStringListValue(contact.Properties["hubspot_proven_list_ids"])
	if len(providerListIDs) == 0 {
		return nil
	}
	mapping := crmProviderListMembershipMap(integration.Settings, "list_membership_map", "hubspot_list_membership_map")
	if len(mapping) == 0 {
		return nil
	}
	targets := make([]crmNativeListMembershipTarget, 0, len(providerListIDs))
	for _, providerListID := range providerListIDs {
		target := strings.TrimSpace(mapping[strings.TrimSpace(providerListID)])
		if target != "" {
			targets = append(targets, crmNativeListMembershipTarget{
				ProviderSegmentType: "hubspot_list",
				ProviderListID:      strings.TrimSpace(providerListID),
				NativeListID:        target,
			})
		}
	}
	return uniqueCRMNativeListMembershipTargets(targets)
}

func crmNativeEventListMembershipTargets(integration *Integration, event EventInput) []crmNativeListMembershipTarget {
	if integration == nil || integration.Provider != ProviderSalesforce {
		return nil
	}
	switch strings.TrimSpace(event.EventName) {
	case "crm.campaign_member.updated", "crm.campaign_member.removed":
	default:
		return nil
	}
	providerListIDs := crmStringListValue(event.Properties["crm_provider_list_id"])
	providerListIDs = append(providerListIDs, crmStringListValue(event.Properties["salesforce_campaign_id"])...)
	providerListIDs = uniqueCRMStrings(providerListIDs)
	if len(providerListIDs) == 0 {
		return nil
	}
	mapping := crmProviderListMembershipMap(
		integration.Settings,
		"campaign_membership_map",
		"salesforce_campaign_membership_map",
		"list_membership_map",
		"salesforce_list_membership_map",
	)
	if len(mapping) == 0 {
		return nil
	}
	targets := make([]crmNativeListMembershipTarget, 0, len(providerListIDs))
	for _, providerListID := range providerListIDs {
		target := strings.TrimSpace(mapping[strings.TrimSpace(providerListID)])
		if target != "" {
			targets = append(targets, crmNativeListMembershipTarget{
				ProviderSegmentType: "salesforce_campaign",
				ProviderListID:      strings.TrimSpace(providerListID),
				NativeListID:        target,
			})
		}
	}
	return uniqueCRMNativeListMembershipTargets(targets)
}

func uniqueCRMNativeListMembershipTargets(values []crmNativeListMembershipTarget) []crmNativeListMembershipTarget {
	out := make([]crmNativeListMembershipTarget, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value.ProviderSegmentType = strings.TrimSpace(value.ProviderSegmentType)
		value.ProviderListID = strings.TrimSpace(value.ProviderListID)
		value.NativeListID = strings.TrimSpace(value.NativeListID)
		if value.ProviderListID == "" || value.NativeListID == "" {
			continue
		}
		key := value.ProviderSegmentType + "\x00" + value.ProviderListID + "\x00" + value.NativeListID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func uniqueCRMNativeListMembershipScans(values []CRMNativeListMembershipScan) []CRMNativeListMembershipScan {
	out := make([]CRMNativeListMembershipScan, 0, len(values))
	seen := map[string]int{}
	for _, value := range values {
		value.Provider = strings.TrimSpace(value.Provider)
		value.ProviderSegmentType = strings.TrimSpace(value.ProviderSegmentType)
		value.ProviderListID = strings.TrimSpace(value.ProviderListID)
		value.NativeListID = strings.TrimSpace(value.NativeListID)
		if value.Provider == "" || value.ProviderSegmentType == "" || value.ProviderListID == "" || value.NativeListID == "" {
			continue
		}
		key := value.Provider + "\x00" + value.ProviderSegmentType + "\x00" + value.ProviderListID + "\x00" + value.NativeListID
		if idx, ok := seen[key]; ok {
			out[idx].Start = out[idx].Start || value.Start
			out[idx].Complete = out[idx].Complete || value.Complete
			continue
		}
		seen[key] = len(out)
		out = append(out, value)
	}
	return out
}

func crmEventRemovesNativeListMembership(integration *Integration, event EventInput) bool {
	if integration == nil || integration.Provider != ProviderSalesforce {
		return false
	}
	if strings.TrimSpace(event.EventName) == "crm.campaign_member.removed" {
		return true
	}
	if crmBoolValue(event.Properties["crm_provider_list_removed"]) ||
		crmBoolValue(event.Properties["salesforce_campaign_member_removed"]) ||
		crmBoolValue(event.Properties["salesforce_is_deleted"]) {
		return true
	}
	return salesforceCampaignMemberRemovalStatus(fmt.Sprint(event.Properties["salesforce_campaign_member_status"]))
}

func crmProviderListMembershipMap(settings map[string]any, keys ...string) map[string]string {
	out := map[string]string{}
	if len(settings) == 0 {
		return out
	}
	for _, key := range keys {
		value, ok := settings[strings.ToLower(strings.TrimSpace(key))]
		if !ok || value == nil {
			continue
		}
		for providerListID, nativeListID := range crmProviderListMembershipMapValue(value) {
			out[providerListID] = nativeListID
		}
	}
	return out
}

func crmProviderListMembershipMapValue(value any) map[string]string {
	out := map[string]string{}
	switch typed := value.(type) {
	case map[string]string:
		for key, val := range typed {
			if key = strings.TrimSpace(key); key != "" {
				if val = strings.TrimSpace(val); val != "" {
					out[key] = val
				}
			}
		}
	case map[string]any:
		for key, val := range typed {
			if key = strings.TrimSpace(key); key != "" {
				if nativeID := strings.TrimSpace(fmt.Sprint(val)); nativeID != "" {
					out[key] = nativeID
				}
			}
		}
	case string:
		raw := strings.TrimSpace(typed)
		if raw == "" {
			return out
		}
		var parsed map[string]string
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			return crmProviderListMembershipMapValue(parsed)
		}
		var generic map[string]any
		if err := json.Unmarshal([]byte(raw), &generic); err == nil {
			return crmProviderListMembershipMapValue(generic)
		}
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == ';' }) {
			providerListID, nativeListID, ok := strings.Cut(part, "=")
			if !ok {
				providerListID, nativeListID, ok = strings.Cut(part, ":")
			}
			if !ok {
				continue
			}
			providerListID = strings.TrimSpace(providerListID)
			nativeListID = strings.TrimSpace(nativeListID)
			if providerListID != "" && nativeListID != "" {
				out[providerListID] = nativeListID
			}
		}
	}
	return out
}

func crmBoolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "1", "yes", "y":
			return true
		default:
			return false
		}
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	default:
		return false
	}
}

func crmStringListValue(value any) []string {
	switch typed := value.(type) {
	case []string:
		return uniqueCRMStrings(typed)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(fmt.Sprint(item)))
		}
		return uniqueCRMStrings(out)
	case string:
		parts := strings.FieldsFunc(typed, func(r rune) bool {
			return r == ',' || r == '\n' || r == ';'
		})
		return uniqueCRMStrings(parts)
	default:
		if value == nil {
			return nil
		}
		return uniqueCRMStrings([]string{fmt.Sprint(value)})
	}
}
