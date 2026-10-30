package views

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type CampaignAssuranceRunLister interface {
	ListCampaignAssuranceRuns(
		context.Context,
		CampaignAssuranceRunFilter,
	) (CampaignAssuranceRunPage, error)
}

type CampaignAssuranceRunDetailer interface {
	CampaignAssuranceRunDetailByID(
		context.Context,
		string,
	) (*CampaignAssuranceRunDetail, error)
}

type CampaignAssuranceRunTimeliner interface {
	CampaignAssuranceRunTimeline(
		context.Context,
		string,
		int64,
		int,
	) (*CampaignAssuranceTimelinePage, error)
}

// CampaignAssuranceRunsHandler serves the content-free, cross-tenant run
// inventory. Every query value is singular and bounded; unknown parameters are
// rejected instead of being silently ignored by this privileged surface.
func CampaignAssuranceRunsHandler(lister CampaignAssuranceRunLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if !onlyCampaignAssuranceQueryKeys(query, "tenant_id", "state", "cursor", "limit") {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_query", "Campaign Assurance filters must be singular and supported")
			return
		}
		filter := CampaignAssuranceRunFilter{Limit: defaultViewRows}
		if value, present, ok := singleQueryValue(query, "tenant_id"); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_tenant", "tenant_id must be one canonical non-zero UUID")
			return
		} else if present {
			filter.TenantID, ok = canonicalUUID(value)
			if !ok {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_tenant", "tenant_id must be one canonical non-zero UUID")
				return
			}
		}
		if value, present, ok := singleQueryValue(query, "state"); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_state", "state must be one supported Campaign Assurance state")
			return
		} else if present {
			if value == "" || !validCampaignAssuranceState(value) {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_state", "state must be one supported Campaign Assurance state")
				return
			}
			filter.State = value
		}
		if value, present, ok := singleQueryValue(query, "cursor"); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_cursor", "cursor must be one canonical bounded cursor")
			return
		} else if present {
			if _, cursorOK := decodeCampaignAssuranceCursor(value); !cursorOK {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_cursor", "cursor must be one canonical bounded cursor")
				return
			}
			filter.Cursor = value
		}
		if value, present, ok := singleQueryValue(query, "limit"); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_limit", "limit must be one integer between 1 and 500")
			return
		} else if present {
			limit, err := strconv.Atoi(value)
			if err != nil || limit < 1 || limit > maxViewRows {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_limit", "limit must be one integer between 1 and 500")
				return
			}
			filter.Limit = limit
		}

		page, err := lister.ListCampaignAssuranceRuns(r.Context(), filter)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "assurance_runs_unavailable", "Campaign Assurance runs are unavailable")
			return
		}
		writeViewJSON(w, page)
	}
}

// CampaignAssuranceRunDetailHandler serves one metadata-only support record.
func CampaignAssuranceRunDetailHandler(detailer CampaignAssuranceRunDetailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Query()) != 0 {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_query", "run detail does not accept query parameters")
			return
		}
		runID, ok := canonicalUUID(chi.URLParam(r, "id"))
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_run_id", "run id must be a canonical non-zero UUID")
			return
		}
		detail, err := detailer.CampaignAssuranceRunDetailByID(r.Context(), runID)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "assurance_run_unavailable", "Campaign Assurance run detail is unavailable")
			return
		}
		if detail == nil {
			writeViewError(w, http.StatusNotFound, "assurance_run_not_found", "Campaign Assurance run was not found")
			return
		}
		writeViewJSON(w, detail)
	}
}

// CampaignAssuranceRunTimelineHandler serves database-derived progress events
// only. The extensible progress metadata envelope is absent from the contract.
func CampaignAssuranceRunTimelineHandler(timeliner CampaignAssuranceRunTimeliner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		runID, ok := canonicalUUID(chi.URLParam(r, "id"))
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_run_id", "run id must be a canonical non-zero UUID")
			return
		}
		query := r.URL.Query()
		if !onlyCampaignAssuranceQueryKeys(query, "after", "limit") {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_timeline_query", "timeline filters must be singular and supported")
			return
		}
		after := int64(0)
		if value, present, valueOK := singleQueryValue(query, "after"); !valueOK {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_timeline_cursor", "after must be one non-negative event number")
			return
		} else if present {
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil || parsed < 0 {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_timeline_cursor", "after must be one non-negative event number")
				return
			}
			after = parsed
		}
		limit := defaultViewRows
		if value, present, valueOK := singleQueryValue(query, "limit"); !valueOK {
			writeViewError(w, http.StatusBadRequest, "invalid_assurance_limit", "limit must be one integer between 1 and 500")
			return
		} else if present {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 1 || parsed > maxViewRows {
				writeViewError(w, http.StatusBadRequest, "invalid_assurance_limit", "limit must be one integer between 1 and 500")
				return
			}
			limit = parsed
		}

		page, err := timeliner.CampaignAssuranceRunTimeline(r.Context(), runID, after, limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "assurance_timeline_unavailable", "Campaign Assurance run timeline is unavailable")
			return
		}
		if page == nil {
			writeViewError(w, http.StatusNotFound, "assurance_run_not_found", "Campaign Assurance run was not found")
			return
		}
		writeViewJSON(w, page)
	}
}

func onlyCampaignAssuranceQueryKeys(query map[string][]string, allowed ...string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key, values := range query {
		if _, ok := allowedSet[key]; !ok || len(values) != 1 {
			return false
		}
	}
	return true
}

func singleQueryValue(query map[string][]string, key string) (string, bool, bool) {
	values, present := query[key]
	if !present {
		return "", false, true
	}
	if len(values) != 1 {
		return "", true, false
	}
	return values[0], true, true
}
