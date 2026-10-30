package segments

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/ai_segment_compiler"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// NLProvider is the AI-gateway interface the AI fallback compiler needs.
// Matches ai_segment_compiler.Provider exactly so callers can pass the
// same client (Anthropic, etc.) without an adapter shim. Kept here as
// a re-export so main.go's wiring only imports the segments package.
type NLProvider interface {
	Complete(ctx context.Context, system, user string) (text string, err error)
}

// AIProviderMetadata is optional, factual runtime metadata exposed by an
// NLProvider. Providers that cannot attest either value leave it empty; the
// response omits unknown provider/model fields rather than guessing.
type AIProviderMetadata struct {
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

type nlProviderMetadataSource interface {
	AIProcessingMetadata() AIProviderMetadata
}

// AIProcessingDisclosure tells clients exactly which categories are sent to
// the configured compiler. Retention and residency intentionally remain
// not_declared: provider wiring alone is not evidence of either policy.
type AIProcessingDisclosure struct {
	Provider       string   `json:"provider,omitempty"`
	Model          string   `json:"model,omitempty"`
	DataCategories []string `json:"data_categories"`
	Retention      string   `json:"retention"`
	Residency      string   `json:"residency"`
}

// Deps bundles the dependencies the segment handlers need. AIProvider
// is optional — when nil the engine=ai query-param returns 503
// "ai_unavailable" so the desktop can render the rules-only error.
//
// Logger is optional — when nil httperror.WriteInternal still emits
// the user-facing 500 envelope but suppresses the structured log line.
// Wire one in main.go so DB / RLS failures land in the operator log.
type Deps struct {
	Repo                *Repo
	AIProvider          NLProvider
	AICompileMiddleware func(http.Handler) http.Handler
	Logger              *slog.Logger
}

const segmentJSONMaxBodyBytes int64 = 1 << 20 // 1 MiB

// Mount registers the segment routes on r. The caller is responsible for
// ensuring tenant middleware is in front of them.
func Mount(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/segments", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/segments", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Post("/api/v1/segments/preview", d.Preview)
	compileHandler := d.compileFromTextRouteHandler()
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Post("/api/v1/segments/compile-from-text", compileHandler.ServeHTTP)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/segments/compile-from-text", d.AICompileDisclosure)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/segments/predicate-registry", d.PredicateRegistry)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/segments/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/segments/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/segments/{id}", d.Delete)
}

func (d *Deps) compileFromTextRouteHandler() http.Handler {
	base := http.Handler(http.HandlerFunc(d.CompileFromText))
	if d.AICompileMiddleware == nil {
		return base
	}
	limitedAIHandler := d.AICompileMiddleware(base)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if strings.EqualFold(strings.TrimSpace(request.URL.Query().Get("engine")), "ai") {
			limitedAIHandler.ServeHTTP(w, request)
			return
		}
		base.ServeHTTP(w, request)
	})
}

// AICompileDisclosure exposes the factual external-processing contract before
// an operator decides whether to send a description. It never calls the
// provider and deliberately carries no workspace or subscriber data.
func (d *Deps) AICompileDisclosure(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"available":     d.AIProvider != nil,
		"ai_processing": aiProcessingDisclosure(d.AIProvider),
	})
}

