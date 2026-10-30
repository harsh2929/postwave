// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type UnixContentScanner struct {
	configuration ScannerConfig
	client        *unixClient
	ready         atomic.Bool
}

var _ campaignimagebroker.ContentScanner = (*UnixContentScanner)(nil)

func NewUnixContentScanner(configuration ScannerConfig) (*UnixContentScanner, error) {
	if err := validateUnixService(configuration.SocketPath, configuration.Engine, configuration.Version,
		configuration.Timeout, configuration.MaxRequestBytes, configuration.MaxResponseBytes); err != nil {
		return nil, fmt.Errorf("%w: scanner: %v", ErrInvalidConfiguration, err)
	}
	return &UnixContentScanner{
		configuration: configuration,
		client: newUnixClient(configuration.SocketPath, configuration.Timeout,
			configuration.MaxRequestBytes, configuration.MaxResponseBytes),
	}, nil
}

func (s *UnixContentScanner) Identity() string {
	if s == nil {
		return ""
	}
	return s.configuration.Engine + "@" + s.configuration.Version
}

func (s *UnixContentScanner) Ready(ctx context.Context) error {
	if s == nil || s.client == nil {
		return ErrInvalidConfiguration
	}
	response, err := s.client.call(ctx, wireRequest{
		Protocol: ProtocolVersion, Operation: "ready",
		Engine: s.configuration.Engine, Version: s.configuration.Version,
	}, nil)
	if err != nil {
		s.ready.Store(false)
		return err
	}
	if response.Status != "ready" || response.SandboxProfile != ScannerSandboxProfile ||
		response.Network == nil || response.Browser == nil || response.Tools == nil || response.Shell == nil ||
		*response.Network || *response.Browser || *response.Tools || *response.Shell ||
		response.Text != "" || response.Language != "" || response.Confidence != nil || response.ReasonCode != "" {
		s.ready.Store(false)
		return fmt.Errorf("%w: scanner readiness identity mismatch", ErrIPCProtocol)
	}
	s.ready.Store(true)
	return nil
}

func (s *UnixContentScanner) Scan(ctx context.Context, input campaignimagebroker.ScanInput) error {
	if s == nil || s.client == nil || !s.ready.Load() {
		return ErrNotReady
	}
	if len(input.Body) == 0 || int64(len(input.Body)) > s.configuration.MaxRequestBytes ||
		!validSHA256(input.AssetSHA256) || sha256Hex(input.Body) != input.AssetSHA256 ||
		!validMediaType(input.MediaType) {
		return fmt.Errorf("%w: invalid scanner input", ErrIPCProtocol)
	}
	response, err := s.client.call(ctx, wireRequest{
		Protocol: ProtocolVersion, Operation: "scan",
		Engine: s.configuration.Engine, Version: s.configuration.Version,
		AssetSHA256: input.AssetSHA256, MediaType: input.MediaType,
		PayloadBytes: len(input.Body), PayloadSHA256: input.AssetSHA256,
	}, input.Body)
	if err != nil {
		return err
	}
	if response.Status == "rejected" && methodIdentityPattern.MatchString(response.ReasonCode) {
		return fmt.Errorf("%w: %s", ErrServiceRejected, response.ReasonCode)
	}
	if response.Status != "clean" || response.ReasonCode != "" || response.SandboxProfile != "" ||
		response.Network != nil || response.Browser != nil || response.Tools != nil || response.Shell != nil ||
		response.Text != "" || response.Language != "" || response.Confidence != nil {
		return fmt.Errorf("%w: invalid scanner verdict", ErrIPCProtocol)
	}
	return nil
}

func (s *UnixContentScanner) IsReady() bool { return s != nil && s.ready.Load() }

func validMediaType(value string) bool {
	if value == "" || strings.TrimSpace(value) != value || len(value) > 100 {
		return false
	}
	switch value {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml":
		return true
	default:
		return false
	}
}
