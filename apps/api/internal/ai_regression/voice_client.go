// SPDX-License-Identifier: AGPL-3.0-only
//
// Strict internal Voice client for AI regression replay. The terminal
// completion envelope is mandatory: a partial/truncated NDJSON stream is an
// error even if one or more result lines were received.
package ai_regression

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrVoiceUnavailable               = errors.New("ai_regression: voice service unavailable")
	ErrVoiceAuthenticationUnavailable = errors.New("ai_regression: internal voice authentication unavailable")
	ErrVoiceRuntimeMismatch           = errors.New("ai_regression: requested voice runtime unavailable")
	ErrVoicePrerequisiteUnavailable   = errors.New("ai_regression: voice prerequisite unavailable")
	ErrVoiceQuotaExceeded             = errors.New("ai_regression: voice quota exceeded")
	ErrVoiceInvalidResponse           = errors.New("ai_regression: voice service returned an invalid response")
)

const (
	voiceReplaySchemaVersion     = 2
	voiceReplayMaxExamples       = 25
	voiceReplayMaxRequestBytes   = 1 << 20
	voiceReplayMaxResponseBytes  = 4 << 20
	voiceReplayMaxLineBytes      = 128 << 10
	voiceReplayMaxOutputRunes    = 32_000
	voiceReplayMaxErrorCodeBytes = 64
	voiceReplayHTTPTimeout       = 3 * time.Minute
	voiceReplayCriticalThreshold = 40.0
)

type VoiceRuntimeIdentity struct {
	Provider            string `json:"provider"`
	ModelID             string `json:"model_id"`
	PromptPolicyVersion string `json:"prompt_policy_version"`
}

type VoiceReplayExample struct {
	ID             string `json:"id"`
	SurfaceKind    string `json:"surface_kind"`
	Brief          string `json:"brief"`
	ApprovedOutput string `json:"approved_output"`
}

type VoiceReplayRequest struct {
	ExpectedRuntime VoiceRuntimeIdentity `json:"expected_runtime"`
	WarnThreshold   float64              `json:"warn_threshold"`
	Examples        []VoiceReplayExample `json:"examples"`
}

type VoiceReplayResult struct {
	ExampleID      string                  `json:"example_id"`
	SurfaceKind    string                  `json:"surface_kind"`
	ReplayedOutput string                  `json:"replayed_output,omitempty"`
	FidelityScore  *float64                `json:"fidelity_score,omitempty"`
	Breakdown      *VoiceFidelityBreakdown `json:"breakdown,omitempty"`
	Severity       string                  `json:"severity"`
	ErrorCode      string                  `json:"error_code,omitempty"`
}

// VoiceFidelityBreakdown is the complete, closed diagnostic contract emitted
// by Voice. Keeping it typed prevents arbitrary provider-controlled JSON from
// crossing the internal evidence boundary or being persisted for report
// readers.
type VoiceFidelityBreakdown struct {
	EmbeddingSimilarity float64 `json:"embedding_similarity"`
	StylisticDistance   float64 `json:"stylistic_distance"`
	VocabularyOverlap   float64 `json:"vocabulary_overlap"`
	StructuralMatch     float64 `json:"structural_match"`
	Combined            float64 `json:"combined"`
}

type VoiceSurfaceAggregate struct {
	Total     int      `json:"total"`
	Scored    int      `json:"scored"`
	Passed    int      `json:"passed"`
	MeanScore *float64 `json:"mean_score,omitempty"`
}

type VoiceBatchAggregate struct {
	Total     int                              `json:"total"`
	Scored    int                              `json:"scored"`
	Passed    int                              `json:"passed"`
	MeanScore *float64                         `json:"mean_score,omitempty"`
	P25Score  *float64                         `json:"p25_score,omitempty"`
	BySurface map[string]VoiceSurfaceAggregate `json:"by_surface"`
}

type VoiceReplayCompletion struct {
	Runtime          VoiceRuntimeIdentity `json:"runtime"`
	ExpectedExamples int                  `json:"expected_examples"`
	ScoredExamples   int                  `json:"scored_examples"`
	Aggregate        VoiceBatchAggregate  `json:"aggregate"`
}