// MountExtended registers the 2026 segments expansion routes: live
// preview count, manual recompute, AI suggestions, usage, size history,
// live members, and static snapshots. Kept separate from Mount so older
// callers can mount only the legacy CRUD surface.
func MountExtended(r chi.Router, d *Deps) {
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers))
	write := r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers))

	read.Post("/api/v1/segments/preview-count", d.PreviewCount)
	read.Get("/api/v1/segments/ai-suggestions", d.AISuggestions)
	// Overlap + growth (full-surface-wiring task 4). The static
	// "overlap" path wins over the {id} match in chi, so no shadowing.
	read.Get("/api/v1/segments/overlap", d.SegmentOverlap)
	read.Get("/api/v1/segments/{id}/growth", d.SegmentGrowth)
	// SUB-031 segment growth report: per-day adds/drops correlated with
	// anomaly events, plus a CSV export variant. The static ".csv" suffix
	// route is registered before the JSON route so chi resolves it.
	read.Get("/api/v1/segments/{id}/growth/report.csv", d.SegmentGrowthReportCSV)
	read.Get("/api/v1/segments/{id}/growth/report", d.SegmentGrowthReport)
	// SUB-036 segment engagement summary: open/click/unsub rates for the
	// audience-performance dashboard.
	read.Get("/api/v1/segments/{id}/engagement-summary", d.SegmentEngagementSummary)
	read.Get("/api/v1/segments/{id}/usage", d.SegmentUsage)
	read.Get("/api/v1/segments/{id}/size-history", d.SegmentSizeHistory)
	read.Get("/api/v1/segments/{id}/members", d.SegmentMembers)
	read.Get("/api/v1/segments/{id}/snapshots", d.ListSnapshots)
	read.Get("/api/v1/segments/snapshots/{snapshot_id}/members", d.SnapshotMembers)

	write.Post("/api/v1/segments/{id}/recompute", d.Recompute)
	write.Post("/api/v1/segments/{id}/snapshot", d.CreateSnapshot)

	// --- Segment P&L (feature #4) ---
	// Static "pnl/compare" path registered BEFORE the {id} routes so chi
	// does not shadow it. Read routes use ScopeReadReports (matching
	// attribution/holdout-lift); holdout config writes use ScopeAdmin.
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	readReports := r.With(apikeys.RequireScope(apikeys.ScopeReadReports))
	readReports.Get("/api/v1/segments/pnl/compare", d.SegmentPnLCompare)
	readReports.Get("/api/v1/segments/{id}/pnl", d.SegmentPnL)
	admin.Post("/api/v1/segments/{id}/holdout", d.CreateSegmentHoldout)
	admin.Delete("/api/v1/segments/{id}/holdout", d.DeleteSegmentHoldout)
}

// CompileFromText POST /api/v1/segments/compile-from-text converts a
// natural-language audience description into the canonical AST.
//
// The engine query-param picks the compiler:
//
//	?engine=rules (default) — deterministic rules compiler. Returns 422
//	  with code=unsupported_text when the phrase doesn't match the
//	  known patterns. The desktop retries with engine=ai on 422.
//
//	?engine=ai — LLM fallback via ai_segment_compiler. Requires the
//	  AIProvider to be wired on Deps; returns 503 ai_unavailable
//	  otherwise. On success the response includes nutrition_facts
//	  explaining inferred predicates + time windows.
//
// Response shape (both engines):
//
//	{
//	  "ast": <SegmentNode AST>,           // alias of queryAst for parity
//	  "engine_used": "rules" | "ai",
//	  "queryAst": <SegmentNode AST>,
//	  "query_ast": <SegmentNode AST>,
//	  "rationale": "...",                 // rules engine only
//	  "suggested_name": "...",            // rules engine only
//	  "nutrition_facts": {...},           // ai engine only
//	  "ai_processing": {                 // ai engine only
//	    "provider": "...",              // only when provider exposes it
//	    "model": "...",                 // only when provider exposes it
//	    "data_categories": [...],
//	    "retention": "not_declared",
//	    "residency": "not_declared"
//	  }
//	}
func (d *Deps) CompileFromText(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text                     string `json:"text"`
		AIProcessingAcknowledged bool   `json:"ai_processing_acknowledged"`
	}
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if utf8.RuneCountInString(in.Text) > 4096 {
		httperror.Write(w, http.StatusBadRequest, "text_too_long", "text must be 4096 characters or fewer")
		return
	}
	engine := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("engine")))
	if engine == "" {
		engine = "rules"
	}
	switch engine {
	case "rules":
		ast, rationale, name, err := compileText(in.Text)
		if err != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_text", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ast":            ast,
			"engine_used":    "rules",
			"query_ast":      ast,
			"queryAst":       ast,
			"rationale":      rationale,
			"suggested_name": name,
			"suggestedName":  name,
		})
	case "ai":
		if !in.AIProcessingAcknowledged {
			httperror.Write(w, http.StatusBadRequest, "ai_processing_acknowledgement_required",
				"explicit AI-processing acknowledgement is required for this request")
			return
		}
		d.compileFromTextAI(w, r, in.Text)
	default:
		httperror.Write(w, http.StatusBadRequest, "bad_engine", "engine must be rules or ai")
	}
}

