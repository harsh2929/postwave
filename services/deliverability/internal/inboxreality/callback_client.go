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

const maxObservationCallbackResponse = 1 << 20

// ObservationCallbackClient implements reportstore.ObservationNotifier. Its
// payload is a sanitized receipt, not the append-only raw evidence object.
type ObservationCallbackClient struct {
	GatewayBaseURL string
	BearerToken    string
	SigningSecret  string
	HTTPClient     *http.Client
	Clock          func() time.Time
}

func (c *ObservationCallbackClient) Validate() error {
	if c == nil || strings.TrimSpace(c.SigningSecret) == "" || strings.TrimSpace(c.BearerToken) == "" {
		return ErrInvalidRequest
	}
	if _, err := callbackEndpoint(c.GatewayBaseURL, inboxrealitycontract.ObservationPath); err != nil {
		return err
	}
	return nil
}

func (c *ObservationCallbackClient) NotifyObservation(ctx context.Context, receipt inboxrealitycontract.ObservationReceipt) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if !isSHA256(receipt.ObservationKey) {
		return ErrInvalidRequest
	}
	endpoint, err := callbackEndpoint(c.GatewayBaseURL, inboxrealitycontract.ObservationPath)
	if err != nil {
		return err
	}
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if c.Clock != nil {
		now = c.Clock().UTC()
	}
	// Sign the path we will actually DELIVER. The gateway verifies against
	// r.URL.EscapedPath(), so a base URL carrying a prefix would otherwise be
	// signed over a different string than the one verified — and because this
	// callback is what makes a dispatch visible as a placement result, the
	// failure would present as "tests never complete", not as an auth error.
	target, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	signed, err := internalsign.Sign(c.SigningSecret, http.MethodPost,
		target.EscapedPath(), receipt.ObservationKey, body, now)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if token := strings.TrimSpace(c.BearerToken); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	internalsign.Apply(request.Header, signed)
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("post Inbox Reality observation: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxObservationCallbackResponse+1))
	if err != nil || len(responseBody) > maxObservationCallbackResponse {
		return errors.New("Inbox Reality observation callback returned an invalid response")
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Inbox Reality observation callback returned status %d", response.StatusCode)
	}
	return nil
}

func callbackEndpoint(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil ||
		base.RawQuery != "" || base.Fragment != "" {
		return "", errors.New("invalid gateway service URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", errors.New("unsupported gateway service URL scheme")
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	return base.String(), nil
}
