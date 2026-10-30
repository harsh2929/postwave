// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/assurancelegalhold"
	"github.com/postwave/postwave/apps/api/internal/assurancelegalholdapi"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceapi"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancequeue"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

const (
	campaignAssuranceAnalyzerSuiteVersion = "postwave.campaign-assurance.analyzers.v1"
	campaignAssuranceModelSuiteVersion    = "postwave.campaign-assurance.model-executor.unavailable.v1"
	campaignAssurancePromptSuiteVersion   = "postwave.campaign-assurance.prompt-suite.unavailable.v1"
	campaignAssuranceNormalizationVersion = "postwave.campaign-assurance.normalization.v1"
	campaignAssuranceScoringVersion       = "postwave.campaign-assurance.score.not-computed.v1"
	campaignAssuranceMethodologyVersion   = "postwave.predicted-agent-comprehension.methodology.v1"

	campaignAssuranceQueueLeaseTTL    = 2 * time.Minute
	campaignAssuranceModelCallTimeout = 45 * time.Second
	// Queue owner identities are persisted into lease rows and therefore must
	// satisfy the queue's canonical UUID contract even on the API control plane,
	// which validates the schema but does not itself lease worker commands.
	campaignAssuranceControlPlaneOwnerID = "7d4a41dc-97b9-4e3a-a355-72155f5bd701"
)

var (
	_ campaignassuranceapi.FindingRemediator = (*campaignartifact.Repo)(nil)

	modeledUnavailableConfiguration = campaignassurance.ConfigurationInput{
		ID:          "modeled.executor.unavailable.v1",
		SourceClass: campaignassurance.SourceModeled,
		Configuration: json.RawMessage(
			`{"executor_status":"unavailable","reason_code":"modeled_analyzer_not_configured"}`,
		),
	}
	controlledUnavailableConfiguration = campaignassurance.ConfigurationInput{
		ID:          "controlled.seed-client.unavailable.v1",
		SourceClass: campaignassurance.SourceControlledObservation,
		Configuration: json.RawMessage(
			`{"executor_status":"unavailable","reason_code":"controlled_observation_not_configured"}`,
		),
	}
)

// campaignAssuranceRuntime keeps the default-off HTTP boundary mounted (and
// therefore authorization-classified) while starting no scheduler/worker until
// the explicit runtime flag and every durable prerequisite validate.
type campaignAssuranceRuntime struct {
	http *campaignassuranceapi.Deps
	// holds is wired whenever a database exists, NOT behind the assurance
	// runtime flag. Retention sweeps delete evidence regardless of whether
	// modeled assurance is enabled — the seed-MIME sweep runs in the
	// deliverability service — so a tenant must be able to preserve it either
	// way. A compliance control that is only available when an unrelated
	// feature flag is on is not a control.
	holds *assurancelegalholdapi.Deps
}

type campaignAssuranceModeledRuntime struct {
	enabled        bool
	executor       campaignassuranceworker.ModelExecutor // worker-only/test seam
	identity       campaignassuranceworker.ModelExecutorIdentity
	configurations map[string][]campaignassurance.ConfigurationInput
	modelID        string
	modelVersion   string
	pricingVersion string
}

