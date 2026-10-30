// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

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
)

var (
	ErrGeneratorUnavailable = errors.New("campaigntemplates: generator unavailable")
	ErrGeneratorRejected    = errors.New("campaigntemplates: generator rejected request")
)

// GenerationReference mirrors the voice service's intentionally narrow
// reference payload. IDs are resolved under tenant RLS before this leaves the
// gateway; clients cannot inject arbitrary remote content through this seam.
type GenerationReference struct {
	ID             string         `json:"id,omitempty"`
	Name           string         `json:"name,omitempty"`
	Brand          string         `json:"brand,omitempty"`
	Description    string         `json:"description,omitempty"`
	Industry       string         `json:"industry,omitempty"`
	Style          string         `json:"style,omitempty"`
	Layout         string         `json:"layout,omitempty"`
	SourceURL      string         `json:"source_url,omitempty"`
	ThumbnailURL   string         `json:"thumbnail_url,omitempty"`
	BodyHTML       string         `json:"body_html,omitempty"`
	BodyMJML       string         `json:"body_mjml,omitempty"`
	DesignMetadata map[string]any `json:"design_metadata,omitempty"`
	// eligibilityValidated is intentionally unexported and not serialized.
	// Only this package's governed resolver can mint it. Production generator
	// clients reject references assembled by an alternate route that bypassed
	// review/license checks (for example, an older MCP adapter).
	eligibilityValidated bool
}

type GenerateDesignRequest struct {
	Brief      string                `json:"brief"`
	Kind       string                `json:"kind,omitempty"`
	Tone       string                `json:"tone,omitempty"`
	References []GenerationReference `json:"references,omitempty"`
}

type GeneratedDesign struct {
	Name        string `json:"name"`
	Subject     string `json:"subject"`
	PreviewText string `json:"preview_text,omitempty"`
	BodyHTML    string `json:"body_html"`
	BodyMJML    string `json:"body_mjml,omitempty"`
}

type TemplateGenerator interface {
	GenerateTemplate(context.Context, string, GenerateDesignRequest) (GeneratedDesign, error)
}

// generatorConfigured reports configuration, not transient service health.
// Only the HTTP adapter has a known configuration boundary; injected test or
// alternate adapters are considered configured by their caller.
func generatorConfigured(generator TemplateGenerator) bool {
	if generator == nil {
		return false
	}
	if client, ok := generator.(*HTTPTemplateGenerator); ok {
		if client == nil || client.BaseURL == "" {
			return false
		}
		parsed, err := url.Parse(client.BaseURL)
		return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
	}
	return true
}

// HTTPTemplateGenerator calls the internal voice service. InternalToken uses
// the same rotation-aware bearer configured on the gateway reverse proxy.
type HTTPTemplateGenerator struct {
	BaseURL       string
	InternalToken string
	HTTP          *http.Client
}

func NewHTTPTemplateGenerator(baseURL, internalToken string) *HTTPTemplateGenerator {
	return &HTTPTemplateGenerator{
		BaseURL:       strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		InternalToken: strings.TrimSpace(internalToken),
		HTTP:          &http.Client{Timeout: 90 * time.Second},
	}
}

func (c *HTTPTemplateGenerator) GenerateTemplate(ctx context.Context, tenantID string, in GenerateDesignRequest) (GeneratedDesign, error) {
	if !generatorConfigured(c) {
		return GeneratedDesign{}, ErrGeneratorUnavailable
	}
	for _, reference := range in.References {
		if !reference.eligibilityValidated {
			return GeneratedDesign{}, fmt.Errorf("%w: unvalidated template reference", ErrGeneratorRejected)
		}
	}
	body, err := json.Marshal(in)
	if err != nil {
		return GeneratedDesign{}, fmt.Errorf("marshal generation request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/voice/templates/generate", bytes.NewReader(body))
	if err != nil {
		return GeneratedDesign{}, fmt.Errorf("build generation request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Tenant-ID", tenantID)
	req.Header.Set("X-Postwave-Tenant-ID", tenantID)
	if c.InternalToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.InternalToken)
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return GeneratedDesign{}, fmt.Errorf("%w: %v", ErrGeneratorUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusBadGateway {
			return GeneratedDesign{}, fmt.Errorf("%w: %s", ErrGeneratorUnavailable, strings.TrimSpace(string(message)))
		}
		return GeneratedDesign{}, fmt.Errorf("%w: status %d: %s", ErrGeneratorRejected, resp.StatusCode, strings.TrimSpace(string(message)))
	}
	var out GeneratedDesign
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&out); err != nil {
		return GeneratedDesign{}, fmt.Errorf("decode generation response: %w", err)
	}
	// The durable design workflow deterministically repairs a missing name or
	// subject and can render MJML into HTML. The generator boundary therefore
	// rejects only a response with no usable body at all.
	if strings.TrimSpace(out.BodyHTML) == "" && strings.TrimSpace(out.BodyMJML) == "" {
		return GeneratedDesign{}, fmt.Errorf("%w: response missing body_html and body_mjml", ErrGeneratorUnavailable)
	}
	return out, nil
}
