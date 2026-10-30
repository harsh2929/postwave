// SPDX-License-Identifier: AGPL-3.0-only
//
// preview_count.go — fast COUNT(*) for the segment builder + a manual
// recompute trigger. See:
//
//	GAP-LS-078 — preview-count before save: segment builder needs a
//	  lightweight "how many subscribers does this match?" check while
//	  editing rule rows, before the operator commits the segment via
//	  POST /api/v1/segments. The existing /segments/preview endpoint
//	  also returns a count but is keyed on a stored segment id; this
//	  handler accepts either a raw AST or a NL text query and runs the
//	  compiler in-process before SELECT COUNT(*).
//
//	GAP-LS-079 — manual recompute: today last_count / last_evaluated_at
//	  only update via the preview path. Surface an explicit
//	  /segments/{id}/recompute the dashboard can wire to a refresh
//	  button so an operator can force a re-evaluation without having to
//	  reopen the editor.
//
// Both routes are mounted from handlers.go::Mount so the standard
// scope + tenant middleware chain applies.
package segments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments/predicates"
)

// previewCountTimeout caps the count query so a pathological predicate
// (e.g. an unindexed JSONB scan over millions of rows) cannot stall the
// editor. 10s matches the docs/gap promise.
const previewCountTimeout = 10 * time.Second

// PreviewCountRequest is the body of POST /api/v1/segments/preview-count.
// Callers MAY supply either a compiled AST (preferred — what the
// visual builder produces) or a free-text description (the NL helper
// surface). If both are present QueryAST wins, since the text compiler
// is best-effort.
type PreviewCountRequest struct {
	QueryAST json.RawMessage `json:"queryAst,omitempty"`
	Text     string          `json:"text,omitempty"`
	// TargetChannel (SUB-051), when set to email/sms/push, ANDs a
	// channel-consent gate onto the compiled predicate so the preview
	// count reflects what the send-guard will actually deliver: profiles
	// lacking marketing consent for that channel are auto-excluded.
	// Empty (the default) preserves the historic behaviour — no consent
	// gate, byte-identical to the pre-SUB-051 count.
	TargetChannel string `json:"target_channel,omitempty"`
}

// channelConsentGate returns a static, arg-free SQL fragment that is TRUE
// only for subscribers who can receive marketing on `channel`
// (email/sms/push). Empty channel returns ("", nil) — no gate. An
// unsupported channel string returns an error so a typo'd target_channel
// surfaces as a 4xx rather than silently disabling the gate.
//
// Reuses the same predicates.CompileChannelConsent the segment AST
// compiler routes channel_consent.* through, so the activation-time
// auto-exclude and the builder predicate share one definition.
func channelConsentGate(channel string) (string, error) {
	if channel == "" {
		return "", nil
	}
	frag, err := predicates.CompileChannelConsent(predicates.ChannelConsentInput{
		Channel:    channel,
		CanReceive: true,
	})
	if err != nil {
		return "", err
	}
	return frag.SQL, nil
}

// ChannelConsentGate is the exported entry point to the SUB-051
// channel-consent gate. It returns a static, arg-free SQL fragment that
// is TRUE only for subscribers who can receive marketing on `channel`
// (email/sms/push); an empty channel yields ("", nil) — no gate. The
// campaigns send/queue path (campaigns.Repo.AudienceEmails) ANDs this
// onto the recipient query so the activation-time audience matches the
// segment-builder preview: profiles whose consent vector for the target
// channel is NULL (never granted, or revoked via a GPC / opt-out
// consent_events row that the 0318 trigger projected to NULL) are
// excluded. Sharing this one definition with the segment compiler keeps
// the preview count and the delivered set byte-identical.
func ChannelConsentGate(channel string) (string, error) {
	return channelConsentGate(channel)
}

