package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/activecampaign"
	"github.com/postwave/migrate/adapter"
	_ "github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/mailchimp"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

const panicSource = canonical.SourcePlatform("panic_source")
const panicDiscoverySource = canonical.SourcePlatform("panic_discovery_source")

type disableAfterDueListStore struct {
	*jobstore.MemoryJobStore
	once sync.Once
}

func (s *disableAfterDueListStore) ListDueSourceEventMonitors(ctx context.Context, now time.Time, limit int) ([]jobstore.SourceEventMonitorRecord, error) {
	monitors, err := s.MemoryJobStore.ListDueSourceEventMonitors(ctx, now, limit)
	if err != nil || len(monitors) == 0 {
		return monitors, err
	}
	s.once.Do(func() {
		_ = s.MemoryJobStore.DisableSourceEventMonitor(
			jobstore.WithTenantID(ctx, monitors[0].TenantID),
			monitors[0].TenantID,
			monitors[0].JobID,
		)
	})
	return monitors, nil
}

const sourceEventProbeSource = canonical.SourcePlatform("source_event_probe")
const cancellationProbeSource = canonical.SourcePlatform("cancellation_probe")
const rateLimitProbeSource = canonical.SourcePlatform("rate_limit_probe")
const rateLimitDiscoverySource = canonical.SourcePlatform("rate_limit_discovery_probe")
const completionRaceProbeSource = canonical.SourcePlatform("completion_race_probe")

var registerPanicAdapterOnce sync.Once
var registerPanicDiscoveryAdapterOnce sync.Once
var registerSourceEventProbeAdapterOnce sync.Once
var registerCancellationProbeAdapterOnce sync.Once
var registerRateLimitProbeAdapterOnce sync.Once
var registerRateLimitDiscoveryAdapterOnce sync.Once
var registerCompletionRaceProbeAdapterOnce sync.Once

var sourceEventProbeState = struct {
	sync.Mutex
	since   time.Time
	cursors []string
	batches map[string]canonical.SourceEventBatch
}{}

var cancellationProbeState = struct {
	sync.Mutex
	started chan struct{}
}{}

type panicAdapter struct{}
type panicDiscoveryAdapter struct{ panicAdapter }
type sourceEventProbeAdapter struct{}
type cancellationProbeAdapter struct{}
type rateLimitProbeAdapter struct{}
type rateLimitDiscoveryAdapter struct{}
type completionRaceProbeAdapter struct{}
type cancelSensitiveStore struct {
	*jobstore.MemoryJobStore
}
type completionConflictStore struct {
	*jobstore.MemoryJobStore
	once sync.Once
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func installActiveCampaignTestTransport(t *testing.T, fn roundTripFunc) {
	t.Helper()
	original := http.DefaultTransport
	http.DefaultTransport = fn
	t.Cleanup(func() { http.DefaultTransport = original })
}

func jsonHTTPResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func (panicAdapter) Capabilities() canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{Source: panicSource, AuthMethod: "api_key"}
	caps.Supports.Subscribers = true
	return caps
}
func (panicAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: panicSource}, nil
}
func (panicAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{SubscribersTotal: 1}, nil
}
func (panicAdapter) ListSubscribers(context.Context, adapter.Session, string) ([]canonical.Subscriber, string, error) {
	panic("adapter subscriber panic")
}
func (panicAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (panicAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (panicAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (panicAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}
func (panicAdapter) ListSourceEvents(context.Context, adapter.Session, time.Time, string, int) (canonical.SourceEventBatch, error) {
	panic("adapter source-event panic")
}

func (panicDiscoveryAdapter) Capabilities() canonical.AdapterCapabilities {
	return canonical.AdapterCapabilities{Source: panicDiscoverySource, AuthMethod: "api_key"}
}
func (panicDiscoveryAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	panic("adapter discovery panic")
}

func (sourceEventProbeAdapter) Capabilities() canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{Source: sourceEventProbeSource, AuthMethod: "api_key"}
	caps.Supports.Subscribers = true
	return caps
}
func (sourceEventProbeAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: sourceEventProbeSource}, nil
}
func (sourceEventProbeAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{SubscribersTotal: 1}, nil
}
func (sourceEventProbeAdapter) ListSubscribers(context.Context, adapter.Session, string) ([]canonical.Subscriber, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (sourceEventProbeAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (sourceEventProbeAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (sourceEventProbeAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (sourceEventProbeAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}
func (sourceEventProbeAdapter) ListSourceEvents(_ context.Context, _ adapter.Session, since time.Time, cursor string, _ int) (canonical.SourceEventBatch, error) {
	sourceEventProbeState.Lock()
	sourceEventProbeState.since = since
	sourceEventProbeState.cursors = append(sourceEventProbeState.cursors, cursor)
	batch := sourceEventProbeState.batches[cursor]
	batch = cloneSourceEventProbeBatch(batch)
	sourceEventProbeState.Unlock()
	return batch, nil
}

func (cancellationProbeAdapter) Capabilities() canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{Source: cancellationProbeSource, AuthMethod: "api_key"}
	caps.Supports.Subscribers = true
	return caps
}
func (cancellationProbeAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: cancellationProbeSource}, nil
}
func (cancellationProbeAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{SubscribersTotal: 1}, nil
}
func (cancellationProbeAdapter) ListSubscribers(ctx context.Context, _ adapter.Session, _ string) ([]canonical.Subscriber, string, error) {
	cancellationProbeState.Lock()
	started := cancellationProbeState.started
	cancellationProbeState.Unlock()
	if started != nil {
		select {
		case <-started:
		default:
			close(started)
		}
	}
	<-ctx.Done()
	return nil, "", ctx.Err()
}
func (cancellationProbeAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (cancellationProbeAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (cancellationProbeAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (cancellationProbeAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (rateLimitProbeAdapter) Capabilities() canonical.AdapterCapabilities {
	caps := canonical.AdapterCapabilities{Source: rateLimitProbeSource, AuthMethod: "api_key"}
	caps.Supports.Subscribers = true
	return caps
}
func (rateLimitProbeAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: rateLimitProbeSource}, nil
}
func (rateLimitProbeAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{SubscribersTotal: 1}, nil
}
func (rateLimitProbeAdapter) ListSubscribers(context.Context, adapter.Session, string) ([]canonical.Subscriber, string, error) {
	return nil, "", &adapter.ErrRateLimited{RetryAfter: 2 * time.Minute}
}
func (rateLimitProbeAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (rateLimitProbeAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (rateLimitProbeAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (rateLimitProbeAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}
func (rateLimitProbeAdapter) ListSourceEvents(context.Context, adapter.Session, time.Time, string, int) (canonical.SourceEventBatch, error) {
	return canonical.SourceEventBatch{}, &adapter.ErrRateLimited{RetryAfter: 2 * time.Minute}
}

func (rateLimitDiscoveryAdapter) Capabilities() canonical.AdapterCapabilities {
	return canonical.AdapterCapabilities{Source: rateLimitDiscoverySource, AuthMethod: "api_key"}
}
func (rateLimitDiscoveryAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: rateLimitDiscoverySource}, nil
}
func (rateLimitDiscoveryAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{}, &adapter.ErrRateLimited{RetryAfter: 10 * time.Minute}
}
func (rateLimitDiscoveryAdapter) ListSubscribers(context.Context, adapter.Session, string) ([]canonical.Subscriber, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (rateLimitDiscoveryAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (rateLimitDiscoveryAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (rateLimitDiscoveryAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (rateLimitDiscoveryAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (completionRaceProbeAdapter) Capabilities() canonical.AdapterCapabilities {
	return canonical.AdapterCapabilities{Source: completionRaceProbeSource, AuthMethod: "api_key"}
}
func (completionRaceProbeAdapter) Authenticate(context.Context, adapter.Credentials) (adapter.Session, error) {
	return adapter.Session{Source: completionRaceProbeSource}, nil
}
func (completionRaceProbeAdapter) Discover(context.Context, adapter.Session) (adapter.DiscoveryReport, error) {
	return adapter.DiscoveryReport{}, nil
}
func (completionRaceProbeAdapter) ListSubscribers(context.Context, adapter.Session, string) ([]canonical.Subscriber, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (completionRaceProbeAdapter) ListSegments(context.Context, adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}
func (completionRaceProbeAdapter) ListAutomations(context.Context, adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}
func (completionRaceProbeAdapter) ListCampaignArchive(context.Context, adapter.Session, string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}
func (completionRaceProbeAdapter) ListPaidSubs(context.Context, adapter.Session, string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func (s cancelSensitiveStore) Update(ctx context.Context, j *canonical.MigrationJob) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.MemoryJobStore.Update(ctx, j)
}

func (s *completionConflictStore) UpdateIfStatus(ctx context.Context, job *canonical.MigrationJob, expected ...canonical.MigrationStatus) error {
	if job != nil && (job.Status == canonical.MigAwaitingConfirmation || job.Status == canonical.MigCompleted) {
		s.once.Do(func() {
			_ = s.MemoryJobStore.CancelIfStatus(ctx, job.ID, cancelledByOperatorMsg, nil, expected...)
		})
	}
	return s.MemoryJobStore.UpdateIfStatus(ctx, job, expected...)
}

func registerPanicAdapter() {
	registerPanicAdapterOnce.Do(func() {
		adapter.Register(panicSource, func() adapter.Adapter { return panicAdapter{} })
	})
}

func registerPanicDiscoveryAdapter() {
	registerPanicDiscoveryAdapterOnce.Do(func() {
		adapter.Register(panicDiscoverySource, func() adapter.Adapter { return panicDiscoveryAdapter{} })
	})
}

func registerSourceEventProbeAdapter() {
	registerSourceEventProbeAdapterOnce.Do(func() {
		adapter.Register(sourceEventProbeSource, func() adapter.Adapter { return sourceEventProbeAdapter{} })
	})
}

func registerCancellationProbeAdapter() {
	registerCancellationProbeAdapterOnce.Do(func() {
		adapter.Register(cancellationProbeSource, func() adapter.Adapter { return cancellationProbeAdapter{} })
	})
}

func registerRateLimitProbeAdapter() {
	registerRateLimitProbeAdapterOnce.Do(func() {
		adapter.Register(rateLimitProbeSource, func() adapter.Adapter { return rateLimitProbeAdapter{} })
	})
}

func registerRateLimitDiscoveryAdapter() {
	registerRateLimitDiscoveryAdapterOnce.Do(func() {
		adapter.Register(rateLimitDiscoverySource, func() adapter.Adapter { return rateLimitDiscoveryAdapter{} })
	})
}

func registerCompletionRaceProbeAdapter() {
	registerCompletionRaceProbeAdapterOnce.Do(func() {
		adapter.Register(completionRaceProbeSource, func() adapter.Adapter { return completionRaceProbeAdapter{} })
	})
}

func resetSourceEventProbeSince() {
	sourceEventProbeState.Lock()
	defer sourceEventProbeState.Unlock()
	sourceEventProbeState.since = time.Time{}
	sourceEventProbeState.cursors = nil
	sourceEventProbeState.batches = nil
}

func resetCancellationProbe() chan struct{} {
	started := make(chan struct{})
	cancellationProbeState.Lock()
	cancellationProbeState.started = started
	cancellationProbeState.Unlock()
	return started
}

func setSourceEventProbeBatch(batch canonical.SourceEventBatch) {
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{"": batch})
}

func setSourceEventProbeBatches(batches map[string]canonical.SourceEventBatch) {
	sourceEventProbeState.Lock()
	defer sourceEventProbeState.Unlock()
	sourceEventProbeState.batches = make(map[string]canonical.SourceEventBatch, len(batches))
	for cursor, batch := range batches {
		sourceEventProbeState.batches[cursor] = cloneSourceEventProbeBatch(batch)
	}
}

func sourceEventProbeSince() time.Time {
	sourceEventProbeState.Lock()
	defer sourceEventProbeState.Unlock()
	return sourceEventProbeState.since
}

func sourceEventProbeCursors() []string {
	sourceEventProbeState.Lock()
	defer sourceEventProbeState.Unlock()
	return append([]string(nil), sourceEventProbeState.cursors...)
}

func cloneSourceEventProbeBatch(batch canonical.SourceEventBatch) canonical.SourceEventBatch {
	batch.Events = append([]canonical.SourceEvent(nil), batch.Events...)
	return batch
}

func TestListSourcesMarksActiveCampaignAutomationModeAsRebuildReview(t *testing.T) {
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/sources", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var caps []canonical.AdapterCapabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
		t.Fatalf("decode capabilities: %v", err)
	}
	for _, cap := range caps {
		if cap.Source != canonical.SourceActiveCampaign {
			continue
		}
		if !cap.Supports.Automations || cap.Supports.AutomationMode != "rebuild_review" {
			t.Fatalf("activecampaign automation support = %v/%q, want rebuild_review", cap.Supports.Automations, cap.Supports.AutomationMode)
		}
		return
	}
	t.Fatalf("activecampaign capability missing from /sources response: %+v", caps)
}

func TestDiscoveryResponseIncludesRegisteredCapabilities(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDiscoveryJSON(rec, "job-mailchimp", canonical.SourceMailchimp, adapter.DiscoveryReport{SubscribersTotal: 7})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		JobID            string                        `json:"job_id"`
		Source           canonical.SourcePlatform      `json:"source"`
		SubscribersCount int                           `json:"subscribers_count"`
		Capabilities     canonical.AdapterCapabilities `json:"capabilities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.JobID != "job-mailchimp" || body.Source != canonical.SourceMailchimp || body.SubscribersCount != 7 {
		t.Fatalf("discovery identity/count = %q/%q/%d", body.JobID, body.Source, body.SubscribersCount)
	}
	if body.Capabilities.Source != canonical.SourceMailchimp || body.Capabilities.AuthMethod != "oauth2" || !body.Capabilities.Supports.Subscribers {
		t.Fatalf("capabilities = %+v, want registered Mailchimp capability matrix", body.Capabilities)
	}
}

func TestKlaviyoDiscoveryResponseExposesExcludedProfilesAndExactArchiveBounds(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDiscoveryJSON(rec, "job-klaviyo", canonical.SourceKlaviyo, adapter.DiscoveryReport{
		SubscribersTotal:          7,
		ProfilesWithoutEmailTotal: 3,
		SourceArchiveTotal:        12,
		SMSCampaignsTotal:         2,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		SubscribersCount          int `json:"subscribers_count"`
		ProfilesWithoutEmailCount int `json:"profiles_without_email_count"`
		SourceArchiveCount        int `json:"source_archive_count"`
		SMSCampaignsCount         int `json:"sms_campaigns_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SubscribersCount != 7 || body.ProfilesWithoutEmailCount != 3 || body.SourceArchiveCount != 12 || body.SMSCampaignsCount != 2 {
		t.Fatalf("Klaviyo discovery bounds = %+v", body)
	}
}

func TestHubSpotDiscoveryResponseExposesAdditionalEmailIdentityEvidence(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDiscoveryJSON(rec, "job-hubspot", canonical.SourceHubSpot, adapter.DiscoveryReport{
		SubscribersTotal:               7,
		ProfilesWithoutEmailTotal:      2,
		AdditionalEmailIdentitiesTotal: 3,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		SubscribersCount               int `json:"subscribers_count"`
		ProfilesWithoutEmailCount      int `json:"profiles_without_email_count"`
		AdditionalEmailIdentitiesCount int `json:"additional_email_identities_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SubscribersCount != 7 || body.ProfilesWithoutEmailCount != 2 || body.AdditionalEmailIdentitiesCount != 3 {
		t.Fatalf("HubSpot discovery identity bounds = %+v", body)
	}
}

func TestCustomerIODiscoveryResponseExposesExactProviderMetadataCounts(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDiscoveryJSON(rec, "job-customerio", canonical.SourceCustomerIO, adapter.DiscoveryReport{
		CustomObjectsTotal:        4,
		SubscriptionChannelsTotal: 3,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		CustomObjectsCount        int `json:"custom_objects_count"`
		SubscriptionChannelsCount int `json:"subscription_channels_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.CustomObjectsCount != 4 {
		t.Fatalf("Customer.io object-type metadata count = %d, want 4", body.CustomObjectsCount)
	}
	if body.SubscriptionChannelsCount != 3 {
		t.Fatalf("Customer.io subscription-channel definition count = %d, want 3", body.SubscriptionChannelsCount)
	}
}

func TestKickoffWithExpiredSessionDoesNotAdvanceJobStatus(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "33333333333333333333333333333333",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/dry-run", bytes.NewBufferString(`{"job_id":"33333333333333333333333333333333"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation {
		t.Fatalf("job status = %q, want %q", stored.Status, canonical.MigAwaitingConfirmation)
	}
}

func TestGetAuditDerivesLifecycleEntriesWithoutDatabase(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 10, 8, 0, 0, 0, time.UTC)
	completedAt := startedAt.Add(5 * time.Minute)
	job := &canonical.MigrationJob{
		ID:          "audit-job-1",
		TenantID:    "tenant_a",
		Source:      canonical.SourceMailchimp,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/audit-job-1/audit", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var entries []migrationAuditEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want terminal and started events", entries)
	}
	if entries[0].Event != "migration.completed" || entries[1].Event != "migration.started" {
		t.Fatalf("events = %q, %q", entries[0].Event, entries[1].Event)
	}
}

func TestDeltaImportRequiresCompletedCommittedJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	originalCursor := "done"
	job := &canonical.MigrationJob{
		ID:        "23232323232323232323232323232323",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor: map[string]*string{
			"subscribers": &originalCursor,
		},
		Progress: canonical.MigrationProgress{SubscribersTotal: 10, SubscribersDone: 10},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(sourceBridgeSessionTTL)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/delta-import", bytes.NewBufferString(`{"job_id":"23232323232323232323232323232323"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation {
		t.Fatalf("status = %q, want awaiting_confirmation", stored.Status)
	}
	if stored.Progress.SubscribersDone != 10 {
		t.Fatalf("progress = %+v, want original progress preserved", stored.Progress)
	}
	if got := stored.Cursor["subscribers"]; got == nil || *got != "done" {
		t.Fatalf("cursor = %#v, want original subscriber cursor", stored.Cursor)
	}
	if _, ok := stored.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot should not be written for ineligible jobs")
	}
}

func TestActiveCampaignDiscoverRequiresFreshSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "21212121212121212121212121212121",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/discover", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before running discovery") {
		t.Fatalf("body = %s, want near-expiry discovery error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation {
		t.Fatalf("status = %q, want awaiting_confirmation", stored.Status)
	}
}

func TestHubSpotDiscoverRequiresFreshSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "21212121212121212121212121212122",
		TenantID:  "tenant_a",
		Source:    canonical.SourceHubSpot,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "12345",
		Source:      canonical.SourceHubSpot,
	}, time.Now().Add(sourceBridgeNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/hubspot/discover", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before running discovery") {
		t.Fatalf("body = %s, want near-expiry discovery error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation {
		t.Fatalf("status = %q, want awaiting_confirmation", stored.Status)
	}
}

func TestActiveCampaignKickoffRequiresFreshSourceSession(t *testing.T) {
	for _, tc := range []struct {
		name   string
		route  string
		action string
	}{
		{
			name:   "dry-run",
			route:  "/v1/migrations/activecampaign/dry-run",
			action: "starting dry-run",
		},
		{
			name:   "commit",
			route:  "/v1/migrations/activecampaign/commit",
			action: "starting import",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			job := &canonical.MigrationJob{
				ID:        "22222222222222222222222222222222",
				TenantID:  "tenant_a",
				Source:    canonical.SourceActiveCampaign,
				Status:    canonical.MigAwaitingConfirmation,
				StartedAt: time.Now(),
				Cursor:    map[string]*string{},
			}
			if err := store.Create(context.Background(), job); err != nil {
				t.Fatalf("create: %v", err)
			}
			if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
				AccessToken: "tok",
				AccountID:   "https://example.api-us1.com/api/3",
				Source:      canonical.SourceActiveCampaign,
			}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
				t.Fatalf("save session: %v", err)
			}

			h := NewMigration("", store)
			r := chi.NewRouter()
			h.Mount(r)

			req := httptest.NewRequest(http.MethodPost, tc.route, bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
			req.Header.Set("X-Tenant-ID", job.TenantID)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before "+tc.action) {
				t.Fatalf("body = %s, want near-expiry %s error", rec.Body.String(), tc.name)
			}
			stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			if stored.Status != canonical.MigAwaitingConfirmation {
				t.Fatalf("status = %q, want awaiting_confirmation", stored.Status)
			}
			if _, ok := stored.Cursor[runModeCursorKey]; ok {
				t.Fatalf("run mode cursor should not be written for near-expired sessions; cursor=%#v", stored.Cursor)
			}
		})
	}
}

func TestHubSpotKickoffRequiresFreshSourceSession(t *testing.T) {
	for _, tc := range []struct {
		name   string
		route  string
		action string
	}{
		{
			name:   "dry-run",
			route:  "/v1/migrations/hubspot/dry-run",
			action: "starting dry-run",
		},
		{
			name:   "commit",
			route:  "/v1/migrations/hubspot/commit",
			action: "starting import",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			job := &canonical.MigrationJob{
				ID:        "22222222222222222222222222222223",
				TenantID:  "tenant_a",
				Source:    canonical.SourceHubSpot,
				Status:    canonical.MigAwaitingConfirmation,
				StartedAt: time.Now(),
				Cursor:    map[string]*string{},
			}
			if err := store.Create(context.Background(), job); err != nil {
				t.Fatalf("create: %v", err)
			}
			if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
				AccessToken: "tok",
				AccountID:   "12345",
				Source:      canonical.SourceHubSpot,
			}, time.Now().Add(sourceBridgeNearExpiryWindow-time.Hour)); err != nil {
				t.Fatalf("save session: %v", err)
			}

			h := NewMigration("", store)
			r := chi.NewRouter()
			h.Mount(r)

			req := httptest.NewRequest(http.MethodPost, tc.route, bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
			req.Header.Set("X-Tenant-ID", job.TenantID)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before "+tc.action) {
				t.Fatalf("body = %s, want near-expiry %s error", rec.Body.String(), tc.name)
			}
			stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			if stored.Status != canonical.MigAwaitingConfirmation {
				t.Fatalf("status = %q, want awaiting_confirmation", stored.Status)
			}
			if _, ok := stored.Cursor[runModeCursorKey]; ok {
				t.Fatalf("run mode cursor should not be written for near-expired sessions; cursor=%#v", stored.Cursor)
			}
		})
	}
}

