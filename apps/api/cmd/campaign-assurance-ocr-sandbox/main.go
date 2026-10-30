// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-ocr-sandbox is the no-network, no-credential image OCR
// process. It accepts canonical PNG pixels over an authenticated Unix socket
// and invokes only the fixed /usr/bin/tesseract executable with fixed options.
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
	ocrSocketEnvironment       = "POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET"
	ocrEngineEnvironment       = "POSTWAVE_CAMPAIGN_IMAGE_OCR_ENGINE"
	ocrVersionEnvironment      = "POSTWAVE_CAMPAIGN_IMAGE_OCR_VERSION"
	ocrClientUIDEnvironment    = "POSTWAVE_CAMPAIGN_IMAGE_OCR_CLIENT_UID"
	ocrConcurrencyEnvironment  = "POSTWAVE_CAMPAIGN_IMAGE_OCR_CONCURRENCY"
	imageIPCTimeoutEnvironment = "POSTWAVE_CAMPAIGN_IMAGE_IPC_TIMEOUT"
)

func main() {
	if err := run(); err != nil {
		log.Printf("campaign assurance OCR sandbox stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	if err := campaignimagebrokerruntime.RejectImageSandboxCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	configuration, err := ocrConfigurationFromEnvironment(os.Getenv)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	isolation, err := campaignimagebrokerruntime.EnforceDataOnlyImageServiceIsolation(ctx)
	if err != nil {
		return err
	}
	executor := campaignimagebrokerruntime.NewTesseractExecutor()
	probeContext, probeCancel := context.WithTimeout(ctx, configuration.timeout)
	actualIdentity, err := executor.Identity(probeContext)
	probeCancel()
	if err != nil {
		return fmt.Errorf("probe fixed OCR executable: %w", err)
	}
	if actualIdentity != configuration.identity {
		return fmt.Errorf("%w: configured OCR identity %s@%s, executable is %s@%s",
			campaignimagebrokerruntime.ErrExecutableIdentity,
			configuration.identity.Engine, configuration.identity.Version,
			actualIdentity.Engine, actualIdentity.Version)
	}
	server, err := campaignimagebrokerruntime.NewOCRServiceServer(
		campaignimagebrokerruntime.OCRServiceServerConfig{
			SocketPath: configuration.socketPath, SocketMode: 0o600,
			AllowedClientUID: configuration.clientUID, ExpectedIdentity: configuration.identity,
			Executor: executor, Isolation: isolation, CallTimeout: configuration.timeout,
			MaxConcurrent: configuration.concurrency,
		},
	)
	if err != nil {
		return err
	}
	log.Printf("campaign assurance OCR sandbox starting; engine=%s version=%s network_isolation=linux_seccomp_af_inet_af_inet6_denied transport=authenticated_unix pixels_only=true",
		actualIdentity.Engine, actualIdentity.Version)
	return server.ListenAndServe(ctx)
}

type ocrCommandConfiguration struct {
	socketPath  string
	identity    campaignimagebrokerruntime.ServiceIdentity
	clientUID   int
	timeout     time.Duration
	concurrency int
}

func ocrConfigurationFromEnvironment(getenv func(string) string) (ocrCommandConfiguration, error) {
	if getenv == nil {
		return ocrCommandConfiguration{}, errors.New("environment reader is required")
	}
	socketPath, err := exactRequiredEnvironment(getenv, ocrSocketEnvironment)
	if err != nil {
		return ocrCommandConfiguration{}, err
	}
	engine, err := exactRequiredEnvironment(getenv, ocrEngineEnvironment)
	if err != nil || engine != campaignimagebrokerruntime.TesseractEngine {
		return ocrCommandConfiguration{}, fmt.Errorf("%s must be exactly %s", ocrEngineEnvironment,
			campaignimagebrokerruntime.TesseractEngine)
	}
	version, err := exactRequiredEnvironment(getenv, ocrVersionEnvironment)
	if err != nil {
		return ocrCommandConfiguration{}, err
	}
	clientUID, err := boundedIntegerEnvironment(getenv, ocrClientUIDEnvironment, os.Geteuid(), 0, 1<<31-1)
	if err != nil {
		return ocrCommandConfiguration{}, err
	}
	concurrency, err := boundedIntegerEnvironment(getenv, ocrConcurrencyEnvironment, 2, 1, 16)
	if err != nil {
		return ocrCommandConfiguration{}, err
	}
	timeout, err := boundedDurationEnvironment(getenv, imageIPCTimeoutEnvironment, 10*time.Second,
		100*time.Millisecond, time.Minute)
	if err != nil {
		return ocrCommandConfiguration{}, err
	}
	return ocrCommandConfiguration{
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
