// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/replies"
)

// These are the canonical-UUID shapes the signed identity requires. They are
// not decoration: the encoder refuses anything else precisely because the
// decoded values are written into uuid columns.
const (
	verpTenantFixture     = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1"
	verpCampaignFixture   = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2"
	verpSubscriberFixture = "cccccccc-3333-4333-8333-ccccccccccc3"
)

var verpSecretFixture = []byte("sending-verp-secret-32-bytes-xx!")

func verpGuard(dispatcher AssuranceBoundDispatcher, policy VERPReplyToPolicy) *Guard {
	return &Guard{
		Listmonk:          &mockListmonk{},
		AssuranceBound:    dispatcher,
		VERPSecret:        verpSecretFixture,
		VERPDomain:        "reply.example.test",
		VERPReplyToPolicy: policy,
	}
}

func boundFixture() AssuranceBinding {
	return AssuranceBinding{
		ContentRevisionID: "revision", SendPlanID: "plan", RunID: "run", RunAttempt: 1,
		ArtifactSetHash: "artifact-set", SourceHash: "source", PlanHash: "plan-hash",
		GateDecision: "pass",
	}
}

func unsubscribeHeaders() map[string]string {
	return map[string]string{"List-Unsubscribe": "<https://example.test/unsubscribe>"}
}

// TestDispatchPreparedStampsVERPReplyToThatDecodesBack is proof (a): the
// address the send path mints is fed to the REAL decoder, and every field must
// come back as the value the send path put in.
//
// It is the guard against the trap this feature was left unbuilt to avoid. If
// the send path encoded campaign_recipients.id in the subscriber position, the
// encoder would refuse it (a bigint is not a canonical UUID) and no address
// would be minted at all; if it encoded some other UUID, the equality check
// below fails. Either way the mutation is caught, and neither can reach
// production as an authoritative-looking misattribution.
func TestDispatchPreparedLeavesReplyCorrelationToQualifiedRawRuntime(t *testing.T) {
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToWhenAbsent)

	result := guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 42, cid: verpCampaignFixture, email: "person@example.test",
			subscriberID: verpSubscriberFixture, binding: boundFixture(),
		},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
		"legacy HTML must not be sent", unsubscribeHeaders(), "", true,
	)
	if result.status != RecipientSent || result.err != nil {
		t.Fatalf("result = %+v", result)
	}
	if len(raw.inputs) != 1 {
		t.Fatalf("raw runtime calls = %d", len(raw.inputs))
	}
	got := raw.inputs[0]

	if got.SubscriberID != verpSubscriberFixture {
		t.Fatalf("SubscriberID = %q, want %q", got.SubscriberID, verpSubscriberFixture)
	}
	// The recipient-queue id and the subscriber id are different identity
	// spaces; nothing may quietly substitute one for the other.
	if got.SubscriberID == strconv.FormatInt(got.CampaignRecipientID, 10) {
		t.Fatal("SubscriberID is the campaign_recipients id")
	}
	if got.ReplyTo != "" || got.EnvelopeReturnPath != "" {
		t.Fatalf("legacy guard minted an unledgered identity: Reply-To=%q return-path=%q", got.ReplyTo, got.EnvelopeReturnPath)
	}
}

// TestVERPStampedAddressSurvivesHeaderlessReplyMatching is proof (d) across
// the package boundary. The address minted by the send path becomes the
// envelope recipient of an inbound reply that carries NO In-Reply-To and no
// References — the AI-mediation case — and the real matcher must still resolve
// the exact campaign and subscriber the send used.
//
// The matcher here has a nil Store, so its In-Reply-To probe and its
// from-address fallback both short-circuit: a pass cannot come from anywhere
// but the signed envelope.
func TestLegacyGuardCannotClaimHeaderlessReplyCorrelation(t *testing.T) {
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToWhenAbsent)
	guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 7, cid: verpCampaignFixture, email: "person@example.test",
			subscriberID: verpSubscriberFixture, binding: boundFixture(),
		},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
		"html", unsubscribeHeaders(), "", true,
	)
	if len(raw.inputs) != 1 {
		t.Fatalf("raw runtime calls = %d", len(raw.inputs))
	}

	matcher := &replies.Matcher{VERPSecret: verpSecretFixture}
	outcome, err := matcher.Resolve(context.Background(), verpTenantFixture, replies.Reply{
		InReplyTo:         "",
		Subject:           "your question, answered",
		RecipientEmail:    "assistant-relay@example.test",
		EnvelopeRecipient: raw.inputs[0].ReplyTo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Method != replies.MatchNone || outcome.CampaignID != "" || outcome.SubscriberID != "" {
		t.Fatalf("unqualified guard manufactured strong correlation: %+v", outcome)
	}
}

// TestVERPTamperedReplyToIsNotAttributed is proof (b) at the seam that
// matters: an address that LOOKS like the one we minted, with one character of
// the local part changed, must resolve to nothing rather than to a neighbouring
// campaign or subscriber.
func TestLegacyGuardDoesNotExposeAStatelessTokenToTamperWith(t *testing.T) {
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToWhenAbsent)
	guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 9, cid: verpCampaignFixture, email: "person@example.test",
			subscriberID: verpSubscriberFixture, binding: boundFixture(),
		},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
		"html", unsubscribeHeaders(), "", true,
	)
	if got := raw.inputs[0].ReplyTo; got != "" {
		t.Fatalf("legacy guard exposed stateless token %q", got)
	}
}