func TestDeltaImportRequiresFreshActiveCampaignSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-2 * time.Hour).UTC()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	job := &canonical.MigrationJob{
		ID:            "24242424242424242424242424242423",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now().Add(-3 * time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/delta-import", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before running a delta import") {
		t.Fatalf("body = %s, want near-expiry reconnect error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want completed", stored.Status)
	}
	if _, ok := stored.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot should not be written for near-expired sessions")
	}
}

func TestDeltaImportRequiresFreshHubSpotSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-2 * time.Hour).UTC()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	job := &canonical.MigrationJob{
		ID:            "24242424242424242424242424242424",
		TenantID:      "tenant_a",
		Source:        canonical.SourceHubSpot,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now().Add(-3 * time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "12345",
		Source:      canonical.SourceHubSpot,
	}, time.Now().Add(sourceBridgeNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/hubspot/delta-import", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before running a delta import") {
		t.Fatalf("body = %s, want near-expiry reconnect error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want completed", stored.Status)
	}
	if _, ok := stored.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot should not be written for near-expired sessions")
	}
}

func TestDeltaImportFailureRestoresCompletedJobState(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Now().Add(-3 * time.Hour).UTC()
	completedAt := time.Now().Add(-2 * time.Hour).UTC()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	importMode := runModeImporting
	subscriberCursor := "done"
	report := &canonical.VerificationReport{
		SubscribersImported: 10,
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource: "subscribers",
			Label:    "Subscribers",
			Imported: 10,
			Status:   "imported_runtime",
		}},
	}
	job := &canonical.MigrationJob{
		ID:                 "24242424242424242424242424242424",
		TenantID:           "tenant_a",
		Source:             panicSource,
		Status:             canonical.MigCompleted,
		StartedAt:          startedAt,
		CompletedAt:        &completedAt,
		RollbackUntil:      &rollbackUntil,
		VerificationReport: report,
		Progress: canonical.MigrationProgress{
			SubscribersTotal: 10,
			SubscribersDone:  10,
			SegmentsTotal:    3,
			SegmentsDone:     3,
		},
		Cursor: map[string]*string{
			runModeCursorKey: &importMode,
			"subscribers":    &subscriberCursor,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "panic-account",
		Source:      panicSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/panic_source/delta-import", bytes.NewBufferString(`{"job_id":"24242424242424242424242424242424"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusAccepted, rec.Body.String())
	}

	var stored *canonical.MigrationJob
	for i := 0; i < 100; i++ {
		got, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		stored = got
		if stored.Status != canonical.MigImporting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if stored == nil {
		t.Fatalf("stored job missing")
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want completed after failed delta restore; error=%v", stored.Status, stored.Error)
	}
	if stored.Progress.SubscribersDone != 10 || stored.Progress.SegmentsDone != 3 {
		t.Fatalf("progress = %+v, want completed progress restored", stored.Progress)
	}
	if stored.StartedAt.Sub(startedAt).Abs() > time.Second {
		t.Fatalf("started_at = %v, want restored %v", stored.StartedAt, startedAt)
	}
	if stored.CompletedAt == nil || stored.CompletedAt.Sub(completedAt).Abs() > time.Second {
		t.Fatalf("completed_at = %v, want restored %v", stored.CompletedAt, completedAt)
	}
	if stored.RollbackUntil == nil || stored.RollbackUntil.Sub(rollbackUntil).Abs() > time.Second {
		t.Fatalf("rollback_until = %v, want restored %v", stored.RollbackUntil, rollbackUntil)
	}
	if stored.VerificationReport == nil || stored.VerificationReport.SubscribersImported != 10 {
		t.Fatalf("verification report = %#v, want original report restored", stored.VerificationReport)
	}
	if got := stored.Cursor["subscribers"]; got == nil || *got != "done" {
		t.Fatalf("cursor = %#v, want original subscriber cursor", stored.Cursor)
	}
	if _, ok := stored.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot should be cleared after restore")
	}
	if stored.Error == nil || !strings.Contains(*stored.Error, "delta import failed") {
		t.Fatalf("error = %v, want delta import failure marker", stored.Error)
	}
	if got := stored.Cursor[deltaImportLastErrorKey]; got == nil || !strings.Contains(*got, "delta import failed") {
		t.Fatalf("last delta error cursor = %#v, want failure marker", stored.Cursor[deltaImportLastErrorKey])
	}
}

func TestDeltaImportRecordsStartedAtCursor(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-2 * time.Hour).UTC()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	importMode := runModeImporting
	demoSession := localDemoSession(canonical.SourceActiveCampaign, "delta")
	demoFingerprint := activeCampaignAccountFingerprint(demoSession)
	job := &canonical.MigrationJob{
		ID:            "25252525252525252525252525252525",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now().Add(-3 * time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor: map[string]*string{
			runModeCursorKey:               &importMode,
			activeCampaignAccountCursorKey: &demoFingerprint,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, demoSession, time.Now().Add(activeCampaignCutoverNearExpiryWindow+time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	preDeltaSyncedAt := time.Now().Add(-time.Minute).UTC()
	nextSyncAt := time.Now().Add(time.Minute).UTC()
	monitorEnabledAt := preDeltaSyncedAt.Add(-time.Minute)
	store.SetClock(func() time.Time { return monitorEnabledAt })
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&preDeltaSyncedAt,
		preDeltaSyncedAt,
		nextSyncAt,
		0,
		0,
		"",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/delta-import", bytes.NewBufferString(`{"job_id":"25252525252525252525252525252525"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusAccepted, rec.Body.String())
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want completed", stored.Status)
	}
	if mode, ok := cursorString(stored.Cursor, runModeCursorKey); !ok || mode != runModeDeltaImport {
		t.Fatalf("run mode cursor = %q/%v, want delta_import/true", mode, ok)
	}
	startedRaw, ok := cursorString(stored.Cursor, deltaImportStartedAtKey)
	if !ok || strings.TrimSpace(startedRaw) == "" {
		t.Fatalf("delta started_at cursor = %q/%v, want value/true", startedRaw, ok)
	}
	startedAt, err := time.Parse(time.RFC3339Nano, startedRaw)
	if err != nil {
		t.Fatalf("parse delta started_at cursor: %v", err)
	}
	if stored.StartedAt.Sub(startedAt).Abs() > time.Second {
		t.Fatalf("started_at = %s cursor = %s, want same delta start", stored.StartedAt.Format(time.RFC3339Nano), startedRaw)
	}
	preDeltaRaw, ok := cursorString(stored.Cursor, sourceEventPreDeltaSyncedKey)
	if !ok || strings.TrimSpace(preDeltaRaw) == "" {
		t.Fatalf("pre-delta source-event cursor = %q/%v, want value/true", preDeltaRaw, ok)
	}
	preDeltaCursorAt, err := time.Parse(time.RFC3339Nano, preDeltaRaw)
	if err != nil {
		t.Fatalf("parse pre-delta source-event cursor: %v", err)
	}
	if preDeltaCursorAt.Sub(preDeltaSyncedAt).Abs() > time.Second {
		t.Fatalf("pre-delta source-event cursor = %s, want %s", preDeltaRaw, preDeltaSyncedAt.Format(time.RFC3339Nano))
	}
	overlapRaw, ok := cursorString(stored.Cursor, sourceEventOverlapSnapshotKey)
	if !ok || strings.TrimSpace(overlapRaw) == "" {
		t.Fatalf("source-event overlap snapshot = %q/%v, want durable value", overlapRaw, ok)
	}
	var overlap sourceEventOverlapSnapshotV1
	if err := json.Unmarshal([]byte(overlapRaw), &overlap); err != nil {
		t.Fatalf("decode source-event overlap snapshot: %v", err)
	}
	if overlap.Version != 1 || !overlap.EnabledSince.Equal(monitorEnabledAt) ||
		!overlap.FirstSuccessfulSync.Equal(preDeltaSyncedAt) ||
		!overlap.PreDeltaSyncedAt.Equal(preDeltaSyncedAt) || overlap.SuccessfulSyncs != 1 ||
		overlap.IntervalSeconds != 300 || overlap.MaxSyncGapSeconds != 0 ||
		!overlap.CapturedAt.Equal(startedAt) {
		t.Fatalf("source-event overlap snapshot = %+v, want monitor evidence captured at delta start %s", overlap, startedAt)
	}
}

func TestDeltaImportRecordsHubSpotPreDeltaSourceEventSync(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-2 * time.Hour).UTC()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	importMode := runModeImporting
	job := &canonical.MigrationJob{
		ID:            "25252525252525252525252525252526",
		TenantID:      "tenant_a",
		Source:        canonical.SourceHubSpot,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now().Add(-3 * time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{runModeCursorKey: &importMode},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "postwave-local-demo",
		AccountID:   "demo-hubspot-delta",
		Source:      canonical.SourceHubSpot,
	}, time.Now().Add(sourceBridgeNearExpiryWindow+time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	preDeltaSyncedAt := time.Now().Add(-time.Minute).UTC()
	nextSyncAt := time.Now().Add(time.Minute).UTC()
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceHubSpot,
		Enabled:         true,
		IntervalSeconds: 300,
	}); err != nil {
		t.Fatalf("upsert source-event monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		&preDeltaSyncedAt,
		preDeltaSyncedAt,
		nextSyncAt,
		0,
		0,
		"",
	); err != nil {
		t.Fatalf("update source-event monitor: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/hubspot/delta-import", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusAccepted, rec.Body.String())
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	preDeltaRaw, ok := cursorString(stored.Cursor, sourceEventPreDeltaSyncedKey)
	if !ok || strings.TrimSpace(preDeltaRaw) == "" {
		t.Fatalf("pre-delta source-event cursor = %q/%v, want value/true", preDeltaRaw, ok)
	}
	preDeltaCursorAt, err := time.Parse(time.RFC3339Nano, preDeltaRaw)
	if err != nil {
		t.Fatalf("parse pre-delta source-event cursor: %v", err)
	}
	if preDeltaCursorAt.Sub(preDeltaSyncedAt).Abs() > time.Second {
		t.Fatalf("pre-delta source-event cursor = %s, want %s", preDeltaRaw, preDeltaSyncedAt.Format(time.RFC3339Nano))
	}
}

func TestUploadChunkRejectsOversizedTotal(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_1?filename=test.csv", strings.NewReader("x"))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	req.Header.Set("Content-Range", "bytes 0-0/"+strconv.FormatInt(maxMigrationUploadBytes+1, 10))
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

func TestResumableUploadRoutesRejectUnsupportedSource(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	tests := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/v1/migrations/mailchimp/uploads/upload_unsupported"},
		{http.MethodPost, "/v1/migrations/mailchimp/uploads/upload_unsupported/complete"},
	}
	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			req.Header.Set("X-Tenant-ID", "tenant_a")
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "does not support file uploads") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestUploadChunkRejectsOversizedChunkBeforeReadingBody(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	end := maxMigrationUploadChunkBytes
	req := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_2?filename=test.csv", http.NoBody)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	req.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", end, end+1))
	req.ContentLength = -1
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUploadChunkRejectsContentLengthMismatch(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_3?filename=test.csv", strings.NewReader("xy"))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	req.Header.Set("Content-Range", "bytes 0-0/1")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUploadChunkRejectsChunkedBodyLongerThanRange(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_4?filename=test.csv", strings.NewReader("xy"))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	req.Header.Set("Content-Range", "bytes 0-0/1")
	req.ContentLength = -1
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "exceeds Content-Range") {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestResumableUploadRejectsSparseChunksAndReportsContiguousOffset(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	first := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_contiguous?filename=test.csv", strings.NewReader("abc"))
	first.Header.Set("X-Tenant-ID", "tenant_a")
	first.Header.Set("Content-Range", "bytes 0-2/6")
	firstRec := httptest.NewRecorder()
	r.ServeHTTP(firstRec, first)
	if firstRec.Code != http.StatusOK || !strings.Contains(firstRec.Body.String(), `"received":3`) {
		t.Fatalf("first chunk status=%d body=%s, want received=3", firstRec.Code, firstRec.Body.String())
	}

	status := httptest.NewRequest(http.MethodGet, "/v1/migrations/csv/uploads/upload_contiguous", nil)
	status.Header.Set("X-Tenant-ID", "tenant_a")
	statusRec := httptest.NewRecorder()
	r.ServeHTTP(statusRec, status)
	if statusRec.Code != http.StatusOK || !strings.Contains(statusRec.Body.String(), `"received":3`) {
		t.Fatalf("status=%d body=%s, want received=3", statusRec.Code, statusRec.Body.String())
	}

	sparse := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload_contiguous?filename=test.csv", strings.NewReader("ef"))
	sparse.Header.Set("X-Tenant-ID", "tenant_a")
	sparse.Header.Set("Content-Range", "bytes 4-5/6")
	sparseRec := httptest.NewRecorder()
	r.ServeHTTP(sparseRec, sparse)
	if sparseRec.Code != http.StatusConflict || !strings.Contains(sparseRec.Body.String(), `"expected_offset":3`) {
		t.Fatalf("sparse status=%d body=%s, want expected_offset=3", sparseRec.Code, sparseRec.Body.String())
	}

	complete := httptest.NewRequest(http.MethodPost, "/v1/migrations/csv/uploads/upload_contiguous/complete", nil)
	complete.Header.Set("X-Tenant-ID", "tenant_a")
	completeRec := httptest.NewRecorder()
	r.ServeHTTP(completeRec, complete)
	if completeRec.Code != http.StatusConflict || !strings.Contains(completeRec.Body.String(), "upload incomplete") {
		t.Fatalf("complete status=%d body=%s, want incomplete conflict", completeRec.Code, completeRec.Body.String())
	}
}

func TestRunJobPanicMarksJobFailed(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "panic-token",
		AccountID:   "panic-account",
		Source:      panicSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	h.runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigFailed {
		t.Fatalf("status = %q, want %q", stored.Status, canonical.MigFailed)
	}
	if stored.Error == nil || !strings.Contains(*stored.Error, "adapter subscriber panic") {
		t.Fatalf("error = %#v, want recovered panic text", stored.Error)
	}
}

func TestRunJobDryRunDoesNotResolveListmonkClient(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "acacacacacacacacacacacacacacacac",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "panic-token",
		AccountID:   "panic-account",
		Source:      panicSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		t.Fatalf("dry-run should not resolve destination Listmonk credentials")
		return nil, nil
	})
	h.runJob(context.Background(), job.TenantID, job.ID)
}

func TestRunJobRateLimitLeavesJobRunnable(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "rate-limit-token",
		AccountID:   "rate-limit-account",
		Source:      rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	h.runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigDryRun {
		t.Fatalf("status = %q, want job to remain runnable as %q", stored.Status, canonical.MigDryRun)
	}
	if stored.Error == nil || !strings.Contains(*stored.Error, "source rate limited") {
		t.Fatalf("error = %#v, want source rate limit pause message", stored.Error)
	}
	retryAtRaw, ok := cursorString(stored.Cursor, rateLimitRetryAtCursorKey)
	if !ok {
		t.Fatalf("retry cursor missing: %#v", stored.Cursor)
	}
	retryAt, err := time.Parse(time.RFC3339Nano, retryAtRaw)
	if err != nil {
		t.Fatalf("parse retry cursor: %v", err)
	}
	if !retryAt.After(time.Now()) {
		t.Fatalf("retry_at = %s, want future", retryAtRaw)
	}
	if retryAfter, ok := cursorString(stored.Cursor, rateLimitRetryAfterCursorKey); !ok || retryAfter != (2*time.Minute).String() {
		t.Fatalf("retry_after = %q ok=%v, want %q", retryAfter, ok, (2 * time.Minute).String())
	}
}