func initializeCampaignAssuranceRuntime(
	ctx context.Context,
	enabled bool,
	pool *db.Pool,
	objects uploads.Store,
	logger *slog.Logger,
) (*campaignAssuranceRuntime, error) {
	if logger == nil {
		logger = slog.Default()
	}
	runtime := &campaignAssuranceRuntime{
		http:  &campaignassuranceapi.Deps{Logger: logger},
		holds: &assurancelegalholdapi.Deps{Logger: logger},
	}
	// Before the enabled check on purpose — see the field comment.
	if pool != nil {
		runtime.holds.Store = &assurancelegalhold.Store{Pool: pool}
	}
	if !enabled {
		return runtime, nil
	}
	if pool == nil || objects == nil {
		return nil, fmt.Errorf("campaign assurance runtime enabled without database or tenant object store")
	}
	modeled, err := loadCampaignAssuranceModeledRuntimeFromEnvironment()
	if err != nil {
		return nil, fmt.Errorf("campaign assurance modeled runtime: %w", err)
	}
	registry, err := newCampaignAssuranceSuiteRegistryWithModeled(modeled)
	if err != nil {
		return nil, fmt.Errorf("campaign assurance suite registry: %w", err)
	}
	// The API owns only run creation and durable queueing. It deliberately has
	// no model, image-fetch, execution, or retention capability; a separately
	// deployed worker claims these commands through the database.
	commandQueue := campaignassurancequeue.New(pool, campaignAssuranceControlPlaneOwnerID)
	commandQueue.LeaseTTL = campaignAssuranceQueueLeaseTTL
	commandQueue.PollInterval = time.Second
	if err := commandQueue.ValidateSchema(ctx); err != nil {
		return nil, fmt.Errorf("campaign assurance runtime readiness: %w", err)
	}
	assuranceRepository := campaignassurance.NewRepo(pool)
	artifactRepository := campaignartifact.NewRepo(pool)
	service, err := campaignassuranceapi.NewService(assuranceRepository, registry, commandQueue)
	if err != nil {
		return nil, fmt.Errorf("campaign assurance service: %w", err)
	}
	runtime.http.Service = service
	// Run creation is metered against the tenant's plan allowance. The enforcer
	// shares the pool the rest of the runtime uses, so the count and the runs it
	// counts can never come from different databases.
	runtime.http.Entitlements = &limits.Enforcer{Pool: pool}
	runtime.http.Remediator = artifactRepository
	runtime.http.Preparer = campaignassuranceapi.NewCurrentSnapshotPreparer(
		artifactRepository,
		objects,
	)
	if modeled.enabled {
		logger.Info("campaign assurance modeled suite enabled on control plane",
			"executor_id", modeled.identity.ID,
			"executor_version", modeled.identity.Version,
			"model_id", modeled.modelID,
			"model_version", modeled.modelVersion,
			"pricing_version", modeled.pricingVersion,
			"execution_boundary", "dedicated_worker_via_no_network_sandbox",
			"claim", "predicted_agent_comprehension_not_provider_observation")
	}
	return runtime, nil
}

func (r *campaignAssuranceRuntime) enabled() bool {
	return r != nil && r.http != nil && r.http.Service != nil
}

func (r *campaignAssuranceRuntime) MountRead(router chi.Router) {
	if r == nil || r.http == nil {
		campaignassuranceapi.MountRead(router, &campaignassuranceapi.Deps{})
		return
	}
	campaignassuranceapi.MountRead(router, r.http)
}

func (r *campaignAssuranceRuntime) MountWrite(router chi.Router) {
	if r == nil || r.http == nil {
		campaignassuranceapi.MountWrite(router, &campaignassuranceapi.Deps{})
		assurancelegalholdapi.Mount(router, &assurancelegalholdapi.Deps{})
		return
	}
	campaignassuranceapi.MountWrite(router, r.http)
	holds := r.holds
	if holds == nil {
		// Still mounted so the route stays authorization-classified; an
		// unwired store answers 503 rather than pretending a hold was placed.
		holds = &assurancelegalholdapi.Deps{}
	}
	assurancelegalholdapi.Mount(router, holds)
}

func newCampaignAssuranceSuiteRegistry() (*campaignassuranceapi.SuiteRegistry, error) {
	return newCampaignAssuranceSuiteRegistryWithModeled(campaignAssuranceModeledRuntime{})
}

