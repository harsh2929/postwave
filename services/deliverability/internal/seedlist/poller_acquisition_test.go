package seedlist

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

type legacyFixtureConnector struct{}

func (legacyFixtureConnector) FetchTaggedMessages(context.Context, *Inbox, time.Time) ([]categorizers.Message, error) {
	return []categorizers.Message{{
		Folder: "INBOX",
		Headers: map[string]string{
			PostwaveTestHeader: "campaign-legacy",
		},
	}}, nil
}

type acquisitionFixtureConnector struct {
	raw *categorizers.RawMIMEAcquisition
}

func (c acquisitionFixtureConnector) FetchTaggedMessages(context.Context, *Inbox, time.Time) ([]categorizers.Message, error) {
	return []categorizers.Message{{
		Folder: "INBOX",
		Labels: []string{"CATEGORY_PROMOTIONS"},
		Headers: map[string]string{
			PostwaveTestHeader: "campaign-rich",
			"Subject":          "Rich result",
		},
		RawMIME: c.raw,
	}}, nil
}

func (acquisitionFixtureConnector) Capabilities() ConnectorCapabilities {
	return (&IMAPConnector{}).Capabilities()
}

type reportOnlySink struct {
	reports []domain.InboxReport
}

func (s *reportOnlySink) WriteReport(_ context.Context, report domain.InboxReport) error {
	s.reports = append(s.reports, report)
	return nil
}

type observationFixtureSink struct {
	reportOnlySink
	observations []MessageObservation
}

func (s *observationFixtureSink) WriteMessageObservation(_ context.Context, observation MessageObservation) error {
	s.observations = append(s.observations, observation)
	return nil
}

func TestPollerBackwardCompatibleWithLegacyConnectorAndReportSink(t *testing.T) {
	sink := &reportOnlySink{}
	poller := NewPoller(NewRegistry(), legacyFixtureConnector{}, NopHealthSender{}, sink, nil)
	err := poller.pollOnce(context.Background(), &Inbox{
		ID:       "gmail-legacy",
		Provider: domain.ProviderGmail,
		Address:  "legacy@example.test",
	}, time.Time{}, map[string]time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.reports) != 1 || sink.reports[0].CampaignID != "campaign-legacy" {
		t.Fatalf("reports = %#v", sink.reports)
	}
}

func TestPollerHandsOffPlacementHeadersAndBoundedRawMIMETogether(t *testing.T) {
	rawBytes := []byte("Content-Type: text/plain\r\n\r\nhello")
	raw := finalizeRawMIME(rawBytes, int64(len(rawBytes)), 1024, 12, 13, false)
	connector := acquisitionFixtureConnector{raw: raw}
	sink := &observationFixtureSink{}
	poller := NewPoller(NewRegistry(), connector, NopHealthSender{}, sink, nil)
	err := poller.pollOnce(context.Background(), &Inbox{
		ID:       "gmail-rich",
		Provider: domain.ProviderGmail,
		Address:  "rich@example.test",
	}, time.Time{}, map[string]time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.reports) != 1 || sink.reports[0].Placement != domain.PlacementPromotions {
		t.Fatalf("reports = %#v", sink.reports)
	}
	if len(sink.observations) != 1 {
		t.Fatalf("observations = %#v", sink.observations)
	}
	observation := sink.observations[0]
	if observation.Placement != domain.PlacementPromotions || observation.Folder != "INBOX" {
		t.Fatalf("placement/folder = %q/%q", observation.Placement, observation.Folder)
	}
	if observation.Headers["Subject"] != "Rich result" || observation.RawMIME == nil {
		t.Fatalf("observation lost evidence: %#v", observation)
	}
	if observation.RawMIME == raw || &observation.RawMIME.Raw[0] == &raw.Raw[0] {
		t.Fatal("poller did not isolate raw MIME ownership at sink boundary")
	}
	if observation.Capabilities.RawMIME != CapabilityAvailable || observation.Capabilities.ObservedSurface != CapabilityUnavailable {
		t.Fatalf("capabilities = %#v", observation.Capabilities)
	}
}
