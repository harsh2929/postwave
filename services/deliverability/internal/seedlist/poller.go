// Poller goroutines: one per inbox, 60s ticker. Searches for unread messages
// carrying the X-Postwave-Test-ID header, classifies via per-provider
// Categorizer, and publishes InboxReport rows.
//
// IMAP work is delegated to a small Connector interface so we can mock it in
// tests. The default implementation is backed by github.com/emersion/go-imap.

package seedlist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

// PostwaveTestHeader is the synthetic header Moosewave attaches to every
// seedlist test send so the poller can filter to relevant traffic only.
const PostwaveTestHeader = "X-Postwave-Test-ID"

// HealthInterval is how often the poller asks the HealthSender to re-emit a
// synthetic email through Moosewave's own infra.
const HealthInterval = 60 * time.Minute

// HealthDeadline is the maximum time a synthetic email may take to land in
// the inbox before we mark the inbox flagged.
const HealthDeadline = 5 * time.Minute

// PollInterval is the per-inbox tick rate.
const PollInterval = 60 * time.Second

// Connector abstracts IMAP. Real impl uses github.com/emersion/go-imap/v2.
type Connector interface {
	// FetchTaggedMessages returns messages bearing the X-Postwave-Test-ID
	// header that arrived since `since`. Each result includes the folder it
	// was found in, any Gmail labels, selected headers, and optional explicit
	// raw-MIME acquisition provenance. Legacy connectors may leave RawMIME nil;
	// production connectors must use a terminal status instead.
	FetchTaggedMessages(ctx context.Context, in *Inbox, since time.Time) ([]categorizers.Message, error)
}

// HealthSender abstracts the synthetic-email send. Provider-backed sending is
// intentionally injected so local/CI runs do not need outbound email creds.
type HealthSender interface {
	SendHealthCheck(ctx context.Context, in *Inbox, testID string) error
}

// ReportSink is where we write InboxReport rows. main.go wires a local
// in-memory sink; production can swap in a durable store later.
type ReportSink interface {
	WriteReport(ctx context.Context, r domain.InboxReport) error
}

// MessageObservationSink is an optional, schema-free handoff for richer seed
// evidence. Production exposes it only when raw-MIME capture has passed the
// PostgreSQL plus encrypted-object-store readiness gates; projection-only
// deployments deliberately hide the interface.
type MessageObservationSink interface {
	WriteMessageObservation(ctx context.Context, observation MessageObservation) error
}

// MessageObservation keeps placement and selected headers alongside raw-MIME
// acquisition provenance so downstream storage cannot accidentally present a
// truncated/failed capture as complete.
type MessageObservation struct {
	TenantID              string `json:"tenant_id,omitempty"`
	CampaignID            string `json:"campaign_id,omitempty"`
	TestID                string `json:"test_id,omitempty"`
	ContentRevisionID     string `json:"content_revision_id,omitempty"`
	SendPlanID            string `json:"send_plan_id,omitempty"`
	ArtifactID            string `json:"artifact_id,omitempty"`
	ScenarioID            string `json:"scenario_id,omitempty"`
	OutboundMIMEHash      string `json:"outbound_mime_hash,omitempty"`
	OutboundStructureHash string `json:"outbound_structure_hash,omitempty"`
	// TestHeaderValue is a bearer-like correlation token. It is available only
	// to the durable resolver and must never be serialized, logged, or stored.
	TestHeaderValue   string                           `json:"-"`
	Provider          domain.Provider                  `json:"provider"`
	MailboxID         string                           `json:"mailbox_id"`
	RegistryVersionID string                           `json:"registry_version_id,omitempty"`
	RecipientEmail    string                           `json:"-"`
	Folder            string                           `json:"folder"`
	Labels            []string                         `json:"labels,omitempty"`
	Headers           map[string]string                `json:"headers"`
	Placement         domain.Placement                 `json:"placement"`
	RawMIME           *categorizers.RawMIMEAcquisition `json:"raw_mime"`
	Capabilities      ConnectorCapabilities            `json:"capabilities"`
	HealthState       Status                           `json:"health_state"`
	UID               uint32                           `json:"uid,omitempty"`
	UIDValidity       uint32                           `json:"uid_validity,omitempty"`
	ReceivedAt        time.Time                        `json:"received_at,omitempty"`
	CheckedAt         time.Time                        `json:"checked_at"`
}