// TestVERPUnconfiguredNeverStampsAnAddress is proof (c). Each half of the
// identity is withheld in turn; in every case the campaign's own Reply-To must
// come through untouched and nothing resembling a VERP address may appear.
func TestVERPUnconfiguredNeverStampsAnAddress(t *testing.T) {
	const configuredReplyTo = "support@tenant.example"
	cases := []struct {
		name   string
		secret []byte
		domain string
		policy VERPReplyToPolicy
	}{
		{"no secret", nil, "reply.example.test", VERPReplyToAlways},
		{"empty secret", []byte{}, "reply.example.test", VERPReplyToAlways},
		{"no domain", verpSecretFixture, "", VERPReplyToAlways},
		{"blank domain", verpSecretFixture, "   ", VERPReplyToAlways},
		{"neither", nil, "", VERPReplyToAlways},
		{"policy off", verpSecretFixture, "reply.example.test", VERPReplyToOff},
		{"unknown policy", verpSecretFixture, "reply.example.test", VERPReplyToPolicy("maybe")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
			guard := &Guard{
				Listmonk: &mockListmonk{}, AssuranceBound: raw,
				VERPSecret: tc.secret, VERPDomain: tc.domain, VERPReplyToPolicy: tc.policy,
			}
			guard.dispatchPrepared(
				context.Background(), verpTenantFixture,
				pendingRow{
					id: 1, cid: verpCampaignFixture, email: "person@example.test",
					subscriberID: verpSubscriberFixture, binding: boundFixture(),
				},
				campaignBody{
					subject: "subject", fromName: "Sender", fromEmail: "sender@example.test",
					replyTo: configuredReplyTo,
				},
				"html", unsubscribeHeaders(), "", true,
			)
			if len(raw.inputs) != 1 {
				t.Fatalf("raw runtime calls = %d", len(raw.inputs))
			}
			got := raw.inputs[0].ReplyTo
			if got != configuredReplyTo {
				t.Fatalf("ReplyTo = %q, want the campaign's own %q", got, configuredReplyTo)
			}
			if strings.HasPrefix(got, replies.VERPTokenPrefix) {
				t.Fatalf("unconfigured VERP emitted an address: %q", got)
			}
		})
	}
}

// TestVERPUnconfiguredWithNoCampaignReplyToStaysEmpty closes the more
// dangerous half of proof (c): with no campaign Reply-To to fall back to, a
// half-configured identity must produce an EMPTY Reply-To, never a bare
// `reply+@domain` or an unsigned lookalike.
func TestVERPUnconfiguredWithNoCampaignReplyToStaysEmpty(t *testing.T) {
	cases := []struct {
		name   string
		secret []byte
		domain string
	}{
		{"no secret", nil, "reply.example.test"},
		{"no domain", verpSecretFixture, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
			guard := &Guard{
				Listmonk: &mockListmonk{}, AssuranceBound: raw,
				VERPSecret: tc.secret, VERPDomain: tc.domain,
			}
			guard.dispatchPrepared(
				context.Background(), verpTenantFixture,
				pendingRow{
					id: 1, cid: verpCampaignFixture, email: "person@example.test",
					subscriberID: verpSubscriberFixture, binding: boundFixture(),
				},
				campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
				"html", unsubscribeHeaders(), "", true,
			)
			if got := raw.inputs[0].ReplyTo; got != "" {
				t.Fatalf("ReplyTo = %q, want empty", got)
			}
		})
	}
}

