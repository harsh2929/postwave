// SPDX-License-Identifier: AGPL-3.0-only
package pushsend

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

type fakeDeviceResolver struct {
	devices     map[string][]Device // subscriberID -> allowed devices
	resolutions map[string]DeviceResolution
	err         error
}

func (f fakeDeviceResolver) WithSendableDevices(
	ctx context.Context,
	_, subscriberID string,
	use func(context.Context, DeviceResolution) error,
) error {
	if f.err != nil {
		return f.err
	}
	if resolution, ok := f.resolutions[subscriberID]; ok {
		return use(ctx, resolution)
	}
	devices := f.devices[subscriberID]
	return use(ctx, DeviceResolution{
		Devices:      devices,
		EnabledCount: len(devices),
	})
}

type fakeTemplateGetter struct {
	tmpl *omnichannel.MessageTemplate
	err  error
}

func (f fakeTemplateGetter) GetTemplate(context.Context, string, string) (*omnichannel.MessageTemplate, error) {
	return f.tmpl, f.err
}

type fakePushProvider struct {
	sent  []string // tokens sent to
	err   error
	calls int
}

func (f *fakePushProvider) SendPush(_ context.Context, token, _, _, _ string, _ map[string]any) error {
	f.calls++
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, token)
	return nil
}

// ---------------------------------------------------------------------
// Token resolution: PushSender resolves a subscriber's devices and routes
// each to the platform-appropriate provider.
// ---------------------------------------------------------------------

func TestPushSender_ResolvesDevicesAndRoutesByPlatform(t *testing.T) {
	apns := &fakePushProvider{}
	fcm := &fakePushProvider{}
	s := PushSender{
		Devices: fakeDeviceResolver{devices: map[string][]Device{
			"sub1": {
				{Token: "ios-token-01234567890", Platform: "ios"},
				{Token: "android-token-0123456", Platform: "android"},
			},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{Subject: "Hi", BodyText: "hello there"}},
		APNs:      apns,
		FCM:       fcm,
	}

	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})

	if out.Status != "sent" || out.Provider != "push" {
		t.Fatalf("expected sent push, got %+v", out)
	}
	if len(apns.sent) != 1 || apns.sent[0] != "ios-token-01234567890" {
		t.Fatalf("expected APNs to receive exact token, got %+v", apns.sent)
	}
	if len(fcm.sent) != 1 || fcm.sent[0] != "android-token-0123456" {
		t.Fatalf("expected FCM to receive exact token, got %+v", fcm.sent)
	}
}

func TestPushSender_NoDevices_Fails(t *testing.T) {
	s := PushSender{
		Devices:   fakeDeviceResolver{devices: map[string][]Device{}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub-none", TemplateID: "tmpl1",
	})
	if out.Status != "failed" || out.Reason == "" {
		t.Fatalf("subscriber with no devices must fail with a reason, got %+v", out)
	}
}

func TestPushSender_MixedSuppression_SendsOnlyAllowedDevice(t *testing.T) {
	apns := &fakePushProvider{}
	fcm := &fakePushProvider{}
	s := PushSender{
		Devices: fakeDeviceResolver{resolutions: map[string]DeviceResolution{
			"sub1": {
				Devices:         []Device{{Token: "android-allowed-012345", Platform: "android"}},
				EnabledCount:    2,
				SuppressedCount: 1,
			},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      apns,
		FCM:       fcm,
	}

	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})

	if out.Status != "sent" {
		t.Fatalf("mixed resolution should send its one allowed device: %+v", out)
	}
	if apns.calls != 0 {
		t.Fatalf("suppressed APNs device reached provider: calls=%d", apns.calls)
	}
	if fcm.calls != 1 || len(fcm.sent) != 1 || fcm.sent[0] != "android-allowed-012345" {
		t.Fatalf("allowed Android device was not sent exactly once: calls=%d sent=%v", fcm.calls, fcm.sent)
	}
}

func TestPushSender_AllSuppressed_FailsWithoutProviderCall(t *testing.T) {
	apns := &fakePushProvider{}
	fcm := &fakePushProvider{}
	s := PushSender{
		Devices: fakeDeviceResolver{resolutions: map[string]DeviceResolution{
			"sub1": {EnabledCount: 2, SuppressedCount: 2},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      apns,
		FCM:       fcm,
	}

	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})

	if out.Status != "failed" || out.Reason != "all enabled push devices are suppressed" {
		t.Fatalf("all-suppressed resolution must fail closed: %+v", out)
	}
	if apns.calls != 0 || fcm.calls != 0 {
		t.Fatalf("all-suppressed resolution called providers: apns=%d fcm=%d", apns.calls, fcm.calls)
	}
}

func TestPushSender_DeviceLookupError_Fails(t *testing.T) {
	apns := &fakePushProvider{}
	fcm := &fakePushProvider{}
	s := PushSender{
		Devices:   fakeDeviceResolver{err: errors.New("db down")},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      apns,
		FCM:       fcm,
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})
	if out.Status != "failed" || out.Reason == "" {
		t.Fatalf("device lookup error must surface as failed: %+v", out)
	}
	if apns.calls != 0 || fcm.calls != 0 {
		t.Fatalf("resolver/checker error called providers: apns=%d fcm=%d", apns.calls, fcm.calls)
	}
}