func TestRecoverRunnableJobsSkipsRateLimitedUntilRetryAt(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	retryAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	job := &canonical.MigrationJob{
		ID:        "abababababababababababababababab",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor: map[string]*string{
			rateLimitRetryAtCursorKey: &retryAt,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "rate-limit-token",
		AccountID:   "rate-limit-account",
		Source:      rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	recovered, err := h.RecoverRunnableJobs(context.Background())
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if recovered != 0 {
		t.Fatalf("recovered = %d, want 0 while retry_at is in the future", recovered)
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Error != nil {
		t.Fatalf("error = %#v, want adapter not invoked while paused", stored.Error)
	}
}

func TestRunJobWorkerCancellationLeavesJobRunnable(t *testing.T) {
	registerCancellationProbeAdapter()
	t.Setenv("LISTMONK_URL", "http://127.0.0.1:9")
	t.Setenv("LISTMONK_ADMIN_USER", "admin")
	t.Setenv("LISTMONK_ADMIN_PASSWORD", "password")
	t.Setenv("LISTMONK_TENANT_MODE", "dedicated")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant_a")
	store := cancelSensitiveStore{MemoryJobStore: jobstore.NewMemoryJobStore()}
	job := &canonical.MigrationJob{
		ID:        "dddddddddddddddddddddddddddddddd",
		TenantID:  "tenant_a",
		Source:    cancellationProbeSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "cancel-token",
		AccountID:   "cancel-account",
		Source:      cancellationProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	// The cancellation probe exercises a commit worker. Supply the same
	// tenant-scoped destination prerequisites production commits require so
	// the worker reaches the blocking adapter call before cancellation.
	h.db = newVerifierNoopDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.runJob(ctx, job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigImporting {
		t.Fatalf("status = %q, want %q so recovery can reclaim the job", stored.Status, canonical.MigImporting)
	}
	if stored.Error != nil {
		t.Fatalf("error = %q, want no terminal cancellation error", *stored.Error)
	}
}

func TestRunJobOperatorCancellationPersistsThroughCancelledContext(t *testing.T) {
	registerCancellationProbeAdapter()
	t.Setenv("LISTMONK_URL", "http://127.0.0.1:9")
	t.Setenv("LISTMONK_ADMIN_USER", "admin")
	t.Setenv("LISTMONK_ADMIN_PASSWORD", "password")
	t.Setenv("LISTMONK_TENANT_MODE", "dedicated")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant_a")
	started := resetCancellationProbe()
	store := cancelSensitiveStore{MemoryJobStore: jobstore.NewMemoryJobStore()}
	job := &canonical.MigrationJob{
		ID:        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		TenantID:  "tenant_a",
		Source:    cancellationProbeSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "cancel-token",
		AccountID:   "cancel-account",
		Source:      cancellationProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	// See TestRunJobWorkerCancellationLeavesJobRunnable: without the commit
	// prerequisites the fail-closed preflight correctly stops before the
	// cancellation probe starts.
	h.db = newVerifierNoopDB(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.runJob(context.Background(), job.TenantID, job.ID)
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("adapter did not start")
	}
	if !h.control.Cancel(job.ID) {
		t.Fatalf("cancel control did not find active job")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("runJob did not stop after operator cancellation")
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigFailed {
		t.Fatalf("status = %q, want %q", stored.Status, canonical.MigFailed)
	}
	if stored.Error == nil || *stored.Error != cancelledByOperatorMsg {
		t.Fatalf("error = %#v, want operator cancellation marker", stored.Error)
	}
	if stored.RollbackUntil == nil {
		t.Fatalf("rollback_until should be available after cancelling an import")
	}
}

func TestRunJobCompletionCASLostToRemoteCancellationNeverAnnouncesSuccess(t *testing.T) {
	registerCompletionRaceProbeAdapter()
	store := &completionConflictStore{MemoryJobStore: jobstore.NewMemoryJobStore()}
	job := &canonical.MigrationJob{
		ID:        "fafafafafafafafafafafafafafafafa",
		TenantID:  "tenant_a",
		Source:    completionRaceProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "completion-race-token",
		AccountID:   "completion-race-account",
		Source:      completionRaceProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	events, unsubscribe := h.broadcaster.Subscribe(job.ID)
	defer unsubscribe()
	h.runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !isCancelledJob(stored) {
		t.Fatalf("durable job = %+v, want exact operator-cancelled state", stored)
	}
	foundCancelled := false
	for {
		select {
		case event := <-events:
			if event.CurrentStep == "Migration complete" {
				t.Fatalf("remote cancellation race emitted false success event: %+v", event)
			}
			if event.CurrentStep == "Migration cancelled" {
				foundCancelled = true
			}
		default:
			if !foundCancelled {
				t.Fatal("remote cancellation race did not publish the durable cancelled outcome")
			}
			return
		}
	}
}

func TestCancelJobStopsWorkerOwnedByAnotherServiceInstance(t *testing.T) {
	registerCancellationProbeAdapter()
	t.Setenv("LISTMONK_URL", "http://127.0.0.1:9")
	t.Setenv("LISTMONK_ADMIN_USER", "admin")
	t.Setenv("LISTMONK_ADMIN_PASSWORD", "password")
	t.Setenv("LISTMONK_TENANT_MODE", "dedicated")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant_a")
	started := resetCancellationProbe()
	store := cancelSensitiveStore{MemoryJobStore: jobstore.NewMemoryJobStore()}
	checkpoint := "subscriber-page-4"
	job := &canonical.MigrationJob{
		ID:        "edededededededededededededededed",
		TenantID:  "tenant_a",
		Source:    cancellationProbeSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{"subscribers": &checkpoint},
		Progress:  canonical.MigrationProgress{SubscribersDone: 400, SubscribersTotal: 1000},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "cancel-token",
		AccountID:   "cancel-account",
		Source:      cancellationProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	owner := NewMigration("", store)
	owner.db = newVerifierNoopDB(t)
	requestReplica := NewMigration("", store)
	done := make(chan struct{})
	go func() {
		defer close(done)
		owner.runJob(context.Background(), job.TenantID, job.ID)
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("adapter did not start")
	}
	if requestReplica.control.Cancel(job.ID) {
		t.Fatalf("request replica unexpectedly owned the worker")
	}
	router := chi.NewRouter()
	requestReplica.Mount(router)
	req := httptest.NewRequest(http.MethodDelete, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var response struct {
		Cancelled bool   `json:"cancelled"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Cancelled || response.Status != string(canonical.MigFailed) {
		t.Fatalf("response = %+v, want durable cross-instance cancellation", response)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("remote worker did not observe durable cancellation")
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigFailed || stored.Error == nil || *stored.Error != cancelledByOperatorMsg {
		t.Fatalf("stored job = %+v, want operator-cancelled terminal state", stored)
	}
	if stored.Progress.SubscribersDone != 400 || stored.Cursor["subscribers"] == nil || *stored.Cursor["subscribers"] != checkpoint {
		t.Fatalf("durable cancellation rewound checkpoint: progress=%+v cursor=%v", stored.Progress, stored.Cursor)
	}
	if stored.RollbackUntil == nil {
		t.Fatalf("cross-instance import cancellation must retain rollback availability")
	}
}

func TestCancelDeltaImportRestoresSnapshotAcrossServiceInstances(t *testing.T) {
	registerCancellationProbeAdapter()
	t.Setenv("LISTMONK_URL", "http://127.0.0.1:9")
	t.Setenv("LISTMONK_ADMIN_USER", "admin")
	t.Setenv("LISTMONK_ADMIN_PASSWORD", "password")
	t.Setenv("LISTMONK_TENANT_MODE", "dedicated")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant_a")
	started := resetCancellationProbe()
	store := cancelSensitiveStore{MemoryJobStore: jobstore.NewMemoryJobStore()}
	priorCursor := "completed-page"
	priorCompletedAt := time.Now().Add(-time.Hour).UTC()
	priorRollbackUntil := priorCompletedAt.Add(7 * 24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "dededededededededededededededede",
		TenantID:      "tenant_a",
		Source:        cancellationProbeSource,
		Status:        canonical.MigCompleted,
		StartedAt:     priorCompletedAt.Add(-time.Hour),
		CompletedAt:   &priorCompletedAt,
		RollbackUntil: &priorRollbackUntil,
		Cursor:        map[string]*string{"subscribers": &priorCursor},
		Progress:      canonical.MigrationProgress{SubscribersDone: 700, SubscribersTotal: 700},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 700,
		},
	}
	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatalf("attach delta snapshot: %v", err)
	}
	job.Status = canonical.MigImporting
	job.Progress = canonical.MigrationProgress{}
	job.CompletedAt = nil
	job.RollbackUntil = nil
	job.VerificationReport = nil
	job.StartedAt = time.Now()
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "cancel-token", AccountID: "cancel-account", Source: cancellationProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	owner := NewMigration("", store)
	owner.db = newVerifierNoopDB(t)
	requestReplica := NewMigration("", store)
	done := make(chan struct{})
	go func() {
		defer close(done)
		owner.runJob(context.Background(), job.TenantID, job.ID)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("delta adapter did not start")
	}

	router := chi.NewRouter()
	requestReplica.Mount(router)
	req := httptest.NewRequest(http.MethodDelete, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var response struct {
		Cancelled bool   `json:"cancelled"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Cancelled || response.Status != string(canonical.MigCompleted) {
		t.Fatalf("response = %+v, want restored completed delta cancellation", response)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("remote delta worker did not observe restored cancellation marker")
	}

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted || !isCancelledDeltaImport(stored) || isCancelledJob(stored) {
		t.Fatalf("stored delta job = %+v, want restored completed cancellation", stored)
	}
	if stored.Progress.SubscribersDone != 700 || stored.Cursor["subscribers"] == nil || *stored.Cursor["subscribers"] != priorCursor {
		t.Fatalf("delta cancellation did not restore checkpoint: progress=%+v cursor=%v", stored.Progress, stored.Cursor)
	}
	if stored.CompletedAt == nil || !stored.CompletedAt.Equal(priorCompletedAt) ||
		stored.RollbackUntil == nil || !stored.RollbackUntil.Equal(priorRollbackUntil) ||
		stored.VerificationReport == nil || stored.VerificationReport.SubscribersImported != 700 {
		t.Fatalf("delta cancellation did not restore prior completion evidence: %+v", stored)
	}
}

func TestIsCancelledJobRequiresCanonicalOperatorMarker(t *testing.T) {
	marker := cancelledByOperatorMsg
	unrelated := "source request was cancelled by upstream"
	wrongStatus := canonical.MigImporting
	failedStatus := canonical.MigFailed
	cases := []struct {
		name string
		job  *canonical.MigrationJob
		want bool
	}{
		{name: "nil", job: nil},
		{name: "canonical", job: &canonical.MigrationJob{Status: failedStatus, Error: &marker}, want: true},
		{name: "unrelated cancellation failure", job: &canonical.MigrationJob{Status: failedStatus, Error: &unrelated}},
		{name: "wrong status", job: &canonical.MigrationJob{Status: wrongStatus, Error: &marker}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isCancelledJob(tc.job); got != tc.want {
				t.Fatalf("isCancelledJob(%+v) = %v, want %v", tc.job, got, tc.want)
			}
		})
	}
}

func TestRollbackWorkerPanicMarksProgressAndJobError(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	rollbackUntil := time.Now().Add(time.Hour)
	origin := string(canonical.MigCompleted)
	job := &canonical.MigrationJob{
		ID:            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TenantID:      "tenant_a",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigRollingBack,
		StartedAt:     time.Now(),
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{rollbackOriginStatusCursorKey: &origin},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	eng := orchestrator.NewRollbackEngine(nil, nil, job.TenantID)
	eng.Now = func() time.Time { panic("rollback clock panic") }

	h.startRollbackWorker(job, eng)

	deadline := time.Now().Add(2 * time.Second)
	var stored *canonical.MigrationJob
	for time.Now().Before(deadline) {
		var err error
		stored, err = store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if stored.Error != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if stored == nil || stored.Error == nil || !strings.Contains(*stored.Error, "rollback clock panic") {
		t.Fatalf("stored error = %#v, want recovered rollback panic", stored)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want %q so rollback can be retried", stored.Status, canonical.MigCompleted)
	}
	prog := eng.Progress(job.ID)
	if prog == nil || prog.State != "failed" || !strings.Contains(prog.Error, "rollback clock panic") {
		t.Fatalf("progress = %#v, want failed rollback progress", prog)
	}
}

func TestShadowCheckPanicReturnsError(t *testing.T) {
	registerPanicDiscoveryAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "cccccccccccccccccccccccccccccccc",
		TenantID:  "tenant_a",
		Source:    panicDiscoverySource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "panic-token",
		AccountID:   "panic-account",
		Source:      panicDiscoverySource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)

	resp, err := h.runShadowCheck(context.Background(), job.TenantID, job.Source, job.ID)
	if err == nil || !strings.Contains(err.Error(), "adapter discovery panic") {
		t.Fatalf("err = %v, want recovered discovery panic", err)
	}
	if resp.JobID != job.ID || resp.Source != job.Source || resp.GeneratedAt.IsZero() {
		t.Fatalf("response = %+v, want identifying fallback response", resp)
	}
}

func TestSourceEventSyncPanicReturnsError(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "dddddddddddddddddddddddddddddddd",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "panic-token",
		AccountID:   "panic-account",
		Source:      panicSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	previousEventAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	monitor := jobstore.SourceEventMonitorRecord{
		JobID:       job.ID,
		TenantID:    job.TenantID,
		Source:      panicSource,
		Cursor:      "keep-me",
		LastEventAt: &previousEventAt,
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), monitor)
	if err == nil || !strings.Contains(err.Error(), "adapter source-event panic") {
		t.Fatalf("err = %v, want recovered source-event panic", err)
	}
	if seen != 0 || applied != 0 || cursor != monitor.Cursor {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 0/0/%q", seen, applied, cursor, monitor.Cursor)
	}
	if lastEventAt != nil {
		t.Fatalf("lastEventAt = %v, want nil so persisted watermark is preserved", lastEventAt)
	}
}

func TestStartSourceEventMonitorRequiresCompletedJob(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/panic_source/source-events", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "requires a completed migration job") {
		t.Fatalf("body = %s, want completed-job error", rec.Body.String())
	}
	if _, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); err == nil {
		t.Fatalf("source-event monitor should not be created for unfinished job")
	}
}

func TestStartSourceEventMonitorRequiresLiveSourceSession(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef",
		TenantID:      "tenant_a",
		Source:        panicSource,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/panic_source/source-events", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expired") {
		t.Fatalf("body = %s, want source-session error", rec.Body.String())
	}
	if _, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("source-event monitor err = %v, want not found", err)
	}
}

func TestStartSourceEventMonitorRequiresFreshActiveCampaignSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeef0",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/activecampaign/source-events", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before starting source-event monitoring") {
		t.Fatalf("body = %s, want near-expiry source-session error", rec.Body.String())
	}
	if _, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("source-event monitor err = %v, want not found", err)
	}
}

func TestStartSourceEventMonitorRequiresFreshHubSpotSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeef1",
		TenantID:      "tenant_a",
		Source:        canonical.SourceHubSpot,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "12345",
		Source:      canonical.SourceHubSpot,
	}, time.Now().Add(sourceBridgeNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/hubspot/source-events", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before starting source-event monitoring") {
		t.Fatalf("body = %s, want near-expiry source-session error", rec.Body.String())
	}
	if _, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("source-event monitor err = %v, want not found", err)
	}
}

func TestSourceEventSyncRequiresCompletedJob(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "ffffffffffffffffffffffffffffffff",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	monitor := jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   panicSource,
		Cursor:   "keep-me",
	}

	seen, applied, cursor, _, err := h.runSourceEventSync(context.Background(), monitor)
	if err == nil || !strings.Contains(err.Error(), "requires a completed migration job") {
		t.Fatalf("err = %v, want completed-job error", err)
	}
	if seen != 0 || applied != 0 || cursor != monitor.Cursor {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 0/0/%q", seen, applied, cursor, monitor.Cursor)
	}
}

func TestRunDueSourceEventSyncsPausesWhileJobImporting(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "12121212121212121212121212121212",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	cursor := "keep-me"
	lastEventAt := now.Add(-time.Hour)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          panicSource,
		Enabled:         true,
		IntervalSeconds: 60,
		Cursor:          cursor,
		LastEventAt:     &lastEventAt,
		NextSyncAt:      &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	h := NewMigration("", store)

	n, err := h.RunDueSourceEventSyncs(context.Background(), 10)
	if err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.LastError != "" {
		t.Fatalf("last_error = %q, want empty pause without new error", monitor.LastError)
	}
	if monitor.LastSyncedAt != nil {
		t.Fatalf("last_synced_at = %v, want nil because pause did not run a sync", monitor.LastSyncedAt)
	}
	if monitor.Cursor != cursor {
		t.Fatalf("cursor = %q, want %q", monitor.Cursor, cursor)
	}
	if monitor.LastEventAt == nil || !monitor.LastEventAt.Equal(lastEventAt) {
		t.Fatalf("last_event_at = %v, want preserved %s", monitor.LastEventAt, lastEventAt)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("source-event results = %+v, want none while job importing", results)
	}
}