func newCampaignAssuranceSuiteRegistryWithModeled(
	modeled campaignAssuranceModeledRuntime,
) (*campaignassuranceapi.SuiteRegistry, error) {
	deterministic, err := campaignassuranceworker.NewDeterministicConfiguration(
		campaignchecks.DefaultPolicyVersion,
	)
	if err != nil {
		return nil, err
	}
	definition := func(
		profile string,
		configurations []campaignassurance.ConfigurationInput,
	) campaignassuranceapi.SuiteDefinition {
		modelSuiteVersion := campaignAssuranceModelSuiteVersion
		promptSuiteVersion := campaignAssurancePromptSuiteVersion
		promptSuiteHash := campaignAssurancePromptSuiteHash(profile)
		normalizationVersion := campaignAssuranceNormalizationVersion
		scoringVersion := campaignAssuranceScoringVersion
		if modeled.enabled {
			modelSuiteVersion = campaignassuranceworker.ProductionModelSuiteVersionV1
			promptSuiteVersion = campaignassuranceworker.ProductionPromptSuiteVersionV1
			promptSuiteHash = campaignassuranceworker.ProductionPromptSuiteHashV1()
			normalizationVersion = campaigncomprehension.ExtractionNormalizationVersionV1
			scoringVersion = campaigncomprehension.ScoreVersionV1
		}
		return campaignassuranceapi.SuiteDefinition{
			Profile:              profile,
			AnalyzerSuiteVersion: campaignAssuranceAnalyzerSuiteVersion,
			ModelSuiteVersion:    modelSuiteVersion,
			PromptSuiteVersion:   promptSuiteVersion,
			PromptSuiteHash:      promptSuiteHash,
			NormalizationVersion: normalizationVersion,
			ScoringVersion:       scoringVersion,
			GatePolicyVersion:    campaignchecks.DefaultPolicyVersion,
			MethodologyVersion:   campaignAssuranceMethodologyVersion,
			Configurations:       configurations,
			MaxAttempts:          3,
		}
	}
	configurations := func(profile string, fallback []campaignassurance.ConfigurationInput) []campaignassurance.ConfigurationInput {
		if !modeled.enabled {
			return fallback
		}
		return append([]campaignassurance.ConfigurationInput{deterministic}, modeled.configurations[profile]...)
	}
	fastConfigurations := configurations(campaignassurance.ProfileFast,
		[]campaignassurance.ConfigurationInput{deterministic})
	fullConfigurations := configurations(campaignassurance.ProfileFull,
		[]campaignassurance.ConfigurationInput{deterministic, modeledUnavailableConfiguration})
	calibrationConfigurations := configurations(campaignassurance.ProfileCalibration,
		[]campaignassurance.ConfigurationInput{deterministic, modeledUnavailableConfiguration})
	calibrationConfigurations = append(calibrationConfigurations, controlledUnavailableConfiguration)
	return campaignassuranceapi.NewSuiteRegistry([]campaignassuranceapi.SuiteDefinition{
		definition(campaignassurance.ProfileFast, fastConfigurations),
		definition(campaignassurance.ProfileFull, fullConfigurations),
		definition(campaignassurance.ProfileCalibration, calibrationConfigurations),
	})
}

func loadCampaignAssuranceModeledRuntimeFromEnvironment() (campaignAssuranceModeledRuntime, error) {
	enabled, err := campaignAssuranceEnvironmentBool("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED")
	if err != nil || !enabled {
		return campaignAssuranceModeledRuntime{}, err
	}
	inputPrice, err := campaignAssurancePositiveInt64Environment(
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS",
	)
	if err != nil {
		return campaignAssuranceModeledRuntime{}, err
	}
	outputPrice, err := campaignAssurancePositiveInt64Environment(
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS",
	)
	if err != nil {
		return campaignAssuranceModeledRuntime{}, err
	}
	modelID := strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_ID"))
	modelVersion := strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_VERSION"))
	pricingVersion := strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION"))
	identity, err := campaignassuranceworker.GeminiModelExecutorIdentity(
		pricingVersion, inputPrice, outputPrice,
	)
	if err != nil {
		return campaignAssuranceModeledRuntime{}, err
	}
	timeout := campaignAssuranceModelCallTimeout
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_TIMEOUT")); raw != "" {
		timeout, err = time.ParseDuration(raw)
		if err != nil || timeout < 100*time.Millisecond || timeout > 5*time.Minute {
			return campaignAssuranceModeledRuntime{}, fmt.Errorf(
				"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_TIMEOUT must be between 100ms and 5m",
			)
		}
	}
	byProfile := make(map[string][]campaignassurance.ConfigurationInput, 3)
	for _, profile := range []string{
		campaignassurance.ProfileFast,
		campaignassurance.ProfileFull,
		campaignassurance.ProfileCalibration,
	} {
		values, configurationErr := campaignassuranceworker.ProductionGeminiConfigurations(
			profile, modelID, modelVersion, identity, timeout,
		)
		if configurationErr != nil {
			return campaignAssuranceModeledRuntime{}, fmt.Errorf("profile %s: %w", profile, configurationErr)
		}
		byProfile[profile] = values
	}
	return campaignAssuranceModeledRuntime{
		enabled: true, identity: identity, configurations: byProfile,
		modelID: modelID, modelVersion: modelVersion, pricingVersion: pricingVersion,
	}, nil
}

func campaignAssuranceEnvironmentBool(name string) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return false, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", name)
	}
	return value, nil
}

func campaignAssurancePositiveInt64Environment(name string) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func campaignAssurancePromptSuiteHash(profile string) string {
	digest := sha256.Sum256([]byte(
		campaignAssurancePromptSuiteVersion + "\nprofile=" + profile +
			"\nstatus=not_invoked\n",
	))
	return hex.EncodeToString(digest[:])
}
