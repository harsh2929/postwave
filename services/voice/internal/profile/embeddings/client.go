// Package embeddings is a thin Go client for Google's Gemini text-embedding
// API.
//
// Used by the voice-profile builder to:
//
//   - Compute a per-tenant semantic signature centroid (mean of representative
//     sample embeddings).
//   - Score voice fidelity of generated content against that signature via
//     cosine similarity.
//   - Cluster representative samples for theme extraction (k-means in the
//     embedding space).
//   - Replace the legacy Jaccard-5gram diversity test in sample selection
//     with embedding cosine similarity.
//
// Wire format mirrors the existing GeminiClient in profile/llm.go: net/http,
// x-goog-api-key header, exponential-backoff retries on 429/5xx, no
// third-party SDK.
package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultModel is the embedding model name. The API exposes it under
// /v1beta/models/text-embedding-004:embedContent.
const DefaultModel = "text-embedding-004"

// DefaultDimension is the output vector size. 768 matches the model's
// native dimension and is sufficient for the voice-signature use case:
// cosine similarity stays well-discriminated at 768 dims and the JSON
// payload (~6 KB per signature) is small enough to cache per-tenant.
//
// The model supports 256, 512, 1024, and 3072 via outputDimensionality.
// We pick 768 for the storage/quality trade-off.
const DefaultDimension = 768

// DefaultBaseURL is the Gemini API root.
const DefaultBaseURL = "https://generativelanguage.googleapis.com"

// BatchLimit caps a single batchEmbedContents call. The API allows up to
// 100 per request; we keep that as the chunk size when callers pass more
// than 100 inputs to EmbedBatch (we transparently fan out).
const BatchLimit = 100
const geminiEmbeddingMaxResponseBodyBytes int64 = 1 << 20

// TaskTypeSemanticSimilarity is the task type for fidelity scoring and
// sample-diversity comparison.
const TaskTypeSemanticSimilarity = "SEMANTIC_SIMILARITY"

// TaskTypeClustering is the task type for theme-cluster embeddings.
const TaskTypeClustering = "CLUSTERING"

// Embedder is the minimal interface profile callers need. Both Client
// (production) and MockEmbeddingClient (tests) implement it so the rest
// of the profile package can stay decoupled from the concrete HTTP
// client.
type Embedder interface {
	Embed(ctx context.Context, text string, taskType string) ([]float64, error)
	EmbedBatch(ctx context.Context, texts []string, taskType string) ([][]float64, error)
}

// Client speaks the Gemini embeddings API directly via net/http.
type Client struct {
	APIKey    string
	Model     string       // default DefaultModel
	BaseURL   string       // default DefaultBaseURL
	HTTP      *http.Client // default 30s timeout
	Retries   int          // default 3 (1s/2s/4s backoff)
	Dimension int          // default DefaultDimension
}

// NewClient constructs a Client with production defaults.
func NewClient(apiKey string) *Client {
	return &Client{
		APIKey:    apiKey,
		Model:     DefaultModel,
		BaseURL:   DefaultBaseURL,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
		Retries:   3,
		Dimension: DefaultDimension,
	}
}

// ErrNotWired is returned when callers attempt to use a Client that has
// no API key. Mirrors profile.ErrLLMNotWired so wrappers can distinguish
// "unconfigured" from "transient failure".
var ErrNotWired = errors.New("embeddings: GEMINI_API_KEY not set; Gemini embedding client not wired")

// Embed returns a single embedding vector for `text` under the supplied
// task type (see the TaskType* constants).
func (c *Client) Embed(ctx context.Context, text string, taskType string) ([]float64, error) {
	if c == nil || c.APIKey == "" {
		return nil, ErrNotWired
	}
	url, err := c.endpoint("embedContent")
	if err != nil {
		return nil, err
	}

	body := map[string]any{
		"content": map[string]any{
			"parts": []map[string]any{{"text": text}},
		},
	}
	if taskType != "" {
		body["taskType"] = taskType
	}
	if c.dim() > 0 {
		body["outputDimensionality"] = c.dim()
	}

	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	raw, err := c.doWithRetry(ctx, url, buf)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Embedding struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("embeddings: decode single response: %w", err)
	}
	if len(resp.Embedding.Values) == 0 {
		return nil, errors.New("embeddings: empty embedding in response")
	}
	return resp.Embedding.Values, nil
}