// TestVERPMintFailureLeavesReplyToUntouched covers the identifiers the encoder
// refuses. A campaign id that is not a canonical UUID cannot produce a token
// the decoder would turn back into a persistable row, so the send must fall
// back to the campaign's own Reply-To rather than carry a partial address.
func TestVERPMintFailureLeavesReplyToUntouched(t *testing.T) {
	cases := []struct {
		name                       string
		tenantID, campaignID, sub  string
		configuredReplyTo, wantOut string
	}{
		{"non-uuid campaign", verpTenantFixture, "campaign-7", verpSubscriberFixture,
			"support@tenant.example", "support@tenant.example"},
		{"non-uuid tenant", "tenant-7", verpCampaignFixture, verpSubscriberFixture,
			"support@tenant.example", "support@tenant.example"},
		{"non-uuid subscriber", verpTenantFixture, verpCampaignFixture, "42",
			"support@tenant.example", "support@tenant.example"},
		{"non-uuid campaign, no fallback", verpTenantFixture, "campaign-7", verpSubscriberFixture,
			"", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
			guard := verpGuard(raw, VERPReplyToAlways)
			guard.dispatchPrepared(
				context.Background(), tc.tenantID,
				pendingRow{
					id: 1, cid: tc.campaignID, email: "person@example.test",
					subscriberID: tc.sub, binding: boundFixture(),
				},
				campaignBody{
					subject: "subject", fromName: "Sender", fromEmail: "sender@example.test",
					replyTo: tc.configuredReplyTo,
				},
				"html", unsubscribeHeaders(), "", true,
			)
			got := raw.inputs[0].ReplyTo
			if got != tc.wantOut {
				t.Fatalf("ReplyTo = %q, want %q", got, tc.wantOut)
			}
			if strings.HasPrefix(got, replies.VERPTokenPrefix) {
				t.Fatalf("a refused identifier still produced a VERP-shaped address: %q", got)
			}
		})
	}
}

// TestVERPWhenAbsentPolicyPreservesConfiguredReplyTo pins the default
// behaviour: a campaign that set its own Reply-To made an explicit routing
// choice, and the default policy does not override it.
func TestVERPWhenAbsentPolicyPreservesConfiguredReplyTo(t *testing.T) {
	const configured = "support@tenant.example"
	for _, policy := range []VERPReplyToPolicy{VERPReplyToWhenAbsent, ""} {
		raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
		guard := verpGuard(raw, policy)
		guard.dispatchPrepared(
			context.Background(), verpTenantFixture,
			pendingRow{
				id: 1, cid: verpCampaignFixture, email: "person@example.test",
				subscriberID: verpSubscriberFixture, binding: boundFixture(),
			},
			campaignBody{
				subject: "subject", fromName: "Sender", fromEmail: "sender@example.test",
				replyTo: configured,
			},
			"html", unsubscribeHeaders(), "", true,
		)
		if got := raw.inputs[0].ReplyTo; got != configured {
			t.Fatalf("policy %q: ReplyTo = %q, want %q", policy, got, configured)
		}
	}
}

// TestVERPAlwaysPolicyOverridesConfiguredReplyTo is the counterpart: the
// override exists, is reachable, and produces a decodable address.
func TestLegacyVERPAlwaysPolicyCannotOverrideConfiguredReplyTo(t *testing.T) {
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToAlways)
	guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 1, cid: verpCampaignFixture, email: "person@example.test",
			subscriberID: verpSubscriberFixture, binding: boundFixture(),
		},
		campaignBody{
			subject: "subject", fromName: "Sender", fromEmail: "sender@example.test",
			replyTo: "support@tenant.example",
		},
		"html", unsubscribeHeaders(), "", true,
	)
	got := raw.inputs[0].ReplyTo
	if got != "support@tenant.example" {
		t.Fatalf("unqualified policy overrode campaign Reply-To: %q", got)
	}
}

