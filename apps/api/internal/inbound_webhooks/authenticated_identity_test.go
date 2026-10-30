// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
)

func TestInboundSignatureBindsStableEventIdentity(t *testing.T) {
	t.Parallel()

	const (
		secret    = "whsec_identity_binding"
		timestamp = "1784784000"
		eventID   = "provider-event-42"
	)
	body := []byte(`{"customer":"cus_42","state":"paid"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(authenticatedInboundPayloadV2(timestamp, eventID, body))
	signature := hex.EncodeToString(mac.Sum(nil))

	if !SignatureValid(
		secret,
		authenticatedInboundPayloadV2(timestamp, eventID, body),
		signature,
	) {
		t.Fatal("canonical timestamp + event id + body signature was rejected")
	}
	if SignatureValid(
		secret,
		authenticatedInboundPayloadV2(timestamp, "attacker-minted-id", body),
		signature,
	) {
		t.Fatal("captured signature remained valid after event-id substitution")
	}
}

func TestInboundV2CanonicalizationIsDelimiterUnambiguous(t *testing.T) {
	t.Parallel()

	first := authenticatedInboundPayloadV2("1784784000", "a", []byte(`123`))
	second := authenticatedInboundPayloadV2("1784784000", "a.1", []byte(`23`))
	if string(first) == string(second) {
		t.Fatalf("length-prefixed v2 payloads collided: %q", first)
	}
	want := `v2:10:1784784000:3:a.1:{"ok":true}`
	if got := string(authenticatedInboundPayloadV2(
		"1784784000",
		"a.1",
		[]byte(`{"ok":true}`),
	)); got != want {
		t.Fatalf("canonical v2 bytes = %q, want %q", got, want)
	}
}

func TestInboundSignatureVersionParsingNeverSilentlyDowngrades(t *testing.T) {
	t.Parallel()

	digest := strings.Repeat("a", sha256.Size*2)
	version, parsed, err := parseInboundSignature("v2=" + digest)
	if err != nil || version != "v2" || parsed != digest {
		t.Fatalf("v2 parse = %q/%q/%v", version, parsed, err)
	}
	version, parsed, err = parseInboundSignature(digest)
	if err != nil || version != "v1" || parsed != digest {
		t.Fatalf("legacy parse = %q/%q/%v", version, parsed, err)
	}
	for _, invalid := range []string{
		"v3=" + digest,
		"v2=" + strings.Repeat("g", sha256.Size*2),
		"v2=" + digest + ",v1=" + digest,
	} {
		if _, _, err := parseInboundSignature(invalid); err == nil {
			t.Errorf("invalid signature %q was accepted", invalid)
		}
	}
}

func TestInboundProviderAliasIdentityIsTheSignedIdentity(t *testing.T) {
	t.Parallel()

	header := http.Header{}
	header.Set("X-GitHub-Delivery", "github-delivery-7")
	identity, err := inboundWebhookEventIdentity(header)
	if err != nil {
		t.Fatalf("inboundWebhookEventIdentity: %v", err)
	}
	if identity != "github-delivery-7" {
		t.Fatalf("identity = %q", identity)
	}
	replayKey, err := inboundWebhookReplayKey(header)
	if err != nil {
		t.Fatalf("inboundWebhookReplayKey: %v", err)
	}
	if replayKey == "" {
		t.Fatal("provider alias did not produce a replay key")
	}
}