// compileFromTextAI is the engine=ai branch. Pulled out so the rules
// branch stays a short straight-line read.
func (d *Deps) compileFromTextAI(w http.ResponseWriter, r *http.Request, text string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.AIProvider == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "ai_unavailable",
			"AI compiler is not configured on this server; fall back to the visual builder")
		return
	}
	reg, err := d.Repo.PredicateRegistry(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defs := make([]ai_segment_compiler.PredicateDef, 0, len(reg.Predicates))
	for _, p := range reg.Predicates {
		// Only expose predicates whose advertised comparator/value contract is
		// executable end-to-end. A model must not be invited to emit a
		// reviewable-looking rule that the production compiler only partially
		// supports.
		if p.CompilerStatus != "supported" || p.Key == "custom.*" {
			continue
		}
		defs = append(defs, ai_segment_compiler.PredicateDef{
			Key:         p.Key,
			Label:       p.Label,
			Category:    p.Category,
			ValueType:   p.ValueType,
			Comparators: p.Comparators,
			Options:     p.Options,
		})
	}
	startedAt := time.Now()
	auditOutcome := "provider_error"
	inferredPredicates := 0
	inferredWindows := 0
	defer func() {
		d.auditAICompile(r.Context(), text, auditOutcome, time.Since(startedAt), inferredPredicates, inferredWindows)
	}()
	out, err := ai_segment_compiler.CompileFromNL(r.Context(), d.AIProvider, t.ID, text, defs)
	if err != nil {
		if errors.Is(err, ai_segment_compiler.ErrEmptyPrompt) {
			httperror.Write(w, http.StatusBadRequest, "missing_text", err.Error())
			return
		}
		if errors.Is(err, ai_segment_compiler.ErrProviderUnavailable) {
			httperror.Write(w, http.StatusServiceUnavailable, "ai_unavailable", httperror.MessageInternal)
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "ai_compile_failed",
			"the AI compiler could not derive a segment from the supplied text")
		return
	}
	inferredPredicates = len(out.NutritionFacts.Predicates)
	inferredWindows = len(out.NutritionFacts.TimeWindows)
	auditOutcome = "rejected_output"
	// The model-facing registry validator is necessary but not sufficient:
	// execute the exact production compiler (including tenant-scoped segment
	// references) before exposing a draft. This prevents registry/compiler
	// drift from returning a reviewable-looking tree that preview/save rejects.
	if _, _, err := CompileASTWithResolver(r.Context(), out.AST, t.ID, d.Repo); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("AI segment output failed executable compiler validation", "tenant_id", t.ID, "error", err)
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "ai_compile_failed",
			"the AI compiler could not derive an executable segment from the supplied text")
		return
	}
	auditOutcome = "success"
	writeJSON(w, http.StatusOK, map[string]any{
		"ast":             json.RawMessage(out.AST),
		"ai_processing":   aiProcessingDisclosure(d.AIProvider),
		"engine_used":     "ai",
		"query_ast":       json.RawMessage(out.AST),
		"queryAst":        json.RawMessage(out.AST),
		"nutrition_facts": out.NutritionFacts,
	})
}

func (d *Deps) auditAICompile(ctx context.Context, prompt, outcome string, elapsed time.Duration, predicateCount, windowCount int) {
	if d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	metadata := aiCompileAuditMetadata(d.AIProvider, prompt, outcome, elapsed, predicateCount, windowCount)
	audit.EmitOrLog(ctx, d.Repo.Pool, "segment.ai_compile", "segment_compiler", "compile-from-text", nil, nil, metadata)
}

