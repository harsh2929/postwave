// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	RuntimeFeatureEnvironmentKey = "POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2"
	// The PRD requires 90 days of full-fidelity evidence followed by a
	// degraded, reclassifiable tier. Total observation retention therefore has
	// to extend beyond that first tier; otherwise the retention sweep would
	// degrade and purge the same row in one pass. One year is the conservative
	// default, while workspaces may choose another bounded period above 90 days.
	defaultObservationRetention   = 365 * 24 * time.Hour
	minimumObservationRetention   = DefaultFullFidelityWindow + time.Hour
	maximumObservationRetention   = 10 * 365 * 24 * time.Hour
	defaultRetentionSweepInterval = time.Minute
)

var (
	ErrRuntimeDisabled   = errors.New("engagementclassification: runtime disabled")
	ErrRuntimeNotReady   = errors.New("engagementclassification: runtime not ready")
	identityKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$`)
)

// RuntimeConfiguration is intentionally isolated behind one feature flag.
// Disabled construction touches neither secrets nor Postgres. Enabled
// construction fails closed unless the dedicated identity key, immutable key
// id, bounded raw-evidence retention, registry, and migration are all ready.
type RuntimeConfiguration struct {
	Enabled                  bool
	IdentityHMACKey          []byte
	IdentityKeyID            string
	ObservationRetention     time.Duration
	ReclassificationLeaseTTL time.Duration
	ReclassificationWorkerID string
	RetentionSweepInterval   time.Duration
	// StageTwoSweepInterval is how often the delayed evaluator drains due
	// messages. It is a cadence, not the delay itself: StageTwoDelay is
	// persisted in an immutable due_at so every node agrees when a message
	// settles regardless of how often any one of them looks.
	StageTwoSweepInterval time.Duration
	// StageTwoConversionWindow is the second Stage-2 moment.
	StageTwoConversionWindow time.Duration
	// StageTwoRetention is how long a SETTLED Stage-2 schedule row is kept. The
	// schedule is a reminder, not evidence: the verdicts it produced are
	// event_classifications rows and the run it used is an
	// event_reclassification_runs row, and both outlive it.
	StageTwoRetention time.Duration
}

func RuntimeConfigurationFromEnvironment(
	getenv func(string) string,
) (RuntimeConfiguration, error) {
	if getenv == nil {
		return RuntimeConfiguration{}, fmt.Errorf("%w: environment reader is required", ErrInvalidInput)
	}
	enabled, err := parseExactRuntimeFlag(getenv(RuntimeFeatureEnvironmentKey))
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	if !enabled {
		return RuntimeConfiguration{}, nil
	}
	retention, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_OBSERVATION_RETENTION"),
		defaultObservationRetention, minimumObservationRetention,
		maximumObservationRetention,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	leaseTTL, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_RECLASSIFICATION_LEASE_TTL"),
		defaultReclassificationLeaseTTL, 5*time.Second, 30*time.Minute,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	retentionSweepInterval, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_RETENTION_SWEEP_INTERVAL"),
		defaultRetentionSweepInterval, 10*time.Second, time.Hour,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	stageTwoSweepInterval, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_STAGE_TWO_SWEEP_INTERVAL"),
		defaultStageTwoSweepInterval, minimumStageTwoSweepInterval,
		maximumStageTwoSweepInterval,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	conversionWindow, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_CONVERSION_WINDOW"),
		DefaultStageTwoConversionWindow, minimumStageTwoConversionWindow,
		maximumStageTwoConversionWindow,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	stageTwoRetention, err := parseBoundedRuntimeDuration(
		getenv("POSTWAVE_ENGAGEMENT_STAGE_TWO_RETENTION"),
		DefaultStageTwoRetention, minimumStageTwoRetention, maximumStageTwoRetention,
	)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	configuration := RuntimeConfiguration{
		Enabled:                  true,
		StageTwoSweepInterval:    stageTwoSweepInterval,
		StageTwoConversionWindow: conversionWindow,
		StageTwoRetention:        stageTwoRetention,
		IdentityHMACKey:          []byte(getenv("POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY")),
		IdentityKeyID:            strings.TrimSpace(getenv("POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID")),
		ObservationRetention:     retention,
		ReclassificationLeaseTTL: leaseTTL,
		ReclassificationWorkerID: strings.TrimSpace(getenv("POSTWAVE_ENGAGEMENT_RECLASSIFICATION_WORKER_ID")),
		RetentionSweepInterval:   retentionSweepInterval,
	}
	if err := configuration.Validate(); err != nil {
		return RuntimeConfiguration{}, err
	}
	return configuration, nil
}

func (configuration RuntimeConfiguration) Validate() error {
	if !configuration.Enabled {
		return nil
	}
	if len(configuration.IdentityHMACKey) < 32 {
		return fmt.Errorf("%w: POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY must contain at least 32 bytes", ErrInvalidInput)
	}
	if !identityKeyIDPattern.MatchString(configuration.IdentityKeyID) {
		return fmt.Errorf("%w: POSTWAVE_ENGAGEMENT_IDENTITY_HMAC_KEY_ID is invalid", ErrInvalidInput)
	}
	if configuration.ObservationRetention < minimumObservationRetention ||
		configuration.ObservationRetention > maximumObservationRetention {
		return fmt.Errorf(
			"%w: engagement observation retention must be longer than the 90-day full-fidelity tier and no more than 10 years",
			ErrInvalidInput,
		)
	}
	if configuration.ReclassificationLeaseTTL < 5*time.Second ||
		configuration.ReclassificationLeaseTTL > 30*time.Minute {
		return fmt.Errorf("%w: reclassification lease is outside 5s..30m", ErrInvalidInput)
	}
	if len(configuration.ReclassificationWorkerID) > 200 ||
		strings.ContainsAny(configuration.ReclassificationWorkerID, "\x00\r\n") {
		return fmt.Errorf("%w: reclassification worker id is invalid", ErrInvalidInput)
	}
	if configuration.RetentionSweepInterval != 0 &&
		(configuration.RetentionSweepInterval < 10*time.Second ||
			configuration.RetentionSweepInterval > time.Hour) {
		return fmt.Errorf("%w: retention sweep interval is outside 10s..1h", ErrInvalidInput)
	}
	if configuration.StageTwoSweepInterval != 0 &&
		(configuration.StageTwoSweepInterval < minimumStageTwoSweepInterval ||
			configuration.StageTwoSweepInterval > maximumStageTwoSweepInterval) {
		return fmt.Errorf("%w: stage two sweep interval is outside 5s..1h", ErrInvalidInput)
	}
	if configuration.StageTwoConversionWindow != 0 &&
		(configuration.StageTwoConversionWindow < minimumStageTwoConversionWindow ||
			configuration.StageTwoConversionWindow > maximumStageTwoConversionWindow) {
		return fmt.Errorf("%w: stage two conversion window is outside 1h..90d", ErrInvalidInput)
	}
	if configuration.StageTwoRetention != 0 &&
		(configuration.StageTwoRetention < minimumStageTwoRetention ||
			configuration.StageTwoRetention > maximumStageTwoRetention) {
		return fmt.Errorf("%w: stage two schedule retention is outside 91d..10y", ErrInvalidInput)
	}
	return nil
}

// ProviderEventInput is the generic trusted-edge handoff. RecipientAddress,
// MessageIdentity, and LinkIdentity exist only in memory; Runtime converts
// them to tenant-separated keyed commitments before calling IngestHook.
type ProviderEventInput struct {
	EventRef
	Source                 string
	SourceEventID          string
	IdempotencyKey         string
	EventSchemaVersion     string
	EventType              string
	OccurredAt             time.Time
	IngestedAt             time.Time
	DeliveredAt            *time.Time
	RecipientAddress       string
	MessageIdentity        string
	LinkIdentity           string
	ProviderMessageID      string
	ProviderRequestID      string
	OrderedHeaders         []Header
	OrderedHeadersComplete bool
	UserAgent              string
	IP                     string
	NetworkASN             *uint32
	// NetworkASNSource must be stated whenever NetworkASN is. Use
	// ObservedNetworkASN at an HTTP boundary; every other adapter leaves both
	// zero and the observation records "unmeasured" rather than a guess.
	NetworkASNSource   NetworkASNSource
	NetworkRegion      string
	ReverseDNS         string
	TLSJA4             string
	ProviderSignals    map[string]any
	DwellMilliseconds  *int64
	MessageLinkCount   *int
	BodyHash           string
	RawObjectRef       string
	RawObjectVersionID string
}

type Runtime struct {
	enabled              bool
	hook                 *IngestHook
	identityKey          []byte
	identityKeyID        string
	observationRetention time.Duration
	retentionWorker      *RetentionWorker
	stageTwoWorker       *StageTwoWorker
	now                  func() time.Time
}

func BuildRuntime(
	ctx context.Context,
	configuration RuntimeConfiguration,
	pool *db.Pool,
) (*Runtime, error) {
	if !configuration.Enabled {
		return &Runtime{}, nil
	}
	if err := configuration.Validate(); err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, fmt.Errorf("%w: database pool is required", ErrRuntimeNotReady)
	}
	repo := &Repo{
		Pool:                     pool,
		ReclassificationWorkerID: configuration.ReclassificationWorkerID,
		ReclassificationLeaseTTL: configuration.ReclassificationLeaseTTL,
		StageTwoConversionWindow: configuration.StageTwoConversionWindow,
	}
	if repo.ReclassificationWorkerID == "" {
		repo.ReclassificationWorkerID = "engagement-reclassifier-" + uuid.NewString()
	}
	retentionInterval := configuration.RetentionSweepInterval
	if retentionInterval == 0 {
		retentionInterval = defaultRetentionSweepInterval
	}
	config := DefaultConfig()
	registry, err := repo.LoadRegistry(ctx, config.RegistryVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: load machine registry: %v", ErrRuntimeNotReady, err)
	}
	if len(registry) == 0 {
		return nil, fmt.Errorf("%w: machine registry %q is empty", ErrRuntimeNotReady, config.RegistryVersion)
	}
	classifier, err := NewClassifier(config, registry)
	if err != nil {
		return nil, fmt.Errorf("%w: compile classifier: %v", ErrRuntimeNotReady, err)
	}
	keyCopy := append([]byte(nil), configuration.IdentityHMACKey...)
	runtime := &Runtime{
		enabled: true,
		// The aggregate builder is what makes Stage 2 possible at ingest.
		//
		// Four of the nine rules — R_ALL_LINKS_FETCHED, R_CLICK_WITHOUT_OPEN,
		// R_BURST, R_UA_MISMATCH — read sibling events for the same message.
		// Without a builder, IngestHook leaves MessageAggregate zero and those
		// four are structurally unable to fire, so every event is classified on
		// single-event evidence and lands in `unknown` more often than the data
		// warrants. loadMessageAggregate already served exactly this purpose on
		// the reclassification path; it is the same query, on the caller's tx.
		hook: &IngestHook{
			Repo:             repo,
			Classifier:       classifier,
			AggregateBuilder: AggregateBuilderFunc(loadMessageAggregate),
		},
		identityKey: keyCopy, identityKeyID: configuration.IdentityKeyID,
		observationRetention: configuration.ObservationRetention,
		now:                  func() time.Time { return time.Now().UTC() },
	}
	runtime.retentionWorker = &RetentionWorker{
		Repo: repo, Interval: retentionInterval,
		TenantBatchSize: 100, ObservationBatchSize: 100,
		StageTwoRetention: configuration.StageTwoRetention,
	}
	stageTwoInterval := configuration.StageTwoSweepInterval
	if stageTwoInterval == 0 {
		stageTwoInterval = defaultStageTwoSweepInterval
	}
	runtime.stageTwoWorker = &StageTwoWorker{
		Repo: repo, Classifier: classifier, Interval: stageTwoInterval,
		TenantBatchSize: 100, MessageBatchSize: 100,
	}
	return runtime, nil
}

func (runtime *Runtime) Enabled() bool {
	return runtime != nil && runtime.enabled
}

// RecordProviderEvent transforms all direct identities before persistence and
// delegates the actual atomic observation/classification write to IngestHook.
func (runtime *Runtime) RecordProviderEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	input ProviderEventInput,
) error {
	observation, err := runtime.providerObservation(tenantID, input)
	if err != nil {
		return err
	}
	_, err = runtime.hook.Record(ctx, tx, tenantID, observation)
	if err != nil {
		return fmt.Errorf("record provider engagement evidence: %w", err)
	}
	return nil
}

func (runtime *Runtime) providerObservation(
	tenantID string,
	input ProviderEventInput,
) (ObservationInput, error) {
	if runtime == nil || !runtime.enabled {
		return ObservationInput{}, ErrRuntimeDisabled
	}
	if runtime.hook == nil || len(runtime.identityKey) < 32 ||
		!identityKeyIDPattern.MatchString(runtime.identityKeyID) ||
		runtime.observationRetention < time.Hour {
		return ObservationInput{}, ErrRuntimeNotReady
	}
	if strings.TrimSpace(input.RawObjectRef) != "" ||
		strings.TrimSpace(input.RawObjectVersionID) != "" {
		return ObservationInput{}, ErrObjectDeletionRequired
	}
	now := time.Now().UTC()
	if runtime.now != nil {
		now = runtime.now().UTC()
	}
	if input.IngestedAt.IsZero() {
		input.IngestedAt = now
	}
	recipient := strings.ToLower(strings.TrimSpace(input.RecipientAddress))
	observation := ObservationInput{
		EventRef: input.EventRef,
		Source:   input.Source, SourceEventID: input.SourceEventID,
		IdempotencyKey:     input.IdempotencyKey,
		EventSchemaVersion: input.EventSchemaVersion,
		EventType:          input.EventType,
		OccurredAt:         input.OccurredAt, IngestedAt: input.IngestedAt,
		DeliveredAt:           input.DeliveredAt,
		RecipientIdentityHMAC: runtime.identityCommitment(tenantID, "recipient", recipient),
		RecipientKeyID:        runtime.identityKeyID,
		MessageIdentityHash: runtime.identityCommitment(
			tenantID, "message", strings.TrimSpace(input.MessageIdentity),
		),
		LinkIdentityHash: runtime.identityCommitment(
			tenantID, "link", strings.TrimSpace(input.LinkIdentity),
		),
		ProviderMessageID:      input.ProviderMessageID,
		ProviderRequestID:      input.ProviderRequestID,
		OrderedHeaders:         append([]Header(nil), input.OrderedHeaders...),
		OrderedHeadersComplete: input.OrderedHeadersComplete,
		UserAgent:              input.UserAgent, IP: input.IP,
		NetworkASN:       input.NetworkASN,
		NetworkASNSource: input.NetworkASNSource,
		NetworkRegion:    input.NetworkRegion,
		ReverseDNS:       input.ReverseDNS, TLSJA4: input.TLSJA4,
		ProviderSignals:   cloneProviderSignals(input.ProviderSignals),
		DwellMilliseconds: input.DwellMilliseconds,
		MessageLinkCount:  input.MessageLinkCount,
		BodyHash:          input.BodyHash, RawObjectRef: input.RawObjectRef,
		RawObjectVersionID: input.RawObjectVersionID,
		PrivacyExpiryAt:    input.IngestedAt.UTC().Add(runtime.observationRetention),
	}
	if recipient == "" {
		observation.RecipientIdentityHMAC = ""
		observation.RecipientKeyID = ""
	}
	if recipient != "" {
		raw, err := json.Marshal(observation)
		if err != nil {
			return ObservationInput{}, fmt.Errorf("marshal provider observation privacy check: %w", err)
		}
		if strings.Contains(strings.ToLower(string(raw)), recipient) {
			return ObservationInput{}, fmt.Errorf("%w: recipient plaintext leaked into engagement observation", ErrInvalidInput)
		}
	}
	return observation, nil
}

func (runtime *Runtime) identityCommitment(tenantID, purpose, value string) string {
	if runtime == nil || value == "" {
		return ""
	}
	// Derive an unlinkable tenant/purpose key first, then commit the value.
	// The NUL separators make concatenation unambiguous.
	derive := hmac.New(sha256.New, runtime.identityKey)
	_, _ = derive.Write([]byte("postwave.engagement-identity-key.v1\x00"))
	_, _ = derive.Write([]byte(strings.TrimSpace(tenantID)))
	_, _ = derive.Write([]byte("\x00" + purpose))
	commit := hmac.New(sha256.New, derive.Sum(nil))
	_, _ = commit.Write([]byte("postwave.engagement-identity.v1\x00"))
	_, _ = commit.Write([]byte(value))
	return hex.EncodeToString(commit.Sum(nil))
}

func cloneProviderSignals(input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func parseExactRuntimeFlag(raw string) (bool, error) {
	switch raw {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	default:
		return false, fmt.Errorf("%w: %s must be exactly true or false", ErrInvalidInput, RuntimeFeatureEnvironmentKey)
	}
}

func parseBoundedRuntimeDuration(
	raw string,
	fallback, minimum, maximum time.Duration,
) (time.Duration, error) {
	if raw == "" {
		return fallback, nil
	}
	if strings.TrimSpace(raw) != raw {
		return 0, fmt.Errorf("%w: duration contains surrounding whitespace", ErrInvalidInput)
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%w: invalid bounded duration %q", ErrInvalidInput, raw)
	}
	return parsed, nil
}
