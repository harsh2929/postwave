// SPDX-License-Identifier: AGPL-3.0-only

// imap_poller.go — the worker loop around the ingest logic.

package replies

import (
	"context"
	"log/slog"
	"time"
)

// SourceFactory builds a transport per poll. A fresh connection per cycle
// rather than a pooled one: IMAP sessions are stateful and long-lived
// connections to someone else's server are the thing most likely to be dropped
// silently, leaving a poller that believes it is connected and never reads
// again.
type SourceFactory func() MessageSource

type Poller struct {
	Mailboxes *MailboxStore
	Store     *Store
	Matcher   *Matcher
	Secrets   SecretResolver
	NewSource SourceFactory
	Logger    *slog.Logger

	// Source is the transport for the current cycle, set by Run before each
	// PollMailbox. Exposed so a test can drive PollMailbox directly with a fake.
	Source MessageSource
}

func (p *Poller) log() *slog.Logger {
	if p.Logger != nil {
		return p.Logger
	}
	return slog.Default()
}

// Configured reports whether the poller has everything it needs.
//
// Fail closed and stay silent: a half-configured poller must not run at all.
// The alternative — starting and logging an error every two minutes — is how a
// deployment ends up with a worker nobody trusts and everybody mutes.
func (p *Poller) Configured() bool {
	return p != nil && p.Mailboxes != nil && p.Mailboxes.Pool != nil &&
		p.Store != nil && p.Secrets != nil && p.NewSource != nil
}

// Run polls due mailboxes until the context is cancelled.
func (p *Poller) Run(ctx context.Context) error {
	if !p.Configured() {
		return nil
	}
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			p.runOnce(ctx)
		}
	}
}

func (p *Poller) runOnce(ctx context.Context) {
	mailboxes, err := p.Mailboxes.DueMailboxes(ctx, 25)
	if err != nil {
		p.log().Warn("reply IMAP: listing due mailboxes failed", "err", err)
		return
	}
	for _, mailbox := range mailboxes {
		if ctx.Err() != nil {
			return
		}
		p.pollOne(ctx, mailbox)
	}
}

// pollOne runs a single mailbox and records the result.
//
// One mailbox's failure never stops the others: a customer whose password
// expired must not stall every other tenant's replies behind them.
func (p *Poller) pollOne(ctx context.Context, mailbox Mailbox) {
	p.Source = p.NewSource()
	outcome, err := p.PollMailbox(ctx, mailbox)
	if err != nil {
		// The mailbox is identified by id and label, never by credential or
		// resolved address; this line goes to logs an operator reads.
		p.log().Warn("reply IMAP poll failed",
			"mailbox_id", mailbox.ID, "label", mailbox.Label, "err", err)
		if recordErr := p.Mailboxes.RecordFailure(ctx, mailbox.ID, err.Error()); recordErr != nil {
			p.log().Warn("reply IMAP: recording failure failed",
				"mailbox_id", mailbox.ID, "err", recordErr)
		}
		return
	}
	if !outcome.CursorAdvanced {
		return
	}
	if err := p.Mailboxes.AdvanceCursor(ctx, mailbox.ID,
		outcome.UIDValidity, outcome.LastUID, outcome.ValidityReset); err != nil {
		// The replies are already committed. Failing to advance means the next
		// cycle re-reads them, which Persist deduplicates — noisy, not lossy,
		// which is the right way round for this failure.
		p.log().Warn("reply IMAP: advancing cursor failed",
			"mailbox_id", mailbox.ID, "err", err)
		return
	}
	if outcome.Ingested > 0 || outcome.ValidityReset {
		p.log().Info("reply IMAP poll complete",
			"mailbox_id", mailbox.ID, "ingested", outcome.Ingested,
			"duplicates", outcome.Duplicates, "uidvalidity_reset", outcome.ValidityReset)
	}
}
