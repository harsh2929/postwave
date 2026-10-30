// SPDX-License-Identifier: AGPL-3.0-only
//
// The regression replay endpoint is an internal evidence boundary. It accepts
// only a bounded, frozen batch for the tenant already authenticated by the
// internal middleware, executes the server-attested replay runtime, and emits
// a typed completion receipt. A missing completion line makes an NDJSON stream
// invalid; callers must never infer success from a partial stream.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/quota"
	"github.com/postwave/postwave/services/voice/internal/regression"
)

const (
	replaySchemaVersion                = 2
	replayMaxExamples                  = 25
	replayMaxIDBytes                   = 128
	replayMaxBriefRunes                = 8_000
	replayMaxApprovedOutputRunes       = 32_000
	replayRequestMaxBody         int64 = 1 << 20
)

var replaySurfaceKinds = map[string]struct{}{
	"campaign_draft":   {},
	"subject_line":     {},
	"sequence_draft":   {},
	"campaign_summary": {},
	"reply_intent":     {},
}

type replayBatchRequest struct {
	ExpectedRuntime RegressionRuntimeIdentity `json:"expected_runtime"`
	WarnThreshold   *float64                  `json:"warn_threshold"`
	Examples        []replayBatchExample      `json:"examples"`
}

type replayBatchExample struct {
	ID             string `json:"id"`
	SurfaceKind    string `json:"surface_kind"`
	Brief          string `json:"brief"`
	ApprovedOutput string `json:"approved_output"`
}

type replayBatchResponse struct {
	SchemaVersion    int                       `json:"schema_version"`
	Runtime          RegressionRuntimeIdentity `json:"runtime"`
	ExpectedExamples int                       `json:"expected_examples"`
	Aggregate        regression.BatchResult    `json:"aggregate"`
}

type replayStreamEnvelope struct {
	SchemaVersion int                      `json:"schema_version"`
	Type          string                   `json:"type"`
	Sequence      int                      `json:"sequence"`
	Result        *regression.ReplayResult `json:"result,omitempty"`
	Complete      *replayCompletion        `json:"complete,omitempty"`
}

type replayCompletion struct {
	Runtime          RegressionRuntimeIdentity `json:"runtime"`
	ExpectedExamples int                       `json:"expected_examples"`
	ScoredExamples   int                       `json:"scored_examples"`
	Aggregate        regression.BatchResult    `json:"aggregate"`
}

func (h *Handler) replayBatch(w http.ResponseWriter, r *http.Request) {
	tenant := strings.TrimSpace(h.TenantFromRequest(r))
	if tenant == "" {
		writeChatError(w, http.StatusUnauthorized, "missing tenant")
		return
	}

	var req replayBatchRequest
	if err := decodeStrictRequestJSON(w, r, replayRequestMaxBody, &req); err != nil {
		writeChatError(w, requestDecodeStatus(err), requestDecodeMessage(err))
		return
	}
	if msg := validateReplayBatch(req); msg != "" {
		writeChatError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	if !validRegressionRuntime(h.RegressionRuntime) {
		writeChatError(w, http.StatusServiceUnavailable, "regression runtime is unavailable")
		return
	}
	if req.ExpectedRuntime != h.RegressionRuntime {
		writeChatError(w, http.StatusConflict, "requested regression runtime is unavailable")
		return
	}
	if !regressionEvaluatorReady(h.RegressionEvaluator) {
		writeChatError(w, http.StatusServiceUnavailable, "regression evaluator is unavailable")
		return
	}
	if h.Chat == nil {
		writeChatError(w, http.StatusServiceUnavailable, "regression generator is unavailable")
		return
	}
	if _, ok := any(h.Chat).(regression.LLMGenerator); !ok {
		writeChatError(w, http.StatusServiceUnavailable, "regression generator is unavailable")
		return
	}

	prof, err := h.Store.GetProfile(r.Context(), tenant)
	if err != nil {
		if errIsNotFound(err) {
			writeChatError(w, http.StatusUnprocessableEntity, "a built voice profile is required")
			return
		}
		writeChatError(w, http.StatusServiceUnavailable, "voice profile is unavailable")
		return
	}
	if !qualifiedRegressionProfile(prof, tenant) {
		writeChatError(w, http.StatusUnprocessableEntity, "a qualified voice profile is required")
		return
	}

	if err := h.quotaOrNoop().CheckAndConsume(
		r.Context(), tenant, "ai_regression", quota.CostMilliCredits("ai_regression", len(req.Examples)),
	); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "ai_regression")
			return
		}
		slog.ErrorContext(r.Context(), "voice regression quota check failed", "tenant_id", tenant)
		writeChatError(w, http.StatusInternalServerError, "AI quota could not be verified")
		return
	}

	replayer := regression.NewReplayer(h.replayGenerator(), h.RegressionEvaluator)
	replayer.WarnThreshold = *req.WarnThreshold
	examples := make([]regression.GoldenExample, 0, len(req.Examples))
	for _, example := range req.Examples {
		examples = append(examples, regression.GoldenExample{
			ID:             example.ID,
			SurfaceKind:    example.SurfaceKind,
			Brief:          example.Brief,
			ApprovedOutput: example.ApprovedOutput,
		})
	}

	w.Header().Set("Cache-Control", "no-store")
	if wantsNDJSON(r) {
		if err := h.replayBatchNDJSON(w, r, replayer, prof, examples); err != nil {
			slog.ErrorContext(r.Context(), "voice regression stream ended without completion", "tenant_id", tenant)
		}
		return
	}
	batch := replayer.ReplayBatch(r.Context(), prof, examples)
	writeJSON(w, http.StatusOK, replayBatchResponse{
		SchemaVersion:    replaySchemaVersion,
		Runtime:          h.RegressionRuntime,
		ExpectedExamples: len(examples),
		Aggregate:        batch,
	})
}

