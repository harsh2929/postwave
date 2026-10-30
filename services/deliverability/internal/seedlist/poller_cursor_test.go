package seedlist

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

type cursorFixtureConnector struct {
	batch       CursorMessageBatch
	legacyCalls int
	seen        map[string]FolderCursor
}

func (c *cursorFixtureConnector) FetchTaggedMessages(context.Context, *Inbox, time.Time) ([]categorizers.Message, error) {
	c.legacyCalls++
	return nil, errors.New("legacy path should not run")
}

func (c *cursorFixtureConnector) FetchTaggedMessagesFromCursors(_ context.Context, _ *Inbox, cursors map[string]FolderCursor) (CursorMessageBatch, error) {
	c.seen = cursors
	return c.batch, nil
}

func (*cursorFixtureConnector) Capabilities() ConnectorCapabilities {
	return ConnectorCapabilities{
		Headers: CapabilityAvailable, RawMIME: CapabilityAvailable,
		BodyParts: CapabilityAvailable, Placement: CapabilityAvailable,
		ObservedSurface: CapabilityUnavailable,
	}
}

type cursorFixtureSink struct {
	cursors       map[string]FolderCursor
	reports       []domain.InboxReport
	observations  []MessageObservation
	advanceCalls  [][]FolderWatermark
	failTestToken string
}

func (s *cursorFixtureSink) LoadSeedMailboxCursors(_ context.Context, _ string) (map[string]FolderCursor, error) {
	out := make(map[string]FolderCursor, len(s.cursors))
	for key, value := range s.cursors {
		out[key] = value
	}
	return out, nil
}

func (s *cursorFixtureSink) AdvanceSeedMailboxCursors(_ context.Context, _ string, watermarks []FolderWatermark) error {
	s.advanceCalls = append(s.advanceCalls, append([]FolderWatermark(nil), watermarks...))
	return nil
}

func (s *cursorFixtureSink) WriteReport(_ context.Context, report domain.InboxReport) error {
	s.reports = append(s.reports, report)
	return nil
}

func (s *cursorFixtureSink) WriteMessageObservation(_ context.Context, observation MessageObservation) error {
	if observation.TestHeaderValue == s.failTestToken {
		return errors.New("object store unavailable")
	}
	s.observations = append(s.observations, observation)
	return nil
}

func TestCursorPollerAdvancesOnlyFoldersWhoseObservationsCommitted(t *testing.T) {
	now := time.Now().UTC()
	connector := &cursorFixtureConnector{batch: CursorMessageBatch{
		Messages: []categorizers.Message{
			{Folder: "INBOX", UID: 8, UIDValidity: 10, Headers: map[string]string{PostwaveTestHeader: "campaign-fails"}},
			{Folder: "Spam", UID: 4, UIDValidity: 20, Headers: map[string]string{PostwaveTestHeader: "campaign-ok"}},
		},
		Watermarks: []FolderWatermark{
			{Folder: "INBOX", UIDValidity: 10, LastUID: 9, ObservedAt: now},
			{Folder: "Spam", UIDValidity: 20, LastUID: 5, ObservedAt: now},
		},
	}}
	sink := &cursorFixtureSink{
		cursors:       map[string]FolderCursor{"INBOX": {Folder: "INBOX", UIDValidity: 10, LastUID: 7}},
		failTestToken: "campaign-fails",
	}
	poller := NewPoller(NewRegistry(), connector, NopHealthSender{}, sink, nil)
	err := poller.pollOnce(context.Background(), &Inbox{
		ID: "gmail-seed", Provider: domain.ProviderGmail, Address: "seed@example.test", Status: StatusActive,
	}, time.Time{}, map[string]time.Time{})
	if err == nil || !strings.Contains(err.Error(), "object store unavailable") {
		t.Fatalf("poll err = %v", err)
	}
	if connector.legacyCalls != 0 || connector.seen["INBOX"].LastUID != 7 {
		t.Fatalf("cursor connector was not used correctly: calls=%d seen=%#v", connector.legacyCalls, connector.seen)
	}
	if len(sink.advanceCalls) != 1 || len(sink.advanceCalls[0]) != 1 || sink.advanceCalls[0][0].Folder != "Spam" {
		t.Fatalf("advanced watermarks = %#v", sink.advanceCalls)
	}
	if len(sink.observations) != 1 || sink.observations[0].UID != 4 || sink.observations[0].UIDValidity != 20 {
		t.Fatalf("durable observations = %#v", sink.observations)
	}
}

func TestCursorPollerAdvancesHealthCheckWithoutWritingCustomerEvidence(t *testing.T) {
	now := time.Now().UTC()
	connector := &cursorFixtureConnector{batch: CursorMessageBatch{
		Messages: []categorizers.Message{{
			Folder: "INBOX", UID: 11, UIDValidity: 12,
			Headers: map[string]string{PostwaveTestHeader: "health-gmail-seed-1"},
		}},
		Watermarks: []FolderWatermark{{Folder: "INBOX", UIDValidity: 12, LastUID: 11, ObservedAt: now}},
	}}
	sink := &cursorFixtureSink{}
	inflight := map[string]time.Time{"health-gmail-seed-1": now.Add(-time.Second)}
	poller := NewPoller(NewRegistry(), connector, NopHealthSender{}, sink, nil)
	if err := poller.pollOnce(context.Background(), &Inbox{
		ID: "gmail-seed", Provider: domain.ProviderGmail, Status: StatusActive,
	}, time.Time{}, inflight); err != nil {
		t.Fatal(err)
	}
	if len(inflight) != 0 || len(sink.reports) != 0 || len(sink.observations) != 0 {
		t.Fatalf("health message leaked into customer evidence: inflight=%#v reports=%#v observations=%#v", inflight, sink.reports, sink.observations)
	}
	if len(sink.advanceCalls) != 1 || sink.advanceCalls[0][0].LastUID != 11 {
		t.Fatalf("health cursor was not advanced: %#v", sink.advanceCalls)
	}
}