// Poller orchestrates one goroutine per inbox.
type Poller struct {
	registry *Registry
	conn     Connector
	health   HealthSender
	sink     ReportSink
	cats     map[domain.Provider]categorizers.Categorizer

	logger *slog.Logger

	wg     sync.WaitGroup
	cancel context.CancelFunc
}

// NewPoller wires the default categorizer set.
func NewPoller(reg *Registry, conn Connector, health HealthSender, sink ReportSink, logger *slog.Logger) *Poller {
	if logger == nil {
		logger = slog.Default()
	}
	cats := defaultCategorizers()
	return &Poller{
		registry: reg,
		conn:     conn,
		health:   health,
		sink:     sink,
		cats:     cats,
		logger:   logger,
	}
}

// Start launches a goroutine per active inbox. Stop cancels them all.
func (p *Poller) Start(ctx context.Context) {
	if p == nil || p.registry == nil {
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	p.cancel = cancel
	for _, in := range p.registry.All() {
		if in.Status != StatusActive {
			continue
		}
		p.wg.Add(1)
		go p.runInbox(ctx, in)
	}
}

// Stop cancels all running goroutines and waits for them to drain.
func (p *Poller) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
	p.wg.Wait()
}

func (p *Poller) runInbox(ctx context.Context, in *Inbox) {
	defer p.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			p.log().Error("seedlist poller: inbox worker panic",
				"inbox", in.ID,
				"provider", string(in.Provider),
				"panic", fmt.Sprint(r))
		}
	}()
	pollT := time.NewTicker(PollInterval)
	healthT := time.NewTicker(HealthInterval)
	defer pollT.Stop()
	defer healthT.Stop()

	// Track in-flight health checks: testID -> sentAt.
	inflight := map[string]time.Time{}

	logger := p.log().With("inbox", in.ID, "provider", string(in.Provider))

	// Initial poll cursor: now.
	since := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-pollT.C:
			next := time.Now()
			if err := p.safePollOnce(ctx, in, since, inflight); err != nil {
				logger.Warn("poll failed", "err", err)
				continue
			}
			since = next
			in.LastCheckedAt = next
			// Sweep inflight health checks past their deadline.
			for id, sent := range inflight {
				if time.Since(sent) > HealthDeadline {
					logger.Warn("health check missed deadline", "test_id", id)
					_ = p.registry.SetStatus(in.ID, StatusFlagged)
					delete(inflight, id)
				}
			}
		case <-healthT.C:
			testID := fmt.Sprintf("health-%s-%d", in.ID, time.Now().UnixNano())
			if p.health == nil {
				continue
			}
			if err := p.safeSendHealth(ctx, in, testID); err != nil {
				logger.Warn("health send failed", "err", err)
				continue
			}
			inflight[testID] = time.Now()
			in.LastHealthAt = time.Now()
		}
	}
}

func (p *Poller) safePollOnce(ctx context.Context, in *Inbox, since time.Time, inflight map[string]time.Time) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("seedlist poll panic: %v", r)
		}
	}()
	return p.pollOnce(ctx, in, since, inflight)
}

func (p *Poller) safeSendHealth(ctx context.Context, in *Inbox, testID string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("seedlist health panic: %v", r)
		}
	}()
	return p.health.SendHealthCheck(ctx, in, testID)
}