type voiceReplayEnvelope struct {
	SchemaVersion int                    `json:"schema_version"`
	Type          string                 `json:"type"`
	Sequence      int                    `json:"sequence"`
	Result        *VoiceReplayResult     `json:"result,omitempty"`
	Complete      *VoiceReplayCompletion `json:"complete,omitempty"`
}

type VoiceReplayBatch struct {
	Results    []VoiceReplayResult
	Completion VoiceReplayCompletion
}

type RegressionVoiceClient interface {
	ReplayBatch(ctx context.Context, tenantID string, request VoiceReplayRequest) (VoiceReplayBatch, error)
}

type HTTPRegressionVoiceClient struct {
	BaseURL          string
	InternalAPIToken string
	HTTP             *http.Client
}

func NewHTTPRegressionVoiceClient(baseURL, internalAPIToken string) *HTTPRegressionVoiceClient {
	return &HTTPRegressionVoiceClient{
		BaseURL:          strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		InternalAPIToken: strings.TrimSpace(internalAPIToken),
		HTTP: &http.Client{
			Timeout: voiceReplayHTTPTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (client *HTTPRegressionVoiceClient) ReplayBatch(
	ctx context.Context,
	tenantID string,
	request VoiceReplayRequest,
) (VoiceReplayBatch, error) {
	if client == nil || client.BaseURL == "" || strings.TrimSpace(tenantID) == "" {
		return VoiceReplayBatch{}, ErrVoiceUnavailable
	}
	if !validVoiceReplayRequest(request) {
		return VoiceReplayBatch{}, ErrVoiceInvalidResponse
	}
	token := strings.TrimSpace(client.InternalAPIToken)
	if token == "" || strings.IndexFunc(token, unicode.IsSpace) >= 0 || strings.IndexFunc(token, unicode.IsControl) >= 0 {
		return VoiceReplayBatch{}, ErrVoiceAuthenticationUnavailable
	}
	payload, err := json.Marshal(request)
	if err != nil || len(payload) == 0 || len(payload) > voiceReplayMaxRequestBytes {
		return VoiceReplayBatch{}, ErrVoiceInvalidResponse
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		client.BaseURL+"/v1/voice/regression/replay-batch",
		bytes.NewReader(payload),
	)
	if err != nil {
		return VoiceReplayBatch{}, ErrVoiceUnavailable
	}
	httpRequest.Header.Set("Authorization", "Bearer "+token)
	httpRequest.Header.Set("X-Tenant-ID", tenantID)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/x-ndjson")

	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	bounded := *httpClient
	if bounded.Timeout <= 0 || bounded.Timeout > voiceReplayHTTPTimeout {
		bounded.Timeout = voiceReplayHTTPTimeout
	}
	bounded.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := bounded.Do(httpRequest)
	if err != nil {
		if ctx.Err() != nil {
			return VoiceReplayBatch{}, ctx.Err()
		}
		return VoiceReplayBatch{}, ErrVoiceUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if err := classifyVoiceStatus(response.StatusCode); err != nil {
		return VoiceReplayBatch{}, err
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/x-ndjson" {
		return VoiceReplayBatch{}, ErrVoiceInvalidResponse
	}
	return decodeVoiceReplayStream(response.Body, request)
}

func classifyVoiceStatus(status int) error {
	switch {
	case status == http.StatusOK:
		return nil
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrVoiceAuthenticationUnavailable
	case status == http.StatusConflict:
		return ErrVoiceRuntimeMismatch
	case status == http.StatusUnprocessableEntity:
		return ErrVoicePrerequisiteUnavailable
	case status == http.StatusTooManyRequests:
		return ErrVoiceQuotaExceeded
	case status >= http.StatusInternalServerError:
		return ErrVoiceUnavailable
	default:
		return ErrVoiceInvalidResponse
	}
}

func decodeVoiceReplayStream(reader io.Reader, request VoiceReplayRequest) (VoiceReplayBatch, error) {
	limited := &io.LimitedReader{R: reader, N: voiceReplayMaxResponseBytes + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4<<10), voiceReplayMaxLineBytes)
	expected := make(map[string]VoiceReplayExample, len(request.Examples))
	for _, example := range request.Examples {
		if _, duplicate := expected[example.ID]; duplicate {
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
		expected[example.ID] = example
	}
	seen := make(map[string]struct{}, len(expected))
	results := make([]VoiceReplayResult, 0, len(expected))
	var completion *VoiceReplayCompletion
	sequence := 0
	for scanner.Scan() {
		if limited.N <= 0 {
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
		var envelope voiceReplayEnvelope
		if err := decodeStrictVoiceLine(line, &envelope); err != nil {
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
		sequence++
		if envelope.SchemaVersion != voiceReplaySchemaVersion || envelope.Sequence != sequence || completion != nil {
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
		switch envelope.Type {
		case "result":
			if envelope.Result == nil || envelope.Complete != nil || len(results) >= len(expected) {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			result := *envelope.Result
			example, ok := expected[result.ExampleID]
			if !ok || example.SurfaceKind != result.SurfaceKind {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			if _, duplicate := seen[result.ExampleID]; duplicate {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			if !validVoiceReplayResult(result, request.WarnThreshold) {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			seen[result.ExampleID] = struct{}{}
			results = append(results, result)
		case "complete":
			if envelope.Result != nil || envelope.Complete == nil {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			candidate := *envelope.Complete
			if candidate.Runtime != request.ExpectedRuntime || candidate.ExpectedExamples != len(expected) || len(results) != len(expected) {
				return VoiceReplayBatch{}, ErrVoiceInvalidResponse
			}
			if err := validateVoiceCompletion(candidate, results, request.WarnThreshold); err != nil {
				return VoiceReplayBatch{}, err
			}
			completion = &candidate
		default:
			return VoiceReplayBatch{}, ErrVoiceInvalidResponse
		}
	}
	if err := scanner.Err(); err != nil || limited.N <= 0 || completion == nil || len(seen) != len(expected) {
		return VoiceReplayBatch{}, ErrVoiceInvalidResponse
	}
	return VoiceReplayBatch{Results: results, Completion: *completion}, nil
}

func decodeStrictVoiceLine(line []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func validVoiceRuntime(runtime VoiceRuntimeIdentity) bool {
	return boundedSingleLine(runtime.Provider, 64) &&
		boundedSingleLine(runtime.ModelID, 160) &&
		boundedSingleLine(runtime.PromptPolicyVersion, 160)
}

func validVoiceReplayRequest(request VoiceReplayRequest) bool {
	if !validVoiceRuntime(request.ExpectedRuntime) || !finiteScore(request.WarnThreshold) ||
		len(request.Examples) == 0 || len(request.Examples) > voiceReplayMaxExamples {
		return false
	}
	seen := make(map[string]struct{}, len(request.Examples))
	for _, example := range request.Examples {
		if !boundedSingleLine(example.ID, 128) || !IsValidSurfaceKind(example.SurfaceKind) ||
			strings.TrimSpace(example.Brief) == "" || utf8.RuneCountInString(example.Brief) > maxBriefLen || !utf8.ValidString(example.Brief) ||
			strings.TrimSpace(example.ApprovedOutput) == "" || utf8.RuneCountInString(example.ApprovedOutput) > maxOutputLen || !utf8.ValidString(example.ApprovedOutput) {
			return false
		}
		if _, duplicate := seen[example.ID]; duplicate {
			return false
		}
		seen[example.ID] = struct{}{}
	}
	return true
}

func boundedSingleLine(value string, maxBytes int) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= maxBytes && utf8.ValidString(value) &&
		!strings.ContainsAny(value, "\r\n")
}

func validVoiceReplayResult(result VoiceReplayResult, warnThreshold float64) bool {
	if !boundedSingleLine(result.ExampleID, 128) || !boundedSingleLine(result.SurfaceKind, 64) ||
		utf8.RuneCountInString(result.ReplayedOutput) > voiceReplayMaxOutputRunes || !utf8.ValidString(result.ReplayedOutput) {
		return false
	}
	switch result.Severity {
	case "error":
		return result.FidelityScore == nil && result.Breakdown == nil &&
			boundedSingleLine(result.ErrorCode, voiceReplayMaxErrorCodeBytes)
	case "ok", "warn", "critical":
		return result.FidelityScore != nil && finiteScore(*result.FidelityScore) &&
			validVoiceBreakdown(result.Breakdown, *result.FidelityScore) && result.ErrorCode == "" &&
			result.Severity == expectedVoiceSeverity(*result.FidelityScore, warnThreshold)
	default:
		return false
	}
}

func expectedVoiceSeverity(score, warnThreshold float64) string {
	if score >= warnThreshold {
		return "ok"
	}
	if score < voiceReplayCriticalThreshold {
		return "critical"
	}
	return "warn"
}

func validVoiceBreakdown(breakdown *VoiceFidelityBreakdown, score float64) bool {
	if breakdown == nil || !finiteUnit(breakdown.EmbeddingSimilarity) ||
		!finiteUnit(breakdown.StylisticDistance) || !finiteUnit(breakdown.VocabularyOverlap) ||
		!finiteUnit(breakdown.StructuralMatch) || !finiteScore(breakdown.Combined) {
		return false
	}
	return math.Abs(breakdown.Combined-score) <= 0.000001
}

func finiteUnit(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func validateVoiceCompletion(
	completion VoiceReplayCompletion,
	results []VoiceReplayResult,
	warnThreshold float64,
) error {
	warn := warnThreshold
	if !finiteScore(warn) {
		warn = DefaultWarnThreshold
	}
	scores := make([]float64, 0, len(results))
	bySurfaceScores := map[string][]float64{}
	bySurfaceTotal := map[string]int{}
	bySurfacePassed := map[string]int{}
	passed := 0
	for _, result := range results {
		bySurfaceTotal[result.SurfaceKind]++
		if result.FidelityScore == nil {
			continue
		}
		score := *result.FidelityScore
		scores = append(scores, score)
		bySurfaceScores[result.SurfaceKind] = append(bySurfaceScores[result.SurfaceKind], score)
		if score >= warn {
			passed++
			bySurfacePassed[result.SurfaceKind]++
		}
	}
	aggregate := completion.Aggregate
	if completion.ScoredExamples != len(scores) || aggregate.Total != len(results) ||
		aggregate.Scored != len(scores) || aggregate.Passed != passed ||
		len(aggregate.BySurface) != len(bySurfaceTotal) {
		return ErrVoiceInvalidResponse
	}
	if !sameOptionalScore(aggregate.MeanScore, meanScore(scores)) ||
		!sameOptionalScore(aggregate.P25Score, p25Score(scores)) {
		return ErrVoiceInvalidResponse
	}
	for surface, total := range bySurfaceTotal {
		claimed, ok := aggregate.BySurface[surface]
		if !ok || claimed.Total != total || claimed.Scored != len(bySurfaceScores[surface]) ||
			claimed.Passed != bySurfacePassed[surface] ||
			!sameOptionalScore(claimed.MeanScore, meanScore(bySurfaceScores[surface])) {
			return ErrVoiceInvalidResponse
		}
	}
	return nil
}

func finiteScore(score float64) bool {
	return !math.IsNaN(score) && !math.IsInf(score, 0) && score >= 0 && score <= 100
}

func sameOptionalScore(actual, expected *float64) bool {
	if actual == nil || expected == nil {
		return actual == nil && expected == nil
	}
	return finiteScore(*actual) && math.Abs(*actual-*expected) <= 0.000001
}

func meanScore(scores []float64) *float64 {
	if len(scores) == 0 {
		return nil
	}
	var sum float64
	for _, score := range scores {
		sum += score
	}
	mean := sum / float64(len(scores))
	return &mean
}

func p25Score(scores []float64) *float64 {
	if len(scores) == 0 {
		return nil
	}
	ordered := append([]float64(nil), scores...)
	sort.Float64s(ordered)
	index := int(math.Ceil(0.25*float64(len(ordered)))) - 1
	if index < 0 {
		index = 0
	}
	value := ordered[index]
	return &value
}
