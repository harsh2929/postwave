// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-worker owns durable Campaign Assurance command execution,
// raw-output retention, and abandoned-write reconciliation. It has database
// and S3 access, but no model-provider credential and no remote-image fetcher:
// those capabilities are reached only through pinned Unix-domain peers.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancemodelsandbox"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceofferbridge"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancequeue"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancerawstore"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceretention"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokeripc"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/offers"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

const (
	runtimeEnabledEnvironment = "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME"
	modeledEnabledEnvironment = "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED"
	imageEnabledEnvironment   = "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER"

	modelSocketEnvironment = "POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET"
	modelUIDEnvironment    = "POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_UID"
	providerSocketEnv      = "POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET"
	providerKeyEnvironment = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY"

	pricingVersionEnvironment = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION"
	inputPriceEnvironment     = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS"
	outputPriceEnvironment    = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS"

	queueLeaseTTL       = 2 * time.Minute
	queueHeartbeatEvery = 30 * time.Second
	runLeaseTTL         = 90 * time.Second
	runHeartbeatEvery   = 20 * time.Second
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: campaign assurance worker: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if err := rejectProviderCapability(os.Environ()); err != nil {
		return err
	}
	enabled, err := booleanEnvironment(runtimeEnabledEnvironment, false)
	if err != nil {
		return err
	}
	if !enabled {
		return fmt.Errorf("%s=true is required", runtimeEnabledEnvironment)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	startup, startupCancel := context.WithTimeout(ctx, 90*time.Second)
	defer startupCancel()

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	pool, err := db.New(startup, databaseURL)
	if err != nil {
		return fmt.Errorf("connect worker database: %w", err)
	}
	defer pool.Close()

	region := strings.TrimSpace(os.Getenv("AWS_REGION"))
	bucket := strings.TrimSpace(os.Getenv("POSTWAVE_UPLOADS_BUCKET"))
	kmsKeyID := strings.TrimSpace(os.Getenv("POSTWAVE_S3_KMS_KEY_ID"))
	if region == "" || bucket == "" || kmsKeyID == "" {
		return errors.New("AWS_REGION, POSTWAVE_UPLOADS_BUCKET, and POSTWAVE_S3_KMS_KEY_ID are required")
	}
	awsConfiguration, err := awsconfig.LoadDefaultConfig(startup, awsconfig.WithRegion(region))
	if err != nil {
		return fmt.Errorf("load worker AWS configuration: %w", err)
	}
	objectsClient := s3.NewFromConfig(awsConfiguration)
	artifactObjects := uploads.NewS3Store(objectsClient, bucket, kmsKeyID)
	workerID := "campaign-assurance-worker-" + uuid.NewString()
	identityProjection, err := emailHMACProjectionWorkerFromEnvironment(
		startup, pool, awsConfiguration, workerID,
	)
	if err != nil {
		return err
	}

	rawRepository, err := campaignassurancerawstore.NewRepository(pool)
	if err != nil {
		return err
	}
	rawObjects, err := campaignassurancerawstore.NewS3Store(
		campaignassurancerawstore.Configuration{
			Bucket: bucket, KMSKeyID: kmsKeyID, WorkerID: workerID,
			OperationTimeout: 30 * time.Second, CleanupLeaseTTL: 2 * time.Minute,
			OrphanGrace: 10 * time.Minute, RetryBackoff: retryBackoff,
		},
		objectsClient,
		rawRepository,
	)
	if err != nil {
		return fmt.Errorf("configure exact-version raw-output store: %w", err)
	}
	if err := retryReadiness(startup, rawObjects.Ready); err != nil {
		return fmt.Errorf("raw-output store readiness: %w", err)
	}

	retentionRepository, err := campaignassuranceretention.NewRepository(pool)
	if err != nil {
		return err
	}
	if err := retryReadiness(startup, retentionRepository.Ready); err != nil {
		return fmt.Errorf("raw-output retention readiness: %w", err)
	}
	retentionWorker, err := campaignassuranceretention.NewWorker(
		retentionRepository,
		rawObjects,
		campaignassuranceretention.DefaultConfiguration(workerID),
	)
	if err != nil {
		return fmt.Errorf("configure raw-output retention: %w", err)
	}

	modelExecutor, err := modelExecutorFromEnvironment(startup)
	if err != nil {
		return err
	}
	imageInspector, err := imageInspectorFromEnvironment(startup)
	if err != nil {
		return err
	}

	queue := campaignassurancequeue.New(pool, workerID)
	queue.LeaseTTL = queueLeaseTTL
	queue.PollInterval = time.Second
	if err := queue.ValidateSchema(startup); err != nil {
		return fmt.Errorf("durable command queue readiness: %w", err)
	}
	worker := &campaignassuranceworker.Worker{
		Assurance:      campaignassurance.NewRepo(pool),
		Artifacts:      campaignartifact.NewRepo(pool),
		Objects:        artifactObjects,
		RawOutputs:     rawObjects,
		ModelExecutor:  modelExecutor,
		ImageInspector: imageInspector,
		OfferResolver: campaignassuranceofferbridge.Bridge{
			Repo: &offers.Repo{Pool: pool},
		},
		Config: campaignassuranceworker.Configuration{
			WorkerID: workerID, LeaseTTL: runLeaseTTL,
			HeartbeatEvery: runHeartbeatEvery, CleanupTimeout: 30 * time.Second,
		},
	}
	orchestrator := &campaignassuranceworker.Orchestrator{
		Worker: worker, Queue: queue, QueueHeartbeatEvery: queueHeartbeatEvery,
	}

	logger.Info("campaign assurance worker ready",
		"worker_id", workerID,
		"modeled_boundary", readinessLabel(modelExecutor != nil, "authenticated-unix-model-sandbox"),
		"image_boundary", readinessLabel(imageInspector != nil, "authenticated-unix-image-broker"),
		"raw_output_backend", "s3-exact-version",
		"email_hmac_identity_projection", "indexed-leased-v2017",
	)
	return supervise(ctx, logger, orchestrator, retentionWorker, rawObjects, identityProjection)
}

func modelExecutorFromEnvironment(ctx context.Context) (campaignassuranceworker.ModelExecutor, error) {
	enabled, err := booleanEnvironment(modeledEnabledEnvironment, false)
	if err != nil || !enabled {
		return nil, err
	}
	inputPrice, err := positiveInt64Environment(inputPriceEnvironment)
	if err != nil {
		return nil, err
	}
	outputPrice, err := positiveInt64Environment(outputPriceEnvironment)
	if err != nil {
		return nil, err
	}
	identity, err := campaignassuranceworker.GeminiModelExecutorIdentity(
		strings.TrimSpace(os.Getenv(pricingVersionEnvironment)), inputPrice, outputPrice,
	)
	if err != nil {
		return nil, err
	}
	timeout, err := durationEnvironment(
		"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_TIMEOUT", 65*time.Second,
		100*time.Millisecond, 5*time.Minute,
	)
	if err != nil {
		return nil, err
	}
	expectedUID, err := nonnegativeIntEnvironment(modelUIDEnvironment, os.Geteuid())
	if err != nil {
		return nil, err
	}
	client, err := campaignassurancemodelsandbox.NewClient(
		campaignassurancemodelsandbox.ClientConfig{
			SocketPath:        strings.TrimSpace(os.Getenv(modelSocketEnvironment)),
			ExpectedServerUID: expectedUID, ExpectedIdentity: identity, Timeout: timeout,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("configure model-sandbox client: %w", err)
	}
	if err := retryReadiness(ctx, client.Ready); err != nil {
		return nil, fmt.Errorf("model-sandbox readiness: %w", err)
	}
	return client, nil
}

func imageInspectorFromEnvironment(ctx context.Context) (campaignimagebroker.Inspector, error) {
	enabled, err := booleanEnvironment(imageEnabledEnvironment, false)
	if err != nil || !enabled {
		return nil, err
	}
	client, err := campaignimagebrokeripc.NewClientFromEnvironment(os.Getenv)
	if err != nil {
		return nil, fmt.Errorf("configure image-broker client: %w", err)
	}
	if err := retryReadiness(ctx, client.Ready); err != nil {
		return nil, fmt.Errorf("image-broker readiness: %w", err)
	}
	return client, nil
}

func supervise(
	ctx context.Context,
	logger *slog.Logger,
	orchestrator *campaignassuranceworker.Orchestrator,
	retention *campaignassuranceretention.Worker,
	rawObjects *campaignassurancerawstore.S3Store,
	identityProjection *conversions.EmailHMACProjectionWorker,
) error {
	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	errorsChannel := make(chan error, 4)
	go func() { errorsChannel <- runOrchestrator(workerContext, logger, orchestrator) }()
	go func() {
		errorsChannel <- retention.Run(workerContext, time.Hour, func(
			result campaignassuranceretention.SweepResult,
			err error,
		) {
			logRetention(logger, result, err)
		})
	}()
	go func() { errorsChannel <- runOrphanReconciliation(workerContext, logger, rawObjects) }()
	go func() {
		errorsChannel <- identityProjection.Run(workerContext, func(
			result conversions.EmailHMACProjectionSweepResult,
			err error,
		) {
			logEmailHMACProjection(logger, result, err)
		})
	}()

	first := <-errorsChannel
	cancel()
	second := <-errorsChannel
	third := <-errorsChannel
	fourth := <-errorsChannel
	return errors.Join(nonCancellation(first), nonCancellation(second),
		nonCancellation(third), nonCancellation(fourth))
}

func runOrchestrator(
	ctx context.Context,
	logger *slog.Logger,
	orchestrator *campaignassuranceworker.Orchestrator,
) error {
	for {
		err := orchestrator.Run(ctx)
		if context.Cause(ctx) != nil {
			return nil
		}
		logger.Warn("campaign assurance orchestrator restarting",
			"error_class", "durable_orchestrator_failure")
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
		if err == nil {
			return errors.New("campaign assurance orchestrator stopped unexpectedly")
		}
	}
}

func runOrphanReconciliation(
	ctx context.Context,
	logger *slog.Logger,
	store *campaignassurancerawstore.S3Store,
) error {
	run := func() {
		result, err := store.ReconcileOrphans(ctx, 100, 4)
		attributes := []any{
			"claimed", result.Claimed, "versions_found", result.VersionsFound,
			"deleted", result.Deleted, "already_missing", result.AlreadyMissing,
			"failed", result.Failed,
		}
		if err != nil {
			logger.Warn("campaign assurance raw-output orphan reconciliation failed",
				append(attributes, "error_class", "orphan_reconciliation_failed")...)
			return
		}
		logger.Info("campaign assurance raw-output orphan reconciliation completed", attributes...)
	}
	run()
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			run()
		}
	}
}

