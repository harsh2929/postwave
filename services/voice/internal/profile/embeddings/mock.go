package embeddings

import (
	"context"
	"hash/fnv"
	"math"
)

// MockEmbeddingClient returns deterministic pseudo-embeddings derived from
// a stable hash of the input string. Used in tests so theme clustering,
// fidelity scoring, and sample diversity have a deterministic embedding
// space without needing live network access.
//
// The vectors are L2-normalized so cosine similarity is bounded in
// [-1, 1] the same way real Gemini outputs are. Identical inputs always
// produce identical vectors. Similar inputs produce moderately similar
// vectors because we mix word-level FNV hashes into the components — two
// strings that share words land closer than two completely disjoint
// strings, which is just enough realism to exercise clustering tests
// without faking the underlying semantics.
type MockEmbeddingClient struct {
	// Dim is the output vector size. Zero falls back to DefaultDimension.
	Dim int
	// Calls records every Embed / EmbedBatch invocation in order. Tests
	// can read it to assert call counts and batching behavior.
	Calls []MockCall
	// Err, when non-nil, is returned from every call. Lets tests force a
	// transient failure on the client.
	Err error
}

// MockCall is a record of a single embed call. Single calls have len(Texts)==1.
type MockCall struct {
	Texts    []string
	TaskType string
}

// Embed implements Embedder.
func (m *MockEmbeddingClient) Embed(_ context.Context, text string, taskType string) ([]float64, error) {
	m.Calls = append(m.Calls, MockCall{Texts: []string{text}, TaskType: taskType})
	if m.Err != nil {
		return nil, m.Err
	}
	return m.vector(text), nil
}

// EmbedBatch implements Embedder.
func (m *MockEmbeddingClient) EmbedBatch(_ context.Context, texts []string, taskType string) ([][]float64, error) {
	cp := append([]string(nil), texts...)
	m.Calls = append(m.Calls, MockCall{Texts: cp, TaskType: taskType})
	if m.Err != nil {
		return nil, m.Err
	}
	out := make([][]float64, len(texts))
	for i, t := range texts {
		out[i] = m.vector(t)
	}
	return out, nil
}

// vector derives a deterministic L2-normalized vector from text.
//
// We split on whitespace and mix per-word FNV-64 hashes into the
// component bins. Two strings that share words will share some bin
// contributions, giving them higher cosine similarity than disjoint
// strings — exactly the property clustering tests need.
func (m *MockEmbeddingClient) vector(text string) []float64 {
	dim := m.Dim
	if dim <= 0 {
		dim = DefaultDimension
	}
	v := make([]float64, dim)
	if text == "" {
		// Degenerate but valid: one-hot at slot 0 so cosine is well-defined.
		v[0] = 1
		return v
	}
	// Tokenize on whitespace, lowercase via byte-level transform.
	words := splitWords(text)
	for _, w := range words {
		h := fnv.New64a()
		_, _ = h.Write([]byte(w))
		hv := h.Sum64()
		// Spread each word's signal across 4 bins so single-word inputs
		// don't produce one-hot vectors (cosine would be 0 or 1 with no
		// gradation in between).
		for s := 0; s < 4; s++ {
			idx := int((hv >> (uint(s) * 8)) % uint64(dim))
			// Sign: stable, depends on the next byte of the hash.
			sign := 1.0
			if (hv>>uint(32+s*4))&1 == 1 {
				sign = -1.0
			}
			v[idx] += sign
		}
	}
	// L2 normalize so cosine similarity == dot product.
	var s2 float64
	for _, x := range v {
		s2 += x * x
	}
	if s2 == 0 {
		v[0] = 1
		return v
	}
	inv := 1.0 / math.Sqrt(s2)
	for i := range v {
		v[i] *= inv
	}
	return v
}

func splitWords(s string) []string {
	out := make([]string, 0, 8)
	start := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlpha := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
		if isAlpha {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			out = append(out, lower(s[start:i]))
			start = -1
		}
	}
	if start >= 0 {
		out = append(out, lower(s[start:]))
	}
	return out
}

func lower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
