// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

var (
	// ErrDispatchUnavailable means the run could not be handed to the durable
	// worker command path. A retry with the same request ID is safe: CreateRun
	// replays the same frozen run before dispatch is attempted again.
	ErrDispatchUnavailable = errors.New("campaign assurance api: run dispatch unavailable")
	ErrServiceUnavailable  = errors.New("campaign assurance api: service unavailable")
)

// Repository is the tenant-scoped durable boundary used by the public API.
// The concrete campaignassurance.Repo satisfies this interface. It purposely
// exposes no worker claims or evidence mutation methods to HTTP handlers.
type Repository interface {
	CreateRun(context.Context, string, campaignassurance.CreateRunInput) (*campaignassurance.Run, error)
	GetRun(context.Context, string, string) (*campaignassurance.Run, error)
	ListRuns(context.Context, string, string, int) ([]campaignassurance.Run, error)
	GetRunManifest(context.Context, string, string) (*campaignassurance.ClaimedRun, error)
	ListExtractions(context.Context, string, string) ([]campaignassurance.Extraction, error)
	ListFindings(context.Context, string, string) ([]campaignassurance.Finding, error)
	ListOverrides(context.Context, string, string) ([]campaignassurance.Override, error)
	CreateOverride(context.Context, string, string, string, campaignassurance.OverrideInput) (*campaignassurance.Override, error)
	CancelRun(context.Context, string, string) (*campaignassurance.Run, error)
}

// DispatchCommand contains only durable identities. The scheduler retrieves
// the frozen manifest from the repository; it does not accept public prompt,
// model, artifact-object, or recipient content.
type DispatchCommand struct {
	TenantID   string
	CampaignID string
	RunID      string
	RequestID  string
}

// Scheduler publishes a durable worker command or outbox intent after the run
// snapshot commits.
type Scheduler interface {
	EnqueueCampaignAssurance(context.Context, DispatchCommand) error
}

// Service is the policy boundary between HTTP input and durable persistence.
// It is safe for concurrent use after construction.
type Service struct {
	repository Repository
	registry   *SuiteRegistry
	scheduler  Scheduler
}

func NewService(repository Repository, registry *SuiteRegistry, scheduler Scheduler) (*Service, error) {
	if repository == nil || registry == nil {
		return nil, ErrServiceUnavailable
	}
	return &Service{repository: repository, registry: registry, scheduler: scheduler}, nil
}

type StartRunCommand struct {
	TenantID          string
	CampaignID        string
	ContentRevisionID string
	SendPlanID        string
	RequestID         string
	Profile           string
	ActorID           string
}