func TestRunDueSourceEventSyncsSkipsMonitorDisabledAfterDueList(t *testing.T) {
	registerPanicAdapter()
	base := jobstore.NewMemoryJobStore()
	store := &disableAfterDueListStore{MemoryJobStore: base}
	job := &canonical.MigrationJob{
		ID:        "abababababababababababababababab",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	due := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertSourceEventMonitor(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          panicSource,
		Enabled:         true,
		IntervalSeconds: 60,
		NextSyncAt:      &due,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	h := NewMigration("", store)
	if _, err := h.RunDueSourceEventSyncs(context.Background(), 10); err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	monitor, err := store.GetSourceEventMonitor(context.Background(), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.Enabled || monitor.LastSyncedAt != nil || monitor.LastError != "" {
		t.Fatalf("stale-listed disabled monitor was mutated: %+v", monitor)
	}
	results, err := store.ListSourceEventResults(context.Background(), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list results: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("stale-listed disabled monitor applied events: %+v", results)
	}
}

func TestRunDueSourceEventSyncsPreservesPreviousFailureWhileJobImporting(t *testing.T) {
	registerPanicAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "90909090909090909090909090909090",
		TenantID:  "tenant_a",
		Source:    panicSource,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	previousSync := now.Add(-time.Hour)
	nextDue := now
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          panicSource,
		Enabled:         true,
		IntervalSeconds: 60,
		NextSyncAt:      &nextDue,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"keep-me",
		nil,
		previousSync,
		nextDue,
		0,
		0,
		"",
	); err != nil {
		t.Fatalf("record previous successful sync: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"keep-me",
		nil,
		previousSync.Add(10*time.Minute),
		nextDue,
		0,
		0,
		"previous source-event error",
	); err != nil {
		t.Fatalf("record previous failure: %v", err)
	}
	h := NewMigration("", store)

	n, err := h.RunDueSourceEventSyncs(context.Background(), 10)
	if err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.LastError != "previous source-event error" {
		t.Fatalf("last_error = %q, want previous error preserved until a real sync runs", monitor.LastError)
	}
	if monitor.LastSyncedAt == nil || !monitor.LastSyncedAt.Equal(previousSync) {
		t.Fatalf("last_synced_at = %v, want previous sync %s preserved", monitor.LastSyncedAt, previousSync)
	}
	if monitor.NextSyncAt == nil || !monitor.NextSyncAt.After(now) {
		t.Fatalf("next_sync_at = %v, want rescheduled after pause", monitor.NextSyncAt)
	}
}

func TestRunDueSourceEventSyncsHonorsRateLimitRetryAfter(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "34343434343434343434343434343434",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "rate-limit-token",
		AccountID:   "rate-limit-account",
		Source:      rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	dueAt := time.Now().UTC().Add(-time.Minute)
	cursor := "keep-me"
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          rateLimitProbeSource,
		Enabled:         true,
		IntervalSeconds: 60,
		Cursor:          cursor,
		NextSyncAt:      &dueAt,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}

	h := NewMigration("", store)
	before := time.Now().UTC()
	n, err := h.RunDueSourceEventSyncs(context.Background(), 10)
	if err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.Cursor != cursor {
		t.Fatalf("cursor = %q, want preserved %q", monitor.Cursor, cursor)
	}
	if monitor.LastError == "" || !strings.Contains(monitor.LastError, "rate limited") {
		t.Fatalf("last_error = %q, want rate-limit error", monitor.LastError)
	}
	if monitor.LastSyncedAt != nil {
		t.Fatalf("last_synced_at = %v, want nil because failed sync is not replay evidence", monitor.LastSyncedAt)
	}
	if monitor.NextSyncAt == nil {
		t.Fatalf("next_sync_at nil")
	}
	if !monitor.NextSyncAt.After(before.Add(90 * time.Second)) {
		t.Fatalf("next_sync_at = %s, want retry-after based delay", monitor.NextSyncAt.Format(time.RFC3339Nano))
	}
	if monitor.NextSyncAt.After(before.Add(3 * time.Minute)) {
		t.Fatalf("next_sync_at = %s, want bounded near retry-after", monitor.NextSyncAt.Format(time.RFC3339Nano))
	}
}

func TestRunDueSourceEventSyncsPreservesLastSyncedAtOnFailure(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "56565656565656565656565656565656",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "rate-limit-token",
		AccountID:   "rate-limit-account",
		Source:      rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	previousSync := time.Now().UTC().Add(-30 * time.Minute)
	dueAt := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          rateLimitProbeSource,
		Enabled:         true,
		IntervalSeconds: 60,
		NextSyncAt:      &dueAt,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(
		jobstore.WithTenantID(context.Background(), job.TenantID),
		job.TenantID,
		job.ID,
		"",
		nil,
		previousSync,
		dueAt,
		0,
		0,
		"",
	); err != nil {
		t.Fatalf("seed previous sync: %v", err)
	}

	h := NewMigration("", store)
	if _, err := h.RunDueSourceEventSyncs(context.Background(), 10); err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.LastSyncedAt == nil || !monitor.LastSyncedAt.Equal(previousSync) {
		t.Fatalf("last_synced_at = %v, want previous successful sync %s preserved", monitor.LastSyncedAt, previousSync)
	}
	if monitor.LastError == "" || !strings.Contains(monitor.LastError, "rate limited") {
		t.Fatalf("last_error = %q, want rate-limit error", monitor.LastError)
	}
}

func TestRunDueSourceEventSyncsExpiredActiveCampaignSessionAsksForReconnect(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC().Add(-time.Hour)
	job := &canonical.MigrationJob{
		ID:          "56565656565656565656565656565657",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		StartedAt:   completedAt.Add(-time.Hour),
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	dueAt := time.Now().UTC().Add(-time.Minute)
	cursor := "offset=20&last_id=123"
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 60,
		Cursor:          cursor,
		NextSyncAt:      &dueAt,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}

	h := NewMigration("", store)
	if _, err := h.RunDueSourceEventSyncs(context.Background(), 10); err != nil {
		t.Fatalf("run due source-event syncs: %v", err)
	}
	monitor, err := store.GetSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.Cursor != cursor {
		t.Fatalf("cursor = %q, want %q", monitor.Cursor, cursor)
	}
	if monitor.LastSyncedAt != nil {
		t.Fatalf("last_synced_at = %v, want nil because expired session did not replay", monitor.LastSyncedAt)
	}
	if !strings.Contains(monitor.LastError, "source session expired") ||
		!strings.Contains(monitor.LastError, "reconnect source before source-event replay") {
		t.Fatalf("last_error = %q, want reconnect guidance", monitor.LastError)
	}
}

func TestGetSourceEventMonitorRedactsActiveCampaignStoredErrors(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	jobID := "ac-source-events"
	tenantID := "tenant_a"
	raw := "poll failed at https://tenant.activehosted.com/api/3 with Api-Token=secret-token"
	now := time.Now().UTC()
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), tenantID), jobstore.SourceEventMonitorRecord{
		JobID:           jobID,
		TenantID:        tenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
		NextSyncAt:      &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(jobstore.WithTenantID(context.Background(), tenantID), tenantID, jobID, raw, nil, now, now.Add(time.Hour), 1, 0, raw); err != nil {
		t.Fatalf("update monitor: %v", err)
	}
	if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.SourceEventRecord{
		JobID:         jobID,
		TenantID:      tenantID,
		Source:        canonical.SourceActiveCampaign,
		SourceEventID: "activecampaign:contact:42:2026-05-12T11:00:00Z:hash",
		ResourceType:  "subscriber",
		Action:        "upsert",
		Error:         raw,
		Payload:       json.RawMessage(`{"contact_id":"42","email":"ada@example.com","projection_hash":"hash"}`),
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/source-events", nil)
	req.Header.Set("X-Tenant-ID", tenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, leaked := range []string{
		"tenant.activehosted.com",
		"secret-token",
		"activecampaign:contact:42",
		"ada@example.com",
		`"contact_id"`,
		`"projection_hash":"hash"`,
	} {
		if strings.Contains(body, leaked) {
			t.Fatalf("body = %s, leaked %q", body, leaked)
		}
	}
	if !strings.Contains(body, `"payload":{}`) {
		t.Fatalf("body = %s, want ActiveCampaign source-event payload scrubbed", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-source-event-id]") {
		t.Fatalf("body = %s, want source-event id redaction marker", body)
	}
	if strings.Contains(body, "tenant.activehosted.com") || strings.Contains(body, "secret-token") {
		t.Fatalf("body = %s, want ActiveCampaign source-event errors redacted", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-api-url]") || !strings.Contains(body, "Api-Token=[redacted]") {
		t.Fatalf("body = %s, want redaction markers", body)
	}
	stored, err := store.GetSourceEventResult(jobstore.WithTenantID(context.Background(), tenantID), tenantID, jobID, "activecampaign:contact:42:2026-05-12T11:00:00Z:hash")
	if err != nil {
		t.Fatalf("get stored source-event result: %v", err)
	}
	if stored.SourceEventID != "activecampaign:contact:42:2026-05-12T11:00:00Z:hash" || !strings.Contains(string(stored.Payload), "ada@example.com") {
		t.Fatalf("stored source-event result = %+v payload=%s, want raw internal dedupe record preserved", stored, string(stored.Payload))
	}
}

func TestGetSourceEventMonitorRedactsHubSpotStoredErrors(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	jobID := "hubspot-source-events"
	tenantID := "tenant_a"
	raw := "poll failed for hubspot:contact:42 with access_token=secret-token; contact ada@example.com missing"
	now := time.Now().UTC()
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), tenantID), jobstore.SourceEventMonitorRecord{
		JobID:           jobID,
		TenantID:        tenantID,
		Source:          canonical.SourceHubSpot,
		Enabled:         true,
		IntervalSeconds: 300,
		NextSyncAt:      &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(jobstore.WithTenantID(context.Background(), tenantID), tenantID, jobID, raw, nil, now, now.Add(time.Hour), 1, 0, raw); err != nil {
		t.Fatalf("update monitor: %v", err)
	}
	if err := store.SaveSourceEventResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.SourceEventRecord{
		JobID:         jobID,
		TenantID:      tenantID,
		Source:        canonical.SourceHubSpot,
		SourceEventID: "hubspot:contact:42:2026-05-12T11:00:00Z:hash",
		ResourceType:  "subscriber",
		Action:        "upsert",
		Error:         raw,
		Payload:       json.RawMessage(`{"contact_id":"42","email":"ada@example.com","projection_hash":"hash"}`),
	}); err != nil {
		t.Fatalf("save source-event result: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/source-events", nil)
	req.Header.Set("X-Tenant-ID", tenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, leaked := range []string{
		"secret-token",
		"hubspot:contact:42",
		"ada@example.com",
		`"contact_id"`,
		`"projection_hash":"hash"`,
	} {
		if strings.Contains(body, leaked) {
			t.Fatalf("body = %s, leaked %q", body, leaked)
		}
	}
	if !strings.Contains(body, `"payload":{}`) {
		t.Fatalf("body = %s, want HubSpot source-event payload scrubbed", body)
	}
	if !strings.Contains(body, "[redacted-hubspot-source-event-id]") {
		t.Fatalf("body = %s, want HubSpot source-event id redaction marker", body)
	}
	if !strings.Contains(body, "access_token=[redacted]") {
		t.Fatalf("body = %s, want token redaction marker", body)
	}
	stored, err := store.GetSourceEventResult(jobstore.WithTenantID(context.Background(), tenantID), tenantID, jobID, "hubspot:contact:42:2026-05-12T11:00:00Z:hash")
	if err != nil {
		t.Fatalf("get stored source-event result: %v", err)
	}
	if stored.SourceEventID != "hubspot:contact:42:2026-05-12T11:00:00Z:hash" || !strings.Contains(string(stored.Payload), "ada@example.com") {
		t.Fatalf("stored source-event result = %+v payload=%s, want raw internal dedupe record preserved", stored, string(stored.Payload))
	}
}

func TestSourceEventSyncStartsInitialReplayAtJobStart(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	job := &canonical.MigrationJob{
		ID:          "abababababababababababababababab",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)

	seen, applied, cursor, _, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 0 || applied != 0 || cursor != "" {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 0/0/empty", seen, applied, cursor)
	}
	if got := sourceEventProbeSince(); !got.Equal(startedAt) {
		t.Fatalf("source-event since = %s, want job start %s", got, startedAt)
	}
}

func TestSourceEventSyncUsesPersistedWatermarkAfterInitialReplay(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	lastEventAt := completedAt.Add(30 * time.Minute)
	job := &canonical.MigrationJob{
		ID:          "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)

	_, _, _, _, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:       job.ID,
		TenantID:    job.TenantID,
		Source:      sourceEventProbeSource,
		LastEventAt: &lastEventAt,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if got := sourceEventProbeSince(); !got.Equal(lastEventAt) {
		t.Fatalf("source-event since = %s, want persisted watermark %s", got, lastEventAt)
	}
}

func TestApplySourceEventUsesConfiguredListmonkClientFactory(t *testing.T) {
	var gotPayload listmonkx.SubscriberPayload
	var gotAuth bool
	var destructiveDelete bool
	var handlerErr error
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/api/subscribers/9" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"id":9,"email":"ada@example.com","status":"enabled","tags":[],"attribs":{}}}`))
			return
		}
		if r.Method == http.MethodDelete && r.URL.Path == "/api/subscribers/9" {
			destructiveDelete = true
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/api/subscribers" {
			handlerErr = fmt.Errorf("request = %s %s, want POST /api/subscribers", r.Method, r.URL.Path)
			http.Error(w, handlerErr.Error(), http.StatusNotFound)
			return
		}
		user, pass, ok := r.BasicAuth()
		gotAuth = ok && user == "admin" && pass == "secret"
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			handlerErr = fmt.Errorf("decode payload: %w", err)
			http.Error(w, handlerErr.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":9,"email":"ada@example.com","status":"enabled","tags":[],"attribs":{}}}`))
	}))
	defer srv.Close()

	h := NewMigration("", jobstore.NewMemoryJobStore())
	dbState := &sourceEventSafetyDBState{failMirror: true}
	h.db = newSourceEventSafetyDB(dbState)
	defer func() { _ = h.db.Close() }()
	factoryCalled := false
	h.SetListmonkClientFactory(func(ctx context.Context) (*listmonkx.Client, error) {
		factoryCalled = true
		return &listmonkx.Client{
			BaseURL:           srv.URL,
			AdminUser:         "admin",
			AdminPass:         "secret",
			HTTPClient:        srv.Client(),
			DedicatedTenant:   true,
			DedicatedTenantID: "tenant_a",
		}, nil
	})
	occurredAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
		ID:       "ac_job",
		TenantID: "tenant_a",
		Source:   canonical.SourceActiveCampaign,
	}, canonical.SourceEvent{
		SourceID:       "activecampaign:contact:42:" + occurredAt.Format(time.RFC3339),
		ResourceType:   "subscriber",
		Action:         "upsert",
		OccurredAt:     occurredAt,
		SourcePlatform: canonical.SourceActiveCampaign,
		Subscriber: &canonical.Subscriber{
			Email:          "ada@example.com",
			Status:         canonical.StatusEnabled,
			ConsentSource:  canonical.ConsentUnknown,
			Tags:           []string{"list:7"},
			SourceID:       "42",
			SourcePlatform: canonical.SourceActiveCampaign,
		},
	}, 0)

	if handlerErr != nil {
		t.Fatalf("Listmonk test server: %v", handlerErr)
	}
	if !factoryCalled {
		t.Fatalf("configured Listmonk client factory was not called")
	}
	if !gotAuth {
		t.Fatalf("Listmonk request did not use configured client credentials")
	}
	if destructiveDelete {
		t.Fatalf("Listmonk mutation was destructively deleted after durable mirror failure: %s", record.Error)
	}
	if applied || record.Applied || !strings.Contains(record.Error, errSourceEventMirrorTest.Error()) {
		t.Fatalf("record = %+v, applied=%v; want durable mirror failure after configured client write", record, applied)
	}
	if gotPayload.Email != "ada@example.com" || gotPayload.Status != "enabled" {
		t.Fatalf("payload email/status = %q/%q, want ada@example.com/enabled", gotPayload.Email, gotPayload.Status)
	}
	if gotPayload.Attribs["postwave_source_platform"] != string(canonical.SourceActiveCampaign) || gotPayload.Attribs["postwave_source_id"] != "42" {
		t.Fatalf("payload attribs = %#v, want ActiveCampaign source identity", gotPayload.Attribs)
	}
	if gotPayload.Attribs["postwave_migration_job_id"] != "ac_job" {
		t.Fatalf("payload attribs = %#v, want migration job id stamp", gotPayload.Attribs)
	}
}

func TestSourceEventSyncDrainsPagesBeforeAdvancingWatermark(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	firstOccurredAt := completedAt.Add(20 * time.Minute)
	secondOccurredAt := completedAt.Add(25 * time.Minute)
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{
		"": {
			Events: []canonical.SourceEvent{{
				SourceID:       "activecampaign:contact:42:" + firstOccurredAt.Format(time.RFC3339),
				ResourceType:   "subscriber",
				Action:         "upsert",
				OccurredAt:     firstOccurredAt,
				SourcePlatform: sourceEventProbeSource,
				Subscriber: &canonical.Subscriber{
					Email:          "ada@example.com",
					Status:         canonical.StatusEnabled,
					ConsentSource:  canonical.ConsentUnknown,
					SourceID:       "42",
					SourcePlatform: sourceEventProbeSource,
				},
			}},
			NextCursor:    "100",
			HighWatermark: firstOccurredAt,
		},
		"100": {
			Events: []canonical.SourceEvent{{
				SourceID:       "activecampaign:contact:43:" + secondOccurredAt.Format(time.RFC3339),
				ResourceType:   "subscriber",
				Action:         "upsert",
				OccurredAt:     secondOccurredAt,
				SourcePlatform: sourceEventProbeSource,
				Subscriber: &canonical.Subscriber{
					Email:          "grace@example.com",
					Status:         canonical.StatusEnabled,
					ConsentSource:  canonical.ConsentUnknown,
					SourceID:       "43",
					SourcePlatform: sourceEventProbeSource,
				},
			}},
			HighWatermark: secondOccurredAt,
		},
	})
	job := &canonical.MigrationJob{
		ID:          "efefefefefefefefefefefefefefefef",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	h.sourceEventApply = func(_ context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
		return jobstore.SourceEventRecord{
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        event.SourcePlatform,
			SourceEventID: sourceEventID(job, event, index),
			ResourceType:  event.ResourceType,
			Action:        event.Action,
			Payload:       marshalSourceEvent(event),
		}, true
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 2 || applied != 2 || cursor != "" {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 2/2/empty", seen, applied, cursor)
	}
	if lastEventAt == nil || !lastEventAt.Equal(secondOccurredAt) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, secondOccurredAt)
	}
	cursors := sourceEventProbeCursors()
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "100" {
		t.Fatalf("source-event cursors = %#v, want empty cursor then 100", cursors)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 2 || !results[0].Applied || !results[1].Applied {
		t.Fatalf("source-event results = %+v, want two applied saved results", results)
	}
}

func TestSourceEventSyncKeepsWatermarkWhenFinalPageIsStaleEmpty(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	occurredAt := completedAt.Add(20 * time.Minute)
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{
		"": {
			Events: []canonical.SourceEvent{{
				SourceID:       "activecampaign:contact:42:" + occurredAt.Format(time.RFC3339),
				ResourceType:   "subscriber",
				Action:         "upsert",
				OccurredAt:     occurredAt,
				SourcePlatform: sourceEventProbeSource,
				Subscriber: &canonical.Subscriber{
					Email:          "ada@example.com",
					Status:         canonical.StatusEnabled,
					ConsentSource:  canonical.ConsentUnknown,
					SourceID:       "42",
					SourcePlatform: sourceEventProbeSource,
				},
			}},
			NextCursor:    "stale-empty",
			HighWatermark: occurredAt,
		},
		"stale-empty": {},
	})
	job := &canonical.MigrationJob{
		ID:          "edededededededededededededededed",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	h.sourceEventApply = func(_ context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
		return jobstore.SourceEventRecord{
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        event.SourcePlatform,
			SourceEventID: sourceEventID(job, event, index),
			ResourceType:  event.ResourceType,
			Action:        event.Action,
			Payload:       marshalSourceEvent(event),
		}, true
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 1 || applied != 1 || cursor != "" {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 1/1/empty", seen, applied, cursor)
	}
	if lastEventAt == nil || !lastEventAt.Equal(occurredAt) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, occurredAt)
	}
	cursors := sourceEventProbeCursors()
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "stale-empty" {
		t.Fatalf("source-event cursors = %#v, want empty cursor then stale-empty", cursors)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 1 || !results[0].Applied {
		t.Fatalf("source-event results = %+v, want one applied saved result", results)
	}
}

func TestSourceEventSyncAdvancesAcrossFilteredEmptyPagesWithWatermarks(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	firstWatermark := completedAt.Add(20 * time.Minute)
	terminalWatermark := completedAt.Add(25 * time.Minute)
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{
		"": {
			NextCursor:    "filtered-nonterminal",
			HighWatermark: firstWatermark,
		},
		"filtered-nonterminal": {
			HighWatermark: terminalWatermark,
		},
	})
	job := &canonical.MigrationJob{
		ID:          "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: sourceEventProbeSource,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 0 || applied != 0 || cursor != "" {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 0/0/empty", seen, applied, cursor)
	}
	if lastEventAt == nil || !lastEventAt.Equal(terminalWatermark) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, terminalWatermark)
	}
	if cursors := sourceEventProbeCursors(); len(cursors) != 2 || cursors[0] != "" || cursors[1] != "filtered-nonterminal" {
		t.Fatalf("source-event cursors = %#v, want empty then filtered-nonterminal", cursors)
	}
}

func TestSourceEventSyncRejectsNextCursorWithoutEvents(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{
		"keep-me": {
			NextCursor: "next-without-events",
		},
	})
	job := &canonical.MigrationJob{
		ID:          "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
		Cursor:   "keep-me",
	})
	if err == nil || !strings.Contains(err.Error(), "next cursor") {
		t.Fatalf("err = %v, want empty-next-cursor pagination failure", err)
	}
	if seen != 0 || applied != 0 || cursor != "keep-me" || lastEventAt != nil {
		t.Fatalf("seen/applied/cursor/lastEventAt = %d/%d/%q/%v, want 0/0/keep-me/nil", seen, applied, cursor, lastEventAt)
	}
	cursors := sourceEventProbeCursors()
	if len(cursors) != 1 || cursors[0] != "keep-me" {
		t.Fatalf("source-event cursors = %#v, want keep-me only", cursors)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("source-event results = %+v, want none", results)
	}
}

func TestSourceEventSyncFailsClosedAtBoundedUniqueCursorLimit(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	watermark := time.Date(2026, 7, 2, 11, 0, 0, 0, time.UTC)
	batches := make(map[string]canonical.SourceEventBatch, maxSourceEventSyncPages)
	cursor := "stable-start"
	for i := 0; i < maxSourceEventSyncPages; i++ {
		next := fmt.Sprintf("unique-%d", i+1)
		batches[cursor] = canonical.SourceEventBatch{NextCursor: next, HighWatermark: watermark}
		cursor = next
	}
	setSourceEventProbeBatches(batches)

	store := jobstore.NewMemoryJobStore()
	completedAt := watermark.Add(-time.Hour)
	job := &canonical.MigrationJob{
		ID: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", TenantID: "tenant_a", Source: sourceEventProbeSource,
		Status: canonical.MigCompleted, StartedAt: completedAt.Add(-time.Hour), CompletedAt: &completedAt, Cursor: map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token", AccountID: "probe-account", Source: sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	seen, applied, gotCursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: sourceEventProbeSource, Cursor: "stable-start",
	})
	if err == nil || !strings.Contains(err.Error(), "10000-page sync limit") {
		t.Fatalf("err = %v, want bounded pagination failure", err)
	}
	if seen != 0 || applied != 0 || gotCursor != "stable-start" || lastEventAt != nil {
		t.Fatalf("seen/applied/cursor/lastEventAt = %d/%d/%q/%v, want 0/0/stable-start/nil", seen, applied, gotCursor, lastEventAt)
	}
	if calls := len(sourceEventProbeCursors()); calls != maxSourceEventSyncPages {
		t.Fatalf("source-event page calls = %d, want exact cap %d", calls, maxSourceEventSyncPages)
	}
}

