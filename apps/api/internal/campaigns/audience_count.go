// SPDX-License-Identifier: AGPL-3.0-only
//
// G6 (campaigns 2026): audience count preview for the compose audience
// picker. Counts a list or segment, minus any excluded lists/segments,
// so the editor can show "12,168 will receive this" live as the
// operator builds the audience. Both counts are of subscribers who would
// actually be sent to — the activation predicate queue-fill and
// send-preview apply — so the number beside the picker is the number the
// send review shows.
//
// Exclusion is a count-level subtraction (base − Σ excluded), not a true
// set difference, so deliverable is reported as an estimate alongside the
// exact base + excluded figures.

package campaigns

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// AudienceCountDeps bundles the counter + logger for the count endpoint.
type AudienceCountDeps struct {
	Audience AudienceCounter
	Logger   *slog.Logger
}

// AudienceCountInput selects the base audience + exclusions.
type AudienceCountInput struct {
	ListID            string   `json:"list_id,omitempty"`
	SegmentID         string   `json:"segment_id,omitempty"`
	ExcludeListIDs    []string `json:"exclude_list_ids,omitempty"`
	ExcludeSegmentIDs []string `json:"exclude_segment_ids,omitempty"`
}

// AudienceCountResult is the count breakdown.
type AudienceCountResult struct {
	Base        int64  `json:"base"`
	Excluded    int64  `json:"excluded"`
	Deliverable int64  `json:"deliverable"` // estimate: max(0, base - excluded)
	Kind        string `json:"kind"`        // list | segment
}

// MountAudienceCount wires POST /api/v1/audiences/count.
func MountAudienceCount(r chi.Router, d *AudienceCountDeps) {
	if d == nil || d.Audience == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Post("/api/v1/audiences/count", d.count)
}

func (d *AudienceCountDeps) count(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in AudienceCountInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.ListID == "" && in.SegmentID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_audience",
			"list_id or segment_id is required"))
		return
	}
	if in.ListID != "" && in.SegmentID != "" {
		writeJSON(w, http.StatusBadRequest, errEnv("ambiguous_audience",
			"provide exactly one of list_id or segment_id"))
		return
	}

	var out AudienceCountResult
	var err error
	if in.ListID != "" {
		out.Kind = "list"
		out.Base, err = d.Audience.CountListAudience(r.Context(), t.ID, in.ListID)
	} else {
		out.Kind = "segment"
		out.Base, err = d.Audience.CountSegmentAudience(r.Context(), t.ID, in.SegmentID)
	}
	if err != nil {
		d.writeCountError(w, r, err)
		return
	}

	for _, id := range in.ExcludeListIDs {
		if id == "" {
			continue
		}
		n, e := d.Audience.CountListAudience(r.Context(), t.ID, id)
		if e != nil {
			d.writeCountError(w, r, e)
			return
		}
		out.Excluded += n
	}
	for _, id := range in.ExcludeSegmentIDs {
		if id == "" {
			continue
		}
		n, e := d.Audience.CountSegmentAudience(r.Context(), t.ID, id)
		if e != nil {
			d.writeCountError(w, r, e)
			return
		}
		out.Excluded += n
	}
	out.Deliverable = out.Base - out.Excluded
	if out.Deliverable < 0 {
		out.Deliverable = 0
	}
	writeJSON(w, http.StatusOK, out)
}

// writeCountError answers a count for a list or segment this workspace does
// not have with the same 422 codes a campaign save and a send use. It used to
// be a 500 "internal error", which the editor could only render as "the count
// failed" — for a list that will never count, because it isn't there.
func (d *AudienceCountDeps) writeCountError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrAudienceListNotFound):
		httperror.Write(w, http.StatusUnprocessableEntity, "list_not_found", audienceListNotFoundMessage)
	case errors.Is(err, ErrSegmentNotFound), errors.Is(err, segments.ErrNotFound):
		httperror.Write(w, http.StatusUnprocessableEntity, "segment_not_found", audienceSegmentNotFoundMessage)
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}