func (p *Poller) pollOnce(ctx context.Context, in *Inbox, since time.Time, inflight map[string]time.Time) error {
	if p.conn == nil {
		return nil // poller starts with stub connector during boot.
	}
	if connector, ok := p.conn.(CursorConnector); ok {
		if cursorStore, ok := p.sink.(MailboxCursorStore); ok {
			return p.pollOnceFromCursors(ctx, in, inflight, connector, cursorStore)
		}
	}
	msgs, err := p.conn.FetchTaggedMessages(ctx, in, since)
	if err != nil {
		return err
	}
	cat, ok := p.cats[in.Provider]
	if !ok {
		return fmt.Errorf("no categorizer for provider %q", in.Provider)
	}
	for _, message := range msgs {
		if err := p.processMessage(ctx, in, inflight, cat, message); err != nil {
			return err
		}
	}
	return nil
}

func (p *Poller) pollOnceFromCursors(ctx context.Context, in *Inbox, inflight map[string]time.Time, connector CursorConnector, cursorStore MailboxCursorStore) error {
	cursors, err := cursorStore.LoadSeedMailboxCursors(ctx, in.ID)
	if err != nil {
		return fmt.Errorf("load seed mailbox cursors: %w", err)
	}
	batch, err := connector.FetchTaggedMessagesFromCursors(ctx, in, cursors)
	if err != nil {
		return err
	}
	cat, ok := p.cats[in.Provider]
	if !ok {
		return fmt.Errorf("no categorizer for provider %q", in.Provider)
	}
	messagesByFolder := make(map[string][]categorizers.Message)
	for _, message := range batch.Messages {
		messagesByFolder[message.Folder] = append(messagesByFolder[message.Folder], message)
	}
	for folder := range messagesByFolder {
		sort.Slice(messagesByFolder[folder], func(i, j int) bool {
			return messagesByFolder[folder][i].UID < messagesByFolder[folder][j].UID
		})
	}

	successful := make([]FolderWatermark, 0, len(batch.Watermarks))
	var processingErrors []error
	seenFolders := make(map[string]struct{}, len(batch.Watermarks))
	for _, watermark := range batch.Watermarks {
		if _, duplicate := seenFolders[watermark.Folder]; duplicate {
			processingErrors = append(processingErrors, fmt.Errorf("duplicate cursor watermark for folder %q", watermark.Folder))
			continue
		}
		seenFolders[watermark.Folder] = struct{}{}
		folderOK := true
		for _, message := range messagesByFolder[watermark.Folder] {
			if err := p.processMessage(ctx, in, inflight, cat, message); err != nil {
				folderOK = false
				processingErrors = append(processingErrors, fmt.Errorf("folder %q uid %d: %w", watermark.Folder, message.UID, err))
				break
			}
		}
		if folderOK {
			successful = append(successful, watermark)
		}
	}
	for folder := range messagesByFolder {
		if _, ok := seenFolders[folder]; !ok {
			processingErrors = append(processingErrors, fmt.Errorf("connector returned messages without a cursor watermark for folder %q", folder))
		}
	}
	if len(successful) > 0 {
		if err := cursorStore.AdvanceSeedMailboxCursors(ctx, in.ID, successful); err != nil {
			processingErrors = append(processingErrors, fmt.Errorf("advance seed mailbox cursors: %w", err))
		}
	}
	return errors.Join(processingErrors...)
}