func aiCompileAuditMetadata(provider NLProvider, prompt, outcome string, elapsed time.Duration, predicateCount, windowCount int) map[string]any {
	disclosure := aiProcessingDisclosure(provider)
	metadata := map[string]any{
		"acknowledged":      true,
		"outcome":           outcome,
		"latency_ms":        elapsed.Milliseconds(),
		"prompt_characters": utf8.RuneCountInString(prompt),
		"predicate_count":   predicateCount,
		"time_window_count": windowCount,
		"data_categories":   disclosure.DataCategories,
		"retention":         disclosure.Retention,
		"residency":         disclosure.Residency,
	}
	if disclosure.Provider != "" {
		metadata["provider"] = disclosure.Provider
	}
	if disclosure.Model != "" {
		metadata["model"] = disclosure.Model
	}
	return metadata
}

func aiProcessingDisclosure(provider NLProvider) AIProcessingDisclosure {
	disclosure := AIProcessingDisclosure{
		DataCategories: []string{
			"operator_supplied_segment_description",
			"segment_predicate_catalog",
		},
		Retention: "not_declared",
		Residency: "not_declared",
	}
	if source, ok := provider.(nlProviderMetadataSource); ok {
		metadata := source.AIProcessingMetadata()
		disclosure.Provider = strings.TrimSpace(metadata.Provider)
		disclosure.Model = strings.TrimSpace(metadata.Model)
	}
	return disclosure
}

// List GET /api/v1/segments
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	segs, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, segs)
}

// Get GET /api/v1/segments/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	s, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("segment", s.ID, s.UpdatedAt))
	writeJSON(w, http.StatusOK, s)
}

// Create POST /api/v1/segments
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Name == "" || len(in.QueryAST) == 0 {
		httperror.Write(w, http.StatusBadRequest, "missing_fields", "name + queryAst required")
		return
	}
	// Validate AST compiles. Use the resolver path so composable
	// segment_id (in_segment / not_in_segment) references are resolved +
	// depth-checked at create time (SUB-032).
	if _, _, err := CompileASTWithResolver(r.Context(), in.QueryAST, t.ID, d.Repo); err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}
	s, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrNameConflict) {
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
			return
		}
		if errors.Is(err, ErrFolderNotFound) {
			httperror.Write(w, http.StatusBadRequest, "folder_not_found", "folder does not exist")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// p5-audit-segments: emit segment.create with the full row as
	// `after` so the audit consumer can diff future updates against
	// the QueryAST snapshot at creation time.
	audit.EmitOrLog(r.Context(), d.Repo.Pool,
		"segment.create", "segment", s.ID,
		nil, s, nil)
	// Count the new segment before answering, so it arrives on the list and its
	// overview with a size instead of "—" and "Never" until the next snapshot.
	d.evaluateSaved(r.Context(), t.ID, s)
	w.Header().Set("ETag", httpcache.ConcurrencyToken("segment", s.ID, s.UpdatedAt))
	writeJSON(w, http.StatusCreated, s)
}

// Update PATCH /api/v1/segments/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.QueryAST != nil {
		// Resolve this segment id to the proposed AST during validation. Without
		// the overlay, an indirect A -> B -> A update would load A's old stored
		// definition and pass validation, only to fail closed at runtime.
		resolver := segmentUpdateValidationResolver(d.Repo, t.ID, id, *in.QueryAST)
		if _, _, err := CompileASTWithResolver(r.Context(), *in.QueryAST, t.ID, resolver); err != nil {
			httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
			return
		}
	}
	// `If-Match: *` means "only if this resource exists" — an explicitly
	// CONDITIONAL request. Discarding the wildcard bool made it an
	// unconditional write returning 200: the caller believes it sent a
	// precondition and got last-writer-wins. Refused instead, because silently
	// weakening a caller's stated intent is worse than rejecting a header shape
	// this resource does not support.
	if tok, present, wildcard := httpcache.ParseIfMatch(r); present {
		if wildcard {
			httpcache.WritePreconditionFailed(w)
			return
		}
		in.IfMatchToken = tok
	}
	// p5-audit-segments: snapshot the row BEFORE mutating so the
	// audit `before` block carries the prior name/description/AST.
	// A missed read here is best-effort — we still emit with a nil
	// before so the post-state is preserved.
	before, _ := d.Repo.Get(r.Context(), t.ID, id)
	s, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
		case errors.Is(err, ErrNameConflict):
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	audit.EmitOrLog(r.Context(), d.Repo.Pool,
		"segment.update", "segment", s.ID,
		before, s, nil)
	// A redefinition (rules or archive scope) cleared the stored size; so does a
	// segment that was never counted. Re-count now rather than show a blank.
	if s.LastEvaluatedAt == nil {
		d.evaluateSaved(r.Context(), t.ID, s)
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("segment", s.ID, s.UpdatedAt))
	writeJSON(w, http.StatusOK, s)
}