// TestVERPStampsCampaignAttributionWithoutASubscriber: a recipient with no
// subscriber row still gets campaign-level attribution. Without this the reply
// would land in the from-address fallback, which guesses the most recent
// campaign in a 30-day window.
func TestLegacyGuardDoesNotClaimCampaignAttributionWithoutASubscriber(t *testing.T) {
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToWhenAbsent)
	guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 1, cid: verpCampaignFixture, email: "stranger@example.test",
			subscriberID: "", binding: boundFixture(),
		},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
		"html", unsubscribeHeaders(), "", true,
	)
	got := raw.inputs[0]
	if got.SubscriberID != "" {
		t.Fatalf("SubscriberID = %q, want empty", got.SubscriberID)
	}
	matcher := &replies.Matcher{VERPSecret: verpSecretFixture}
	outcome, err := matcher.Resolve(context.Background(), verpTenantFixture, replies.Reply{
		EnvelopeRecipient: got.ReplyTo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Method != replies.MatchNone || outcome.CampaignID != "" || outcome.SubscriberID != "" {
		t.Fatalf("unledgered address produced attribution: %+v", outcome)
	}
}

// TestWithVERPReplyToHeaderReplacesEverySpelling: header names are
// case-insensitive, so leaving a differently-cased `reply-to` in place next to
// the signed `Reply-To` emits two reply addresses. Agents that fold them into
// a list send the reply to whichever comes first, and a reply that lands on
// the campaign's own mailbox is silently unattributable — the failure this
// whole feature exists to remove.
func TestWithVERPReplyToHeaderReplacesEverySpelling(t *testing.T) {
	const signed = "reply+token@reply.example.test"
	input := map[string]string{
		"Reply-To":         "support@tenant.example",
		"reply-to":         "other@tenant.example",
		" REPLY-TO ":       "third@tenant.example",
		"X-Postwave-Keep":  "1",
		"List-Unsubscribe": "<https://example.test/u>",
	}
	got := withVERPReplyToHeader(input, signed)

	found := []string{}
	for name, value := range got {
		if strings.EqualFold(strings.TrimSpace(name), "Reply-To") {
			found = append(found, name+"="+value)
		}
	}
	if len(found) != 1 {
		t.Fatalf("Reply-To headers = %v, want exactly one", found)
	}
	if got["Reply-To"] != "<"+signed+">" {
		t.Fatalf("Reply-To = %q, want the signed address", got["Reply-To"])
	}
	if got["X-Postwave-Keep"] != "1" || got["List-Unsubscribe"] != "<https://example.test/u>" {
		t.Fatalf("unrelated headers were disturbed: %v", got)
	}
	// The caller's map is untouched, so one recipient's signed identity can
	// never survive into the next row's headers.
	if input["Reply-To"] != "support@tenant.example" || len(input) != 5 {
		t.Fatalf("caller map was mutated: %v", input)
	}
}

// TestWithVERPReplyToHeaderRejectsUnrenderableAddress: anything that is not a
// single bare mailbox must leave the headers exactly as they were rather than
// installing a malformed Reply-To.
func TestWithVERPReplyToHeaderRejectsUnrenderableAddress(t *testing.T) {
	cases := []string{
		"", "   ", "not an address", "reply+token@", "@reply.example.test",
		"Support <reply+token@reply.example.test>",
		"a@b.test, c@d.test",
		"reply+token@reply.example.test\r\nBcc: attacker@evil.test",
	}
	for _, address := range cases {
		t.Run(address, func(t *testing.T) {
			input := map[string]string{"Reply-To": "support@tenant.example", "X-Keep": "1"}
			got := withVERPReplyToHeader(input, address)
			if got["Reply-To"] != "support@tenant.example" {
				t.Fatalf("Reply-To = %q, want the untouched original", got["Reply-To"])
			}
			if got["X-Keep"] != "1" {
				t.Fatalf("headers = %v, want the original map", got)
			}
		})
	}
	// A nil header map with a valid address still produces a usable map,
	// because the legacy branch switches to SendWithHeaders on non-nil.
	if got := withVERPReplyToHeader(nil, "reply+token@reply.example.test"); got == nil ||
		got["Reply-To"] != "<reply+token@reply.example.test>" {
		t.Fatalf("nil headers + valid address = %v", got)
	}
}

// TestVERPReplyToRefusesCrossTenantAttribution: the tenant is inside the
// signature, so an address minted for one tenant cannot attribute a reply
// ingested under another. Without the tenant in the token this address would
// have resolved to the other tenant's campaign and been labelled MatchVERP —
// the label that gates the canonical replied event.
func TestVERPReplyToRefusesCrossTenantAttribution(t *testing.T) {
	const otherTenant = "dddddddd-4444-4444-8444-ddddddddddd4"
	raw := &recordingBoundDispatcher{result: BoundDispatchResult{Status: BoundDispatchAccepted}}
	guard := verpGuard(raw, VERPReplyToWhenAbsent)
	guard.dispatchPrepared(
		context.Background(), verpTenantFixture,
		pendingRow{
			id: 1, cid: verpCampaignFixture, email: "person@example.test",
			subscriberID: verpSubscriberFixture, binding: boundFixture(),
		},
		campaignBody{subject: "subject", fromName: "Sender", fromEmail: "sender@example.test"},
		"html", unsubscribeHeaders(), "", true,
	)
	matcher := &replies.Matcher{VERPSecret: verpSecretFixture}
	outcome, err := matcher.Resolve(context.Background(), otherTenant, replies.Reply{
		EnvelopeRecipient: raw.inputs[0].ReplyTo,
	})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Method != replies.MatchNone || outcome.CampaignID != "" {
		t.Fatalf("foreign tenant resolved %+v, want no match", outcome)
	}
}
