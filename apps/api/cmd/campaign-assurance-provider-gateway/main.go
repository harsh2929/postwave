// SPDX-License-Identifier: AGPL-3.0-only

// campaign-assurance-provider-gateway is the only Campaign Assurance process
// that receives a provider credential and opens provider HTTP connections.
// Its sole listener is a mode-0600 Unix socket for the no-network sandbox.
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
	socketEnvironment         = "POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET"
	providerKeyEnvironment    = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY"
	pricingVersionEnvironment = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION"
	inputPriceEnvironment     = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS"
	outputPriceEnvironment    = "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS"
)

func main() {
	if err := run(); err != nil {
		log.Printf("campaign assurance provider gateway stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	if err := campaignassurancemodelsandbox.RejectApplicationCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	inputPrice, err := positiveInt64Environment(inputPriceEnvironment)
	if err != nil {
		return err
	}
	outputPrice, err := positiveInt64Environment(outputPriceEnvironment)
	if err != nil {
		return err
	}
	executor, err := campaignassuranceworker.NewGeminiModelExecutor(campaignassuranceworker.GeminiExecutorConfig{
		APIKey:                        strings.TrimSpace(os.Getenv(providerKeyEnvironment)),
		BaseURL:                       strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_BASE_URL")),
		PricingVersion:                strings.TrimSpace(os.Getenv(pricingVersionEnvironment)),
		InputMicroUSDPerMillionTokens: inputPrice, OutputMicroUSDPerMillionTokens: outputPrice,
	})
	if err != nil {
		return fmt.Errorf("configure provider executor: %w", err)
	}
	timeout, err := durationEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_TIMEOUT", 65*time.Second)
	if err != nil || timeout < 100*time.Millisecond || timeout > 5*time.Minute {
		return errors.New("POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_TIMEOUT must be between 100ms and 5m")
	}
	allowedUID, err := optionalNonnegativeIntEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_UID", os.Geteuid())
	if err != nil {
		return err
	}
	concurrency, err := optionalPositiveIntEnvironment("POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_CONCURRENCY", 4)
	if err != nil || concurrency > 32 {
		return errors.New("POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_CONCURRENCY must be between 1 and 32")
	}
	server, err := campaignassurancemodelsandbox.NewProviderGatewayServer(
		campaignassurancemodelsandbox.ProviderGatewayServerConfig{
			SocketPath: strings.TrimSpace(os.Getenv(socketEnvironment)), SocketMode: 0o600,
			AllowedClientUID: allowedUID, Executor: executor, CallTimeout: timeout, MaxConcurrent: concurrency,
		},
	)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	log.Printf("campaign assurance provider gateway starting; executor=%s version=%s provider_egress=%s",
		executor.Identity().ID, executor.Identity().Version, campaignassurancemodelsandbox.GatewayProviderEgress)
	return server.ListenAndServe(ctx)
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
