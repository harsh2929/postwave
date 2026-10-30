// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-content-scanner is the no-network, no-credential image
// content-scanning process. It accepts only bounded bytes over an authenticated
// Unix socket and invokes the fixed /usr/bin/clamscan executable on stdin.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokerruntime"
)

const (
	scannerSocketEnvironment      = "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET"
	scannerEngineEnvironment      = "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_ENGINE"
	scannerVersionEnvironment     = "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_VERSION"
	scannerClientUIDEnvironment   = "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_CLIENT_UID"
	scannerConcurrencyEnvironment = "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_CONCURRENCY"
	imageIPCTimeoutEnvironment    = "POSTWAVE_CAMPAIGN_IMAGE_IPC_TIMEOUT"
)

func main() {
	if err := run(); err != nil {
		log.Printf("campaign assurance content scanner stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	if err := campaignimagebrokerruntime.RejectImageSandboxCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	configuration, err := scannerConfigurationFromEnvironment(os.Getenv)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	isolation, err := campaignimagebrokerruntime.EnforceDataOnlyImageServiceIsolation(ctx)
	if err != nil {
		return err
	}
	executor := campaignimagebrokerruntime.NewClamAVExecutor()
	probeContext, probeCancel := context.WithTimeout(ctx, configuration.timeout)
	actualIdentity, err := executor.Identity(probeContext)
	probeCancel()
	if err != nil {
		return fmt.Errorf("probe fixed scanner executable: %w", err)
	}
	if actualIdentity != configuration.identity {
		return fmt.Errorf("%w: configured scanner identity %s@%s, executable/database is %s@%s",
			campaignimagebrokerruntime.ErrExecutableIdentity,
			configuration.identity.Engine, configuration.identity.Version,
			actualIdentity.Engine, actualIdentity.Version)
	}
	server, err := campaignimagebrokerruntime.NewScannerServiceServer(
		campaignimagebrokerruntime.ScannerServiceServerConfig{
			SocketPath: configuration.socketPath, SocketMode: 0o600,
			AllowedClientUID: configuration.clientUID, ExpectedIdentity: configuration.identity,
			Executor: executor, Isolation: isolation, CallTimeout: configuration.timeout,
			MaxConcurrent: configuration.concurrency,
		},
	)
	if err != nil {
		return err
	}
	log.Printf("campaign assurance content scanner starting; engine=%s version=%s network_isolation=linux_seccomp_af_inet_af_inet6_denied transport=authenticated_unix database_identity_pinned=true",
		actualIdentity.Engine, actualIdentity.Version)
	return server.ListenAndServe(ctx)
}

type scannerCommandConfiguration struct {
	socketPath  string
	identity    campaignimagebrokerruntime.ServiceIdentity
	clientUID   int
	timeout     time.Duration
	concurrency int
}

func scannerConfigurationFromEnvironment(getenv func(string) string) (scannerCommandConfiguration, error) {
	if getenv == nil {
		return scannerCommandConfiguration{}, errors.New("environment reader is required")
	}
	socketPath, err := exactRequiredEnvironment(getenv, scannerSocketEnvironment)
	if err != nil {
		return scannerCommandConfiguration{}, err
	}
	engine, err := exactRequiredEnvironment(getenv, scannerEngineEnvironment)
	if err != nil || engine != campaignimagebrokerruntime.ClamAVEngine {
		return scannerCommandConfiguration{}, fmt.Errorf("%s must be exactly %s", scannerEngineEnvironment,
			campaignimagebrokerruntime.ClamAVEngine)
	}
	version, err := exactRequiredEnvironment(getenv, scannerVersionEnvironment)
	if err != nil {
		return scannerCommandConfiguration{}, err
	}
	clientUID, err := boundedIntegerEnvironment(getenv, scannerClientUIDEnvironment, os.Geteuid(), 0, 1<<31-1)
	if err != nil {
		return scannerCommandConfiguration{}, err
	}
	concurrency, err := boundedIntegerEnvironment(getenv, scannerConcurrencyEnvironment, 2, 1, 16)
	if err != nil {
		return scannerCommandConfiguration{}, err
	}
	timeout, err := boundedDurationEnvironment(getenv, imageIPCTimeoutEnvironment, 10*time.Second,
		100*time.Millisecond, time.Minute)
	if err != nil {
		return scannerCommandConfiguration{}, err
	}
	return scannerCommandConfiguration{
		socketPath: socketPath,
		identity:   campaignimagebrokerruntime.ServiceIdentity{Engine: engine, Version: version},
		clientUID:  clientUID, timeout: timeout, concurrency: concurrency,
	}, nil
}

func exactRequiredEnvironment(getenv func(string) string, name string) (string, error) {
	raw := getenv(name)
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\r\n\x00") {
		return "", fmt.Errorf("%s must be a nonempty exact value", name)
	}
	return raw, nil
}

func boundedIntegerEnvironment(
	getenv func(string) string,
	name string,
	fallback int,
	minimum int,
	maximum int,
) (int, error) {
	raw := getenv(name)
	if raw == "" {
		return fallback, nil
	}
	if strings.TrimSpace(raw) != raw {
		return 0, fmt.Errorf("%s contains surrounding whitespace", name)
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return value, nil
}

func boundedDurationEnvironment(
	getenv func(string) string,
	name string,
	fallback time.Duration,
	minimum time.Duration,
	maximum time.Duration,
) (time.Duration, error) {
	raw := getenv(name)
	if raw == "" {
		return fallback, nil
	}
	if strings.TrimSpace(raw) != raw {
		return 0, fmt.Errorf("%s contains surrounding whitespace", name)
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %s and %s", name, minimum, maximum)
	}
	return value, nil
}
