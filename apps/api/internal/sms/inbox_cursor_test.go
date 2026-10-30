package sms

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestInboxCursorEncryptedBoundAndRotatable(t *testing.T) {
	current := bytes.Repeat([]byte{0x42}, 32)
	previous := bytes.Repeat([]byte{0x24}, 32)
	tenant := "11111111-1111-4111-8111-111111111111"
	query := "private@example.com"
	binding := inboxCursorBinding(tenant, "admin", query)
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	position := inboxCursorPosition{
		SnapshotAt: now,
		KeyAt:      now.Add(-time.Minute),
		KeyID:      "+14155551212",
	}
	token, err := encodeInboxCursor(previous, tenant, "search", binding, position)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{query, position.KeyID, tenant, binding} {
		if strings.Contains(token, secret) {
			t.Fatalf("cursor exposed plaintext %q", secret)
		}
	}
	got, err := decodeInboxCursor([][]byte{current, previous}, token, tenant, "search", binding, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyID != position.KeyID || !got.KeyAt.Equal(position.KeyAt) || !got.SnapshotAt.Equal(position.SnapshotAt) {
		t.Fatalf("decoded position mismatch: %+v", got)
	}
	if _, err := decodeInboxCursor([][]byte{current, previous}, token, "22222222-2222-4222-8222-222222222222", "search", binding, now); !errors.Is(err, errInboxInvalidCursor) {
		t.Fatalf("cross-tenant cursor error=%v", err)
	}
	if _, err := decodeInboxCursor([][]byte{current, previous}, token, tenant, "messages", binding, now); !errors.Is(err, errInboxInvalidCursor) {
		t.Fatalf("cross-kind cursor error=%v", err)
	}
	if _, err := decodeInboxCursor([][]byte{current, previous}, token, tenant, "search", inboxCursorBinding(tenant, "admin", "different"), now); !errors.Is(err, errInboxCursorMismatch) {
		t.Fatalf("query-bound AAD error=%v", err)
	}
}

func TestInboxCursorTamperExpiryAndKeyAvailability(t *testing.T) {
	key := bytes.Repeat([]byte{0x7a}, 32)
	tenant := "11111111-1111-4111-8111-111111111111"
	binding := inboxCursorBinding(tenant, "admin", "recent")
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	token, err := encodeInboxCursor(key, tenant, "conversations", binding, inboxCursorPosition{
		SnapshotAt: now, KeyAt: now, KeyID: "+14155551212",
	})
	if err != nil {
		t.Fatal(err)
	}
	tamperAt := len("v1.") + (len(token)-len("v1."))/2
	replacement := byte('A')
	if token[tamperAt] == replacement {
		replacement = 'B'
	}
	tampered := token[:tamperAt] + string(replacement) + token[tamperAt+1:]
	if _, err := decodeInboxCursor([][]byte{key}, tampered, tenant, "conversations", binding, now); !errors.Is(err, errInboxInvalidCursor) {
		t.Fatalf("tampered cursor error=%v", err)
	}
	if _, err := decodeInboxCursor([][]byte{key}, token, tenant, "conversations", binding, now.Add(inboxCursorTTL)); !errors.Is(err, errInboxCursorExpired) {
		t.Fatalf("expired cursor error=%v", err)
	}
	if _, err := decodeInboxCursor([][]byte{bytes.Repeat([]byte{1}, 31)}, token, tenant, "conversations", binding, now); !errors.Is(err, errInboxCursorUnavailable) {
		t.Fatalf("short key error=%v", err)
	}
}
