// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-model-sandbox is the no-network, no-credential Campaign
// Assurance comprehension process. It relays bounded quoted data over a
// second Unix socket to the separately credentialed provider gateway. On
// Linux it installs a process-wide seccomp filter before opening its listener;
// unsupported platforms fail closed.
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

	"github.com/postwave/postwave/apps/api/internal/campaignassurancemodelsandbox"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

const (
	socketEnvironment         = "POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET"
	gatewaySocketEnvironment  = "POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET"
	pricingVersionEnvironment = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION"
	inputPriceEnvironment     = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS"
	outputPriceEnvironment    = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS"
)

func main() {
	if err := run(); err != nil {
		log.Printf("campaign assurance no-network model sandbox stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	if err := campaignassurancemodelsandbox.RejectSandboxCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	identity, err := expectedExecutorIdentity()
	if err != nil {
		return err
	}
	timeout, err := durationEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_TIMEOUT", 65*time.Second)
	if err != nil || timeout < 100*time.Millisecond || timeout > 5*time.Minute {
		return errors.New("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_TIMEOUT must be between 100ms and 5m")
	}
	gatewayUID, err := optionalNonnegativeIntEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_UID", os.Geteuid())
	if err != nil {
		return err
	}
	gateway, err := campaignassurancemodelsandbox.NewProviderGatewayClient(
		campaignassurancemodelsandbox.ProviderGatewayClientConfig{
			SocketPath:        strings.TrimSpace(os.Getenv(gatewaySocketEnvironment)),
			ExpectedServerUID: gatewayUID, ExpectedIdentity: identity, Timeout: timeout,
		},
	)
	if err != nil {
		return fmt.Errorf("configure provider gateway client: %w", err)
	}
	isolation, err := campaignassurancemodelsandbox.NewProcessNetworkIsolationEnforcer()
	if err != nil {
		return err
	}
	allowedUID, err := optionalNonnegativeIntEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_CLIENT_UID", os.Geteuid())
	if err != nil {
		return err
	}
	concurrency, err := optionalPositiveIntEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_CONCURRENCY", 4)
	if err != nil || concurrency > 32 {
		return errors.New("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_CONCURRENCY must be between 1 and 32")
	}
	server, err := campaignassurancemodelsandbox.NewServer(campaignassurancemodelsandbox.ServerConfig{
		SocketPath: strings.TrimSpace(os.Getenv(socketEnvironment)), SocketMode: 0o600,
		AllowedClientUID: allowedUID, Executor: gateway, NetworkIsolation: isolation,
		CallTimeout: timeout, MaxConcurrent: concurrency,
	})
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	log.Printf("campaign assurance model sandbox starting; executor=%s version=%s network_isolation=%s provider_transport=unix",
		identity.ID, identity.Version, campaignassurancemodelsandbox.NetworkIsolationAFDenied)
	return server.ListenAndServe(ctx)
}

func expectedExecutorIdentity() (campaignassuranceworker.ModelExecutorIdentity, error) {
	inputPrice, err := positiveInt64Environment(inputPriceEnvironment)
	if err != nil {
		return campaignassuranceworker.ModelExecutorIdentity{}, err
	}
	outputPrice, err := positiveInt64Environment(outputPriceEnvironment)
	if err != nil {
		return campaignassuranceworker.ModelExecutorIdentity{}, err
	}
	return campaignassuranceworker.GeminiModelExecutorIdentity(
		strings.TrimSpace(os.Getenv(pricingVersionEnvironment)), inputPrice, outputPrice,
	)
}

func positiveInt64Environment(name string) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func optionalPositiveIntEnvironment(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func optionalNonnegativeIntEnvironment(name string, fallback int) (int, error) {
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

func durationEnvironment(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	return time.ParseDuration(raw)
}
