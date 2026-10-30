// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-image-broker is the only Campaign Assurance process that
// may resolve and fetch remote image URLs. The assurance worker reaches it over
// authenticated Unix IPC; this command never exposes an HTTP listener.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokeripc"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokerruntime"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: campaign assurance image broker: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if err := rejectModelProviderCredentials(os.Environ()); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	configuration, err := campaignimagebrokerruntime.ConfigurationFromEnvironment(os.Getenv)
	if err != nil {
		return err
	}
	if !configuration.Enabled {
		return errors.New("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER=true is required")
	}
	ipcConfiguration, err := campaignimagebrokeripc.ServerConfigFromEnvironment(os.Getenv)
	if err != nil {
		return err
	}
	database := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if database == "" {
		return errors.New("DATABASE_URL is required")
	}
	databaseContext, databaseCancel := context.WithTimeout(context.Background(), 10*time.Second)
	pool, err := db.New(databaseContext, database)
	databaseCancel()
	if err != nil {
		return fmt.Errorf("connect image-broker database: %w", err)
	}
	defer pool.Close()

	startupContext, startupCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer startupCancel()
	region := strings.TrimSpace(os.Getenv("AWS_REGION"))
	if region == "" {
		return errors.New("AWS_REGION is required")
	}
	awsConfiguration, err := awsconfig.LoadDefaultConfig(startupContext, awsconfig.WithRegion(region))
	if err != nil {
		return fmt.Errorf("load image-broker AWS configuration: %w", err)
	}
	runtime, err := campaignimagebrokerruntime.Build(startupContext, configuration,
		campaignimagebrokerruntime.Dependencies{
			Pool: pool, Objects: s3.NewFromConfig(awsConfiguration),
		})
	if err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	errorsChannel := make(chan error, 2)
	go func() {
		errorsChannel <- campaignimagebrokeripc.RunServer(ctx, ipcConfiguration, runtime.Inspector())
	}()
	go func() {
		errorsChannel <- runtime.RunRetention(ctx, func(
			result campaignimagebrokerruntime.RetentionResult,
			sweepErr error,
		) {
			attributes := []any{
				"cache_entries_deleted", result.CacheEntriesDeleted,
				"evidence_versions_deleted", result.EvidenceVersions,
				"failures", result.Failures,
			}
			if sweepErr != nil {
				logger.Warn("campaign image evidence retention sweep failed",
					append(attributes, "error_class", "retention_sweep_failed")...)
				return
			}
			logger.Info("campaign image evidence retention sweep completed", attributes...)
		})
	}()
	logger.Info("campaign assurance image broker ready",
		"boundary", campaignimagebrokeripc.BoundaryProfile,
		"transport", "authenticated-unix-ipc")
	first := <-errorsChannel
	cancel()
	second := <-errorsChannel
	return errors.Join(nonCancellation(first), nonCancellation(second))
}

func rejectModelProviderCredentials(environment []string) error {
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || strings.TrimSpace(value) == "" {
			continue
		}
		switch strings.TrimSpace(name) {
		case "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY", "GEMINI_API_KEY":
			return fmt.Errorf("%s must not be present in the image-broker process", strings.TrimSpace(name))
		}
	}
	return nil
}

func nonCancellation(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
}