func validateReplayBatch(req replayBatchRequest) string {
	if !validRegressionRuntime(req.ExpectedRuntime) {
		return "expected_runtime is required"
	}
	if req.WarnThreshold == nil || math.IsNaN(*req.WarnThreshold) || math.IsInf(*req.WarnThreshold, 0) ||
		*req.WarnThreshold < 0 || *req.WarnThreshold > 100 {
		return "warn_threshold must be between 0 and 100"
	}
	if len(req.Examples) == 0 {
		return "at least one regression example is required"
	}
	if len(req.Examples) > replayMaxExamples {
		return fmt.Sprintf("no more than %d regression examples are allowed", replayMaxExamples)
	}
	seen := make(map[string]struct{}, len(req.Examples))
	for _, example := range req.Examples {
		id := strings.TrimSpace(example.ID)
		if id == "" || id != example.ID || len(id) > replayMaxIDBytes || !utf8.ValidString(id) {
			return "every regression example requires a valid bounded id"
		}
		if _, exists := seen[id]; exists {
			return "regression example ids must be unique"
		}
		seen[id] = struct{}{}
		if _, ok := replaySurfaceKinds[example.SurfaceKind]; !ok {
			return "unsupported regression surface_kind"
		}
		brief := strings.TrimSpace(example.Brief)
		if brief == "" || utf8.RuneCountInString(example.Brief) > replayMaxBriefRunes || !utf8.ValidString(example.Brief) {
			return "every regression example requires a valid bounded brief"
		}
		if strings.TrimSpace(example.ApprovedOutput) == "" ||
			utf8.RuneCountInString(example.ApprovedOutput) > replayMaxApprovedOutputRunes || !utf8.ValidString(example.ApprovedOutput) {
			return "approved_output is invalid or too large"
		}
	}
	return ""
}

func validRegressionRuntime(runtime RegressionRuntimeIdentity) bool {
	return validRegressionRuntimeField(runtime.Provider, 64) &&
		validRegressionRuntimeField(runtime.ModelID, 160) &&
		validRegressionRuntimeField(runtime.PromptPolicyVersion, 160)
}

func validRegressionRuntimeField(value string, maxBytes int) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > maxBytes || !utf8.ValidString(value) {
		return false
	}
	return !strings.ContainsAny(value, "\r\n")
}

func regressionEvaluatorReady(evaluator fidelity.Evaluator) bool {
	if evaluator == nil {
		return false
	}
	if embedding, ok := evaluator.(*fidelity.EmbeddingEvaluator); ok {
		return embedding != nil && embedding.Embeddings != nil
	}
	return true
}

func qualifiedRegressionProfile(prof profile.VoiceProfile, tenantID string) bool {
	return strings.TrimSpace(prof.TenantID) == tenantID &&
		strings.TrimSpace(prof.SemanticModel) != "" &&
		len(prof.RepresentativeSamples) > 0
}

func (h *Handler) replayBatchNDJSON(
	w http.ResponseWriter,
	r *http.Request,
	replayer *regression.Replayer,
	prof profile.VoiceProfile,
	examples []regression.GoldenExample,
) error {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	controller := http.NewResponseController(w)
	results := make([]regression.ReplayResult, 0, len(examples))
	for index, example := range examples {
		if err := r.Context().Err(); err != nil {
			return err
		}
		result := replayer.ReplayExample(r.Context(), prof, example)
		results = append(results, result)
		if err := encoder.Encode(replayStreamEnvelope{
			SchemaVersion: replaySchemaVersion,
			Type:          "result",
			Sequence:      index + 1,
			Result:        &result,
		}); err != nil {
			return err
		}
		if err := controller.Flush(); err != nil {
			return err
		}
	}
	batch := regression.AggregateResults(results, replayer.WarnThreshold)
	batch.Results = nil
	completion := replayCompletion{
		Runtime:          h.RegressionRuntime,
		ExpectedExamples: len(examples),
		ScoredExamples:   batch.Scored,
		Aggregate:        batch,
	}
	if err := encoder.Encode(replayStreamEnvelope{
		SchemaVersion: replaySchemaVersion,
		Type:          "complete",
		Sequence:      len(examples) + 1,
		Complete:      &completion,
	}); err != nil {
		return err
	}
	return controller.Flush()
}

func (h *Handler) replayGenerator() regression.Generator {
	chat, ok := any(h.Chat).(regression.LLMGenerator)
	if !ok || h.Chat == nil {
		return regression.NewLLMReplayGenerator(nil)
	}
	return regression.NewLLMReplayGenerator(chat)
}

func wantsNDJSON(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/x-ndjson")
}

func errIsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

var _ fidelity.Evaluator = (*fidelity.EmbeddingEvaluator)(nil)
var _ = context.Canceled
