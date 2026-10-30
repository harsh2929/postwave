// SPDX-License-Identifier: AGPL-3.0-only

// imap_ingest.go — turning fetched messages into canonical replies.
//
// The transport is behind MessageSource on purpose. Everything that decides
// CORRECTNESS lives here — which UIDs to ask for, what to do when the server
// renumbers, when the cursor may move — and none of it needs a network. The
// IMAP client is the thin part; a bug there fails loudly at connect time, while
// a bug in the cursor arithmetic silently loses or duplicates customer replies.

package replies

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// FetchedMessage is one message as the transport hands it over.
type FetchedMessage struct {
	UID       uint32
	From      string
	Subject   string
	InReplyTo string
	MessageID string
	Body      string
	Date      time.Time
}

// MailboxSnapshot is what a source reports about the folder itself.
type MailboxSnapshot struct {
	UIDValidity uint32
	// UIDNext is the UID the server will assign to the next arrival, so
	// UIDNext-1 is the current high-water mark.
	UIDNext uint32
}

// MessageSource is the transport seam.
type MessageSource interface {
	// Open selects the folder and reports its identity.
	Open(ctx context.Context, mailbox Mailbox, username, password string) (MailboxSnapshot, error)
	// FetchSince returns messages with UID strictly greater than sinceUID,
	// bounded by limit, in ascending UID order.
	FetchSince(ctx context.Context, sinceUID uint32, limit int) ([]FetchedMessage, error)
	Close() error
}

// SecretResolver resolves a scheme-prefixed reference. Implementations must
// never include the resolved value in an error.
type SecretResolver interface {
	Resolve(ctx context.Context, tenantID, reference string) (string, error)
}

// MaxMessagesPerPoll bounds one cycle. A mailbox with a large backlog is
// drained across cycles rather than in one transaction that holds a connection
// open for minutes and risks the server dropping it mid-fetch.
const MaxMessagesPerPoll = 200

// PollOutcome is what one cycle did, for the caller to persist and log.
type PollOutcome struct {
	Ingested       int
	Duplicates     int
	UIDValidity    uint32
	LastUID        uint32
	ValidityReset  bool
	CursorAdvanced bool
}

// PlanFetch decides where to read from, given the stored cursor and what the
// server currently reports.
//
// Three cases, and the difference between them is the whole reason this is a
// separate function with its own tests:
//
//   - Never polled: start at the CURRENT high-water mark. A mailbox being
//     connected today is full of years of mail that are not replies to
//     campaigns we sent; ingesting them would fabricate engagement and, worse,
//     attribute it to whichever campaign the matcher happened to fit.
//   - UIDVALIDITY unchanged: resume above the stored UID.
//   - UIDVALIDITY changed: the server renumbered, so every stored UID now means
//     something else. Resume from the new high-water mark rather than from UID
//     0 — re-reading the whole mailbox would duplicate every reply already
//     ingested under the previous numbering.
func PlanFetch(mailbox Mailbox, snapshot MailboxSnapshot) (sinceUID uint32, validityReset bool) {
	highWater := uint32(0)
	if snapshot.UIDNext > 0 {
		highWater = snapshot.UIDNext - 1
	}
	switch {
	case mailbox.NeverPolled():
		return highWater, false
	case mailbox.UIDValidity != snapshot.UIDValidity:
		return highWater, true
	default:
		return mailbox.LastUID, false
	}
}

// toReply maps a fetched message onto the canonical Reply.
//
// It sets only what the message actually says. Classification, quote stripping
// and the evidence receipt are Store.Persist's job, and a caller that
// pre-classified would let a source that mishandled headers turn an
// auto-responder into human engagement.
func toReply(message FetchedMessage) Reply {
	received := message.Date
	if received.IsZero() {
		received = time.Now().UTC()
	}
	return Reply{
		RecipientEmail: strings.TrimSpace(message.From),
		Subject:        strings.TrimSpace(message.Subject),
		InReplyTo:      strings.TrimSpace(message.InReplyTo),
		RawMessageID:   strings.TrimSpace(message.MessageID),
		Source:         SourceIMAP,
		ReceivedAt:     received.UTC(),
		// The transient body Persist strips, bounds and classifies.
		ClassificationBody: message.Body,
	}
}