func TestSourceEventSyncSkipsAlreadyAppliedOverlapEvents(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	occurredAt := completedAt.Add(20 * time.Minute)
	eventID := "activecampaign:contact:42:" + occurredAt.Format(time.RFC3339)
	setSourceEventProbeBatch(canonical.SourceEventBatch{
		Events: []canonical.SourceEvent{{
			SourceID:       eventID,
			ResourceType:   "subscriber",
			Action:         "upsert",
			OccurredAt:     occurredAt,
			SourcePlatform: sourceEventProbeSource,
			Subscriber: &canonical.Subscriber{
				Email:          "ada@example.com",
				Status:         canonical.StatusEnabled,
				ConsentSource:  canonical.ConsentUnknown,
				SourceID:       "42",
				SourcePlatform: sourceEventProbeSource,
			},
		}},
		HighWatermark: occurredAt,
	})
	job := &canonical.MigrationJob{
		ID:          "abababababababababababababababab",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        sourceEventProbeSource,
		SourceEventID: eventID,
		ResourceType:  "subscriber",
		Action:        "upsert",
		OccurredAt:    &occurredAt,
		Applied:       true,
		Payload:       json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("save existing source event: %v", err)
	}
	h := NewMigration("", store)
	applyCalls := 0
	h.sourceEventApply = func(_ context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
		applyCalls++
		return jobstore.SourceEventRecord{
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        event.SourcePlatform,
			SourceEventID: sourceEventID(job, event, index),
			ResourceType:  event.ResourceType,
			Action:        event.Action,
			Payload:       marshalSourceEvent(event),
		}, true
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:       job.ID,
		TenantID:    job.TenantID,
		Source:      sourceEventProbeSource,
		LastEventAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 1 || applied != 0 || cursor != "" || applyCalls != 0 {
		t.Fatalf("seen/applied/cursor/applyCalls = %d/%d/%q/%d, want 1/0/empty/0", seen, applied, cursor, applyCalls)
	}
	if lastEventAt == nil || !lastEventAt.Equal(occurredAt) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, occurredAt)
	}
}

func TestSourceEventSyncRetriesPreviouslyFailedAutomaticReplay(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	occurredAt := completedAt.Add(20 * time.Minute)
	eventID := "activecampaign:contact:42:" + occurredAt.Format(time.RFC3339)
	setSourceEventProbeBatch(canonical.SourceEventBatch{
		Events: []canonical.SourceEvent{{
			SourceID:       eventID,
			ResourceType:   "subscriber",
			Action:         "upsert",
			OccurredAt:     occurredAt,
			SourcePlatform: sourceEventProbeSource,
			Subscriber: &canonical.Subscriber{
				Email:          "ada@example.com",
				Status:         canonical.StatusEnabled,
				ConsentSource:  canonical.ConsentUnknown,
				SourceID:       "42",
				SourcePlatform: sourceEventProbeSource,
			},
		}},
		HighWatermark: occurredAt,
	})
	job := &canonical.MigrationJob{
		ID:          "acacacacacacacacacacacacacacacac",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := store.SaveSourceEventResult(context.Background(), jobstore.SourceEventRecord{
		JobID:         job.ID,
		TenantID:      job.TenantID,
		Source:        sourceEventProbeSource,
		SourceEventID: eventID,
		ResourceType:  "subscriber",
		Action:        "upsert",
		OccurredAt:    &occurredAt,
		Applied:       false,
		Error:         "destination unavailable",
		Payload:       json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("save existing source event: %v", err)
	}
	h := NewMigration("", store)
	applyCalls := 0
	h.sourceEventApply = func(_ context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
		applyCalls++
		return jobstore.SourceEventRecord{
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        event.SourcePlatform,
			SourceEventID: sourceEventID(job, event, index),
			ResourceType:  event.ResourceType,
			Action:        event.Action,
			Payload:       marshalSourceEvent(event),
		}, true
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:       job.ID,
		TenantID:    job.TenantID,
		Source:      sourceEventProbeSource,
		LastEventAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 1 || applied != 1 || cursor != "" || applyCalls != 1 {
		t.Fatalf("seen/applied/cursor/applyCalls = %d/%d/%q/%d, want 1/1/empty/1", seen, applied, cursor, applyCalls)
	}
	if lastEventAt == nil || !lastEventAt.Equal(occurredAt) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, occurredAt)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 1 || !results[0].Applied || results[0].Error != "" {
		t.Fatalf("source-event results = %+v, want retried applied result", results)
	}
}

func TestSourceEventSyncDoesNotAdvanceWatermarkWhenAutomaticReplayFails(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	occurredAt := completedAt.Add(20 * time.Minute)
	setSourceEventProbeBatches(map[string]canonical.SourceEventBatch{
		"keep-me": {
			Events: []canonical.SourceEvent{{
				SourceID:       "activecampaign:contact:42:" + occurredAt.Format(time.RFC3339),
				ResourceType:   "subscriber",
				Action:         "upsert",
				OccurredAt:     occurredAt,
				SourcePlatform: sourceEventProbeSource,
				Subscriber: &canonical.Subscriber{
					Email:          "ada@example.com",
					Status:         canonical.StatusEnabled,
					ConsentSource:  canonical.ConsentUnknown,
					SourceID:       "42",
					SourcePlatform: sourceEventProbeSource,
				},
			}},
			HighWatermark: occurredAt,
		},
	})
	job := &canonical.MigrationJob{
		ID:          "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	h.sourceEventApply = func(_ context.Context, job canonical.MigrationJob, event canonical.SourceEvent, index int) (jobstore.SourceEventRecord, bool) {
		return jobstore.SourceEventRecord{
			JobID:         job.ID,
			TenantID:      job.TenantID,
			Source:        event.SourcePlatform,
			SourceEventID: sourceEventID(job, event, index),
			ResourceType:  event.ResourceType,
			Action:        event.Action,
			Error:         "destination unavailable",
			Payload:       marshalSourceEvent(event),
		}, false
	}

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
		Cursor:   "keep-me",
	})
	if err == nil || !strings.Contains(err.Error(), "destination unavailable") {
		t.Fatalf("err = %v, want automatic replay failure", err)
	}
	if strings.Contains(err.Error(), "activecampaign:contact:42") {
		t.Fatalf("err = %q, want raw source-event id omitted", err.Error())
	}
	if !strings.Contains(err.Error(), "subscriber upsert occurred_at=") {
		t.Fatalf("err = %q, want resource/action/timestamp label", err.Error())
	}
	if seen != 1 || applied != 0 || cursor != "keep-me" || lastEventAt != nil {
		t.Fatalf("seen/applied/cursor/lastEventAt = %d/%d/%q/%v, want 1/0/keep-me/nil", seen, applied, cursor, lastEventAt)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 1 || results[0].Applied || !strings.Contains(results[0].Error, "destination unavailable") {
		t.Fatalf("source-event results = %+v, want one failed saved result", results)
	}
}

func TestSourceEventSyncAdvancesWatermarkForReviewOnlyEvents(t *testing.T) {
	registerSourceEventProbeAdapter()
	resetSourceEventProbeSince()
	defer resetSourceEventProbeSince()
	store := jobstore.NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 2, 10, 15, 0, 0, time.UTC)
	completedAt := startedAt.Add(47 * time.Minute)
	occurredAt := completedAt.Add(20 * time.Minute)
	setSourceEventProbeBatch(canonical.SourceEventBatch{
		Events: []canonical.SourceEvent{{
			SourceID:       "activecampaign:automation:99:" + occurredAt.Format(time.RFC3339),
			ResourceType:   "automation",
			Action:         "manual_review",
			OccurredAt:     occurredAt,
			SourcePlatform: sourceEventProbeSource,
		}},
		HighWatermark: occurredAt,
	})
	job := &canonical.MigrationJob{
		ID:          "dededededededededededededededede",
		TenantID:    "tenant_a",
		Source:      sourceEventProbeSource,
		Status:      canonical.MigCompleted,
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "probe-token",
		AccountID:   "probe-account",
		Source:      sourceEventProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)

	seen, applied, cursor, lastEventAt, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID:    job.ID,
		TenantID: job.TenantID,
		Source:   sourceEventProbeSource,
	})
	if err != nil {
		t.Fatalf("run source-event sync: %v", err)
	}
	if seen != 1 || applied != 0 || cursor != "" {
		t.Fatalf("seen/applied/cursor = %d/%d/%q, want 1/0/empty", seen, applied, cursor)
	}
	if lastEventAt == nil || !lastEventAt.Equal(occurredAt) {
		t.Fatalf("lastEventAt = %v, want %s", lastEventAt, occurredAt)
	}
	results, err := store.ListSourceEventResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list source-event results: %v", err)
	}
	if len(results) != 1 || results[0].Applied || !strings.Contains(results[0].Error, "captured for review") {
		t.Fatalf("source-event results = %+v, want one review-only saved result", results)
	}
}

func TestListJobsUsesTenantScopedStore(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	for _, job := range []*canonical.MigrationJob{
		{
			ID:        "44444444444444444444444444444444",
			TenantID:  "tenant_a",
			Source:    canonical.SourceMailchimp,
			Status:    canonical.MigCompleted,
			StartedAt: time.Now(),
			Cursor:    map[string]*string{},
		},
		{
			ID:        "55555555555555555555555555555555",
			TenantID:  "tenant_b",
			Source:    canonical.SourceBeehiiv,
			Status:    canonical.MigCompleted,
			StartedAt: time.Now(),
			Cursor:    map[string]*string{},
		},
	} {
		if err := store.Create(context.Background(), job); err != nil {
			t.Fatalf("create: %v", err)
		}
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var rows []canonical.MigrationJob
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 1 || rows[0].TenantID != "tenant_a" {
		t.Fatalf("rows = %#v, want only tenant_a", rows)
	}
}

func TestListJobsEmptyTenantReturnsJSONArray(t *testing.T) {
	h := NewMigration("", jobstore.NewMemoryJobStore())
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "[]\n" {
		t.Fatalf("body = %q, want []", got)
	}
}

func TestSessionSurvivesHandlerRecreationWhenStoreIsShared(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()

	first := NewMigration("", store)
	r1 := chi.NewRouter()
	first.Mount(r1)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/beehiiv/credentials", bytes.NewBufferString(`{"api_key":"local-demo","account_id":"pub_123"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r1.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var auth struct {
		JobID string `json:"job_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &auth); err != nil {
		t.Fatalf("decode auth: %v", err)
	}
	if auth.JobID == "" {
		t.Fatalf("job id empty")
	}

	second := NewMigration("", store)
	r2 := chi.NewRouter()
	second.Mount(r2)
	req = httptest.NewRequest(http.MethodPost, "/v1/migrations/beehiiv/discover", bytes.NewBufferString(`{"job_id":"`+auth.JobID+`"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec = httptest.NewRecorder()
	r2.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("discover status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var discovery struct {
		JobID  string                   `json:"job_id"`
		Source canonical.SourcePlatform `json:"source"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &discovery); err != nil {
		t.Fatalf("decode discovery: %v", err)
	}
	if discovery.JobID != auth.JobID || discovery.Source != canonical.SourceBeehiiv {
		t.Fatalf("discovery identity = %q/%q, want %q/%q", discovery.JobID, discovery.Source, auth.JobID, canonical.SourceBeehiiv)
	}
}

func TestLocalDemoVerificationActiveCampaignUsesRebuildSemantics(t *testing.T) {
	rep := localDemoDiscovery(canonical.SourceActiveCampaign)
	if rep.AutomationsTotal == 0 || rep.TemplatesTotal == 0 || rep.FormsTotal == 0 || rep.CRMTotal == 0 {
		t.Fatalf("activecampaign demo discovery missing cutover surfaces: %#v", rep)
	}

	report := localDemoVerification(canonical.SourceActiveCampaign, rep)
	if report.AutomationsTranslated != 0 {
		t.Fatalf("automations translated = %d, want 0", report.AutomationsTranslated)
	}
	if len(report.AutomationsUnsupported) != rep.AutomationsTotal {
		t.Fatalf("unsupported automations = %d, want %d", len(report.AutomationsUnsupported), rep.AutomationsTotal)
	}
	if got := report.SourceArchiveByResource["activecampaign_message"]; got != rep.TemplatesTotal {
		t.Fatalf("activecampaign_message archive count = %d, want %d", got, rep.TemplatesTotal)
	}
	if got := report.SourceArchiveByResource["crm_deal"] + report.SourceArchiveByResource["crm_pipeline"]; got != rep.CRMTotal {
		t.Fatalf("crm archive count = %d, want %d", got, rep.CRMTotal)
	}
	if got := report.SourceArchiveByResource["activecampaign_custom_field"]; got != len(rep.CustomFields) {
		t.Fatalf("activecampaign_custom_field archive count = %d, want %d", got, len(rep.CustomFields))
	}
	if got := report.SourceArchiveByResource["activecampaign_tag"]; got != rep.GroupsTotal {
		t.Fatalf("activecampaign_tag archive count = %d, want %d", got, rep.GroupsTotal)
	}

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range report.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	if row := byResource["automations"]; row.Imported != 0 || row.Status != "manual_rebuild_required" {
		t.Fatalf("automation row = %#v, want zero imported manual rebuild", row)
	}
	if row := byResource["audience_schema"]; row.SourceTotal != len(rep.CustomFields)+rep.GroupsTotal || row.Status != "preserved_for_rebuild" {
		t.Fatalf("audience schema row = %#v, want custom-field/tag schema preserved", row)
	}
	for _, resource := range []string{"templates", "forms", "crm", "custom_objects", "ecommerce", "sms"} {
		if row := byResource[resource]; row.Status != "preserved_for_rebuild" {
			t.Fatalf("%s row = %#v, want preserved_for_rebuild", resource, row)
		}
	}
}

func TestCompleteDemoJobActiveCampaignDoesNotMarkAutomationsDone(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "34343434343434343434343434343434",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	h.completeDemoJob(jobstore.WithTenantID(context.Background(), job.TenantID), job, false)

	if job.Progress.AutomationsTotal == 0 {
		t.Fatalf("automations total should be present in demo progress")
	}
	if job.Progress.AutomationsDone != 0 {
		t.Fatalf("automations done = %d, want 0 for ActiveCampaign rebuild-only automations", job.Progress.AutomationsDone)
	}
	if job.VerificationReport == nil || job.VerificationReport.AutomationsTranslated != 0 {
		t.Fatalf("verification report = %#v, want zero runtime automation translations", job.VerificationReport)
	}
}

func TestLocalDemoVerificationCustomerIOMatchesExactAudienceChannelAndArchiveBounds(t *testing.T) {
	rep := localDemoDiscovery(canonical.SourceCustomerIO)
	if len(rep.Audiences) != rep.SegmentsTotal {
		t.Fatalf("Customer.io demo audiences = %d, want segments total %d", len(rep.Audiences), rep.SegmentsTotal)
	}
	topics := 0
	for _, audience := range rep.Audiences {
		if strings.HasPrefix(audience.ID, "customerio:topic:") {
			topics++
		}
	}
	if topics != 4 || rep.SubscriptionChannelsTotal != 3 {
		t.Fatalf("Customer.io demo preference definitions = %d topics/%d channels, want 4/3", topics, rep.SubscriptionChannelsTotal)
	}
	if rep.AutomationsTotal != 28 {
		t.Fatalf("Customer.io demo workflow definitions = %d, want 28", rep.AutomationsTotal)
	}

	report := localDemoVerification(canonical.SourceCustomerIO, rep)
	if report.AutomationsTranslated != 0 {
		t.Fatalf("Customer.io runtime automations translated = %d, want 0", report.AutomationsTranslated)
	}
	if report.SourceArchiveImported != rep.SourceArchiveTotal {
		t.Fatalf("Customer.io source archive imported = %d, want %d", report.SourceArchiveImported, rep.SourceArchiveTotal)
	}
	if got := report.SourceArchiveByResource["customerio_subscription_channel"]; got != rep.SubscriptionChannelsTotal {
		t.Fatalf("Customer.io channel definitions archived = %d, want %d", got, rep.SubscriptionChannelsTotal)
	}
	if got := report.SourceArchiveByResource["customerio_subscription_topic"]; got != topics {
		t.Fatalf("Customer.io topic definitions archived = %d, want %d", got, topics)
	}
	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range report.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	if row := byResource["subscription_topics"]; row.SourceTotal != topics+rep.SubscriptionChannelsTotal || row.Imported != row.SourceTotal || row.Status != "preserved_for_rebuild" {
		t.Fatalf("Customer.io preference-definition row = %#v, want exact topic+channel preservation", row)
	}
	if row := byResource["workflow_definitions"]; row.SourceTotal != rep.AutomationsTotal || row.Imported != row.SourceTotal || row.Status != "preserved_for_rebuild" {
		t.Fatalf("Customer.io workflow-definition row = %#v, want exact rebuild evidence", row)
	}
}

func TestLocalDemoVerificationBeehiivMatchesRebuildAndBillingBoundaries(t *testing.T) {
	rep := localDemoDiscovery(canonical.SourceBeehiiv)
	if rep.PaidSubsTotal == 0 || rep.AutomationsTotal == 0 || rep.GroupsTotal == 0 {
		t.Fatalf("Beehiiv demo discovery missing premium/automation/newsletter-list inventory: %#v", rep)
	}
	if rep.FormsTotal != 0 || rep.LandingPagesTotal != 0 {
		t.Fatalf("Beehiiv demo discovery fabricates forms or website totals: %#v", rep)
	}

	report := localDemoVerification(canonical.SourceBeehiiv, rep)
	if report.AutomationsTranslated != 0 {
		t.Fatalf("automations translated = %d, want 0", report.AutomationsTranslated)
	}
	if len(report.AutomationsUnsupported) != rep.AutomationsTotal {
		t.Fatalf("unsupported automations = %d, want %d", len(report.AutomationsUnsupported), rep.AutomationsTotal)
	}
	if report.PaidSubsImported != 0 {
		t.Fatalf("paid subscriptions imported = %d, want 0", report.PaidSubsImported)
	}

	byResource := map[string]canonical.ResourceCompleteness{}
	for _, row := range report.ResourceCompleteness {
		byResource[row.Resource] = row
	}
	if row := byResource["automations"]; row.Imported != rep.AutomationsTotal || row.Status != "preserved_for_rebuild" {
		t.Fatalf("automation row = %#v, want all definitions preserved for rebuild", row)
	}
	if row := byResource["premium_memberships"]; row.Imported != rep.PaidSubsTotal || row.Status != "imported_runtime" {
		t.Fatalf("premium membership row = %#v, want profile metadata retained", row)
	}
	if row := byResource["paid_subs"]; row.Imported != 0 || row.Supported || row.Status != "manual_rebuild_required" {
		t.Fatalf("paid subscription row = %#v, want billing continuity blocked", row)
	}
	for _, resource := range []string{"segment_definitions", "custom_field_schema", "newsletter_list_history"} {
		if row := byResource[resource]; row.SourceTotal != row.Imported || row.Status != "imported_runtime" {
			t.Fatalf("%s row = %#v, want complete source-preserved coverage", resource, row)
		}
	}
}

func TestCompleteDemoJobBeehiivDoesNotMarkRebuildOrBillingAsRuntimeDone(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "45454545454545454545454545454545",
		TenantID:  "tenant_a",
		Source:    canonical.SourceBeehiiv,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	h.completeDemoJob(jobstore.WithTenantID(context.Background(), job.TenantID), job, false)

	if job.Progress.AutomationsTotal == 0 || job.Progress.PaidSubsTotal == 0 {
		t.Fatalf("Beehiiv demo progress should retain source inventory: %#v", job.Progress)
	}
	if job.Progress.AutomationsDone != 0 || job.Progress.PaidSubsDone != 0 {
		t.Fatalf("Beehiiv rebuild/billing progress falsely completed: %#v", job.Progress)
	}
	if job.VerificationReport == nil || job.VerificationReport.AutomationsTranslated != 0 || job.VerificationReport.PaidSubsImported != 0 {
		t.Fatalf("verification report overclaims Beehiiv runtime parity: %#v", job.VerificationReport)
	}
}

func TestOAuthCredentialsEndpointAcceptsDirectTokenForCertification(t *testing.T) {
	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "us21.api.mailchimp.com" || req.URL.Path != "/3.0/" {
			return nil, fmt.Errorf("unexpected Mailchimp identity request %s", req.URL.String())
		}
		if req.Header.Get("Authorization") != "Bearer tok_livecert" {
			return nil, fmt.Errorf("unexpected authorization header")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"account_id":"account-livecert"}`)),
			Request:    req,
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/credentials", bytes.NewBufferString(`{"access_token":"tok_livecert","account_id":"us21"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var auth struct {
		JobID     string `json:"job_id"`
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &auth); err != nil {
		t.Fatalf("decode auth: %v", err)
	}
	if auth.JobID == "" || auth.AccountID != "us21" {
		t.Fatalf("auth = %+v, want job id and account us21", auth)
	}
	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", auth.JobID, time.Now())
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.AccessToken != "tok_livecert" || sess.AccountID != "us21" {
		t.Fatalf("session = %+v, want direct Mailchimp token", sess)
	}
	if mailchimpAccountFingerprint(sess) == "" {
		t.Fatal("direct Mailchimp session is missing stable account fingerprint")
	}
	job, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), auth.JobID)
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	storedFingerprint, ok := cursorString(job.Cursor, mailchimpAccountCursorKey)
	if !ok || storedFingerprint != mailchimpAccountFingerprint(sess) {
		t.Fatalf("job account fingerprint = %q, want session fingerprint %q", storedFingerprint, mailchimpAccountFingerprint(sess))
	}
}

