// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// A NUL anywhere in a stranger's address must not dead-letter the reply.
//
// recipient_email was the ONE mandatory string that never reached boundedUTF8,
// while every optional field beside it did. Postgres text rejects 0x00 outright,
// so a single NUL in a From address failed the insert on every provider path —
// and this is an at-least-once ingest, so a failed insert is retried forever
// rather than dropped. The bytes come from outside; a mandatory field is not
// more trustworthy than an optional one, it is merely more load-bearing.
func TestAControlByteInTheSenderAddressIsSanitisedNotFatal(t *testing.T) {
	// Through Persist, against the real column. Asserting on boundedUTF8 alone
	// proves the helper works and says nothing about whether Persist ROUTES the
	// address through it — which was the entire defect, and which an earlier
	// version of this test failed to catch for exactly that reason.
	pool := repliesDB(t)
	receivedAt := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Microsecond)
	fixture := seedReplyFixture(t, pool, false)
	store := &Store{
		Pool: pool, EngagementClassifier: replyClassifierRuntime(t, pool),
		Now: func() time.Time { return receivedAt.Add(time.Minute) },
	}
	reply := stronglyMatchedHumanReply(fixture, receivedAt)
	// A NUL in the sender's address, exactly as a hostile or broken client sends
	// it. Postgres text rejects 0x00 outright.
	reply.RecipientEmail = strings.ToUpper(fixture.Email[:3]) + "\x00" + fixture.Email[3:]

	id, _, err := store.Persist(context.Background(), fixture.TenantID, reply)
	if err != nil {
		t.Fatalf("a NUL in the sender address failed the insert: %v — on an "+
			"at-least-once ingest this is retried forever", err)
	}
	if id == "" {
		t.Fatal("Persist returned no id")
	}

	cleaned := boundedUTF8(strings.ToLower(strings.TrimSpace("Buy\x00er@Example.COM")), 320)
	if strings.ContainsRune(cleaned, 0) {
		t.Fatalf("NUL survived sanitisation: %q", cleaned)
	}
	if cleaned != "buyer@example.com" {
		t.Fatalf("sanitised address = %q, want buyer@example.com", cleaned)
	}

	// An address made only of control bytes must be REJECTED as empty, not
	// stored as "". This is why sanitising happens before the emptiness check.
	if got := boundedUTF8(strings.ToLower(strings.TrimSpace("\x00\x00")), 320); got != "" {
		t.Fatalf("an all-NUL address sanitised to %q, want the empty string so "+
			"Persist rejects it", got)
	}
}

// The metadata blob must be valid JSON for ANY inbound header.
//
// The four provider webhooks built it with fmt %q, which is GO quoting rather
// than JSON quoting. The two agree on ordinary text and diverge exactly where
// untrusted input lives: %q renders 0x00 as the literal \x00, for which JSON has
// no escape. Store.Persist json.Unmarshals the blob and rejects it, so one NUL
// in a To header dead-lettered the reply before it reached any column that
// boundedUTF8 guards.
func TestReplyMetadataIsValidJSONForHostileHeaders(t *testing.T) {
	for _, hostile := range []string{
		"ops\x00@example.test",
		`quote"inside@example.test`,
		"back\\slash@example.test",
		"emoji-🙂@example.test",
		"newline\n@example.test",
	} {
		blob := replyMetadataJSON(map[string]string{"to": hostile})
		if len(blob) == 0 {
			t.Fatalf("no metadata produced for %q", hostile)
		}
		var decoded map[string]any
		if err := json.Unmarshal(blob, &decoded); err != nil {
			t.Fatalf("metadata for %q is not valid JSON (%v): %s", hostile, err, blob)
		}
		if _, ok := decoded["to"]; !ok {
			t.Fatalf("metadata for %q lost the `to` key: %s", hostile, blob)
		}
	}
}

// A VERP token with no subscriber must not mint a message identity.
//
// "verp:<campaign>:" is the SAME string for every subscriber-less recipient of a
// campaign, and it is not empty, so it hashes to a real message_identity_hash
// and the aggregate groups on exactly that column. Replies from N different
// strangers would be counted as one message, and message-level rules would then
// reason about burst behaviour that belongs to N different people.
func TestAVERPReplyWithNoSubscriberHasNoMessageIdentity(t *testing.T) {
	shared := replyMessageIdentity(Reply{
		MatchMethod: MatchVERP, CampaignID: "11111111-1111-4111-8111-111111111111",
		SubscriberID: "",
	})
	if shared != "" {
		t.Fatalf("a subscriber-less VERP reply minted identity %q; every stranger "+
			"replying to this campaign would share it", shared)
	}

	// Guard the guard: a real subscriber MUST still get an identity, or this
	// test would pass against a function that returned "" for everything and
	// silently removed every VERP reply from message-level aggregation.
	named := replyMessageIdentity(Reply{
		MatchMethod: MatchVERP, CampaignID: "11111111-1111-4111-8111-111111111111",
		SubscriberID: "22222222-2222-4222-8222-222222222222",
	})
	if named == "" {
		t.Fatal("a VERP reply naming a subscriber produced no message identity")
	}
	if named == shared {
		t.Fatal("named and anonymous VERP replies share one identity")
	}
}