func (p *Poller) processMessage(ctx context.Context, in *Inbox, inflight map[string]time.Time, categorizer categorizers.Categorizer, message categorizers.Message) error {
	testID := message.Headers[PostwaveTestHeader]
	if _, ok := inflight[testID]; ok {
		delete(inflight, testID)
		return nil
	}
	tenantID, campaignID := parsePostwaveTestID(testID)
	placement := categorizer.Categorize(message)
	checkedAt := time.Now().UTC()
	if p.sink == nil {
		return nil
	}
	var writeErrors []error
	if campaignID != "" {
		if err := p.sink.WriteReport(ctx, domain.InboxReport{
			TenantID: tenantID, CampaignID: campaignID, Provider: in.Provider,
			MailboxID: in.ID, RecipientEmail: in.Address, Placement: placement, CheckedAt: checkedAt,
		}); err != nil {
			writeErrors = append(writeErrors, fmt.Errorf("write placement projection: %w", err))
		}
	}
	if observationSink, ok := p.sink.(MessageObservationSink); ok {
		rawMIME := cloneRawMIME(message.RawMIME)
		if rawMIME != nil {
			if rawMIME.UID == 0 {
				rawMIME.UID = message.UID
			}
			if rawMIME.UIDValidity == 0 {
				rawMIME.UIDValidity = message.UIDValidity
			}
		}
		if err := observationSink.WriteMessageObservation(ctx, MessageObservation{
			TenantID: tenantID, CampaignID: campaignID, TestHeaderValue: testID,
			Provider: in.Provider, MailboxID: in.ID, RegistryVersionID: in.RegistryVersionID,
			RecipientEmail: in.Address,
			Folder:         message.Folder, Labels: append([]string(nil), message.Labels...),
			Headers: cloneHeaders(message.Headers), Placement: placement, RawMIME: rawMIME,
			Capabilities: CapabilitiesOf(p.conn), HealthState: in.Status,
			UID: message.UID, UIDValidity: message.UIDValidity,
			ReceivedAt: message.ReceivedAt, CheckedAt: checkedAt,
		}); err != nil {
			writeErrors = append(writeErrors, fmt.Errorf("write durable observation: %w", err))
		}
	}
	return errors.Join(writeErrors...)
}

func (p *Poller) log() *slog.Logger {
	if p != nil && p.logger != nil {
		return p.logger
	}
	return slog.Default()
}

func parsePostwaveTestID(raw string) (tenantID, campaignID string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if isInboxRealityHeaderToken(raw) {
		return "", ""
	}
	var payload struct {
		TenantID   string `json:"tenant_id"`
		CampaignID string `json:"campaign_id"`
	}
	if strings.HasPrefix(raw, "{") && json.Unmarshal([]byte(raw), &payload) == nil {
		return strings.TrimSpace(payload.TenantID), strings.TrimSpace(payload.CampaignID)
	}
	for _, sep := range []string{"|", ":"} {
		parts := strings.SplitN(raw, sep, 2)
		if len(parts) == 2 && looksLikeUUID(parts[0]) {
			return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		}
	}
	return "", raw
}

func isInboxRealityHeaderToken(raw string) bool {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "irt_") {
		raw = strings.TrimPrefix(raw, "irt_")
	}
	if len(raw) != 32 {
		return false
	}
	for _, character := range raw {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') &&
			(character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func looksLikeUUID(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
				return false
			}
		}
	}
	return true
}

// --- Local-safe implementations below are wired by default so the service
// starts without mailbox/provider credentials.

// NopConnector is a Connector that returns no messages. Used when seedlist
// credentials are not configured.
type NopConnector struct{}

func (NopConnector) FetchTaggedMessages(ctx context.Context, _ *Inbox, _ time.Time) ([]categorizers.Message, error) {
	return nil, nil
}

func (NopConnector) Capabilities() ConnectorCapabilities {
	return unavailableCapabilities()
}

// NopHealthSender records no outbound send; provider-backed health checks
// need external sending credentials and are intentionally injected.
type NopHealthSender struct{}

func (NopHealthSender) SendHealthCheck(_ context.Context, _ *Inbox, _ string) error { return nil }

// NopSink discards reports. Tests can use it when persistence is irrelevant.
type NopSink struct{}

func (NopSink) WriteReport(_ context.Context, _ domain.InboxReport) error { return nil }

func cloneHeaders(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func cloneRawMIME(in *categorizers.RawMIMEAcquisition) *categorizers.RawMIMEAcquisition {
	if in == nil {
		return nil
	}
	out := *in
	out.Raw = append([]byte(nil), in.Raw...)
	out.Manifest.Headers = append([]categorizers.MIMEHeader(nil), in.Manifest.Headers...)
	out.Manifest.AuthenticationResults = append([]categorizers.AuthenticationResult(nil), in.Manifest.AuthenticationResults...)
	out.Manifest.Parts = append([]categorizers.MIMEPart(nil), in.Manifest.Parts...)
	return &out
}