func TestMailchimpOAuthReconnectReusesJobAndAudienceScope(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	t.Setenv("MAILCHIMP_CLIENT_ID", "")
	t.Setenv("MAILCHIMP_CLIENT_SECRET", "")
	store := jobstore.NewMemoryJobStore()
	selected := "aud_a,aud_b"
	demoFingerprint := mailchimpAccountFingerprint(localDemoSession(canonical.SourceMailchimp, "oauth"))
	job := &canonical.MigrationJob{
		ID:       "abababababababababababababababab",
		TenantID: "tenant_a",
		Source:   canonical.SourceMailchimp,
		Status:   canonical.MigAwaitingConfirmation,
		Cursor: map[string]*string{
			selectedAudiencesCursorKey: &selected,
			mailchimpAccountCursorKey:  &demoFingerprint,
		},
		StartedAt: time.Now(),
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	otherTenantReq := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/oauth/start?job_id="+job.ID, nil)
	otherTenantReq.Header.Set("X-Tenant-ID", "tenant_b")
	otherTenantRec := httptest.NewRecorder()
	r.ServeHTTP(otherTenantRec, otherTenantReq)
	if otherTenantRec.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant reconnect status = %d, want 404", otherTenantRec.Code)
	}

	startReq := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/oauth/start?job_id="+job.ID, nil)
	startReq.Header.Set("X-Tenant-ID", job.TenantID)
	startRec := httptest.NewRecorder()
	r.ServeHTTP(startRec, startReq)
	if startRec.Code != http.StatusOK {
		t.Fatalf("start status = %d, body=%s", startRec.Code, startRec.Body.String())
	}
	var started struct {
		AuthorizeURL string `json:"authorize_url"`
		State        string `json:"state"`
	}
	if err := json.Unmarshal(startRec.Body.Bytes(), &started); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if got := oauthStateJobID(started.State); got != job.ID {
		t.Fatalf("state job id = %q, want %q", got, job.ID)
	}

	callbackReq := httptest.NewRequest(http.MethodGet, "/v1/migrations/mailchimp/oauth/callback?code="+url.QueryEscape(localDemoOAuthCode())+"&state="+url.QueryEscape(started.State), nil)
	callbackReq.Header.Set("X-Tenant-ID", job.TenantID)
	callbackRec := httptest.NewRecorder()
	r.ServeHTTP(callbackRec, callbackReq)
	if callbackRec.Code != http.StatusOK {
		t.Fatalf("callback status = %d, body=%s", callbackRec.Code, callbackRec.Body.String())
	}
	var completed struct {
		JobID string `json:"job_id"`
	}
	if err := json.Unmarshal(callbackRec.Body.Bytes(), &completed); err != nil {
		t.Fatalf("decode callback: %v", err)
	}
	if completed.JobID != job.ID {
		t.Fatalf("callback job id = %q, want existing %q", completed.JobID, job.ID)
	}
	jobs, err := store.List(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID)
	if err != nil {
		t.Fatalf("list jobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("jobs = %d, want reconnect to keep one job", len(jobs))
	}
	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatalf("get reconnected session: %v", err)
	}
	if got := sess.Extra[mailchimp.SelectedAudiencesExtraKey]; got != selected {
		t.Fatalf("selected audiences = %q, want %q", got, selected)
	}

	replayReq := httptest.NewRequest(http.MethodGet, "/v1/migrations/mailchimp/oauth/callback?code="+url.QueryEscape(localDemoOAuthCode())+"&state="+url.QueryEscape(started.State), nil)
	replayReq.Header.Set("X-Tenant-ID", job.TenantID)
	replayRec := httptest.NewRecorder()
	r.ServeHTTP(replayRec, replayReq)
	if replayRec.Code != http.StatusBadRequest {
		t.Fatalf("replayed callback status = %d, want 400", replayRec.Code)
	}
}

func TestMailchimpOAuthReconnectRejectsDifferentAccount(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	expected := strings.Repeat("a", 64)
	job := &canonical.MigrationJob{
		ID:        "acacacacacacacacacacacacacacacac",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		Cursor:    map[string]*string{mailchimpAccountCursorKey: &expected},
		StartedAt: time.Now(),
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	oldSession := adapter.Session{
		AccessToken: "old-token",
		AccountID:   "us1",
		Source:      canonical.SourceMailchimp,
		Extra:       map[string]string{mailchimp.AccountFingerprintExtraKey: expected},
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, oldSession, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	h := NewMigration("", store)
	newSession := adapter.Session{
		AccessToken: "different-token",
		AccountID:   "us1",
		Source:      canonical.SourceMailchimp,
		Extra:       map[string]string{mailchimp.AccountFingerprintExtraKey: strings.Repeat("b", 64)},
	}
	_, err := h.completeOAuthJob(context.Background(), job.TenantID, job.Source, oauthStateForJob("opaque", job.ID), newSession)
	if !errors.Is(err, errOAuthAccountMismatch) {
		t.Fatalf("error = %v, want account mismatch", err)
	}
	stored, err := store.GetSession(context.Background(), job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if stored.AccessToken != oldSession.AccessToken {
		t.Fatalf("stored token = %q, want original session unchanged", stored.AccessToken)
	}
}

func TestOAuthReconnectLeasePreventsConcurrentSessionSwap(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "job_oauth_refresh_lease",
		TenantID: "tenant_a",
		Source:   canonical.SourceConvertKit,
		Status:   canonical.MigAwaitingConfirmation,
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	h := NewMigration("", store)
	lease, err := h.acquireJobExecution(ctx, job.TenantID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Release() })

	_, err = h.completeOAuthJob(ctx, job.TenantID, job.Source, oauthStateForJob("opaque", job.ID), adapter.Session{
		Source:      job.Source,
		AccessToken: "replacement-token",
	})
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("OAuth reconnect error = %v, want execution-in-progress conflict", err)
	}
	if _, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now()); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("session lookup after rejected reconnect = %v, want not found", err)
	}
}

func TestActiveCampaignCredentialsEndpointStoresNormalizedAPIURL(t *testing.T) {
	var gotPath string
	var gotToken string
	apiURL := "https://account-one.api-us1.com/api/3"
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		gotPath = req.URL.Path
		gotToken = req.Header.Get("Api-Token")
		return jsonHTTPResponse(req, http.StatusOK, `{"user":{"id":"1"}}`), nil
	})

	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/credentials", bytes.NewBufferString(fmt.Sprintf(`{"api_key":"ac_secret","account_id":%q}`, apiURL)))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/3/users/me" || gotToken != "ac_secret" {
		t.Fatalf("validation request path/token = %q/%q, want /api/3/users/me/ac_secret", gotPath, gotToken)
	}
	var auth struct {
		JobID     string `json:"job_id"`
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &auth); err != nil {
		t.Fatalf("decode auth: %v", err)
	}
	wantAccountID := "account-one.api-us1.com"
	if auth.JobID == "" || auth.AccountID != "[redacted-activecampaign-account]" {
		t.Fatalf("auth = %+v, want job id and redacted ActiveCampaign account marker", auth)
	}

	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", auth.JobID, time.Now())
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.Source != canonical.SourceActiveCampaign || sess.AccessToken != "ac_secret" || sess.AccountID != wantAccountID {
		t.Fatalf("session = %+v, want ActiveCampaign token/account", sess)
	}
	if got, want := sess.Extra["api_url"], apiURL; got != want {
		t.Fatalf("session api_url = %q, want %q", got, want)
	}
	if activeCampaignAccountFingerprint(sess) == "" {
		t.Fatal("session is missing the ActiveCampaign account fingerprint")
	}
	job, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), auth.JobID)
	if err != nil {
		t.Fatal(err)
	}
	storedFingerprint, ok := cursorString(job.Cursor, activeCampaignAccountCursorKey)
	if !ok || storedFingerprint != activeCampaignAccountFingerprint(sess) {
		t.Fatalf("job fingerprint = %q, session fingerprint = %q", storedFingerprint, activeCampaignAccountFingerprint(sess))
	}
}

func TestActiveCampaignCredentialsEndpointRequiresAPITokenWording(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/credentials", bytes.NewBufferString(`{"account_id":"https://acme.api-us1.com/api/3"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "ActiveCampaign API token required") {
		t.Fatalf("body = %s, want API token wording", body)
	}
	if strings.Contains(body, "api_key") || strings.Contains(body, "API key") {
		t.Fatalf("body = %s, should not expose generic API-key wording", body)
	}
}

func TestActiveCampaignCredentialsEndpointRequiresAccountAPIURLWording(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/credentials", bytes.NewBufferString(`{"api_key":"secret-token"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "ActiveCampaign account API URL required") {
		t.Fatalf("body = %s, want account API URL wording", body)
	}
	if strings.Contains(body, "api_url") {
		t.Fatalf("body = %s, should not expose internal api_url field name", body)
	}
}

func TestActiveCampaignCredentialsEndpointRedactsProviderError(t *testing.T) {
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		return jsonHTTPResponse(req, http.StatusUnauthorized, "callback https://tenant.activehosted.com/api/3 Api-Token=secret-token"), nil
	})

	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/credentials", bytes.NewBufferString(`{"api_key":"secret-token","account_id":"https://account-one.api-us1.com/api/3"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("credentials status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "tenant.activehosted.com") || strings.Contains(body, "secret-token") {
		t.Fatalf("body = %s, want ActiveCampaign host/token redacted", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-api-url]") || !strings.Contains(body, "Api-Token=[redacted]") {
		t.Fatalf("body = %s, want redaction markers", body)
	}
}

func TestActiveCampaignJobResponseRedactsStoredErrorsAndReportWarnings(t *testing.T) {
	raw := "sync failed against tenant.activehosted.com/api/3 with Api-Token=secret-token"
	cursorValue := raw
	job := &canonical.MigrationJob{
		ID:       "job_ac_sensitive",
		TenantID: "tenant_a",
		Source:   canonical.SourceActiveCampaign,
		Status:   canonical.MigFailed,
		Error:    &raw,
		Cursor:   map[string]*string{deltaImportLastErrorKey: &cursorValue},
		VerificationReport: &canonical.VerificationReport{
			DiscoveryWarnings: []string{raw},
			SegmentsWithWarnings: []canonical.SegmentWarning{{
				Name:    "VIP",
				Warning: raw,
			}},
			AutomationsUnsupported: []canonical.AutomationUnsupported{{
				Name:   "Welcome",
				Reason: raw,
			}},
			AutomationRebuilds: []canonical.AutomationRebuildItem{{
				Name:         "Welcome",
				Notes:        raw,
				TestEvidence: raw,
			}},
			CampaignArchiveWarnings: []canonical.ResourceWarning{{Resource: "campaigns", Warning: raw}},
			TemplateWarnings:        []canonical.ResourceWarning{{Resource: "templates", Warning: raw}},
			SourceArchiveWarnings:   []canonical.ResourceWarning{{Resource: "forms", Warning: raw}},
			ResourceCompleteness: []canonical.ResourceCompleteness{{
				Resource: "forms",
				Label:    "Forms",
				Status:   "preserved_for_rebuild",
				Notes:    []string{raw},
			}},
		},
	}

	sanitizeMigrationJobForResponse(job)
	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal job: %v", err)
	}
	body := string(encoded)
	if strings.Contains(body, "tenant.activehosted.com") || strings.Contains(body, "secret-token") {
		t.Fatalf("job JSON = %s, want ActiveCampaign host/token redacted", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-api-url]") || !strings.Contains(body, "Api-Token=[redacted]") {
		t.Fatalf("job JSON = %s, want redaction markers", body)
	}
}

func TestHubSpotJobResponseRedactsStoredErrorsAndReportWarnings(t *testing.T) {
	raw := "sync failed for hubspot:contact:42 with access_token=secret-token; contact ada@example.com missing"
	cursorValue := raw
	job := &canonical.MigrationJob{
		ID:       "job_hubspot_sensitive",
		TenantID: "tenant_a",
		Source:   canonical.SourceHubSpot,
		Status:   canonical.MigFailed,
		Error:    &raw,
		Cursor:   map[string]*string{deltaImportLastErrorKey: &cursorValue},
		VerificationReport: &canonical.VerificationReport{
			DiscoveryWarnings: []string{raw},
			SegmentsWithWarnings: []canonical.SegmentWarning{{
				Name:    "VIP",
				Warning: raw,
			}},
			AutomationsUnsupported: []canonical.AutomationUnsupported{{
				Name:   "Workflow",
				Reason: raw,
			}},
			ResourceCompleteness: []canonical.ResourceCompleteness{{
				Resource: "lists",
				Label:    "HubSpot lists",
				Status:   "imported_runtime",
				Notes:    []string{raw},
			}},
		},
	}

	sanitizeMigrationJobForResponse(job)
	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal job: %v", err)
	}
	body := string(encoded)
	for _, leaked := range []string{"hubspot:contact:42", "secret-token", "ada@example.com"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("job JSON = %s, leaked %q", body, leaked)
		}
	}
	for _, marker := range []string{"[redacted-hubspot-source-event-id]", "access_token=[redacted]", "contact [redacted-activecampaign-contact] missing"} {
		if !strings.Contains(body, marker) {
			t.Fatalf("job JSON = %s, want marker %q", body, marker)
		}
	}
}

func TestRefreshSourceSessionUpdatesExistingActiveCampaignJob(t *testing.T) {
	var gotPath string
	var gotToken string
	apiURL := "https://account-one.api-us1.com/api/3"
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		gotPath = req.URL.Path
		gotToken = req.Header.Get("Api-Token")
		return jsonHTTPResponse(req, http.StatusOK, `{"user":{"id":"1"}}`), nil
	})
	fingerprint, err := activecampaign.AccountFingerprintForAPIURL(apiURL)
	if err != nil {
		t.Fatal(err)
	}

	store := jobstore.NewMemoryJobStore()
	rawProviderError := "previous callback https://tenant.activehosted.com/api/3 Api-Token=secret-token"
	job := &canonical.MigrationJob{
		ID:        "job_ac",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor: map[string]*string{
			deltaImportLastErrorKey:        &rawProviderError,
			activeCampaignAccountCursorKey: &fingerprint,
		},
		Error: &rawProviderError,
		VerificationReport: &canonical.VerificationReport{
			DiscoveryWarnings: []string{rawProviderError},
		},
	}
	if err := store.Create(jobstore.WithTenantID(context.Background(), "tenant_a"), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, "tenant_a", adapter.Session{
		Source:      canonical.SourceActiveCampaign,
		AccessToken: "old_token",
		AccountID:   "account-one.api-us1.com",
		Extra:       map[string]string{activecampaign.AccountFingerprintExtraKey: fingerprint},
	}, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("save expired session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/job_ac/source-session", bytes.NewBufferString(fmt.Sprintf(`{
		"api_key":"new_token",
		"account_id":%q
	}`, apiURL)))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "tenant.activehosted.com") || strings.Contains(rec.Body.String(), "secret-token") {
		t.Fatalf("refresh body = %s, want stored ActiveCampaign provider details redacted", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "[redacted-activecampaign-api-url]") || !strings.Contains(rec.Body.String(), "Api-Token=[redacted]") {
		t.Fatalf("refresh body = %s, want redaction markers", rec.Body.String())
	}
	if gotPath != "/api/3/users/me" || gotToken != "new_token" {
		t.Fatalf("validation request path/token = %q/%q, want /api/3/users/me/new_token", gotPath, gotToken)
	}
	var refreshed canonical.MigrationJob
	if err := json.Unmarshal(rec.Body.Bytes(), &refreshed); err != nil {
		t.Fatalf("decode refreshed job: %v", err)
	}
	if refreshed.ID != job.ID || refreshed.SourceSessionExpiresAt == nil {
		t.Fatalf("refreshed job = %+v, want same job with session expiry", refreshed)
	}
	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", job.ID, time.Now())
	if err != nil {
		t.Fatalf("get refreshed session: %v", err)
	}
	if sess.AccessToken != "new_token" || sess.AccountID != "account-one.api-us1.com" || activeCampaignAccountFingerprint(sess) != fingerprint {
		t.Fatalf("session = %+v, want refreshed token on original account", sess)
	}
}

