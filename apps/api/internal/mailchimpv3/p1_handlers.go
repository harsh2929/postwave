package mailchimpv3

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

func (d *Deps) CampaignPlanner(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var q PlannerQuery
	if start, ok := parseReportDate(r.URL.Query().Get("start")); ok {
		q.Start = start
	}
	if end, ok := parseReportDate(r.URL.Query().Get("end")); ok {
		q.End = end
	}
	out, err := d.Store.CampaignPlanner(r.Context(), t, q)
	if err != nil {
		writeStoreError(w, err, "campaign planner")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetMultivariateTest(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetMultivariateTest(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "multivariate test")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertMultivariateTest(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in MultivariateTestInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if len(in.Variations) < 2 || len(in.Variations) > 8 {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "multivariate tests require 2 to 8 variations")
		return
	}
	out, err := d.Store.UpsertMultivariateTest(r.Context(), t, chi.URLParam(r, "campaign_id"), in)
	if err != nil {
		writeStoreError(w, err, "multivariate test")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SendTimeOptimization(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.SendTimeOptimization(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "send time optimization")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SendDayOptimization(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.SendDayOptimization(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "send day optimization")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ClickMap(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ClickMap(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "click map")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CustomReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	in := CustomReportInput{
		View:      r.URL.Query().Get("view"),
		Metrics:   splitCSV(r.URL.Query().Get("metrics")),
		GroupBy:   splitCSV(r.URL.Query().Get("group_by")),
		StartDate: r.URL.Query().Get("start_date"),
		EndDate:   r.URL.Query().Get("end_date"),
		Format:    r.URL.Query().Get("format"),
		Filters:   map[string]string{},
	}
	if campaignID := strings.TrimSpace(r.URL.Query().Get("campaign_id")); campaignID != "" {
		in.Filters["campaign_id"] = campaignID
	}
	if eventType := strings.TrimSpace(r.URL.Query().Get("event_type")); eventType != "" {
		in.Filters["event_type"] = eventType
	}
	for _, key := range []string{"channel", "device", "country", "client", "source"} {
		if v := strings.TrimSpace(r.URL.Query().Get(key)); v != "" {
			in.Filters[key] = v
		}
	}
	if r.Method == http.MethodPost {
		if !decodeOptionalMailchimpJSON(w, r, &in) {
			return
		}
	}
	out, err := d.Store.CustomReport(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "custom report")
		return
	}
	if strings.EqualFold(in.Format, "csv") || strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="postwave-custom-report.csv"`)
		_, _ = w.Write([]byte(customReportCSV(out)))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeliveryInsights(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.DeliveryInsights(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "delivery insights")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CancelDelivery(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.CancelDelivery(r.Context(), t, chi.URLParam(r, "campaign_id"))
	if err != nil {
		writeStoreError(w, err, "delivery cancellation")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CampaignInbox(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.CampaignInbox(
		r.Context(),
		t,
		chi.URLParam(r, "campaign_id"),
		intQuery(r, "offset", 0),
		intQuery(r, "count", 50),
	)
	if err != nil {
		writeStoreError(w, err, "campaign inbox")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func splitCSV(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}
