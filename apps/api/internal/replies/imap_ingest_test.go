// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// A mailbox connected today is full of years of mail that are not replies to
// campaigns we sent. Ingesting that history would fabricate engagement and,
// worse, attribute it to whichever campaign the matcher happened to fit.
func TestFirstPollStartsAtTheCurrentHighWaterMark(t *testing.T) {
	fresh := Mailbox{}
	since, reset := PlanFetch(fresh, MailboxSnapshot{UIDValidity: 1000, UIDNext: 4211})
	if since != 4210 {
		t.Fatalf("first poll starts at UID %d, want the high-water mark 4210", since)
	}
	if reset {
		t.Fatal("a first poll is not a UIDVALIDITY reset")
	}
}

func TestSteadyStatePollResumesAboveTheStoredCursor(t *testing.T) {
	stored := Mailbox{UIDValidity: 1000, LastUID: 512}
	since, reset := PlanFetch(stored, MailboxSnapshot{UIDValidity: 1000, UIDNext: 600})
	if since != 512 {
		t.Fatalf("resumed at %d, want 512", since)
	}
	if reset {
		t.Fatal("an unchanged UIDVALIDITY is not a reset")
	}
}

// The server renumbered, so every stored UID now means something else.
// Resuming from UID 0 would re-read the whole mailbox and duplicate every reply
// already ingested under the previous numbering.
func TestUIDValidityChangeResumesAtTheNewHighWaterMarkNotZero(t *testing.T) {
	stored := Mailbox{UIDValidity: 1000, LastUID: 512}
	since, reset := PlanFetch(stored, MailboxSnapshot{UIDValidity: 2000, UIDNext: 31})
	if !reset {
		t.Fatal("a changed UIDVALIDITY was not reported as a reset")
	}
	if since != 30 {
		t.Fatalf("resumed at %d after renumbering, want the new high-water mark 30", since)
	}
	if since == 0 {
		t.Fatal("resuming at 0 would re-ingest the entire mailbox")
	}
}

// An empty mailbox reports UIDNext 1, so the high-water mark is 0 and the
// arithmetic must not underflow into 4294967295 — which would skip every
// message the mailbox ever receives.
func TestAnEmptyMailboxDoesNotUnderflowTheHighWaterMark(t *testing.T) {
	since, _ := PlanFetch(Mailbox{}, MailboxSnapshot{UIDValidity: 1000, UIDNext: 1})
	if since != 0 {
		t.Fatalf("empty mailbox planned from UID %d, want 0", since)
	}
	since, _ = PlanFetch(Mailbox{}, MailboxSnapshot{UIDValidity: 1000, UIDNext: 0})
	if since != 0 {
		t.Fatalf("a zero UIDNext planned from %d, want 0", since)
	}
}

// The caller must not pre-classify or name its own correlation: Store.Persist
// classifies centrally, and a source that named its own method could turn an
// unattributed message into strong-correlation evidence.
func TestMappingSetsOnlyWhatTheMessageSays(t *testing.T) {
	reply := toReply(FetchedMessage{
		UID: 7, From: " reader@example.test ", Subject: " Re: launch ",
		InReplyTo: "<m1@example.test>", MessageID: "<m2@example.test>",
		Body: "thanks!", Date: time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC),
	})
	if reply.Source != SourceIMAP {
		t.Fatalf("source = %q", reply.Source)
	}
	if reply.Classification != "" {
		t.Fatalf("the mapper pre-classified the reply as %q", reply.Classification)
	}
	if reply.MatchMethod != "" {
		t.Fatalf("the mapper named a match method %q", reply.MatchMethod)
	}
	if reply.RecipientEmail != "reader@example.test" || reply.Subject != "Re: launch" {
		t.Fatalf("fields not trimmed: %+v", reply)
	}
	if reply.BodySnippet != "" {
		t.Fatal("the mapper wrote a persisted body field; Persist owns bounding and stripping")
	}
}

func TestMappingSubstitutesNowForAMissingDate(t *testing.T) {
	reply := toReply(FetchedMessage{From: "a@example.test", MessageID: "<x@example.test>"})
	if reply.ReceivedAt.IsZero() {
		t.Fatal("a message with no Date produced a zero received_at")
	}
}

type fakeSource struct {
	snapshot  MailboxSnapshot
	messages  []FetchedMessage
	openErr   error
	fetchErr  error
	sinceSeen uint32
	closed    bool
}

func (f *fakeSource) Open(context.Context, Mailbox, string, string) (MailboxSnapshot, error) {
	return f.snapshot, f.openErr
}

