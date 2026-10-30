package subscribers

// SUB-070 — Right-to-explanation for automated decisions (EU AI Act Art. 86).
//
// A data subject has a right to understand WHY an automated system placed
// them in a segment or included them in a campaign. This file is the
// read/write API surface over subscriber_decision_explanations (migration
// 0951) PLUS a live "segment membership + why" computation that compiles each
// leaf condition of a segment's QueryAST and tests it against the one
// subscriber — producing "matched 3 of 5 conditions in 'High-Engagement'"
// without a stored snapshot.
//
// Wire surface:
//
//	GET  /api/v1/subscribers/{id}/decision-explanations   read  — stored snapshots
//	POST /api/v1/subscribers/{id}/decision-explanations   write — admin records one
//	GET  /api/v1/subscribers/{id}/segment-membership      read  — live segments + why
//
// The stored-snapshot table mirrors migration 0266's ai_explainability_records
// pattern but for behavioural (segment / campaign) decisions rather than LLM
// summaries. The live segment-membership endpoint is the headline
// right-to-explanation surface: it enumerates the tenant's segments, and for
// each one whose root is an AND/OR of leaf conditions, reports which conditions
// the subscriber matched and a human-readable reason per condition.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// DecisionType is the migration-0951 decision_type taxonomy.
const (
	DecisionTypeSegment  = "segment"
	DecisionTypeCampaign = "campaign"
)

// ValidDecisionType reports whether v matches the migration-0951 CHECK.
func ValidDecisionType(v string) bool {
	return v == DecisionTypeSegment || v == DecisionTypeCampaign
}