// EmbedBatch returns embeddings for up to len(texts) inputs, transparently
// chunking into BatchLimit-sized requests when needed. Returned vectors
// are in the same order as `texts`. An error from any chunk fails the
// whole call.
func (c *Client) EmbedBatch(ctx context.Context, texts []string, taskType string) ([][]float64, error) {
	if c == nil || c.APIKey == "" {
		return nil, ErrNotWired
	}
	if len(texts) == 0 {
		return nil, nil
	}
	out := make([][]float64, 0, len(texts))
	for start := 0; start < len(texts); start += BatchLimit {
		end := start + BatchLimit
		if end > len(texts) {
			end = len(texts)
		}
		chunk, err := c.embedBatchOne(ctx, texts[start:end], taskType)
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
	}
	return out, nil
}

func (c *Client) embedBatchOne(ctx context.Context, texts []string, taskType string) ([][]float64, error) {
	url, err := c.endpoint("batchEmbedContents")
	if err != nil {
		return nil, err
	}

	requests := make([]map[string]any, 0, len(texts))
	modelPath := "models/" + c.model()
	for _, t := range texts {
		req := map[string]any{
			"model": modelPath,
			"content": map[string]any{
				"parts": []map[string]any{{"text": t}},
			},
		}
		if taskType != "" {
			req["taskType"] = taskType
		}
		if c.dim() > 0 {
			req["outputDimensionality"] = c.dim()
		}
		requests = append(requests, req)
	}
	buf, err := json.Marshal(map[string]any{"requests": requests})
	if err != nil {
		return nil, err
	}
	raw, err := c.doWithRetry(ctx, url, buf)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Embeddings []struct {
			Values []float64 `json:"values"`
		} `json:"embeddings"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("embeddings: decode batch response: %w", err)
	}
	if len(resp.Embeddings) != len(texts) {
		return nil, fmt.Errorf("embeddings: expected %d vectors, got %d", len(texts), len(resp.Embeddings))
	}
	out := make([][]float64, len(resp.Embeddings))
	for i, e := range resp.Embeddings {
		if len(e.Values) == 0 {
			return nil, fmt.Errorf("embeddings: empty vector at index %d", i)
		}
		out[i] = e.Values
	}
	return out, nil
}

// doWithRetry performs a POST with 429/5xx exponential-backoff retries.
// Mirrors GeminiClient.Generate's 1s/2s/4s + jitter cadence so operators
// see the same retry behavior across LLM + embedding calls.
func (c *Client) doWithRetry(ctx context.Context, url string, buf []byte) ([]byte, error) {
	retries := c.Retries
	if retries <= 0 {
		retries = 3
	}
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		raw, retryable, err := c.doOnce(ctx, url, buf)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		if !retryable || attempt == retries {
			break
		}
		sleep := time.Duration(1<<attempt) * time.Second
		jitter := time.Duration(float64(sleep) * (0.8 + 0.4*rand.Float64()))
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(jitter):
		}
	}
	return nil, lastErr
}

func (c *Client) doOnce(ctx context.Context, url string, buf []byte) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	req.Header.Set("content-type", "application/json")

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("embeddings: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, geminiEmbeddingMaxResponseBodyBytes)
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode/100 == 5 {
		if readErr != nil {
			return nil, true, fmt.Errorf("embeddings: status %d: %w", resp.StatusCode, readErr)
		}
		return nil, true, fmt.Errorf("embeddings: status %d: %s", resp.StatusCode, string(raw))
	}
	if resp.StatusCode/100 != 2 {
		if readErr != nil {
			return nil, false, fmt.Errorf("embeddings: status %d: %w", resp.StatusCode, readErr)
		}
		return nil, false, fmt.Errorf("embeddings: status %d: %s", resp.StatusCode, string(raw))
	}
	if readErr != nil {
		return nil, false, fmt.Errorf("embeddings: %w", readErr)
	}
	return raw, false, nil
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return raw, nil
}

func (c *Client) base() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return DefaultBaseURL
}

func (c *Client) endpoint(action string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(c.base()), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid embeddings base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported embeddings base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe embeddings base URL")
	}
	if action != "embedContent" && action != "batchEmbedContents" {
		return "", fmt.Errorf("unsupported embeddings action")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/v1beta/models/" + url.PathEscape(c.model()) + ":" + action
	return base.String(), nil
}

func (c *Client) model() string {
	if c.Model != "" {
		return c.Model
	}
	return DefaultModel
}

func (c *Client) dim() int {
	if c.Dimension > 0 {
		return c.Dimension
	}
	return DefaultDimension
}