// IngestOne persists a single fetched message.
//
// A message with no usable sender or no provider message id is SKIPPED rather
// than stored: RawMessageID is the deduplication key, so a reply without one
// would be re-ingested on every cycle for as long as it sits in the folder.
func (p *Poller) IngestOne(
	ctx context.Context, tenantID string, message FetchedMessage,
) (ingested bool, duplicate bool, err error) {
	if strings.TrimSpace(message.From) == "" || strings.TrimSpace(message.MessageID) == "" {
		return false, false, nil
	}
	reply := toReply(message)
	if p.Matcher != nil {
		// The matcher decides campaign/subscriber attribution and, crucially,
		// the MatchMethod that governs whether this becomes canonical
		// engagement. Left to the matcher rather than assumed here: a source
		// that named its own method could turn an unattributed message into
		// strong-correlation evidence.
		//
		// A matcher error degrades to no match rather than failing the poll.
		// An unattributed reply is still a reply worth storing; dropping the
		// message because attribution was unavailable would lose the customer's
		// words over a transient lookup.
		if result, err := p.Matcher.Resolve(ctx, tenantID, reply); err == nil {
			reply.CampaignID = result.CampaignID
			reply.SubscriberID = result.SubscriberID
			reply.MatchMethod = result.Method
		} else {
			reply.MatchMethod = MatchNone
		}
	}
	_, isDup, err := p.Store.Persist(ctx, tenantID, reply)
	if err != nil {
		return false, false, err
	}
	return !isDup, isDup, nil
}

// PollMailbox runs one cycle against one mailbox.
//
// The cursor is advanced only after every message in the batch has been
// persisted. A crash mid-batch therefore re-reads, which Persist deduplicates;
// advancing first would skip the remainder permanently and silently.
func (p *Poller) PollMailbox(ctx context.Context, mailbox Mailbox) (PollOutcome, error) {
	var outcome PollOutcome
	if p.Source == nil || p.Store == nil || p.Secrets == nil {
		return outcome, errors.New("replies: IMAP poller is not fully configured")
	}
	username, err := p.Secrets.Resolve(ctx, mailbox.TenantID, mailbox.UsernameSecretRef)
	if err != nil {
		// The reference is named, never the resolved value.
		return outcome, fmt.Errorf("resolve username reference: %w", err)
	}
	password, err := p.Secrets.Resolve(ctx, mailbox.TenantID, mailbox.PasswordSecretRef)
	if err != nil {
		return outcome, fmt.Errorf("resolve password reference: %w", err)
	}

	snapshot, err := p.Source.Open(ctx, mailbox, username, password)
	if err != nil {
		return outcome, fmt.Errorf("open mailbox: %w", err)
	}
	defer func() { _ = p.Source.Close() }()

	sinceUID, validityReset := PlanFetch(mailbox, snapshot)
	outcome.UIDValidity = snapshot.UIDValidity
	outcome.ValidityReset = validityReset
	outcome.LastUID = sinceUID

	messages, err := p.Source.FetchSince(ctx, sinceUID, MaxMessagesPerPoll)
	if err != nil {
		return outcome, fmt.Errorf("fetch messages: %w", err)
	}
	for _, message := range messages {
		// Never move the watermark below where we started, whatever order the
		// server returned.
		if message.UID > outcome.LastUID {
			outcome.LastUID = message.UID
		}
		ingested, duplicate, err := p.IngestOne(ctx, mailbox.TenantID, message)
		if err != nil {
			// Stop at the first failure and do NOT advance past it. The next
			// cycle retries from the same point.
			return outcome, fmt.Errorf("persist reply: %w", err)
		}
		if ingested {
			outcome.Ingested++
		}
		if duplicate {
			outcome.Duplicates++
		}
	}
	outcome.CursorAdvanced = true
	return outcome, nil
}
