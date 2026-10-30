// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

const maxDispatchResponseBytes int64 = 2 << 20

type DeliverabilityClient struct {
	BaseURL       string
	BearerToken   string
	SigningSecret string
	HTTPClient    *http.Client
	Clock         func() time.Time
}

func (c *DeliverabilityClient) Validate() error {
	if c == nil || strings.TrimSpace(c.SigningSecret) == "" || strings.TrimSpace(c.BearerToken) == "" {
		return ErrDispatchPermanent
	}
	if _, err := internalEndpoint(c.BaseURL, inboxrealitycontract.DispatchPath); err != nil {
		return fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	return nil
}

func (c *DeliverabilityClient) Execute(ctx context.Context, request inboxrealitycontract.DispatchRequest) (inboxrealitycontract.ExecutionReceipt, error) {
	if err := c.Validate(); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, err
	}
	endpoint, err := internalEndpoint(c.BaseURL, inboxrealitycontract.DispatchPath)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	body, err := json.Marshal(request)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	now := time.Now().UTC()
	if c.Clock != nil {
		now = c.Clock().UTC()
	}
	// Sign the path we will actually DELIVER. The service verifies against
	// r.URL.EscapedPath(), so a base URL carrying a prefix — any path-routed
	// ingress — would otherwise be signed over a different string than the one
	// verified, and every dispatch would 401 as if the secret were wrong.
	target, err := url.Parse(endpoint)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	signed, err := internalsign.Sign(c.SigningSecret, http.MethodPost,
		target.EscapedPath(), request.CommandID, body, now)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchPermanent, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if token := strings.TrimSpace(c.BearerToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	internalsign.Apply(req.Header, signed)
	client := c.HTTPClient
	if client == nil {
		// Execution may fan out across the full controlled-seed registry. Keep
		// this below the two-minute command lease/server write timeout while
		// allowing sequential provider receipts to converge in one attempt.
		client = &http.Client{Timeout: 110 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: %v", ErrDispatchRetryable, err)
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, maxDispatchResponseBytes+1))
	if readErr != nil || int64(len(responseBody)) > maxDispatchResponseBytes {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: invalid response", ErrDispatchRetryable)
	}
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden ||
			response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnprocessableEntity ||
			response.StatusCode == http.StatusConflict {
			return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: status %d", ErrDispatchPermanent, response.StatusCode)
		}
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: status %d", ErrDispatchRetryable, response.StatusCode)
	}
	var receipt inboxrealitycontract.ExecutionReceipt
	if err := json.Unmarshal(responseBody, &receipt); err != nil {
		return inboxrealitycontract.ExecutionReceipt{}, fmt.Errorf("%w: invalid receipt", ErrDispatchRetryable)
	}
	return receipt, nil
}

func internalEndpoint(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", errors.New("invalid internal service URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", errors.New("unsupported internal service URL scheme")
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	return base.String(), nil
}