func segmentUpdateValidationResolver(base SegmentResolver, tenantID, segmentID string, proposed json.RawMessage) SegmentResolver {
	proposed = append(json.RawMessage(nil), proposed...)
	return SegmentResolverFunc(func(ctx context.Context, requestedTenantID, requestedSegmentID string) (json.RawMessage, error) {
		if requestedTenantID == tenantID && requestedSegmentID == segmentID {
			return append(json.RawMessage(nil), proposed...), nil
		}
		return base.ASTForSegment(ctx, requestedTenantID, requestedSegmentID)
	})
}

// Delete DELETE /api/v1/segments/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	// p5-audit-segments: capture the row pre-delete so the audit
	// `before` payload preserves the AST + name for forensic diffing
	// after the row is gone from `segments`.
	before, _ := d.Repo.Get(r.Context(), t.ID, id)
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		// A refusal is a state the operator can act on, not a server fault: 409
		// with the campaigns to move. It is also not retried by clients, unlike
		// the 500 it replaces. Nothing was deleted, so nothing is audited.
		var inUse *SegmentInUseError
		if errors.As(err, &inUse) {
			httperror.Write(w, http.StatusConflict, "segment_in_use", inUse.Message())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), d.Repo.Pool,
		"segment.delete", "segment", id,
		before, nil, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Preview POST /api/v1/segments/preview — compiles the AST and returns only
// aggregate audience evidence. Compiled SQL and subscriber identities never
// cross this boundary.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in PreviewRequest
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.QueryAST) == 0 {
		httperror.Write(w, http.StatusBadRequest, "missing_ast", "queryAst required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()
	// Definition previews exclude archived profiles by default. Pinning a
	// target channel deliberately switches the question to activation
	// eligibility (enabled + non-archived + channel consent).
	scope := DefinitionPopulation(in.IncludeArchived)
	if strings.TrimSpace(in.TargetChannel) != "" {
		channel, channelErr := validatedActivationChannel(ActivationChannel(in.TargetChannel))
		if channelErr != nil {
			httperror.WriteValidation(w, "bad_target_channel", channelErr.Error())
			return
		}
		if in.IncludeArchived {
			httperror.WriteValidation(w, "incompatible_scope", "activation previews cannot include archived subscribers")
			return
		}
		scope = ActivationPopulation(channel)
	}
	predicate, err := CompilePopulation(ctx, in.QueryAST, t.ID, d.Repo, scope)
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}
	count, total, err := d.Repo.CountWithWorkspaceTotal(ctx, t.ID, predicate.SQL, predicate.Args, in.IncludeArchived)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, PreviewResponse{
		Count:               count,
		WorkspaceTotal:      total,
		WorkspacePercentage: workspacePercentage(count, total),
		GeneratedAt:         time.Now().UTC(),
		ArchiveScope:        previewArchiveScope(in.IncludeArchived),
		AppliedExclusions:   previewAppliedExclusions(in.IncludeArchived, in.TargetChannel),
	})
}

func previewAudienceFragment(fragment string, includeArchived bool) string {
	if includeArchived {
		return fragment
	}
	return "(" + fragment + ") AND subscribers.archived_at IS NULL"
}

func previewArchiveScope(includeArchived bool) string {
	if includeArchived {
		return "including_archived"
	}
	return "active_only"
}

func previewAppliedExclusions(includeArchived bool, targetChannel string) []string {
	exclusions := make([]string, 0, 3)
	if !includeArchived {
		exclusions = append(exclusions, "archived_subscribers")
	}
	if channel := strings.ToLower(strings.TrimSpace(targetChannel)); channel != "" {
		exclusions = append(exclusions, "non_enabled_subscribers")
		exclusions = append(exclusions, "missing_"+channel+"_marketing_consent")
	}
	return exclusions
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
