package handlers

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const auditChainLimit = 500

// What happened when the operator clicked that.
//
// One request writes audit rows across several of the 35 audit tables — the
// mutation, an approval decision, an entitlement check, an outbox dispatch —
// and nothing said they belonged together. Read individually they are 35
// answers to questions nobody asked. The question asked during an incident is
// about a single moment, and reconstructing it meant eyeballing timestamps and
// hoping no two operators acted in the same second.
//
// The id already existed: chi generates one per request and the logger prints
// it, so it is the id an engineer already has in hand from a log line. It is
// now stamped into `audit_log.metadata.correlation_id`, and this returns the
// chain for it.
//
// Ordered ASCENDING, unlike every other audit read here. This is a NARRATIVE —
// what happened, then what happened next — and the reverse-chronological order
// that suits a feed makes a causal chain read backwards.

// chainRequestID reads the {requestId} path param as the server actually
// receives it. Extracted from AuditChain so a test can exercise the REAL
// decode through a real chi router without a database — the decode is the part
// a client has to get right, and the part whose failure is silent.
//
// See the block comment inside AuditChain for why the decode exists at all.
func chainRequestID(r *http.Request) string {
	raw := chi.URLParam(r, "requestId")
	if unescaped, err := url.PathUnescape(raw); err == nil {
		raw = unescaped
	}
	return strings.TrimSpace(raw)
}

// AuditChain GET /api/v1/audit/chain/{requestId}
func (h *AuditHandlers) AuditChain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	// THE PARAM ARRIVES PERCENT-ENCODED, and decoding it is not cosmetic — it is
	// the difference between this endpoint answering and silently answering
	// nothing.
	//
	// chi's own request-id generator builds `hostname/b64prefix-000001`
	// (middleware/request_id.go: `prefix = fmt.Sprintf("%s/%s", hostname, ...)`),
	// so every real correlation id contains a literal slash. A client therefore
	// MUST percent-encode it to keep it one path segment, and chi routes on
	// r.URL.RawPath whenever the URL contained an escape — so URLParam hands
	// back `host%2Fb64-000001` still encoded. The SQL below compares that to the
	// stored `host/b64-000001` and matches zero rows.
	//
	// The failure mode is the bad one: not an error, an empty chain. The caller
	// is told this request touched nothing, which is a confident wrong answer to
	// the exact question the endpoint exists for.
	//
	// A decode failure is ignored rather than rejected: chi only consults
	// RawPath when the URL actually contained an escape, so an unescaped id
	// (the "-" sentinel, or an id with no slash) passes through untouched and
	// keeps working.
	requestID := chainRequestID(r)
	if requestID == "" {
		httperror.WriteValidation(w, "missing_request_id",
			"a request id is required; it is the correlation_id on any audit row")
		return
	}
	// An empty correlation_id is written by nothing (audit.Emit omits the key
	// rather than storing ""), but a caller could still ask for one and would
	// otherwise get every row that happens to lack the field.
	if requestID == "-" {
		httperror.WriteValidation(w, "invalid_request_id", "request id is not valid")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// RLS is what enforces the isolation here — the tx runs under
	// db.WithTenant, and removing the predicate below changes nothing
	// observable, which a mutation confirmed. It is kept as defence in depth
	// against a future policy change, NOT because the test proves it: a request
	// id is not a secret (it appears in logs and error responses), so it must
	// never work as a capability across tenants, and one enforcement point for
	// that is worth two.
	const q = `
SELECT id, action, COALESCE(resource_type, ''), COALESCE(resource_id, ''),
       COALESCE(actor_type, ''), COALESCE(actor_label, ''), user_id,
       COALESCE(host(ip), ''), COALESCE(user_agent, ''), metadata, at
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND metadata #>> '{context,correlation_id}' = $2
 ORDER BY id ASC
 LIMIT $3`
	rows, err := tx.Query(r.Context(), q, t.ID, requestID, auditChainLimit+1)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := []auditChainRow{}
	for rows.Next() {
		var ar auditChainRow
		var meta map[string]any
		if err := rows.Scan(&ar.ID, &ar.Action, &ar.ResourceType, &ar.ResourceID,
			&ar.ActorType, &ar.ActorLabel, &ar.UserID, &ar.IP, &ar.UserAgent,
			&meta, &ar.At); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if meta == nil {
			meta = map[string]any{}
		}
		ar.Metadata = meta
		out = append(out, ar)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	out, truncated := finalizeAuditChain(out)
	middleware.RowCounterFromContext(r.Context()).Store(int64(len(out)))

	writeJSON(w, http.StatusOK, map[string]any{
		"requestId": requestID,
		"rows":      out,
		// Stated rather than inferred from len(rows): a chain that hit the cap
		// is a different fact from one that ended, and a reader comparing
		// against 500 would be guessing.
		"truncated": truncated,
	})
}

// finalizeAuditChain removes the look-ahead row. A chain is marked truncated
// only when row 501 exists; exactly 500 rows is a complete chain, not a guess.
func finalizeAuditChain(rows []auditChainRow) ([]auditChainRow, bool) {
	if len(rows) <= auditChainLimit {
		return rows, false
	}
	return rows[:auditChainLimit], true
}

// auditChainRow is deliberately narrower than the feed's row shape: a chain is
// read to understand a sequence, not to drive the slideover's per-row
// affordances (legal hold, retention override, AIVS bundles). Returning those
// here would imply actions this endpoint does not support.
type auditChainRow struct {
	ID           int64          `json:"id"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resourceType"`
	ResourceID   string         `json:"resourceId,omitempty"`
	ActorType    string         `json:"actorType,omitempty"`
	ActorLabel   string         `json:"actorLabel,omitempty"`
	UserID       *string        `json:"userId,omitempty"`
	IP           string         `json:"ip,omitempty"`
	UserAgent    string         `json:"userAgent,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	At           time.Time      `json:"at"`
}