// applyChannelConsent ANDs the channel-consent gate for `channel` onto an
// already-compiled WHERE fragment. The compiled fragment's args are
// untouched (the gate is arg-free), so the placeholder numbering stays
// valid. Empty channel is a no-op (returns frag unchanged).
func applyChannelConsent(frag, channel string) (string, error) {
	gate, err := channelConsentGate(channel)
	if err != nil {
		return "", err
	}
	if gate == "" {
		return frag, nil
	}
	return "(" + frag + ") AND (" + gate + ")", nil
}

// PreviewCountResponse mirrors the contract the dashboard preview chip
// reads: a raw count, the wall-clock cost, and a capped flag so the UI
// can render "10,000+" instead of an exact number when we ran into the
// timeout.
type PreviewCountResponse struct {
	Count        int  `json:"count"`
	ComputedInMs int  `json:"computed_in_ms"`
	Capped       bool `json:"capped"`
}

// RecomputeResponse is the wire shape for POST /segments/{id}/recompute.
// scheduled_at is the timestamp we kicked off the work; for the
// synchronous implementation it equals the moment we started the count.
type RecomputeResponse struct {
	ScheduledAt time.Time `json:"scheduled_at"`
	Count       int       `json:"count"`
}

// PreviewCount POST /api/v1/segments/preview-count.
func (d *Deps) PreviewCount(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PreviewCountRequest
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	ast := in.QueryAST
	if len(ast) == 0 && in.Text != "" {
		compiled, _, _, terr := compileText(in.Text)
		if terr != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_text", terr.Error())
			return
		}
		buf, err := json.Marshal(compiled)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		ast = buf
	}
	if len(ast) == 0 {
		httperror.WriteValidation(w, "missing_input", "queryAst or text required")
		return
	}

	scope := DefinitionPopulation(false)
	if in.TargetChannel != "" {
		channel, channelErr := validatedActivationChannel(ActivationChannel(in.TargetChannel))
		if channelErr != nil {
			httperror.WriteValidation(w, "bad_target_channel", channelErr.Error())
			return
		}
		scope = ActivationPopulation(channel)
	}
	predicate, err := CompilePopulation(r.Context(), ast, t.ID, d.Repo, scope)
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()

	start := time.Now()
	n, err := d.Repo.Count(ctx, t.ID, predicate.SQL, predicate.Args)
	elapsed := time.Since(start)
	if err != nil {
		// A deadline trip is the documented capped case — surface
		// the partial response so the UI can render "10,000+" rather
		// than a hard error.
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeJSON(w, http.StatusOK, PreviewCountResponse{
				Count:        0,
				ComputedInMs: int(elapsed.Milliseconds()),
				Capped:       true,
			})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, PreviewCountResponse{
		Count:        n,
		ComputedInMs: int(elapsed.Milliseconds()),
		Capped:       false,
	})
}

// Recompute POST /api/v1/segments/{id}/recompute. Runs the existing
// AST compiler against the segment's stored query and refreshes
// last_count + last_evaluated_at. Implemented synchronously since the
// compiler already runs in-process and the count is the same cost we
// already pay on /preview.
func (d *Deps) Recompute(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "segment id required")
		return
	}

	seg, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	// Recompute the stored last_count under the segment's persisted archive
	// scope (SEG-034) so the list figure matches what the definition saved.
	predicate, err := CompilePopulation(r.Context(), seg.QueryAST, t.ID, d.Repo, DefinitionPopulation(seg.IncludeArchived))
	if err != nil {
		httperror.WriteValidation(w, "bad_ast", "request payload is invalid")
		return
	}

	scheduledAt := time.Now().UTC()

	ctx, cancel := context.WithTimeout(r.Context(), previewCountTimeout)
	defer cancel()

	n, err := d.Repo.Count(ctx, t.ID, predicate.SQL, predicate.Args)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Recorded against the version that was counted: when a concurrent save
	// redefined the segment meanwhile, the count still answers this request but
	// is not stored as the new definition's size.
	if _, err := d.Repo.RecordEvaluation(r.Context(), t.ID, id, seg.UpdatedAt, n); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	writeJSON(w, http.StatusAccepted, RecomputeResponse{
		ScheduledAt: scheduledAt,
		Count:       n,
	})
}
