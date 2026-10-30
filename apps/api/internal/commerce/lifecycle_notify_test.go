// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type fakeLifecycleEmitter struct {
	calls []struct {
		tenantID, subscriberID, eventName string
		props                             map[string]any
	}
	failOn string // event name to fail on
}

func (f *fakeLifecycleEmitter) Insert(_ context.Context, tenantID, subscriberID, eventName string, propsJSON []byte, _ time.Time, _ string) (int64, error) {
	var props map[string]any
	_ = json.Unmarshal(propsJSON, &props)
	f.calls = append(f.calls, struct {
		tenantID, subscriberID, eventName string
		props                             map[string]any
	}{tenantID, subscriberID, eventName, props})
	if f.failOn != "" && f.failOn == eventName {
		return 0, errors.New("emit failed")
	}
	return int64(len(f.calls)), nil
}

func TestLifecycleNotificationProperties(t *testing.T) {
	bis := LifecycleNotification{Kind: EventBackInStock, ProductID: "p1", VariantID: "v1",
		Title: "Shoe", URL: "http://x/p1", ImageURL: "http://x/img", PriceCents: 4999, Currency: "USD"}
	p := bis.properties()
	if p["product_id"] != "p1" || p["variant_id"] != "v1" || p["price_cents"] != 4999 || p["title"] != "Shoe" {
		t.Fatalf("back_in_stock props wrong: %+v", p)
	}
	if _, ok := p["drop_percent"]; ok {
		t.Fatalf("back_in_stock must not carry drop_percent: %+v", p)
	}

	pd := LifecycleNotification{Kind: EventPriceDrop, ProductID: "p2", Title: "Bag",
		PriceCents: 8000, OriginalPriceCents: 10000, Currency: "USD"}
	pp := pd.properties()
	if pp["new_price_cents"] != 8000 || pp["original_price_cents"] != 10000 || pp["drop_percent"] != 20 {
		t.Fatalf("price_drop props/drop_percent wrong: %+v", pp)
	}

	// No variant → variant_id omitted entirely.
	if _, ok := pp["variant_id"]; ok {
		t.Fatalf("empty variant must be omitted: %+v", pp)
	}
}

func TestEmitLifecycleNotifications(t *testing.T) {
	emitter := &fakeLifecycleEmitter{}
	items := []LifecycleNotification{
		{Kind: EventBackInStock, SubscriberID: "sub-1", ProductID: "p1", Title: "A", PriceCents: 100, Currency: "USD"},
		{Kind: EventPriceDrop, SubscriberID: "sub-2", ProductID: "p2", Title: "B", PriceCents: 80, OriginalPriceCents: 100, Currency: "USD"},
	}
	emitted, err := emitLifecycleNotifications(context.Background(), emitter, "tenant-1", time.Now(), items)
	if err != nil || emitted != 2 {
		t.Fatalf("emitted=%d err=%v want 2/nil", emitted, err)
	}
	if len(emitter.calls) != 2 {
		t.Fatalf("want 2 emitter calls, got %d", len(emitter.calls))
	}
	if emitter.calls[0].eventName != EventBackInStock || emitter.calls[0].subscriberID != "sub-1" {
		t.Fatalf("first call wrong: %+v", emitter.calls[0])
	}
	if emitter.calls[1].eventName != EventPriceDrop || emitter.calls[1].props["drop_percent"] != float64(20) {
		t.Fatalf("second call wrong: %+v", emitter.calls[1])
	}
}

func TestEmitLifecycleNotificationsPartialFailureIsCounted(t *testing.T) {
	emitter := &fakeLifecycleEmitter{failOn: EventBackInStock}
	items := []LifecycleNotification{
		{Kind: EventBackInStock, SubscriberID: "sub-1", ProductID: "p1"},
		{Kind: EventPriceDrop, SubscriberID: "sub-2", ProductID: "p2"},
	}
	emitted, err := emitLifecycleNotifications(context.Background(), emitter, "tenant-1", time.Now(), items)
	// The failing one is skipped but the loop continues; the good one is emitted.
	if emitted != 1 {
		t.Fatalf("emitted=%d want 1 (one failed, one succeeded)", emitted)
	}
	if err == nil {
		t.Fatal("expected the first error surfaced")
	}
}

// notifyEligible with no emitter wired must be a complete no-op (prior behaviour
// preserved for deployments that haven't injected the event sink).
func TestNotifyEligibleNoEmitterIsNoop(t *testing.T) {
	w := &Worker{} // Events nil
	if got := w.notifyEligible(context.Background(), LifecycleEvaluationTarget{TenantID: "t", IntegrationID: "i"}, time.Now()); got != 0 {
		t.Fatalf("no-emitter notify should be 0, got %d", got)
	}
}
