// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestIngestPayload_FlatHonorsPostmarkVariants(t *testing.T) {
	p := IngestPayload{
		From:        "user@example.com",
		PMSubject:   "Re: Welcome",
		PMTextBody:  "thanks!",
		PMHtmlBody:  "<p>thanks!</p>",
		PMMessageID: "<abc@mail>",
		PMHeaders: []map[string]interface{}{
			{"Name": "In-Reply-To", "Value": "<orig@mail>"},
		},
	}
	from, _, subj, msgID, inReplyTo, text, html := p.flat()
	if from != "user@example.com" {
		t.Fatalf("from: %s", from)
	}
	if subj != "Re: Welcome" {
		t.Fatalf("subject: %s", subj)
	}
	if msgID != "<abc@mail>" {
		t.Fatalf("messageID: %s", msgID)
	}
	if inReplyTo != "<orig@mail>" {
		t.Fatalf("inReplyTo: %s", inReplyTo)
	}
	if text != "thanks!" || html != "<p>thanks!</p>" {
		t.Fatalf("body: %q / %q", text, html)
	}
}

func TestIngestPayload_FlatPrefersTopLevel(t *testing.T) {
	p := IngestPayload{
		Subject:    "primary",
		PMSubject:  "fallback",
		MessageID:  "primary-id",
		InReplyTo:  "primary-irt",
		TextBody:   "primary text",
		PMTextBody: "fallback",
	}
	_, _, subj, msgID, irt, text, _ := p.flat()
	if subj != "primary" || msgID != "primary-id" || irt != "primary-irt" || text != "primary text" {
		t.Fatalf("got %s / %s / %s / %s", subj, msgID, irt, text)
	}
}

func TestAuthenticateInboundEmailRequiresFreshTimestampedSignature(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"From":"user@example.com","MessageID":"m-1"}`)
	ts := "1800000000"
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write(append([]byte(ts+"."), body...))
	sig := hex.EncodeToString(mac.Sum(nil))
	if err := authenticateInboundEmail([]byte("secret"), body, ts, sig, now); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	if !errors.Is(authenticateInboundEmail(nil, body, ts, sig, now), errInboundEmailSecretUnavailable) {
		t.Fatal("empty secret did not fail closed")
	}
	if !errors.Is(authenticateInboundEmail([]byte("secret"), body, "", sig, now), errInboundEmailMissingTimestamp) {
		t.Fatal("missing timestamp accepted")
	}
	if !errors.Is(authenticateInboundEmail([]byte("secret"), body, "1799999000", sig, now), errInboundEmailStaleTimestamp) {
		t.Fatal("stale timestamp accepted")
	}
	if !errors.Is(authenticateInboundEmail([]byte("secret"), append(body, 'x'), ts, sig, now), errInboundEmailBadSignature) {
		t.Fatal("tampered body accepted")
	}
}

func TestInboundEmailReplayKeyIsBoundedAndOpaque(t *testing.T) {
	key, err := inboundEmailReplayKey("<provider-message-id@example.com>")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "event:v1:") || strings.Contains(key, "provider-message-id") {
		t.Fatalf("replay key = %q", key)
	}
	if _, err := inboundEmailReplayKey(""); !errors.Is(err, errInboundEmailMissingEventID) {
		t.Fatalf("empty event id error = %v", err)
	}
	if _, err := inboundEmailReplayKey(strings.Repeat("x", 513)); !errors.Is(err, errInboundEmailEventIDTooLong) {
		t.Fatalf("oversized event id error = %v", err)
	}
}

func TestInsertIdempotentRejectsMalformedReplayMaterialBeforeDatabaseUse(t *testing.T) {
	repo := &Repo{}
	if _, _, err := repo.InsertIdempotent(t.Context(), "tenant", Email{}, "event:v1:short", ""); err == nil {
		t.Fatal("malformed replay material accepted")
	}
}

func TestEndpointMetadataSerializationNeverIncludesSecret(t *testing.T) {
	metadata, err := json.Marshal(Endpoint{
		ID:               "endpoint-id",
		TenantID:         "tenant-id",
		Slug:             "opaque-slug",
		SecretConfigured: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(metadata), `"secret"`) {
		t.Fatalf("metadata response exposed secret field: %s", metadata)
	}

	oneShot, err := json.Marshal(Endpoint{Secret: "iem_revealed_once"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(oneShot), `"secret":"iem_revealed_once"`) {
		t.Fatalf("one-shot response omitted secret: %s", oneShot)
	}
}
