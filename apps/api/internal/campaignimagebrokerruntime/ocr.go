// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"strings"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type UnixOCREngine struct {
	configuration OCRConfig
	client        *unixClient
	ready         atomic.Bool
}

var _ campaignimagebroker.OCREngine = (*UnixOCREngine)(nil)

func NewUnixOCREngine(configuration OCRConfig) (*UnixOCREngine, error) {
	if err := validateUnixService(configuration.SocketPath, configuration.Engine, configuration.Version,
		configuration.Timeout, configuration.MaxRequestBytes, configuration.MaxResponseBytes); err != nil {
		return nil, fmt.Errorf("%w: OCR: %v", ErrInvalidConfiguration, err)
	}
	return &UnixOCREngine{
		configuration: configuration,
		client: newUnixClient(configuration.SocketPath, configuration.Timeout,
			configuration.MaxRequestBytes, configuration.MaxResponseBytes),
	}, nil
}

func (e *UnixOCREngine) Identity() campaignimagebroker.OCRIdentity {
	if e == nil {
		return campaignimagebroker.OCRIdentity{}
	}
	return campaignimagebroker.OCRIdentity{
		Engine: e.configuration.Engine, Version: e.configuration.Version,
	}
}

// Ready verifies the exact service identity and an explicit data-only sandbox
// attestation. Deployment policy must still enforce the profile at the process
// or workload boundary; this protocol never grants a network, URL, browser,
// tool, shell, credential, or callback capability.
func (e *UnixOCREngine) Ready(ctx context.Context) error {
	if e == nil || e.client == nil {
		return ErrInvalidConfiguration
	}
	response, err := e.client.call(ctx, wireRequest{
		Protocol: ProtocolVersion, Operation: "ready",
		Engine: e.configuration.Engine, Version: e.configuration.Version,
	}, nil)
	if err != nil {
		e.ready.Store(false)
		return err
	}
	if response.Status != "ready" || response.SandboxProfile != SandboxProfile ||
		response.Network == nil || response.Browser == nil || response.Tools == nil || response.Shell == nil ||
		*response.Network || *response.Browser || *response.Tools || *response.Shell ||
		response.Text != "" || response.Language != "" || response.Confidence != nil || response.ReasonCode != "" {
		e.ready.Store(false)
		return fmt.Errorf("%w: OCR readiness attestation mismatch", ErrIPCProtocol)
	}
	e.ready.Store(true)
	return nil
}

func (e *UnixOCREngine) Recognize(ctx context.Context, input campaignimagebroker.OCRInput) (campaignimagebroker.OCROutput, error) {
	if e == nil || e.client == nil || !e.ready.Load() {
		return campaignimagebroker.OCROutput{}, ErrNotReady
	}
	if len(input.RasterPNG) == 0 || int64(len(input.RasterPNG)) > e.configuration.MaxRequestBytes ||
		!bytes.HasPrefix(input.RasterPNG, []byte("\x89PNG\r\n\x1a\n")) ||
		!validSHA256(input.AssetSHA256) || !validSHA256(input.RasterSHA256) ||
		sha256Hex(input.RasterPNG) != input.RasterSHA256 || input.Width < 1 || input.Height < 1 ||
		input.Width > 16_384 || input.Height > 16_384 || int64(input.Width)*int64(input.Height) > 40_000_000 ||
		!validBoundedText(input.LanguageHint, 64) {
		return campaignimagebroker.OCROutput{}, fmt.Errorf("%w: invalid OCR input", ErrIPCProtocol)
	}
	response, err := e.client.call(ctx, wireRequest{
		Protocol: ProtocolVersion, Operation: "recognize",
		Engine: e.configuration.Engine, Version: e.configuration.Version,
		AssetSHA256: input.AssetSHA256, RasterSHA256: input.RasterSHA256,
		MediaType: "image/png", Width: input.Width, Height: input.Height,
		LanguageHint: input.LanguageHint, PayloadBytes: len(input.RasterPNG),
		PayloadSHA256: input.RasterSHA256,
	}, input.RasterPNG)
	if err != nil {
		return campaignimagebroker.OCROutput{}, err
	}
	if response.Status != "complete" {
		if response.Status == "error" && methodIdentityPattern.MatchString(response.ReasonCode) {
			return campaignimagebroker.OCROutput{}, fmt.Errorf("%w: %s", ErrServiceRejected, response.ReasonCode)
		}
		return campaignimagebroker.OCROutput{}, fmt.Errorf("%w: OCR completion status", ErrIPCProtocol)
	}
	if response.SandboxProfile != "" || response.Network != nil || response.Browser != nil ||
		response.Tools != nil || response.Shell != nil || response.ReasonCode != "" ||
		!validBoundedOCRText(response.Text, 32<<10) ||
		response.Text == "" && (response.Language != "" || response.Confidence != nil) ||
		response.Text != "" && !validBoundedText(response.Language, 64) ||
		response.Confidence != nil && (math.IsNaN(*response.Confidence) || math.IsInf(*response.Confidence, 0) ||
			*response.Confidence < 0 || *response.Confidence > 1) {
		return campaignimagebroker.OCROutput{}, fmt.Errorf("%w: invalid OCR output", ErrIPCProtocol)
	}
	return campaignimagebroker.OCROutput{
		Text: response.Text, Language: strings.TrimSpace(response.Language), Confidence: response.Confidence,
	}, nil
}

func (e *UnixOCREngine) IsReady() bool { return e != nil && e.ready.Load() }

func validBoundedOCRText(value string, maximum int) bool {
	return value == "" || validBoundedText(value, maximum)
}
