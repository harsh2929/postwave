package mailchimpv3

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

func (d *Deps) MultiChannelReadiness(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.MultiChannelReadiness(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "multi-channel readiness")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListSocialProviderConnections(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListSocialProviderConnections(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "provider connections")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertSocialProviderConnection(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in SocialProviderConnectionInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Provider) == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Provider is required.")
		return
	}
	out, err := d.Store.UpsertSocialProviderConnection(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "provider connection")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListSocialPosts(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListSocialPosts(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "social posts")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateSocialPost(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in SocialPostInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Text) == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Social post text is required.")
		return
	}
	out, err := d.Store.CreateSocialPost(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "social post")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SocialPostReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.SocialPostReport(r.Context(), t, chi.URLParam(r, "post_id"))
	if err != nil {
		writeStoreError(w, err, "social post report")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListAdCampaigns(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListAdCampaigns(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "ads")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateAdCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in AdCampaignInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Ad campaign name is required.")
		return
	}
	out, err := d.Store.CreateAdCampaign(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "ad campaign")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) AdCampaignReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.AdCampaignReport(r.Context(), t, chi.URLParam(r, "ad_id"))
	if err != nil {
		writeStoreError(w, err, "ad campaign report")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DirectMailStatus(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.DirectMailStatus(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "direct mail")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListSurveys(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListSurveys(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "surveys")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateSurvey(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in SurveyInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.CreateSurvey(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "survey")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SurveyReport(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.SurveyReport(r.Context(), t, chi.URLParam(r, "survey_id"))
	if err != nil {
		writeStoreError(w, err, "survey report")
		return
	}
	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="postwave-survey-report.csv"`)
		_, _ = w.Write([]byte(surveyReportCSV(out)))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RecordSurveyResponse(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in SurveyResponseInput
	if !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	if q := r.URL.Query(); len(in.Answers) == 0 && q.Get("question_id") != "" {
		in.Answers = map[string]any{q.Get("question_id"): q.Get("choice")}
		in.Source = "email_poll"
	}
	if len(in.Answers) == 0 {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Survey response answers are required.")
		return
	}
	out, err := d.Store.RecordSurveyResponse(r.Context(), t, chi.URLParam(r, "survey_id"), in)
	if err != nil {
		writeStoreError(w, err, "survey response")
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) PollMergeTags(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	in := PollMergeTagInput{
		SurveyID:   r.URL.Query().Get("survey_id"),
		QuestionID: r.URL.Query().Get("question_id"),
		Choices:    splitCSV(r.URL.Query().Get("choices")),
	}
	if r.Method == http.MethodPost && !decodeOptionalMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.PollMergeTags(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "poll merge tags")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) LandingPageParity(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.LandingPageParity(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "landing page parity")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) WebsiteBuilderStatus(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.WebsiteBuilderStatus(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "website builder status")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListInterestCategories(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListInterestCategories(r.Context(), t, chi.URLParam(r, "list_id"))
	if err != nil {
		writeStoreError(w, err, "interest categories")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListInterests(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListInterests(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "category_id"))
	if err != nil {
		writeStoreError(w, err, "interests")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ContactRating(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ContactRating(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"))
	if err != nil {
		writeStoreError(w, err, "contact rating")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ContactProfile(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ContactProfile(r.Context(), t, chi.URLParam(r, "list_id"), chi.URLParam(r, "subscriber_hash"))
	if err != nil {
		writeStoreError(w, err, "contact profile")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) AudienceInsights(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	listID := chi.URLParam(r, "list_id")
	if listID == "" {
		listID = t.Slug
	}
	out, err := d.Store.AudienceInsights(r.Context(), t, listID)
	if err != nil {
		writeStoreError(w, err, "audience insights")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) AdvancedSegmentSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	listID := chi.URLParam(r, "list_id")
	if listID == "" {
		listID = t.Slug
	}
	out, err := d.Store.AdvancedSegmentSchema(r.Context(), t, listID)
	if err != nil {
		writeStoreError(w, err, "advanced segment schema")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