func TestPushSender_MappingAmbiguity_FailsBeforeAnyProviderCall(t *testing.T) {
	apns := &fakePushProvider{}
	fcm := &fakePushProvider{}
	s := PushSender{
		Devices: fakeDeviceResolver{resolutions: map[string]DeviceResolution{
			"sub1": {
				Devices: []Device{
					{Token: "valid-first-012345678", Platform: "ios"},
					{Token: "ambiguous-second-01234", Platform: "web"},
				},
				EnabledCount: 2,
			},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      apns,
		FCM:       fcm,
	}

	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})

	if out.Status != "failed" || out.Reason != "push device eligibility is ambiguous" {
		t.Fatalf("unknown platform must fail the complete resolution: %+v", out)
	}
	if apns.calls != 0 || fcm.calls != 0 {
		t.Fatalf("mapping ambiguity called providers: apns=%d fcm=%d", apns.calls, fcm.calls)
	}
}

func TestPushSender_InconsistentSuppressionCounts_FailBeforeProviderCall(t *testing.T) {
	apns := &fakePushProvider{}
	s := PushSender{
		Devices: fakeDeviceResolver{resolutions: map[string]DeviceResolution{
			"sub1": {
				Devices:         []Device{{Token: "token-012345678901234", Platform: "ios"}},
				EnabledCount:    1,
				SuppressedCount: 1,
			},
		}},
		APNs: apns,
	}

	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})
	if out.Status != "failed" || apns.calls != 0 {
		t.Fatalf("partial/ambiguous suppression resolution must fail closed: outcome=%+v calls=%d", out, apns.calls)
	}
}

func TestPushSender_NoSubscriberID_Fails(t *testing.T) {
	s := PushSender{Devices: fakeDeviceResolver{}}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "push"})
	if out.Status != "failed" {
		t.Fatalf("missing subscriber id must fail: %+v", out)
	}
}

func TestPushSender_MissingTemplate_Fails(t *testing.T) {
	s := PushSender{
		Devices: fakeDeviceResolver{devices: map[string][]Device{
			"sub1": {{Token: "token-012345678901234", Platform: "ios"}},
		}},
		Templates: fakeTemplateGetter{tmpl: nil},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "missing",
	})
	if out.Status != "failed" {
		t.Fatalf("nil template must fail: %+v", out)
	}
}

func TestPushSenderNeverPersistsTemplateRepositoryError(t *testing.T) {
	const privateDetail = "tenant=private SQLSTATE=XX000"
	s := PushSender{
		Devices:   fakeDeviceResolver{},
		Templates: fakeTemplateGetter{err: errors.New(privateDetail)},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})
	if out.Status != "failed" || out.Reason != "push notification content unavailable" ||
		strings.Contains(out.Reason, privateDetail) {
		t.Fatalf("durable reason retained repository evidence: %+v", out)
	}
}

func TestPushSender_ProviderSendError_Fails(t *testing.T) {
	s := PushSender{
		Devices: fakeDeviceResolver{devices: map[string][]Device{
			"sub1": {{Token: "token-012345678901234", Platform: "ios"}},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      &fakePushProvider{err: errors.New("APNs push credentials not configured")},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})
	if out.Status != "failed" || out.Reason != "push provider delivery failed" {
		t.Fatalf("provider errors must collapse to a durable-safe reason: %+v", out)
	}
}

func TestPushSenderNeverPersistsProviderErrorOrRawToken(t *testing.T) {
	const token = "private-token-0123456789"
	s := PushSender{
		Devices: fakeDeviceResolver{devices: map[string][]Device{
			"sub1": {{Token: token, Platform: "ios"}},
		}},
		Templates: fakeTemplateGetter{tmpl: &omnichannel.MessageTemplate{BodyText: "hi"}},
		APNs:      &fakePushProvider{err: errors.New("Post https://api.push.apple.com/3/device/" + token)},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "push", SubscriberID: "sub1", TemplateID: "tmpl1",
	})
	if out.Reason != "push provider delivery failed" || strings.Contains(out.Reason, token) {
		t.Fatalf("durable reason retained provider-controlled secret: %+v", out)
	}
}

// ---------------------------------------------------------------------
// Non-push channel: falls through to Next, or queues with no Next — same
// contract as omnichannel.EmailSender.
// ---------------------------------------------------------------------

func TestPushSender_NonPushChannel_FallsThroughToNext(t *testing.T) {
	next := stubSender{out: omnichannel.SendOutcome{Status: "sent", Provider: "sms"}}
	s := PushSender{Next: next}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "sms"})
	if out.Status != "sent" || out.Provider != "sms" {
		t.Fatalf("non-push channel must fall through to Next: %+v", out)
	}
}

func TestPushSender_NonPushChannel_NoNext_Queues(t *testing.T) {
	s := PushSender{}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "sms"})
	if out.Status != "queued" {
		t.Fatalf("non-push channel with no Next must queue: %+v", out)
	}
}

func TestPushSender_NotConfigured_Queues(t *testing.T) {
	s := PushSender{} // Devices is nil
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "push", SubscriberID: "sub1"})
	if out.Status != "queued" || out.Reason == "" {
		t.Fatalf("unconfigured push sender must queue with a reason, got %+v", out)
	}
}

type stubSender struct{ out omnichannel.SendOutcome }

func (s stubSender) Send(context.Context, string, omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	return s.out
}