func (s *Service) StartRun(ctx context.Context, command StartRunCommand) (*campaignassurance.Run, []string, error) {
	if s == nil || s.repository == nil || s.registry == nil {
		return nil, nil, ErrServiceUnavailable
	}
	if s.scheduler == nil {
		return nil, nil, ErrDispatchUnavailable
	}
	var err error
	if command.TenantID, err = canonicalUUID(command.TenantID); err != nil {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	if command.CampaignID, err = canonicalUUID(command.CampaignID); err != nil {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	if command.ContentRevisionID, err = canonicalUUID(command.ContentRevisionID); err != nil {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	if command.SendPlanID, err = canonicalUUID(command.SendPlanID); err != nil {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	if command.RequestID, err = canonicalUUID(command.RequestID); err != nil {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	if command.ActorID, err = canonicalUUID(command.ActorID); err != nil {
		return nil, nil, campaignassurance.ErrUnauthorized
	}
	definition, exists := s.registry.Resolve(command.Profile)
	if !exists {
		return nil, nil, campaignassurance.ErrInvalidInput
	}
	run, err := s.repository.CreateRun(ctx, command.TenantID, campaignassurance.CreateRunInput{
		CampaignID:           command.CampaignID,
		ContentRevisionID:    command.ContentRevisionID,
		SendPlanID:           command.SendPlanID,
		RequestID:            command.RequestID,
		TriggerKind:          campaignassurance.TriggerExplicit,
		Profile:              definition.Profile,
		AnalyzerSuiteVersion: definition.AnalyzerSuiteVersion,
		ModelSuiteVersion:    definition.ModelSuiteVersion,
		PromptSuiteVersion:   definition.PromptSuiteVersion,
		PromptSuiteHash:      definition.PromptSuiteHash,
		NormalizationVersion: definition.NormalizationVersion,
		ScoringVersion:       definition.ScoringVersion,
		GatePolicyVersion:    definition.GatePolicyVersion,
		MethodologyVersion:   definition.MethodologyVersion,
		Configurations:       definition.Configurations,
		MaxAttempts:          definition.MaxAttempts,
		CreatedBy:            command.ActorID,
	})
	if err != nil {
		return nil, nil, err
	}
	if run == nil {
		return nil, nil, fmt.Errorf("%w: repository returned no run", campaignassurance.ErrInvalidTransition)
	}
	runID, runIDErr := canonicalUUID(run.ID)
	if runIDErr != nil || runID != run.ID || run.CampaignID != command.CampaignID || run.ContentRevisionID != command.ContentRevisionID ||
		run.SendPlanID != command.SendPlanID || run.RequestID != command.RequestID ||
		run.Profile != definition.Profile {
		return nil, nil, fmt.Errorf("%w: repository returned a mismatched run", campaignassurance.ErrInvalidTransition)
	}
	if err := s.scheduler.EnqueueCampaignAssurance(ctx, DispatchCommand{
		TenantID: command.TenantID, CampaignID: command.CampaignID,
		RunID: run.ID, RequestID: command.RequestID,
	}); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrDispatchUnavailable, err)
	}
	return run, sourceClassesFromInputs(definition.Configurations), nil
}

type RunDetail struct {
	Run           campaignassurance.Run        `json:"run"`
	Manifest      campaignassurance.ClaimedRun `json:"manifest"`
	SourceClasses []string                     `json:"source_classes"`
}

func (s *Service) Latest(ctx context.Context, tenantID, campaignID string) (*RunDetail, error) {
	if s == nil || s.repository == nil {
		return nil, ErrServiceUnavailable
	}
	var err error
	if tenantID, err = canonicalUUID(tenantID); err != nil {
		return nil, campaignassurance.ErrInvalidInput
	}
	if campaignID, err = canonicalUUID(campaignID); err != nil {
		return nil, campaignassurance.ErrInvalidInput
	}
	runs, err := s.repository.ListRuns(ctx, tenantID, campaignID, 1)
	if err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, campaignassurance.ErrNotFound
	}
	return s.detailForBoundRun(ctx, tenantID, campaignID, runs[0])
}

func (s *Service) Detail(ctx context.Context, tenantID, campaignID, runID string) (*RunDetail, error) {
	run, tenantID, campaignID, err := s.boundRun(ctx, tenantID, campaignID, runID)
	if err != nil {
		return nil, err
	}
	return s.detailForBoundRun(ctx, tenantID, campaignID, *run)
}

func (s *Service) detailForBoundRun(ctx context.Context, tenantID, campaignID string, run campaignassurance.Run) (*RunDetail, error) {
	if run.CampaignID != campaignID {
		return nil, campaignassurance.ErrNotFound
	}
	manifest, err := s.repository.GetRunManifest(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	if manifest == nil {
		return nil, campaignassurance.ErrSnapshotIncomplete
	}
	if manifest.Run.CampaignID != campaignID || manifest.Run.ID != run.ID {
		return nil, campaignassurance.ErrNotFound
	}
	return &RunDetail{
		Run:           manifest.Run,
		Manifest:      *manifest,
		SourceClasses: sourceClassesFromManifest(manifest.Configurations),
	}, nil
}

type Page[T any] struct {
	Items      []T  `json:"items"`
	Offset     int  `json:"offset"`
	Limit      int  `json:"limit"`
	Total      int  `json:"total"`
	NextOffset *int `json:"next_offset,omitempty"`
}

type EvidencePage struct {
	Run           campaignassurance.Run              `json:"run"`
	SourceClasses []string                           `json:"source_classes"`
	Extractions   Page[campaignassurance.Extraction] `json:"extractions"`
	Findings      Page[campaignassurance.Finding]    `json:"findings"`
	Overrides     Page[campaignassurance.Override]   `json:"overrides"`
}

func (s *Service) Evidence(ctx context.Context, tenantID, campaignID, runID string, offset, limit int) (*EvidencePage, error) {
	if offset < 0 || offset > maxEvidenceOffset || limit < 1 || limit > maxEvidenceLimit {
		return nil, campaignassurance.ErrInvalidInput
	}
	run, tenantID, campaignID, err := s.boundRun(ctx, tenantID, campaignID, runID)
	if err != nil {
		return nil, err
	}
	manifest, err := s.repository.GetRunManifest(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	if manifest == nil {
		return nil, campaignassurance.ErrSnapshotIncomplete
	}
	if manifest.Run.CampaignID != campaignID || manifest.Run.ID != run.ID {
		return nil, campaignassurance.ErrNotFound
	}
	extractions, err := s.repository.ListExtractions(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	findings, err := s.repository.ListFindings(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	overrides, err := s.repository.ListOverrides(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	return &EvidencePage{
		Run:           *run,
		SourceClasses: sourceClassesFromManifest(manifest.Configurations),
		Extractions:   pageValues(extractions, offset, limit),
		Findings:      pageValues(findings, offset, limit),
		Overrides:     pageValues(overrides, offset, limit),
	}, nil
}

// ProgressSnapshot is intentionally not an event stream. The current durable
// repository has no append-only progress-event read model, so this endpoint
// exposes only the authoritative aggregate state and says so explicitly.
type ProgressSnapshot struct {
	RunID                   string     `json:"run_id"`
	State                   string     `json:"state"`
	GateDecision            string     `json:"gate_decision"`
	AttemptCount            int        `json:"attempt_count"`
	RequiredExtractions     int        `json:"required_extractions"`
	TerminalExtractions     int        `json:"terminal_extractions"`
	SuccessfulExtractions   int        `json:"successful_extractions"`
	ExtractionErrors        int        `json:"extraction_errors"`
	FindingCount            int        `json:"finding_count"`
	BlockingFindingCount    int        `json:"blocking_finding_count"`
	UpdatedAt               time.Time  `json:"updated_at"`
	CompletedAt             *time.Time `json:"completed_at,omitempty"`
	EventHistoryAvailable   bool       `json:"event_history_available"`
	EventHistoryExplanation string     `json:"event_history_explanation"`
	SourceClasses           []string   `json:"source_classes"`
}

func (s *Service) Progress(ctx context.Context, tenantID, campaignID, runID string) (*ProgressSnapshot, error) {
	run, tenantID, campaignID, err := s.boundRun(ctx, tenantID, campaignID, runID)
	if err != nil {
		return nil, err
	}
	manifest, err := s.repository.GetRunManifest(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	if manifest == nil {
		return nil, campaignassurance.ErrSnapshotIncomplete
	}
	if manifest.Run.CampaignID != campaignID || manifest.Run.ID != run.ID {
		return nil, campaignassurance.ErrNotFound
	}
	return &ProgressSnapshot{
		RunID: run.ID, State: run.State, GateDecision: run.GateDecision,
		AttemptCount: run.AttemptCount, RequiredExtractions: run.RequiredExtractionCount,
		TerminalExtractions:   run.TerminalExtractionCount,
		SuccessfulExtractions: run.SuccessfulExtractionCount,
		ExtractionErrors:      run.ExtractionErrorCount, FindingCount: run.FindingCount,
		BlockingFindingCount: run.BlockingFindingCount, UpdatedAt: run.UpdatedAt,
		CompletedAt: run.CompletedAt, EventHistoryAvailable: false,
		EventHistoryExplanation: "durable event history is not available; this is the current authoritative run snapshot",
		SourceClasses:           sourceClassesFromManifest(manifest.Configurations),
	}, nil
}

type AppealCommand struct {
	TenantID   string
	CampaignID string
	RunID      string
	FindingID  string
	RequestID  string
	ActorID    string
	Decision   string
	Reason     string
	ExpiresAt  *time.Time
}

func (s *Service) Appeal(ctx context.Context, command AppealCommand) (*campaignassurance.Override, error) {
	if s == nil || s.repository == nil {
		return nil, ErrServiceUnavailable
	}
	run, tenantID, _, err := s.boundRun(ctx, command.TenantID, command.CampaignID, command.RunID)
	if err != nil {
		return nil, err
	}
	findingID, err := canonicalUUID(command.FindingID)
	if err != nil {
		return nil, campaignassurance.ErrInvalidInput
	}
	requestID, err := canonicalUUID(command.RequestID)
	if err != nil {
		return nil, campaignassurance.ErrInvalidInput
	}
	actorID, err := canonicalUUID(command.ActorID)
	if err != nil {
		return nil, campaignassurance.ErrUnauthorized
	}
	return s.repository.CreateOverride(ctx, tenantID, run.ID, actorID, campaignassurance.OverrideInput{
		FindingID: findingID, RequestID: requestID, Decision: command.Decision,
		Reason: command.Reason, ExpiresAt: command.ExpiresAt,
	})
}

func (s *Service) Cancel(ctx context.Context, tenantID, campaignID, runID string) (*campaignassurance.Run, error) {
	if s == nil || s.repository == nil {
		return nil, ErrServiceUnavailable
	}
	run, tenantID, _, err := s.boundRun(ctx, tenantID, campaignID, runID)
	if err != nil {
		return nil, err
	}
	// Repeating the exact cancel is a successful state read. This preserves
	// semantic idempotency even if an outer HTTP replay cache has expired.
	if run.State == campaignassurance.StateCancelled {
		return run, nil
	}
	cancelled, err := s.repository.CancelRun(ctx, tenantID, run.ID)
	if !errors.Is(err, campaignassurance.ErrInvalidTransition) {
		return cancelled, err
	}
	// Two exact requests can pass the read above before either transition
	// commits. Re-read after a lost transition race and converge on the already
	// cancelled receipt; other terminal states remain a conflict.
	replayed, replayErr := s.repository.GetRun(ctx, tenantID, run.ID)
	if replayErr == nil && replayed != nil && replayed.CampaignID == campaignID &&
		replayed.ID == run.ID && replayed.State == campaignassurance.StateCancelled {
		return replayed, nil
	}
	if replayErr != nil && !errors.Is(replayErr, campaignassurance.ErrNotFound) {
		return nil, replayErr
	}
	return nil, err
}

func (s *Service) boundRun(ctx context.Context, tenantID, campaignID, runID string) (*campaignassurance.Run, string, string, error) {
	if s == nil || s.repository == nil {
		return nil, "", "", ErrServiceUnavailable
	}
	var err error
	if tenantID, err = canonicalUUID(tenantID); err != nil {
		return nil, "", "", campaignassurance.ErrInvalidInput
	}
	if campaignID, err = canonicalUUID(campaignID); err != nil {
		return nil, "", "", campaignassurance.ErrInvalidInput
	}
	if runID, err = canonicalUUID(runID); err != nil {
		return nil, "", "", campaignassurance.ErrInvalidInput
	}
	run, err := s.repository.GetRun(ctx, tenantID, runID)
	if err != nil {
		return nil, "", "", err
	}
	if run == nil {
		return nil, "", "", campaignassurance.ErrNotFound
	}
	// Same-tenant runs under a different campaign are deliberately flattened
	// to the same result as a nonexistent run.
	if run.CampaignID != campaignID || run.ID != runID {
		return nil, "", "", campaignassurance.ErrNotFound
	}
	return run, tenantID, campaignID, nil
}

func pageValues[T any](values []T, offset, limit int) Page[T] {
	total := len(values)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	items := append([]T(nil), values[offset:end]...)
	page := Page[T]{Items: items, Offset: offset, Limit: limit, Total: total}
	if end < total {
		next := end
		page.NextOffset = &next
	}
	return page
}

func sourceClassesFromInputs(configurations []campaignassurance.ConfigurationInput) []string {
	seen := make(map[string]struct{}, len(configurations))
	for _, configuration := range configurations {
		if configuration.SourceClass != "" {
			seen[configuration.SourceClass] = struct{}{}
		}
	}
	values := make([]string, 0, len(seen))
	for value := range seen {
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

func sourceClassesFromManifest(configurations []campaignassurance.RunConfiguration) []string {
	seen := make(map[string]struct{}, len(configurations))
	for _, configuration := range configurations {
		if configuration.SourceClass != "" {
			seen[configuration.SourceClass] = struct{}{}
		}
	}
	values := make([]string, 0, len(seen))
	for value := range seen {
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

func canonicalUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}
