// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

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
	UpsertSubscription(ctx context.Context, tenantID, provider string, subscription SubscriptionInput) (string, error)
	UpsertShipment(ctx context.Context, tenantID, provider string, shipment ShipmentInput) (string, error)
}

type EventSink interface {
	TrackLifecycleEvent(ctx context.Context, tenantID, provider string, event LifecycleEventInput) (int64, error)
}

type subscriberUpserter interface {
	Upsert(context.Context, string, subscribers.CreateInput) (*subscribers.Subscriber, error)
}

type SubscriberLifecycleSink struct {
	Repo subscriberUpserter
}

func (s SubscriberLifecycleSink) UpsertSubscription(ctx context.Context, tenantID, provider string, subscription SubscriptionInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("subscription_integrations: profile sink unavailable")
	}
	if strings.TrimSpace(subscription.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := map[string]any{}
	for k, v := range subscription.Properties {
		props[k] = v
	}
	props["subscription_provider"] = provider
	if subscription.SourceID != "" {
		props["subscription_source_id"] = subscription.SourceID
	}
	if subscription.CustomerID != "" {
		props["subscription_customer_id"] = subscription.CustomerID
	}
	if subscription.SubscriptionID != "" {
		props["subscription_id"] = subscription.SubscriptionID
	}
	if subscription.Status != "" {
		props["subscription_status"] = subscription.Status
	}
	if subscription.ProductID != "" {
		props["subscription_product_id"] = subscription.ProductID
	}
	if subscription.SKU != "" {
		props["subscription_sku"] = subscription.SKU
	}
	if subscription.Frequency != "" {
		props["subscription_frequency"] = subscription.Frequency
	}
	if subscription.NextChargeAt != nil {
		props["subscription_next_charge_at"] = subscription.NextChargeAt.UTC().Format(time.RFC3339)
	}
	if subscription.CancelledAt != nil {
		props["subscription_cancelled_at"] = subscription.CancelledAt.UTC().Format(time.RFC3339)
	}
	tags := []string{provider, "subscription-customer"}
	if subscription.Status != "" {
		tags = append(tags, "subscription-"+slugTag(subscription.Status))
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(subscription.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             firstString(subscription.SourceID, subscription.SubscriptionID, subscription.CustomerID),
		SourcePlatform:       provider,
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_subscription_sync_at": time.Now().UTC().Format(time.RFC3339)},
	})
	if err != nil {
		return "", err
	}
	return sub.ID, nil
}

func (s SubscriberLifecycleSink) UpsertShipment(ctx context.Context, tenantID, provider string, shipment ShipmentInput) (string, error) {
	if s.Repo == nil {
		return "", fmt.Errorf("subscription_integrations: profile sink unavailable")
	}
	if strings.TrimSpace(shipment.Email) == "" {
		return "", fmt.Errorf("email is required")
	}
	props := map[string]any{}
	for k, v := range shipment.Properties {
		props[k] = v
	}
	props["shipping_provider"] = provider
	if shipment.SourceID != "" {
		props["shipping_source_id"] = shipment.SourceID
	}
	if shipment.OrderID != "" {
		props["last_shipment_order_id"] = shipment.OrderID
	}
	if shipment.TrackingNumber != "" {
		props["last_tracking_number"] = shipment.TrackingNumber
	}
	if shipment.Carrier != "" {
		props["last_shipment_carrier"] = shipment.Carrier
	}
	if shipment.Status != "" {
		props["last_shipment_status"] = shipment.Status
	}
	if shipment.ETA != nil {
		props["last_shipment_eta"] = shipment.ETA.UTC().Format(time.RFC3339)
	}
	if shipment.DeliveredAt != nil {
		props["last_shipment_delivered_at"] = shipment.DeliveredAt.UTC().Format(time.RFC3339)
	}
	tags := []string{provider, "shipment-recipient"}
	if shipment.Status != "" {
		tags = append(tags, "shipment-"+slugTag(shipment.Status))
	}
	sub, err := s.Repo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                strings.ToLower(strings.TrimSpace(shipment.Email)),
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		CustomFields:         props,
		Tags:                 tags,
		SourceID:             firstString(shipment.SourceID, shipment.TrackingNumber, shipment.OrderID),
		SourcePlatform:       provider,
		SignupSource:         subscribers.SignupSourceIntegration,
		ActivitySummary:      map[string]any{"last_shipment_sync_at": time.Now().UTC().Format(time.RFC3339)},
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

func (s TrackEventSink) TrackLifecycleEvent(ctx context.Context, tenantID, provider string, event LifecycleEventInput) (int64, error) {
	if s.Repo == nil {
		return 0, fmt.Errorf("subscription_integrations: event sink unavailable")
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
	props["lifecycle_provider"] = provider
	if event.SourceID != "" {
		props["source_id"] = event.SourceID
	}
	if event.SubscriptionID != "" {
		props["subscription_id"] = event.SubscriptionID
	}
	if event.OrderID != "" {
		props["order_id"] = event.OrderID
	}
	if event.TrackingNumber != "" {
		props["tracking_number"] = event.TrackingNumber
	}
	if event.Status != "" {
		props["status"] = event.Status
	}
	raw, _ := json.Marshal(props)
	occurred := time.Now().UTC()
	if event.OccurredAt != nil {
		occurred = event.OccurredAt.UTC()
	}
	eventName := firstString(event.EventName, "lifecycle.event")
	return s.Repo.Insert(ctx, tenantID, sub.ID, eventName, raw, occurred, "")
}

func subscriptionEvent(subscription SubscriptionInput) LifecycleEventInput {
	eventName := "subscription.updated"
	if subscription.Status != "" {
		eventName = "subscription." + slugTag(subscription.Status)
	}
	return LifecycleEventInput{
		SourceID:       subscription.SourceID,
		Email:          subscription.Email,
		EventName:      eventName,
		SubscriptionID: subscription.SubscriptionID,
		Status:         subscription.Status,
		Properties: map[string]any{
			"customer_id":     subscription.CustomerID,
			"product_id":      subscription.ProductID,
			"sku":             subscription.SKU,
			"frequency":       subscription.Frequency,
			"next_charge_at":  timePtrString(subscription.NextChargeAt),
			"cancelled_at":    timePtrString(subscription.CancelledAt),
			"subscription_id": subscription.SubscriptionID,
		},
		OccurredAt: subscription.UpdatedAt,
	}
}

func shipmentEvent(shipment ShipmentInput) LifecycleEventInput {
	eventName := "shipment.updated"
	if shipment.Status != "" {
		eventName = "shipment." + slugTag(shipment.Status)
	}
	return LifecycleEventInput{
		SourceID:       shipment.SourceID,
		Email:          shipment.Email,
		EventName:      eventName,
		OrderID:        shipment.OrderID,
		TrackingNumber: shipment.TrackingNumber,
		Status:         shipment.Status,
		Properties: map[string]any{
			"order_id":        shipment.OrderID,
			"tracking_number": shipment.TrackingNumber,
			"carrier":         shipment.Carrier,
			"eta":             timePtrString(shipment.ETA),
			"delivered_at":    timePtrString(shipment.DeliveredAt),
		},
		OccurredAt: shipment.UpdatedAt,
	}
}

func timePtrString(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
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
