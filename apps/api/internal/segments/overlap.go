// SPDX-License-Identifier: AGPL-3.0-only
//
// overlap.go — GET /api/v1/segments/overlap?a=&b= (feat/full-surface-
// wiring task 4). Computes the membership overlap between two saved
// segments:
//
//	{
//	  "a": "<segment-a-id>", "b": "<segment-b-id>",
//	  "a_count": 1200, "b_count": 800,
//	  "intersection": 300, "jaccard": 0.176...
//	}
//
// Membership is computed live: both segments' query_ast are compiled
// via CompileAST and evaluated in ONE bounded pass over subscribers
// using three COUNT(*) FILTER aggregates, so the cost is a single
// sequential/index scan regardless of segment sizes — the same cost
// class as the preview-count chip. The two compiled fragments use
// independent placeholder sequences, so the second fragment's
// placeholders are shifted by len(argsA) before concatenation.

package segments

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// OverlapResponse is the wire shape.
type OverlapResponse struct {
	A            string  `json:"a"`
	B            string  `json:"b"`
	ACount       int64   `json:"a_count"`
	BCount       int64   `json:"b_count"`
	Intersection int64   `json:"intersection"`
	Jaccard      float64 `json:"jaccard"`
}

var placeholderRe = regexp.MustCompile(`\$(\d+)`)

// shiftPlaceholders renumbers $1..$n placeholders in a compiled
// fragment by offset, so two independently-compiled fragments can be
// concatenated into one statement with args = argsA ++ argsB. Safe on
// compiler output: CompileAST parameterises every operator value, so
// the fragment text never contains a literal dollar sign outside a
// placeholder.
// ShiftPlaceholders renumbers a compiler-produced fragment so callers can
// prepend fixed statement arguments (for example tenant_id at $1) without
// aliasing the fragment's own $1 placeholder. CompileAST output is the only
// supported input; arbitrary SQL may contain dollar-quoted text.
func ShiftPlaceholders(frag string, offset int) string {
	if offset == 0 {
		return frag
	}
	return placeholderRe.ReplaceAllStringFunc(frag, func(m string) string {
		n, err := strconv.Atoi(m[1:])
		if err != nil {
			return m
		}
		return "$" + strconv.Itoa(n+offset)
	})
}

func shiftPlaceholders(frag string, offset int) string {
	return ShiftPlaceholders(frag, offset)
}

// jaccard returns |A∩B| / |A∪B| with the 0/0 case pinned to 0.
func jaccard(aCount, bCount, intersection int64) float64 {
	union := aCount + bCount - intersection
	if union <= 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

// SegmentOverlap GET /api/v1/segments/overlap?a=&b=.
func (d *Deps) SegmentOverlap(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	aID := strings.TrimSpace(r.URL.Query().Get("a"))
	bID := strings.TrimSpace(r.URL.Query().Get("b"))
	if aID == "" || bID == "" {
		httperror.WriteValidation(w, "missing_segments", "query params a and b are required")
		return
	}
	if aID == bID {
		httperror.WriteValidation(w, "same_segment", "a and b must be different segments")
		return
	}
	segA, err := d.Repo.Get(r.Context(), t.ID, aID)
	if err != nil {
		writeOverlapLookupErr(w, d, r, t.ID, "a", err)
		return
	}
	segB, err := d.Repo.Get(r.Context(), t.ID, bID)
	if err != nil {
		writeOverlapLookupErr(w, d, r, t.ID, "b", err)
		return
	}
	predicateA, err := CompilePopulation(r.Context(), segA.QueryAST, t.ID, d.Repo, DefinitionPopulation(false))
	if err != nil {
		httperror.WriteValidation(w, "bad_segment_ast", "segment a: "+"request payload is invalid")
		return
	}
	predicateB, err := CompilePopulation(r.Context(), segB.QueryAST, t.ID, d.Repo, DefinitionPopulation(false))
	if err != nil {
		httperror.WriteValidation(w, "bad_segment_ast", "segment b: "+"request payload is invalid")
		return
	}
	fragA, argsA := predicateA.SQL, predicateA.Args
	fragB, argsB := predicateB.SQL, predicateB.Args
	fragB = shiftPlaceholders(fragB, len(argsA))
	args := append(append([]any{}, argsA...), argsB...)

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	out := OverlapResponse{A: aID, B: bID}
	q := fmt.Sprintf(`
SELECT COUNT(*) FILTER (WHERE (%s)),
       COUNT(*) FILTER (WHERE (%s)),
       COUNT(*) FILTER (WHERE (%s) AND (%s))
  FROM subscribers`, fragA, fragB, fragA, fragB)
	if err := tx.QueryRow(r.Context(), q, args...).
		Scan(&out.ACount, &out.BCount, &out.Intersection); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out.Jaccard = jaccard(out.ACount, out.BCount, out.Intersection)
	writeJSON(w, http.StatusOK, out)
}

func writeOverlapLookupErr(w http.ResponseWriter, d *Deps, r *http.Request, tenantID, which string, err error) {
	if err == ErrNotFound {
		httperror.Write(w, http.StatusNotFound, "not_found", "segment "+which+" not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}
