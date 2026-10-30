package fidelity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EmbeddingClient returns embeddings for a slice of texts. Implementations
// should preserve order (output[i] corresponds to input[i]).
type EmbeddingClient interface {
	Embed(ctx context.Context, texts []string) ([][]float64, error)
}

// OpenAIClient calls OpenAI's /v1/embeddings endpoint with
// text-embedding-3-small. The API key is read from the field; callers
// usually populate it from config.OpenAIAPIKey.
type OpenAIClient struct {
	APIKey  string
	Model   string // default "text-embedding-3-small"
	HTTP    *http.Client
	BaseURL string // default "https://api.openai.com"
}

const openAIEmbeddingMaxResponseBytes int64 = 1 << 20

// NewOpenAIClient constructs an OpenAIClient with sensible defaults.
func NewOpenAIClient(apiKey string) *OpenAIClient {
	return &OpenAIClient{
		APIKey: apiKey,
		Model:  "text-embedding-3-small",
		HTTP:   &http.Client{Timeout: 60 * time.Second},
	}
}

// ErrEmbeddingsNotWired indicates OPENAI_API_KEY is unset.
var ErrEmbeddingsNotWired = errors.New("fidelity: OpenAI embedding client not wired (set OPENAI_API_KEY)")

// Embed implements EmbeddingClient.
func (c *OpenAIClient) Embed(ctx context.Context, texts []string) ([][]float64, error) {
	if c.APIKey == "" {
		return nil, ErrEmbeddingsNotWired
	}
	base := c.BaseURL
	if base == "" {
		base = "https://api.openai.com"
	}
	model := c.Model
	if model == "" {
		model = "text-embedding-3-small"
	}
	body, err := json.Marshal(map[string]any{
		"model": model,
		"input": texts,
	})
	if err != nil {
		return nil, err
	}
	endpoint, err := openAIEmbeddingURL(base)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai embed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, openAIEmbeddingMaxResponseBytes)
	if resp.StatusCode/100 != 2 {
		if readErr != nil {
			return nil, fmt.Errorf("openai embed: status %d: %w", resp.StatusCode, readErr)
		}
		return nil, fmt.Errorf("openai embed: status %d: %s", resp.StatusCode, string(raw))
	}
	if readErr != nil {
		return nil, fmt.Errorf("openai embed: %w", readErr)
	}
	var env struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
			Index     int       `json:"index"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("openai embed: decode: %w", err)
	}
	out := make([][]float64, len(env.Data))
	for _, d := range env.Data {
		if d.Index < 0 || d.Index >= len(out) {
			continue
		}
		out[d.Index] = d.Embedding
	}
	return out, nil
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

func openAIEmbeddingURL(baseRaw string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid OpenAI base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported OpenAI base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe OpenAI base URL")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/v1/embeddings"
	return base.String(), nil
}

// MockEmbeddingClient returns deterministic vectors derived from a SHA-256
// hash of each text. Vector dimension is 64. Identical strings produce
// identical vectors; small edits produce small differences (because the
// hash bytes differ in a few positions). That property is good enough to
// make Score's tests stable without making the test pretend the vectors
// have semantic meaning.
type MockEmbeddingClient struct{}

// Embed implements EmbeddingClient.
func (m *MockEmbeddingClient) Embed(_ context.Context, texts []string) ([][]float64, error) {
	out := make([][]float64, len(texts))
	for i, t := range texts {
		out[i] = hashVector(t, 64)
	}
	return out, nil
}

// hashVector turns a string into a fixed-length unit vector by hashing
// (text || counter) for each dimension. Components live in [-1, 1].
func hashVector(text string, dim int) []float64 {
	v := make([]float64, dim)
	rounds := (dim + 7) / 8
	pos := 0
	for r := 0; r < rounds; r++ {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(r))
		h := sha256.Sum256(append([]byte(text), b[:]...))
		for j := 0; j < 8 && pos < dim; j++ {
			u := binary.BigEndian.Uint32(h[j*4:])
			v[pos] = (float64(u)/float64(^uint32(0)))*2 - 1
			pos++
		}
	}
	// Normalize to unit length so cosine similarity behaves.
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n == 0 {
		return v
	}
	for i := range v {
		v[i] /= sqrt(n)
	}
	return v
}

// sqrt avoids importing math just for one call.
func sqrt(x float64) float64 {
	// Newton's method, plenty good for unit-vector normalization.
	if x == 0 {
		return 0
	}
	z := x
	for i := 0; i < 12; i++ {
		z = (z + x/z) / 2
	}
	return z
}