func (f *fakeSource) FetchSince(_ context.Context, since uint32, _ int) ([]FetchedMessage, error) {
	f.sinceSeen = since
	return f.messages, f.fetchErr
}

func (f *fakeSource) Close() error { f.closed = true; return nil }

type fakeSecrets struct{ err error }

func (f fakeSecrets) Resolve(context.Context, string, string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return "value", nil
}

func mailboxFixture() Mailbox {
	return Mailbox{
		ID: "m1", TenantID: "t1", Label: "support",
		UsernameSecretRef: "env:U", PasswordSecretRef: "env:P",
		UIDValidity: 1000, LastUID: 10,
	}
}

// A credential that cannot be resolved must abort the poll BEFORE the cursor
// moves, and the error must name the reference rather than any resolved value.
func TestUnresolvableCredentialsAbortBeforeTheCursorMoves(t *testing.T) {
	poller := &Poller{
		Store:   &Store{},
		Secrets: fakeSecrets{err: errors.New("referenced environment secret is unavailable")},
		Source:  &fakeSource{},
	}
	outcome, err := poller.PollMailbox(context.Background(), mailboxFixture())
	if err == nil {
		t.Fatal("an unresolvable credential did not fail the poll")
	}
	if outcome.CursorAdvanced {
		t.Fatal("the cursor advanced despite a failed poll")
	}
}

// A message with no provider message id has no deduplication key, so storing it
// would re-ingest it on every cycle for as long as it sits in the folder.
func TestMessagesWithoutADeduplicationKeyAreSkipped(t *testing.T) {
	poller := &Poller{Store: &Store{}, Secrets: fakeSecrets{}}
	for name, message := range map[string]FetchedMessage{
		"no message id": {UID: 1, From: "a@example.test"},
		"no sender":     {UID: 2, MessageID: "<x@example.test>"},
		"neither":       {UID: 3},
	} {
		ingested, duplicate, err := poller.IngestOne(context.Background(), "t1", message)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if ingested || duplicate {
			t.Fatalf("%s: an unkeyed message was persisted", name)
		}
	}
}

// A poll that cannot even open the mailbox must not be mistaken for an empty
// one; nothing may be recorded as progress.
func TestAFailedOpenDoesNotAdvanceTheCursor(t *testing.T) {
	poller := &Poller{
		Store: &Store{}, Secrets: fakeSecrets{},
		Source: &fakeSource{openErr: errors.New("dial tcp: connection refused")},
	}
	outcome, err := poller.PollMailbox(context.Background(), mailboxFixture())
	if err == nil {
		t.Fatal("a failed open did not fail the poll")
	}
	if outcome.CursorAdvanced || outcome.LastUID != 0 {
		t.Fatalf("a failed open produced progress: %+v", outcome)
	}
}

// The fetch must ask for messages above the stored cursor, not from zero.
func TestPollAsksTheSourceForMessagesAboveTheStoredCursor(t *testing.T) {
	source := &fakeSource{snapshot: MailboxSnapshot{UIDValidity: 1000, UIDNext: 60}}
	poller := &Poller{Store: &Store{}, Secrets: fakeSecrets{}, Source: source}
	if _, err := poller.PollMailbox(context.Background(), mailboxFixture()); err != nil {
		t.Fatal(err)
	}
	if source.sinceSeen != 10 {
		t.Fatalf("fetched since UID %d, want the stored cursor 10", source.sinceSeen)
	}
	if !source.closed {
		t.Fatal("the source was not closed; connections would leak every cycle")
	}
}

// Fail closed and stay silent: a half-configured poller must not run at all.
func TestAnIncompletePollerDoesNotRun(t *testing.T) {
	for name, poller := range map[string]*Poller{
		"no mailbox store": {Store: &Store{}, Secrets: fakeSecrets{}, NewSource: func() MessageSource { return nil }},
		"no reply store":   {Mailboxes: &MailboxStore{}, Secrets: fakeSecrets{}},
		"no secrets":       {Mailboxes: &MailboxStore{}, Store: &Store{}},
		"no source":        {Mailboxes: &MailboxStore{}, Store: &Store{}, Secrets: fakeSecrets{}},
	} {
		if poller.Configured() {
			t.Errorf("%s: an incomplete poller reported itself configured", name)
		}
		if err := poller.Run(context.Background()); err != nil {
			t.Errorf("%s: an unconfigured poller returned an error instead of staying quiet: %v", name, err)
		}
	}
}