func TestRefreshSourceSessionLeasePreventsConcurrentJobStart(t *testing.T) {
	apiURL := "https://account-one.api-us1.com/api/3"
	authStarted := make(chan struct{})
	releaseAuth := make(chan struct{})
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		close(authStarted)
		select {
		case <-releaseAuth:
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		return jsonHTTPResponse(req, http.StatusOK, `{"user":{"id":"1"}}`), nil
	})
	fingerprint, err := activecampaign.AccountFingerprintForAPIURL(apiURL)
	if err != nil {
		t.Fatal(err)
	}

	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "job_ac_refresh_lease",
		TenantID: "tenant_a",
		Source:   canonical.SourceActiveCampaign,
		Status:   canonical.MigAwaitingConfirmation,
		Cursor:   map[string]*string{activeCampaignAccountCursorKey: &fingerprint},
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, adapter.Session{
		Source:      canonical.SourceActiveCampaign,
		AccessToken: "old-token",
		AccountID:   "account-one.api-us1.com",
		Extra: map[string]string{
			"api_url": apiURL,
			activecampaign.AccountFingerprintExtraKey: fingerprint,
		},
	}, time.Now().Add(sourceBridgeSessionTTL)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	refreshDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(fmt.Sprintf(`{"api_key":"new-token","account_id":%q}`, apiURL)))
		req.Header.Set("X-Tenant-ID", job.TenantID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		refreshDone <- rec
	}()
	select {
	case <-authStarted:
	case <-time.After(time.Second):
		t.Fatal("refresh did not reach remote authentication")
	}

	dryRunReq := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/dry-run", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	dryRunReq.Header.Set("X-Tenant-ID", job.TenantID)
	dryRunRec := httptest.NewRecorder()
	router.ServeHTTP(dryRunRec, dryRunReq)
	if dryRunRec.Code != http.StatusConflict || !strings.Contains(dryRunRec.Body.String(), "execution is already owned") {
		t.Fatalf("concurrent dry-run status/body = %d/%s, want execution-lease conflict", dryRunRec.Code, dryRunRec.Body.String())
	}

	close(releaseAuth)
	select {
	case refreshRec := <-refreshDone:
		if refreshRec.Code != http.StatusOK {
			t.Fatalf("refresh status = %d, body=%s", refreshRec.Code, refreshRec.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("refresh did not complete after authentication was released")
	}
	stored, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation {
		t.Fatalf("job status = %s, want awaiting_confirmation", stored.Status)
	}
}

func TestRefreshSourceSessionRejectsDifferentActiveCampaignAccount(t *testing.T) {
	originalURL := "https://account-one.api-us1.com/api/3"
	otherURL := "https://account-two.api-us1.com/api/3"
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		return jsonHTTPResponse(req, http.StatusOK, `{"user":{"id":"2"}}`), nil
	})
	originalFingerprint, err := activecampaign.AccountFingerprintForAPIURL(originalURL)
	if err != nil {
		t.Fatal(err)
	}
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "job_ac_account_lock",
		TenantID: "tenant_a",
		Source:   canonical.SourceActiveCampaign,
		Status:   canonical.MigCompleted,
		Cursor:   map[string]*string{activeCampaignAccountCursorKey: &originalFingerprint},
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	originalSession := adapter.Session{
		Source:      canonical.SourceActiveCampaign,
		AccessToken: "original-token",
		AccountID:   "account-one.api-us1.com",
		Extra: map[string]string{
			"api_url": originalURL,
			activecampaign.AccountFingerprintExtraKey: originalFingerprint,
		},
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, originalSession, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(fmt.Sprintf(`{"api_key":"other-token","account_id":%q}`, otherURL)))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "original account") {
		t.Fatalf("refresh status/body = %d/%s, want account-mismatch conflict", rec.Code, rec.Body.String())
	}
	stored, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if stored.AccessToken != originalSession.AccessToken || activeCampaignAccountFingerprint(stored) != originalFingerprint {
		t.Fatalf("stored session changed after rejected refresh: %+v", stored)
	}
}

func TestActiveCampaignDryRunAndCommitRejectSessionAccountDrift(t *testing.T) {
	originalFingerprint, err := activecampaign.AccountFingerprintForAPIURL("https://account-one.api-us1.com/api/3")
	if err != nil {
		t.Fatal(err)
	}
	otherFingerprint, err := activecampaign.AccountFingerprintForAPIURL("https://account-two.api-us1.com/api/3")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		route  string
		report *canonical.VerificationReport
	}{
		{name: "dry-run", route: "/v1/migrations/activecampaign/dry-run"},
		{name: "commit", route: "/v1/migrations/activecampaign/commit", report: &canonical.VerificationReport{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			job := &canonical.MigrationJob{
				ID:                 "job_ac_drift_" + strings.ReplaceAll(tc.name, "-", "_"),
				TenantID:           "tenant_a",
				Source:             canonical.SourceActiveCampaign,
				Status:             canonical.MigAwaitingConfirmation,
				Cursor:             map[string]*string{activeCampaignAccountCursorKey: &originalFingerprint},
				VerificationReport: tc.report,
			}
			ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
			if err := store.Create(ctx, job); err != nil {
				t.Fatal(err)
			}
			if err := store.SaveSession(ctx, job.ID, job.TenantID, adapter.Session{
				Source:      canonical.SourceActiveCampaign,
				AccessToken: "other-token",
				AccountID:   "account-two.api-us1.com",
				Extra: map[string]string{
					"api_url": "https://account-two.api-us1.com/api/3",
					activecampaign.AccountFingerprintExtraKey: otherFingerprint,
				},
			}, time.Now().Add(sourceBridgeSessionTTL)); err != nil {
				t.Fatal(err)
			}

			h := NewMigration("", store)
			router := chi.NewRouter()
			h.Mount(router)
			req := httptest.NewRequest(http.MethodPost, tc.route, bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
			req.Header.Set("X-Tenant-ID", job.TenantID)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "original account") {
				t.Fatalf("status/body = %d/%s, want account-drift conflict", rec.Code, rec.Body.String())
			}
			stored, err := store.Get(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.Status != canonical.MigAwaitingConfirmation {
				t.Fatalf("job status changed after rejected kickoff: %s", stored.Status)
			}
			if _, ok := stored.Cursor[runModeCursorKey]; ok {
				t.Fatalf("run mode was written after rejected kickoff: %#v", stored.Cursor)
			}
		})
	}
}

func TestRefreshMailchimpSourceSessionPreservesAccountAndAudienceScope(t *testing.T) {
	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "us21.api.mailchimp.com" || req.URL.Path != "/3.0/" {
			return nil, fmt.Errorf("unexpected Mailchimp identity request %s", req.URL.String())
		}
		accountID := "account-a"
		if req.Header.Get("Authorization") == "Bearer new_other" {
			accountID = "account-b"
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"account_id":"` + accountID + `"}`)),
			Request:    req,
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	fingerprintSum := sha256.Sum256([]byte("mailchimp-account-v1:account-a"))
	fingerprint := fmt.Sprintf("%x", fingerprintSum[:])
	selected := "aud_a,aud_b"
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "job_mailchimp_refresh",
		TenantID: "tenant_a",
		Source:   canonical.SourceMailchimp,
		Status:   canonical.MigAwaitingConfirmation,
		Cursor: map[string]*string{
			mailchimpAccountCursorKey:  &fingerprint,
			selectedAudiencesCursorKey: &selected,
		},
		StartedAt: time.Now(),
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, adapter.Session{
		AccessToken: "old_token",
		AccountID:   "us21",
		Source:      canonical.SourceMailchimp,
		Extra: map[string]string{
			mailchimp.AccountFingerprintExtraKey: fingerprint,
			mailchimp.SelectedAudiencesExtraKey:  selected,
		},
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	refresh := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(fmt.Sprintf(`{"access_token":%q,"account_id":"us21"}`, token)))
		req.Header.Set("X-Tenant-ID", job.TenantID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := refresh("new_same")
	if rec.Code != http.StatusOK {
		t.Fatalf("same-account refresh status = %d, body=%s", rec.Code, rec.Body.String())
	}
	sess, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if sess.AccessToken != "new_same" || sess.Extra[mailchimp.SelectedAudiencesExtraKey] != selected {
		t.Fatalf("refreshed session = %+v, want same account and retained audience scope", sess)
	}

	rec = refresh("new_other")
	if rec.Code != http.StatusConflict {
		t.Fatalf("different-account refresh status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	sess, err = store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if sess.AccessToken != "new_same" {
		t.Fatalf("stored token = %q, want last same-account session unchanged", sess.AccessToken)
	}
}

func TestRefreshSourceSessionRejectsRunningJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "job_ac",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(jobstore.WithTenantID(context.Background(), "tenant_a"), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/job_ac/source-session", bytes.NewBufferString(`{"api_key":"new_token","account_id":"https://acme.api-us1.com/api/3"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "cannot be refreshed while migration job is running") {
		t.Fatalf("refresh status/body = %d/%s, want conflict", rec.Code, rec.Body.String())
	}
}

func TestSessionExpiresAtExtendsActiveCampaignCutoverWindow(t *testing.T) {
	now := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	got := sessionExpiresAt(adapter.Session{Source: canonical.SourceActiveCampaign}, now)
	want := now.Add(sourceBridgeSessionTTL)
	if !got.Equal(want) {
		t.Fatalf("ActiveCampaign session expires at %s, want %s", got, want)
	}
}

func TestActiveCampaignRollbackWindowOutlastsRequiredSourceEventOverlap(t *testing.T) {
	got := migrationRollbackWindow(canonical.SourceActiveCampaign)
	if got != activeCampaignRollbackWindow {
		t.Fatalf("ActiveCampaign rollback window = %s, want %s", got, activeCampaignRollbackWindow)
	}
	if got < 2*activeCampaignMinimumSourceEventOverlap {
		t.Fatalf("ActiveCampaign rollback window = %s, want at least twice overlap %s", got, activeCampaignMinimumSourceEventOverlap)
	}
	if other := migrationRollbackWindow(canonical.SourceMailchimp); other != defaultMigrationRollbackWindow {
		t.Fatalf("default rollback window = %s, want %s", other, defaultMigrationRollbackWindow)
	}
}

func TestHubSpotRollbackWindowCoversRetainedCertificationOverlap(t *testing.T) {
	got := migrationRollbackWindow(canonical.SourceHubSpot)
	if got != activeCampaignRollbackWindow {
		t.Fatalf("HubSpot rollback window = %s, want %s", got, activeCampaignRollbackWindow)
	}
	if got < 14*24*time.Hour {
		t.Fatalf("HubSpot rollback window = %s, want a seven-day overlap plus seven-day cleanup cushion", got)
	}
}

func TestMigrationMonitorsRunOnlyWhileCommittedDestinationIsLive(t *testing.T) {
	statuses := []canonical.MigrationStatus{
		canonical.MigPending,
		canonical.MigAuthenticating,
		canonical.MigDiscovering,
		canonical.MigDryRun,
		canonical.MigAwaitingConfirmation,
		canonical.MigImporting,
		canonical.MigRollingBack,
		canonical.MigFailed,
		canonical.MigRolledBack,
	}
	for _, status := range statuses {
		if !migrationMonitorPausedStatus(status) {
			t.Fatalf("monitor status %q = runnable, want paused", status)
		}
	}
	if migrationMonitorPausedStatus(canonical.MigCompleted) {
		t.Fatal("completed migration monitor = paused, want runnable")
	}
	origin := string(canonical.MigCompleted)
	if !migrationMonitorPaused(&canonical.MigrationJob{
		Status: canonical.MigCompleted,
		Cursor: map[string]*string{rollbackOriginStatusCursorKey: &origin},
	}) {
		t.Fatal("completed migration with failed-rollback sentinel = runnable, want paused")
	}
	completedAt := time.Now().UTC()
	authorizedJob := &canonical.MigrationJob{
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
	}
	markPostPilotCleanupAuthorized(authorizedJob, completedAt.Add(time.Minute))
	if !migrationMonitorPaused(authorizedJob) {
		t.Fatal("completed migration with post-pilot cleanup authorization = runnable, want paused")
	}
	authorizedJob.Status = canonical.MigRollingBack
	if !migrationMonitorPaused(authorizedJob) {
		t.Fatal("rolling-back migration lost its post-pilot cleanup authorization latch")
	}
	authorizedJob.Status = canonical.MigRolledBack
	if !activeCampaignPostPilotCleanupAuthorized(authorizedJob) || !migrationMonitorPaused(authorizedJob) {
		t.Fatal("rolled-back migration lost its post-pilot cleanup authorization latch")
	}
}

func TestSessionExpiresAtExtendsHubSpotBridgeWindow(t *testing.T) {
	now := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	got := sessionExpiresAt(adapter.Session{Source: canonical.SourceHubSpot}, now)
	want := now.Add(sourceBridgeSessionTTL)
	if !got.Equal(want) {
		t.Fatalf("HubSpot session expires at %s, want %s", got, want)
	}
}

func TestSessionExpiresAtKeepsDefaultForOtherSources(t *testing.T) {
	now := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	got := sessionExpiresAt(adapter.Session{Source: canonical.SourceMailchimp}, now)
	want := now.Add(sessionTTL)
	if !got.Equal(want) {
		t.Fatalf("Mailchimp session expires at %s, want %s", got, want)
	}
}

func TestSessionExpiresAtHonorsProviderExpiry(t *testing.T) {
	now := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	providerExpiry := now.Add(2 * time.Hour)
	got := sessionExpiresAt(adapter.Session{
		Source:    canonical.SourceActiveCampaign,
		ExpiresAt: providerExpiry,
	}, now)
	if !got.Equal(providerExpiry) {
		t.Fatalf("session expires at %s, want provider expiry %s", got, providerExpiry)
	}
}

func TestDryRunPersistsMailchimpSelectedAudiences(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "12121212121212121212121212121212",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "postwave-local-demo",
		AccountID:   "demo-mailchimp",
		Source:      canonical.SourceMailchimp,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/dry-run", bytes.NewBufferString(`{"job_id":"12121212121212121212121212121212","selected_audience_ids":["aud_b","aud_a","aud_a"]}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}

	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", job.ID, time.Now())
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if got := sess.Extra[mailchimp.SelectedAudiencesExtraKey]; got != "aud_a,aud_b" {
		t.Fatalf("selected audiences = %q, want aud_a,aud_b", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var gotJob canonical.MigrationJob
	if err := json.Unmarshal(rec.Body.Bytes(), &gotJob); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if fmt.Sprint(gotJob.SelectedAudienceIDs) != "[aud_a aud_b]" {
		t.Fatalf("selected audience ids on job = %v, want [aud_a aud_b]", gotJob.SelectedAudienceIDs)
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/commit", bytes.NewBufferString(`{"job_id":"12121212121212121212121212121212"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("commit status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	sess, err = store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", job.ID, time.Now())
	if err != nil {
		t.Fatalf("get session after commit: %v", err)
	}
	if got := sess.Extra[mailchimp.SelectedAudiencesExtraKey]; got != "aud_a,aud_b" {
		t.Fatalf("selected audiences after commit = %q, want aud_a,aud_b", got)
	}
	if err := store.DeleteSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", job.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get after session delete status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &gotJob); err != nil {
		t.Fatalf("decode job after session delete: %v", err)
	}
	if fmt.Sprint(gotJob.SelectedAudienceIDs) != "[aud_a aud_b]" {
		t.Fatalf("selected audience ids after session delete = %v, want [aud_a aud_b]", gotJob.SelectedAudienceIDs)
	}
}

func TestMailchimpCommitRejectsAudienceScopeChangedAfterDryRun(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "35353535353535353535353535353535",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, localDemoSession(job.Source, "scope-lock"), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/dry-run", bytes.NewBufferString(`{"job_id":"`+job.ID+`","selected_audience_ids":["aud_a"]}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("dry-run status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/commit", bytes.NewBufferString(`{"job_id":"`+job.ID+`","selected_audience_ids":["aud_b"]}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("commit status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "audience scope changed") {
		t.Fatalf("body = %s, want scope-review error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation || stored.VerificationReport == nil {
		t.Fatalf("reviewed dry-run state was mutated: %+v", stored)
	}
	if got, _ := cursorString(stored.Cursor, selectedAudiencesCursorKey); got != "aud_a" {
		t.Fatalf("reviewed scope = %q, want aud_a", got)
	}
	sess, err := store.GetSession(context.Background(), job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got := sess.Extra[mailchimp.SelectedAudiencesExtraKey]; got != "aud_a" {
		t.Fatalf("saved session scope = %q, want aud_a", got)
	}
}

func TestMailchimpKickoffRequiresExplicitAudienceSelection(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "34343434343434343434343434343434",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, localDemoSession(job.Source, "audience-gate"), time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/dry-run", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "select at least one Mailchimp audience") {
		t.Fatalf("body = %s, want explicit audience selection error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigAwaitingConfirmation || stored.VerificationReport != nil || len(stored.Cursor) != 0 {
		t.Fatalf("job mutated after rejected kickoff: %+v", stored)
	}
}

func TestPrepareJobForNewRunResetsExecutionStateAndPreservesScope(t *testing.T) {
	selected := "aud_a,aud_b"
	resourceCursor := "1000"
	acceptance := "pass"
	errText := "old failure"
	completedAt := time.Now().Add(-time.Hour)
	rollbackUntil := time.Now().Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		Status: canonical.MigAwaitingConfirmation,
		Progress: canonical.MigrationProgress{
			SubscribersTotal: 10,
			SubscribersDone:  10,
			TemplatesTotal:   2,
			TemplatesDone:    2,
		},
		Cursor: map[string]*string{
			"subscribers":                &resourceCursor,
			"templates":                  &resourceCursor,
			selectedAudiencesCursorKey:   &selected,
			rollbackRehearsalStatusKey:   &acceptance,
			rateLimitRetryAtCursorKey:    &resourceCursor,
			rateLimitRetryAfterCursorKey: &resourceCursor,
		},
		VerificationReport: &canonical.VerificationReport{SubscribersImported: 10},
		Error:              &errText,
		CompletedAt:        &completedAt,
		RollbackUntil:      &rollbackUntil,
	}
	startedAt := time.Now().UTC()
	prepareJobForNewRun(job, canonical.MigImporting, startedAt)

	if job.Status != canonical.MigImporting || !job.StartedAt.Equal(startedAt) {
		t.Fatalf("status/started = %q/%s", job.Status, job.StartedAt)
	}
	if job.Progress != (canonical.MigrationProgress{}) || job.VerificationReport != nil || job.Error != nil || job.CompletedAt != nil || job.RollbackUntil != nil {
		t.Fatalf("execution state was not reset: %+v", job)
	}
	for _, key := range []string{"subscribers", "templates", rateLimitRetryAtCursorKey, rateLimitRetryAfterCursorKey} {
		if _, ok := job.Cursor[key]; ok {
			t.Fatalf("execution cursor %q was not cleared", key)
		}
	}
	if got, _ := cursorString(job.Cursor, selectedAudiencesCursorKey); got != selected {
		t.Fatalf("selected scope = %q, want %q", got, selected)
	}
	if got, _ := cursorString(job.Cursor, rollbackRehearsalStatusKey); got != acceptance {
		t.Fatalf("acceptance evidence = %q, want %q", got, acceptance)
	}
}

func TestCommitRequiresDryRunVerification(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, localDemoSession(job.Source, "commit-gate"), time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/mailchimp/commit", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "dry-run") {
		t.Fatalf("commit status/body = %d/%s, want dry-run gate", rec.Code, rec.Body.String())
	}
}

func TestGetJobIncludesSourceSessionExpiry(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	expiresAt := time.Now().Add(2 * time.Hour).UTC()
	job := &canonical.MigrationJob{
		ID:        "13131313131313131313131313131313",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "us21",
		Source:      canonical.SourceMailchimp,
	}, expiresAt); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got canonical.MigrationJob
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.SourceSessionExpiresAt == nil {
		t.Fatalf("source_session_expires_at missing")
	}
	if got.SourceSessionExpiresAt.Sub(expiresAt).Abs() > time.Second {
		t.Fatalf("source_session_expires_at = %s, want about %s", got.SourceSessionExpiresAt, expiresAt)
	}
}

func TestRecoverRunnableJobsCompletesAcceptedDemoJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "77777777777777777777777777777777",
		TenantID:  "tenant_a",
		Source:    canonical.SourceBeehiiv,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "postwave-local-demo",
		AccountID:   "demo-beehiiv-recover",
		Source:      canonical.SourceBeehiiv,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	recovered, err := h.RecoverRunnableJobs(context.Background())
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if recovered != 1 {
		t.Fatalf("recovered = %d, want 1", recovered)
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %q, want %q", stored.Status, canonical.MigCompleted)
	}
	if stored.RollbackUntil == nil {
		t.Fatalf("rollback_until should be set")
	}
	if stored.VerificationReport == nil || stored.VerificationReport.SubscribersImported == 0 ||
		stored.VerificationReport.SourceArchiveByResource["beehiiv_newsletter_list_history_manifest"] == 0 ||
		stored.VerificationReport.SourceArchiveByResource["beehiiv_automation_email_inventory_manifest"] == 0 {
		t.Fatalf("verification report not populated: %#v", stored.VerificationReport)
	}
}