func logRetention(
	logger *slog.Logger,
	result campaignassuranceretention.SweepResult,
	err error,
) {
	attributes := []any{
		"claimed", result.Claimed, "versions_resolved", result.VersionResolved,
		"deleted", result.Deleted, "already_missing", result.AlreadyMissing,
		"deferred", result.Deferred, "failed", result.Failed,
	}
	if err != nil {
		logger.Warn("campaign assurance raw-output retention sweep failed",
			append(attributes, "error_class", "retention_sweep_failed")...)
		return
	}
	logger.Info("campaign assurance raw-output retention sweep completed", attributes...)
}

func retryReadiness(ctx context.Context, ready func(context.Context) error) error {
	if ready == nil {
		return errors.New("readiness function is required")
	}
	delay := 250 * time.Millisecond
	var last error
	for {
		attempt, cancel := context.WithTimeout(ctx, 15*time.Second)
		last = ready(attempt)
		cancel()
		if last == nil {
			return nil
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return errors.Join(last, context.Cause(ctx))
		case <-timer.C:
		}
		if delay < 2*time.Second {
			delay *= 2
		}
	}
}

func rejectProviderCapability(environment []string) error {
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || strings.TrimSpace(value) == "" {
			continue
		}
		switch strings.TrimSpace(name) {
		case providerKeyEnvironment, "GEMINI_API_KEY":
			return fmt.Errorf("%s must not be present in the worker process", strings.TrimSpace(name))
		case providerSocketEnv:
			return fmt.Errorf("%s belongs only to the model-sandbox process", providerSocketEnv)
		}
	}
	return nil
}

func booleanEnvironment(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", name)
	}
	return value, nil
}

func positiveInt64Environment(name string) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func nonnegativeIntEnvironment(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a nonnegative integer", name)
	}
	return value, nil
}

func durationEnvironment(name string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	value := fallback
	var err error
	if raw != "" {
		value, err = time.ParseDuration(raw)
	}
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %s and %s", name, minimum, maximum)
	}
	return value, nil
}

func retryBackoff(attempt int64) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 6 {
		shift = 6
	}
	return time.Minute * time.Duration(1<<shift)
}

func readinessLabel(enabled bool, label string) string {
	if enabled {
		return label
	}
	return "disabled"
}

func nonCancellation(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
}