// The failure that loses customer replies permanently. If persistence fails
// mid-batch and the cursor still advances, every message from the failure point
// onward is skipped on the next cycle and never read again — silently, because
// the poller believes it made progress.
//
// Re-reading is the correct failure mode: Persist deduplicates on the provider
// message id, so a retry costs a wasted fetch. Skipping costs the reply.
func TestAFailedPersistDoesNotAdvanceTheCursor(t *testing.T) {
	source := &fakeSource{
		snapshot: MailboxSnapshot{UIDValidity: 1000, UIDNext: 60},
		messages: []FetchedMessage{
			{UID: 11, From: "reader@example.test", MessageID: "<a@example.test>", Body: "hi"},
			{UID: 12, From: "other@example.test", MessageID: "<b@example.test>", Body: "hello"},
		},
	}
	// A Store with no pool cannot persist, which is the failure this asserts on.
	poller := &Poller{Store: &Store{}, Secrets: fakeSecrets{}, Source: source}

	outcome, err := poller.PollMailbox(context.Background(), mailboxFixture())
	if err == nil {
		t.Fatal("a failing persist did not fail the poll")
	}
	if outcome.CursorAdvanced {
		t.Fatal("the cursor advanced past a message that was never stored; " +
			"the next cycle would skip it forever")
	}
	if outcome.Ingested != 0 {
		t.Fatalf("reported %d ingested despite a persist failure", outcome.Ingested)
	}
}

// The Go validator and the SQL CHECK must accept exactly the same shapes. A
// reference the database stores and the resolver rejects is a mailbox that
// saves fine and never polls, with "invalid secret reference" as the only clue.
func TestSecretReferenceValidationMatchesTheMigrationCheck(t *testing.T) {
	for _, valid := range []string{
		"env:IMAP_PASSWORD", "env://IMAP_PASSWORD", "aws-sm://prod/imap",
		"vault:secret/imap", "gcp-sm://projects/p/secrets/s", "azure-kv://vault/key",
		"env-json:BUNDLE",
	} {
		if !ValidSecretReference(valid) {
			t.Errorf("%q is accepted by the migration CHECK but rejected here", valid)
		}
	}
	for _, invalid := range []string{
		"hunter2", "", "env:", "http://example.test/secret", "env:with space",
		"ENV:UPPER", "env\n:x",
	} {
		if ValidSecretReference(invalid) {
			t.Errorf("%q is rejected by the migration CHECK but accepted here", invalid)
		}
	}
}

// A resolver error must name the reference, never the resolved value: this
// string reaches last_error, which operators read and logs retain.
func TestResolverErrorsNeverCarryTheSecretValue(t *testing.T) {
	tenantID := "92de77ea-6444-4e4a-9840-291731c3d345"
	reference, err := TenantEnvironmentSecretReference(tenantID, "TEST_SECRET")
	if err != nil {
		t.Fatal(err)
	}
	environmentName := strings.TrimPrefix(reference, "env:")
	t.Setenv(environmentName, "super-secret-password")
	resolver := EnvironmentSecretResolver{}

	value, err := resolver.Resolve(context.Background(), tenantID, reference)
	if err != nil || value != "super-secret-password" {
		t.Fatalf("resolution failed: %q %v", value, err)
	}
	missingReference, err := TenantEnvironmentSecretReference(tenantID, "MISSING")
	if err != nil {
		t.Fatal(err)
	}
	_, err = resolver.Resolve(context.Background(), tenantID, missingReference)
	if err == nil {
		t.Fatal("a missing secret resolved successfully")
	}
	if strings.Contains(err.Error(), "super-secret-password") {
		t.Fatalf("the error carried a secret value: %v", err)
	}
	// Unsupported schemes must be refused rather than silently returning empty,
	// which would present as "login rejected" and misdirect the operator.
	if _, err := resolver.Resolve(context.Background(), tenantID, "aws-sm://prod/imap"); err == nil {
		t.Fatal("the environment resolver accepted an aws-sm reference")
	}
}

func TestEnvironmentResolverCannotReadArbitraryProcessSecrets(t *testing.T) {
	tenantID := "92de77ea-6444-4e4a-9840-291731c3d345"
	t.Setenv("DATABASE_URL", "postgres://secret-database-credential")
	resolver := EnvironmentSecretResolver{}

	value, err := resolver.Resolve(context.Background(), tenantID, "env:DATABASE_URL")
	if err == nil {
		t.Fatalf("env:DATABASE_URL resolved to %q", value)
	}
	if strings.Contains(err.Error(), "postgres://secret-database-credential") {
		t.Fatalf("resolver error leaked the process secret: %v", err)
	}
}