func TestGetJobEventsStreamsTerminalSnapshot(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "66666666666666666666666666666666",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/66666666666666666666666666666666/events", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content-type = %q, want text/event-stream", got)
	}
	body := rec.Body.String()
	if !bytes.Contains([]byte(body), []byte("event: snapshot")) || !bytes.Contains([]byte(body), []byte(job.ID)) {
		t.Fatalf("unexpected SSE body (no snapshot): %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("event: done")) {
		t.Fatalf("expected event: done frame for terminal job, got: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("\"resources\":")) {
		t.Fatalf("done frame missing resources block: %s", body)
	}
}

// TestGetJobEventsEmitsProgressAndDone exercises the broadcaster path:
// publish a progress event AFTER the handler is subscribed, then flip
// the stored job to a terminal state. The handler should write
//
//	event: snapshot ... event: progress ... event: done
//
// in that order before closing.
func TestGetJobEventsEmitsProgressAndDone(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	jobID := "88888888888888888888888888888888"
	job := &canonical.MigrationJob{
		ID:        jobID,
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/events", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()

	// Publish + flip to terminal in a sibling goroutine. We bound the
	// test by using a request context that we cancel after the SSE
	// handler has had ~250ms to drain — terminal status closes the
	// stream on the next 2s polling tick anyway, but we cap the test
	// budget to keep it fast.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Publish a synthetic progress event. The handler will receive
		// it after writing its initial snapshot.
		time.Sleep(20 * time.Millisecond)
		h.broadcaster.Publish(jobID, ProgressEvent{
			Resource:    "subscribers",
			Completed:   234,
			Total:       1500,
			CurrentStep: "Importing subscribers (page 5 of 30)",
			At:          time.Now(),
		})
		// Flip to terminal so the polling tick triggers `done`.
		time.Sleep(50 * time.Millisecond)
		stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), jobID)
		if err != nil {
			t.Errorf("get: %v", err)
			return
		}
		stored.Status = canonical.MigCompleted
		now := time.Now()
		stored.CompletedAt = &now
		if err := store.Update(jobstore.WithTenantID(context.Background(), "tenant_a"), stored); err != nil {
			t.Errorf("update: %v", err)
		}
	}()

	r.ServeHTTP(rec, req)
	<-done

	body := rec.Body.String()
	if !bytes.Contains([]byte(body), []byte("event: snapshot")) {
		t.Fatalf("missing snapshot in SSE body: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("event: progress")) {
		t.Fatalf("missing progress event in SSE body: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("\"resource\":\"subscribers\"")) {
		t.Fatalf("progress event missing subscribers resource: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("\"completed\":234")) {
		t.Fatalf("progress event missing completed counter: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("event: done")) {
		t.Fatalf("missing done event: %s", body)
	}
}

func TestCancelJobIdempotent(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	job := &canonical.MigrationJob{
		ID:            "99999999999999999999999999999999",
		TenantID:      "tenant_a",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now(),
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
		Progress: canonical.MigrationProgress{
			SubscribersTotal: 10,
			SubscribersDone:  7,
			TemplatesTotal:   2,
			TemplatesDone:    1,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	// First cancel: no runner registered → cancelled=false but 200 OK.
	req := httptest.NewRequest(http.MethodDelete, "/v1/migrations/"+job.ID, nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		JobID             string                      `json:"job_id"`
		Cancelled         bool                        `json:"cancelled"`
		Status            string                      `json:"status"`
		Progress          canonical.MigrationProgress `json:"progress"`
		RollbackAvailable bool                        `json:"rollback_available"`
		RollbackUntil     *time.Time                  `json:"rollback_until"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.JobID != job.ID || resp.Cancelled || resp.Status != string(canonical.MigCompleted) {
		t.Fatalf("response = %+v, want idempotent cancel of completed job", resp)
	}
	if !resp.RollbackAvailable || resp.RollbackUntil == nil {
		t.Fatalf("rollback metadata missing from cancel response: %+v", resp)
	}
	if resp.Progress.SubscribersDone != 7 || resp.Progress.TemplatesDone != 1 {
		t.Fatalf("progress = %+v, want persisted progress in cancel response", resp.Progress)
	}

	// Second call same job → still 200, still cancelled=false.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("second status = %d, want 200", rec.Code)
	}

	// Unknown job → 404.
	missingReq := httptest.NewRequest(http.MethodDelete, "/v1/migrations/00000000000000000000000000000000", nil)
	missingReq.Header.Set("X-Tenant-ID", "tenant_a")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, missingReq)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing-job status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUpdateJobSetsAndClearsAnnotations(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "99999999-9999-9999-9999-999999999999",
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	patch := func(body string) canonical.MigrationJob {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID, strings.NewReader(body))
		req.Header.Set("X-Tenant-ID", "tenant_a")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var resp canonical.MigrationJob
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}

	// Set both — label is trimmed.
	resp := patch(`{"label":"  Q3 re-import  ","notes":"second attempt after DNS fix"}`)
	if resp.Label == nil || *resp.Label != "Q3 re-import" {
		t.Fatalf("label = %v, want trimmed 'Q3 re-import'", resp.Label)
	}
	if resp.Notes == nil || *resp.Notes != "second attempt after DNS fix" {
		t.Fatalf("notes = %v", resp.Notes)
	}
	// Persisted.
	got, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Label == nil || *got.Label != "Q3 re-import" {
		t.Fatalf("persisted label = %v", got.Label)
	}
	// Empty label clears; omitted notes preserved (tri-state).
	resp2 := patch(`{"label":""}`)
	if resp2.Label != nil {
		t.Fatalf("empty label should clear, got %v", resp2.Label)
	}
	if resp2.Notes == nil || *resp2.Notes != "second attempt after DNS fix" {
		t.Fatalf("omitted notes should be preserved, got %v", resp2.Notes)
	}

	// Foreign tenant → 404 (RLS/scope).
	foreign := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID, strings.NewReader(`{"label":"x"}`))
	foreign.Header.Set("X-Tenant-ID", "tenant_b")
	foreign.Header.Set("Content-Type", "application/json")
	frec := httptest.NewRecorder()
	r.ServeHTTP(frec, foreign)
	if frec.Code != http.StatusNotFound {
		t.Fatalf("foreign-tenant status = %d, want 404; body=%s", frec.Code, frec.Body.String())
	}
}

func TestStartRollbackAllowsCancelledJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	cancelledMsg := cancelledByOperatorMsg
	job := &canonical.MigrationJob{
		ID:            "88888888888888888888888888888888",
		TenantID:      "tenant_a",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigFailed,
		StartedAt:     time.Now(),
		RollbackUntil: &rollbackUntil,
		Error:         &cancelledMsg,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/rollback", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigRollingBack && stored.Status != canonical.MigRolledBack {
		t.Fatalf("status = %s, want rolling_back or rolled_back", stored.Status)
	}
	if stored.Error != nil {
		t.Fatalf("error = %v, want cleared for rollback", *stored.Error)
	}
}

func TestStartRollbackRejectsUntrackedFailedCommit(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	failure := "destination write failed"
	job := &canonical.MigrationJob{
		ID:            "89898989898989898989898989898989",
		TenantID:      "tenant_a",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigFailed,
		StartedAt:     time.Now(),
		RollbackUntil: &rollbackUntil,
		Error:         &failure,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/rollback", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigFailed || stored.Error == nil || *stored.Error != failure {
		t.Fatalf("untracked failed job changed: status=%s error=%v", stored.Status, stored.Error)
	}
}

func TestStartRollbackRejectsMissingListmonkForTrackedSubscribers(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	rollbackUntil := time.Now().Add(24 * time.Hour).UTC()
	job := &canonical.MigrationJob{
		ID:            "99999999999999999999999999999999",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     time.Now(),
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 1,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return nil, fmt.Errorf("missing test Listmonk client")
	})
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/rollback", nil)
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "rollback requires destination Listmonk credentials") {
		t.Fatalf("body = %s, want destination credential error", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigCompleted {
		t.Fatalf("status = %s, want completed so rollback can be retried after credentials are fixed", stored.Status)
	}
	if stored.Error != nil {
		t.Fatalf("error = %v, want unchanged nil error", *stored.Error)
	}
}

func TestRollbackFailureStatusPreservesOrigin(t *testing.T) {
	failed := string(canonical.MigFailed)
	completed := string(canonical.MigCompleted)
	tests := []struct {
		name string
		job  *canonical.MigrationJob
		want canonical.MigrationStatus
	}{
		{
			name: "failed migration cleanup",
			job: &canonical.MigrationJob{Cursor: map[string]*string{
				rollbackOriginStatusCursorKey: &failed,
			}},
			want: canonical.MigFailed,
		},
		{
			name: "completed migration rollback",
			job: &canonical.MigrationJob{Cursor: map[string]*string{
				rollbackOriginStatusCursorKey: &completed,
			}},
			want: canonical.MigCompleted,
		},
		{
			name: "legacy rolling back job",
			job:  &canonical.MigrationJob{},
			want: canonical.MigCompleted,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := rollbackFailureStatus(tt.job); got != tt.want {
				t.Fatalf("rollbackFailureStatus() = %s, want %s", got, tt.want)
			}
		})
	}
}

// TestProgressDeltaPicksChangedResource is a unit test on the small
// pure helper used to derive `event: progress` payloads from successive
// MigrationProgress snapshots.
func TestProgressDeltaPicksChangedResource(t *testing.T) {
	prev := canonical.MigrationProgress{SubscribersTotal: 100, SubscribersDone: 50}
	next := canonical.MigrationProgress{SubscribersTotal: 100, SubscribersDone: 75}
	evt, ok := progressDelta(prev, next, "")
	if !ok {
		t.Fatalf("expected delta")
	}
	if evt.Resource != "subscribers" || evt.Completed != 75 || evt.Total != 100 {
		t.Fatalf("delta = %+v, want subscribers 75/100", evt)
	}

	prev = canonical.MigrationProgress{TemplatesTotal: 4, TemplatesDone: 1}
	next = canonical.MigrationProgress{TemplatesTotal: 4, TemplatesDone: 2}
	evt, ok = progressDelta(prev, next, "")
	if !ok {
		t.Fatalf("expected template delta")
	}
	if evt.Resource != "templates" || evt.Completed != 2 || evt.Total != 4 {
		t.Fatalf("delta = %+v, want templates 2/4", evt)
	}

	prev = canonical.MigrationProgress{SourceArchiveTotal: 9, SourceArchiveDone: 3}
	next = canonical.MigrationProgress{SourceArchiveTotal: 9, SourceArchiveDone: 5}
	evt, ok = progressDelta(prev, next, "")
	if !ok {
		t.Fatalf("expected source archive delta")
	}
	if evt.Resource != "source_archive" || evt.Completed != 5 || evt.Total != 9 {
		t.Fatalf("delta = %+v, want source_archive 5/9", evt)
	}
}

func TestResourceLabelForSourceNamesActiveCampaignAutomationRebuilds(t *testing.T) {
	if got := resourceLabelForSource(canonical.SourceActiveCampaign, "automations", 0, 4); got != "Preserving automation rebuild evidence" {
		t.Fatalf("activecampaign automation progress label = %q", got)
	}
	if got := resourceLabelForSource(canonical.SourceActiveCampaign, "automations", 4, 4); got != "Automation rebuild evidence complete" {
		t.Fatalf("activecampaign automation complete label = %q", got)
	}
	if got := resourceLabelForSource(canonical.SourceMailchimp, "automations", 0, 4); got != "Translating automations" {
		t.Fatalf("mailchimp automation progress label = %q", got)
	}
}

func TestTerminalDoneEventIncludesLongTailResources(t *testing.T) {
	job := &canonical.MigrationJob{
		Status: canonical.MigCompleted,
		Progress: canonical.MigrationProgress{
			TemplatesTotal:     4,
			SourceArchiveTotal: 9,
		},
		VerificationReport: &canonical.VerificationReport{
			TemplatesImported:     3,
			SourceArchiveImported: 9,
		},
	}
	evt := terminalDoneEvent(job)
	resources, ok := evt["resources"].(map[string]map[string]int)
	if !ok {
		t.Fatalf("resources type = %T", evt["resources"])
	}
	if got := resources["templates"]["imported"]; got != 3 {
		t.Fatalf("templates imported = %d, want 3", got)
	}
	if got := resources["templates"]["failed"]; got != 1 {
		t.Fatalf("templates failed = %d, want 1", got)
	}
	if got := resources["source_archive"]["imported"]; got != 9 {
		t.Fatalf("source_archive imported = %d, want 9", got)
	}
}

func TestTerminalDoneEventClassifiesActiveCampaignAutomationsAsReview(t *testing.T) {
	job := &canonical.MigrationJob{
		Source: canonical.SourceActiveCampaign,
		Status: canonical.MigCompleted,
		Progress: canonical.MigrationProgress{
			AutomationsTotal: 4,
		},
		VerificationReport: &canonical.VerificationReport{
			AutomationsTranslated: 0,
		},
	}
	evt := terminalDoneEvent(job)
	resources, ok := evt["resources"].(map[string]map[string]int)
	if !ok {
		t.Fatalf("resources type = %T", evt["resources"])
	}
	automations := resources["automations"]
	if automations["imported"] != 0 || automations["failed"] != 0 || automations["skipped"] != 4 || automations["review"] != 4 {
		t.Fatalf("automations resource = %#v, want 0 imported, 0 failed, 4 skipped/review", automations)
	}
}

func TestRollbackProgressFromJobIncludesTemplatesAndSourceArchive(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	job := &canonical.MigrationJob{
		StartedAt: now,
		Progress: canonical.MigrationProgress{
			ArchiveDone:       2,
			SourceArchiveDone: 7,
			TemplatesDone:     4,
			PaidSubsDone:      3,
		},
	}
	prog := rollbackProgressFromJob(job, "completed")
	if prog.ArchiveTotal != 9 || prog.ArchiveDeleted != 9 {
		t.Fatalf("archive rollback = %d/%d, want 9/9", prog.ArchiveDeleted, prog.ArchiveTotal)
	}
	if prog.TemplatesTotal != 4 || prog.TemplatesDeleted != 4 {
		t.Fatalf("template rollback = %d/%d, want 4/4", prog.TemplatesDeleted, prog.TemplatesTotal)
	}
	if prog.PaidSubsTotal != 3 || prog.PaidSubsDeleted != 3 {
		t.Fatalf("paid subs rollback = %d/%d, want 3/3", prog.PaidSubsDeleted, prog.PaidSubsTotal)
	}
}

func TestRollbackProgressRedactsActiveCampaignErrors(t *testing.T) {
	rawErr := `rollback failed against https://tenant.activehosted.com/api/3 with Api-Token: secret-token; replay activecampaign:contact:42 cursor last_id=42; contact ada@example.com missing stable timestamp`
	job := &canonical.MigrationJob{
		Source:    canonical.SourceActiveCampaign,
		StartedAt: time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC),
		Error:     &rawErr,
	}

	prog := rollbackProgressFromJob(job, "completed")
	for _, leaked := range []string{"tenant.activehosted.com", "secret-token", "activecampaign:contact:42", "last_id=42", "ada@example.com"} {
		if strings.Contains(prog.Error, leaked) {
			t.Fatalf("reconstructed rollback error leaked %q: %q", leaked, prog.Error)
		}
	}
	for _, marker := range []string{"[redacted-activecampaign-api-url]", "Api-Token=[redacted]", "[redacted-activecampaign-source-event-id]", "last_id=[redacted]", "contact [redacted-activecampaign-contact] missing"} {
		if !strings.Contains(prog.Error, marker) {
			t.Fatalf("reconstructed rollback error = %q, want marker %q", prog.Error, marker)
		}
	}

	live := sanitizeRollbackProgressForResponse(canonical.SourceActiveCampaign, &orchestrator.RollbackProgress{
		State: "failed",
		Error: rawErr,
	})
	for _, leaked := range []string{"tenant.activehosted.com", "secret-token", "activecampaign:contact:42", "last_id=42", "ada@example.com"} {
		if strings.Contains(live.Error, leaked) {
			t.Fatalf("live rollback error leaked %q: %q", leaked, live.Error)
		}
	}
	if !strings.Contains(live.Error, "[redacted-activecampaign-api-url]") || !strings.Contains(live.Error, "[redacted-activecampaign-source-event-id]") {
		t.Fatalf("live rollback error = %q, want ActiveCampaign redaction markers", live.Error)
	}

	other := sanitizeRollbackProgressForResponse(canonical.SourceMailchimp, &orchestrator.RollbackProgress{Error: rawErr})
	if other.Error != rawErr {
		t.Fatalf("non-ActiveCampaign rollback error = %q, want raw error preserved", other.Error)
	}
}

func TestRollbackProgressRedactsHubSpotErrors(t *testing.T) {
	rawErr := `rollback failed for hubspot:contact:42 with access_token=secret-token; contact ada@example.com missing stable timestamp`
	job := &canonical.MigrationJob{
		Source:    canonical.SourceHubSpot,
		StartedAt: time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC),
		Error:     &rawErr,
	}

	prog := rollbackProgressFromJob(job, "completed")
	for _, leaked := range []string{"hubspot:contact:42", "secret-token", "ada@example.com"} {
		if strings.Contains(prog.Error, leaked) {
			t.Fatalf("reconstructed rollback error leaked %q: %q", leaked, prog.Error)
		}
	}
	for _, marker := range []string{"[redacted-hubspot-source-event-id]", "access_token=[redacted]", "contact [redacted-activecampaign-contact] missing"} {
		if !strings.Contains(prog.Error, marker) {
			t.Fatalf("reconstructed rollback error = %q, want marker %q", prog.Error, marker)
		}
	}

	live := sanitizeRollbackProgressForResponse(canonical.SourceHubSpot, &orchestrator.RollbackProgress{
		State: "failed",
		Error: rawErr,
	})
	for _, leaked := range []string{"hubspot:contact:42", "secret-token", "ada@example.com"} {
		if strings.Contains(live.Error, leaked) {
			t.Fatalf("live rollback error leaked %q: %q", leaked, live.Error)
		}
	}
	if !strings.Contains(live.Error, "[redacted-hubspot-source-event-id]") {
		t.Fatalf("live rollback error = %q, want HubSpot redaction marker", live.Error)
	}
}

func TestSourceEventStatusAuthoritativeIncludesHubSpot(t *testing.T) {
	if !sourceEventStatusAuthoritative(
		canonical.MigrationJob{Source: canonical.SourceHubSpot},
		canonical.SourceEvent{SourcePlatform: canonical.SourceHubSpot},
	) {
		t.Fatalf("HubSpot source-event replay should use source-authoritative subscriber status")
	}
	if !sourceEventStatusAuthoritative(
		canonical.MigrationJob{Source: canonical.SourceMailchimp},
		canonical.SourceEvent{SourcePlatform: canonical.SourceActiveCampaign},
	) {
		t.Fatalf("ActiveCampaign source-event replay should remain source-authoritative")
	}
	if sourceEventStatusAuthoritative(
		canonical.MigrationJob{Source: canonical.SourceMailchimp},
		canonical.SourceEvent{SourcePlatform: canonical.SourceMailchimp},
	) {
		t.Fatalf("Mailchimp source-event replay should not be source-authoritative by default")
	}
	klaviyoPolicy := sourceEventSubscriberAuthority(
		canonical.MigrationJob{Source: canonical.SourceKlaviyo},
		canonical.SourceEvent{SourcePlatform: canonical.SourceKlaviyo},
	)
	if !klaviyoPolicy.status || !klaviyoPolicy.fields || !klaviyoPolicy.guardSourceEmailMove {
		t.Fatalf("Klaviyo source-event policy = %+v, want authoritative status/profile fields and stable-email guard", klaviyoPolicy)
	}
	if klaviyoPolicy.tags || !klaviyoPolicy.preserveSourceAudiences {
		t.Fatalf("Klaviyo source-event policy = %+v, want non-authoritative tags with preserved full-snapshot audiences", klaviyoPolicy)
	}
}