// GetDecisionExplanations returns every stored decision explanation for one
// subscriber (newest first). Returns ErrNotFound when the subscriber does not
// exist; an empty Items list when none have been recorded.
func (r *Repo) GetDecisionExplanations(ctx context.Context, tenantID, subscriberID string) (*DecisionExplanationList, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := &DecisionExplanationList{SubscriberID: sub.ID, Items: []DecisionExplanation{}}
	rows, err := tx.Query(ctx, `
SELECT id::text, decision_type, target_id::text, reasoning_snapshot, created_at, updated_at
  FROM subscriber_decision_explanations
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY created_at DESC`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d DecisionExplanation
		var snapRaw []byte
		if err := rows.Scan(&d.ID, &d.DecisionType, &d.TargetID, &snapRaw, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		d.SubscriberID = sub.ID
		d.ReasoningSnapshot = map[string]any{}
		if len(snapRaw) > 0 {
			if err := json.Unmarshal(snapRaw, &d.ReasoningSnapshot); err != nil {
				return nil, fmt.Errorf("decode reasoning_snapshot: %w", err)
			}
		}
		out.Items = append(out.Items, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RecordDecisionExplanation upserts one decision explanation (admin path /
// automation hook). Replaces in place per (subscriber, decision_type,
// target_id) via the migration-0951 unique constraint. Returns the refreshed
// list view.
func (r *Repo) RecordDecisionExplanation(ctx context.Context, tenantID, subscriberID string, in RecordDecisionExplanationInput) (*DecisionExplanationList, error) {
	if !ValidDecisionType(in.DecisionType) {
		return nil, fmt.Errorf("%w: invalid decision_type %q", ErrInvalidInput, in.DecisionType)
	}
	if strings.TrimSpace(in.TargetID) == "" {
		return nil, fmt.Errorf("%w: target_id is required", ErrInvalidInput)
	}
	snapRaw := []byte("{}")
	if in.ReasoningSnapshot != nil {
		b, err := json.Marshal(in.ReasoningSnapshot)
		if err != nil {
			return nil, fmt.Errorf("%w: reasoning_snapshot not JSON-serialisable", ErrInvalidInput)
		}
		snapRaw = b
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_decision_explanations
  (tenant_id, subscriber_id, decision_type, target_id, reasoning_snapshot, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb, now(), now())
ON CONFLICT (tenant_id, subscriber_id, decision_type, target_id) DO UPDATE
   SET reasoning_snapshot = EXCLUDED.reasoning_snapshot,
       updated_at         = now()`,
		tenantID, sub.ID, in.DecisionType, in.TargetID, snapRaw)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetDecisionExplanations(ctx, tenantID, sub.ID)
}

// GetSegmentMembership computes, live, which of the tenant's segments the
// subscriber currently belongs to and WHY. For each segment whose root op is
// AND/OR of leaf conditions, it tests every leaf condition against the
// subscriber and reports "matched N of M". A segment is reported as a member
// only when its full compiled predicate matches the subscriber.
func (r *Repo) GetSegmentMembership(ctx context.Context, tenantID, subscriberID string) (*SegmentMembershipResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT id::text, name, query_ast
  FROM segments
 WHERE tenant_id = $1::uuid
 ORDER BY name ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	type seg struct {
		id   string
		name string
		ast  json.RawMessage
	}
	segList := []seg{}
	for rows.Next() {
		var s seg
		if err := rows.Scan(&s.id, &s.name, &s.ast); err != nil {
			rows.Close()
			return nil, err
		}
		segList = append(segList, s)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	out := &SegmentMembershipResponse{SubscriberID: sub.ID, Segments: []SegmentMembership{}}
	resolver := segments.TransactionSegmentResolver{Queryer: tx}
	for _, s := range segList {
		conds, err := compileLeafConditions(ctx, tenantID, resolver, s.ast)
		if err != nil {
			return nil, fmt.Errorf("compile segment %s explanation: %w", s.id, err)
		}
		matched := 0
		condResults := make([]SegmentConditionResult, 0, len(conds))
		for _, lc := range conds {
			ok, matchErr := subscriberMatchesFragment(ctx, tx, tenantID, sub.ID, lc.frag, lc.args)
			if matchErr != nil {
				return nil, fmt.Errorf("evaluate segment %s condition: %w", s.id, matchErr)
			}
			if ok {
				matched++
			}
			condResults = append(condResults, SegmentConditionResult{
				Field:       lc.field,
				Comparator:  lc.comparator,
				Value:       lc.value,
				Matched:     ok,
				Description: lc.describe(ok),
			})
		}
		// Full-predicate membership.
		predicate, compileErr := segments.CompilePopulation(ctx, s.ast, tenantID, resolver, segments.DefinitionPopulation(false))
		if compileErr != nil {
			return nil, fmt.Errorf("compile segment %s membership: %w", s.id, compileErr)
		}
		isMember, matchErr := subscriberMatchesFragment(ctx, tx, tenantID, sub.ID, predicate.SQL, predicate.Args)
		if matchErr != nil {
			return nil, fmt.Errorf("evaluate segment %s membership: %w", s.id, matchErr)
		}
		summary := fmt.Sprintf("matched %d of %d conditions in %q", matched, len(conds), s.name)
		out.Segments = append(out.Segments, SegmentMembership{
			SegmentID:       s.id,
			SegmentName:     s.name,
			IsMember:        isMember,
			MatchedCount:    matched,
			TotalConditions: len(conds),
			Summary:         summary,
			Conditions:      condResults,
		})
	}
	return out, tx.Commit(ctx)
}

// leafCondition is one compiled leaf of a segment AST plus its human-readable
// parts for the explanation panel.
type leafCondition struct {
	field      string
	comparator string
	value      string
	rawValue   json.RawMessage
	frag       string
	args       []any
}

func (lc leafCondition) describe(matched bool) string {
	verb := "does not match"
	if matched {
		verb = "matches"
	}
	c := humanComparator(lc.comparator)
	if lc.value == "" {
		return fmt.Sprintf("%s %s %s", lc.field, c, verb)
	}
	return fmt.Sprintf("%s %s %s — %s", lc.field, c, lc.value, verb)
}

// humanComparator maps an AST comparator token to a readable phrase.
func humanComparator(c string) string {
	switch strings.ToLower(c) {
	case "equals", "=":
		return "is"
	case "not_equals", "!=":
		return "is not"
	case "contains":
		return "contains"
	case "not_contains":
		return "does not contain"
	case "starts_with":
		return "starts with"
	case "ends_with":
		return "ends with"
	case "gt", ">":
		return "is greater than"
	case "gte", ">=":
		return "is at least"
	case "lt", "<":
		return "is less than"
	case "lte", "<=":
		return "is at most"
	case "in":
		return "is one of"
	case "not_in":
		return "is none of"
	default:
		return c
	}
}

// astLeaf is the minimal subset of the segment AST node the leaf walker reads.
type astLeaf struct {
	Op         string          `json:"op"`
	Children   []astLeaf       `json:"children,omitempty"`
	Child      *astLeaf        `json:"child,omitempty"`
	Field      string          `json:"field,omitempty"`
	Comparator string          `json:"comparator,omitempty"`
	Value      json.RawMessage `json:"value,omitempty"`
}

// extractLeafConditions walks a segment AST and returns every leaf condition.
// NOT-wrapped subtrees are walked
// without inverting — the panel reports the raw leaf result and the field's
// human reason; full membership is still computed from the whole predicate.
func extractLeafConditions(raw json.RawMessage) []leafCondition {
	var root astLeaf
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil
	}
	out := []leafCondition{}
	var walk func(n astLeaf)
	walk = func(n astLeaf) {
		switch strings.ToLower(n.Op) {
		case "and", "or":
			for _, ch := range n.Children {
				walk(ch)
			}
		case "not":
			if n.Child != nil {
				walk(*n.Child)
			} else if len(n.Children) > 0 {
				walk(n.Children[0])
			}
		case "condition":
			out = append(out, leafCondition{
				field:      n.Field,
				comparator: n.Comparator,
				value:      decodeASTValue(n.Value),
				rawValue:   append(json.RawMessage(nil), n.Value...),
			})
		}
	}
	walk(root)
	return out
}

// compileLeafConditions applies the same resolver-aware, non-archived
// definition contract as full membership to every isolated leaf. This keeps
// composed segment predicates explainable and makes evaluator failures
// explicit rather than rendering a false "does not match" result.
func compileLeafConditions(ctx context.Context, tenantID string, resolver segments.SegmentResolver, raw json.RawMessage) ([]leafCondition, error) {
	conditions := extractLeafConditions(raw)
	for i := range conditions {
		single, err := json.Marshal(map[string]any{
			"op":         "condition",
			"field":      conditions[i].field,
			"comparator": conditions[i].comparator,
			"value":      conditions[i].rawValue,
		})
		if err != nil {
			return nil, err
		}
		predicate, err := segments.CompilePopulation(ctx, single, tenantID, resolver, segments.DefinitionPopulation(false))
		if err != nil {
			return nil, err
		}
		conditions[i].frag = predicate.SQL
		conditions[i].args = predicate.Args
	}
	return conditions, nil
}

// decodeASTValue renders an AST condition value as a short display string.
func decodeASTValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

// subscriberMatchesFragment tests whether one subscriber satisfies a compiled
// segment SQL fragment. Returns false (no error) for an empty fragment so a
// condition that didn't compile is reported as "not matched" rather than
// failing the whole panel.
func subscriberMatchesFragment(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, frag string, args []any) (bool, error) {
	if strings.TrimSpace(frag) == "" {
		return false, nil
	}
	// $1 = tenant_id, $2 = subscriber_id, $3.. = the fragment's own args. The
	// fragment was compiled with $1-based placeholders for ITS args, so shift
	// them by 2 to sit after our two leading params.
	shifted := shiftPlaceholders(frag, 2)
	sql := "SELECT EXISTS (SELECT 1 FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid AND (" + shifted + "))"
	full := append([]any{tenantID, subscriberID}, args...)
	var ok bool
	if err := tx.QueryRow(ctx, sql, full...).Scan(&ok); err != nil {
		return false, err
	}
	return ok, nil
}

// placeholderRe matches a $N positional parameter (whole number run).
var placeholderRe = regexp.MustCompile(`\$(\d+)`)

// shiftPlaceholders rewrites every $N placeholder in a SQL fragment to $(N+by)
// so a fragment compiled with its own $1-based numbering can be spliced after
// `by` leading parameters. Uses a single regexp pass over the full $N token so
// $10 is rewritten as one unit (never matched as $1 followed by 0).
func shiftPlaceholders(frag string, by int) string {
	if by == 0 {
		return frag
	}
	return placeholderRe.ReplaceAllStringFunc(frag, func(m string) string {
		n, err := strconv.Atoi(m[1:])
		if err != nil {
			return m
		}
		return fmt.Sprintf("$%d", n+by)
	})
}

// MountDecisionExplanationRoutes registers the SUB-070 right-to-explanation
// endpoints. The two GETs are read-scoped; the record POST is write-scoped.
func MountDecisionExplanationRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/decision-explanations", d.GetDecisionExplanations)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/decision-explanations", d.RecordDecisionExplanation)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/segment-membership", d.GetSegmentMembership)
}

// GetDecisionExplanations GET /api/v1/subscribers/{id}/decision-explanations
func (d *Deps) GetDecisionExplanations(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetDecisionExplanations(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RecordDecisionExplanation POST /api/v1/subscribers/{id}/decision-explanations
func (d *Deps) RecordDecisionExplanation(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in RecordDecisionExplanationInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.RecordDecisionExplanation(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.decision_explanation.recorded", map[string]any{"id": out.SubscriberID})
	writeJSON(w, http.StatusCreated, out)
}

// GetSegmentMembership GET /api/v1/subscribers/{id}/segment-membership
func (d *Deps) GetSegmentMembership(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetSegmentMembership(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
