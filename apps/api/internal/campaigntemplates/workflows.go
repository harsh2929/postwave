// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxReferenceTemplates = 3

const (
	reviewedDesignMaxSubjectRunes       = 998
	reviewedDesignMaxPreviewRunes       = 500
	reviewedDesignMaxTaxonomyRunes      = 120
	reviewedDesignMaxBodyBytes          = 1 << 20
	reviewedDesignMaxCombinedBodyBytes  = 1536 << 10
	reviewedDesignMaxVariables          = 100
	reviewedDesignMaxVariableValueRunes = 4096
	reviewedDesignMaxVariablesJSONBytes = 64 << 10
)

var placeholderRE = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}`)
var reviewedVariableNameRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

type CampaignCreator interface {
	Create(context.Context, string, campaigns.CreateInput) (*campaigns.Campaign, error)
}

type AdaptInput struct {
	Instructions         string         `json:"instructions,omitempty"`
	Tone                 string         `json:"tone,omitempty"`
	Name                 string         `json:"name,omitempty"`
	Subject              string         `json:"subject,omitempty"`
	Brand                map[string]any `json:"brand,omitempty"`
	Content              map[string]any `json:"content,omitempty"`
	Variables            map[string]any `json:"variables,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
}

type GenerateInput struct {
	Brief                string         `json:"brief"`
	Kind                 string         `json:"kind,omitempty"`
	Tone                 string         `json:"tone,omitempty"`
	Name                 string         `json:"name,omitempty"`
	Goal                 string         `json:"goal,omitempty"`
	Category             string         `json:"category,omitempty"`
	Subject              string         `json:"subject,omitempty"`
	PreviewText          string         `json:"preview_text,omitempty"`
	Audience             string         `json:"audience,omitempty"`
	Industry             string         `json:"industry,omitempty"`
	Style                string         `json:"style,omitempty"`
	Layout               string         `json:"layout,omitempty"`
	Brand                map[string]any `json:"brand,omitempty"`
	Content              map[string]any `json:"content,omitempty"`
	Variables            map[string]any `json:"variables,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
}

// SaveGeneratedDesignInput is the narrow contract for persisting a design the
// user has already reviewed. It deliberately contains no provenance, review,
// license, quality, import, or generation-metadata fields: those are stamped
// below after every reference has been resolved through the eligibility gate.
type SaveGeneratedDesignInput struct {
	Slug                 string         `json:"slug"`
	Name                 string         `json:"name"`
	Subject              string         `json:"subject"`
	PreviewText          string         `json:"preview_text,omitempty"`
	BodyHTML             string         `json:"body_html"`
	BodyMJML             string         `json:"body_mjml,omitempty"`
	Category             string         `json:"category,omitempty"`
	Goal                 string         `json:"goal,omitempty"`
	Industry             string         `json:"industry,omitempty"`
	Style                string         `json:"style,omitempty"`
	Layout               string         `json:"layout,omitempty"`
	Variables            map[string]any `json:"variables,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
}

type DesignResponse struct {
	Name                 string         `json:"name"`
	Subject              string         `json:"subject"`
	PreviewText          string         `json:"preview_text,omitempty"`
	BodyHTML             string         `json:"body_html"`
	BodyMJML             string         `json:"body_mjml,omitempty"`
	Variables            map[string]any `json:"variables,omitempty"`
	UnresolvedVariables  []string       `json:"unresolved_variables"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids"`
	Warnings             []string       `json:"warnings"`
}

// AudienceListID accepts Listmonk's native integer JSON shape as well as the
// string form used by existing desktop/API clients, without converting
// through float64 and losing precision.
type AudienceListID string

func (id *AudienceListID) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		*id = ""
		return nil
	}
	if strings.HasPrefix(raw, `"`) {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		*id = AudienceListID(value)
		return nil
	}
	if _, err := strconv.ParseInt(raw, 10, 64); err != nil {
		return fmt.Errorf("list_id must be an integer or integer string")
	}
	*id = AudienceListID(raw)
	return nil
}

type FromTemplateInput struct {
	TemplateID  string         `json:"template_id"`
	Name        string         `json:"name,omitempty"`
	Subject     string         `json:"subject,omitempty"`
	PreviewText string         `json:"preview_text,omitempty"`
	Variables   map[string]any `json:"variables,omitempty"`
	Content     map[string]any `json:"content,omitempty"`
	Brand       map[string]any `json:"brand,omitempty"`
	SegmentID   string         `json:"segment_id,omitempty"`
	ListID      AudienceListID `json:"list_id,omitempty"`
}

func (d *Deps) Adapt(w http.ResponseWriter, r *http.Request) {
	writeLegacyDesignWorkflowRetired(w, r)
}

func (d *Deps) Generate(w http.ResponseWriter, r *http.Request) {
	writeLegacyDesignWorkflowRetired(w, r)
}

func writeLegacyDesignWorkflowRetired(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	w.Header().Set("Deprecation", "true")
	w.Header().Set("Link", `</api/v1/campaign-template-designs>; rel="successor-version"`)
	httperror.Write(w, http.StatusGone, "durable_design_workflow_required",
		"Create a durable design with Idempotency-Key, then poll and commit its exact revision and output_hash.")
}

// SaveGeneratedDesign is the tombstone for the pre-revision commit endpoint.
// Caller-supplied HTML can no longer mint a template without a durable,
// immutable design revision and output hash.
func (d *Deps) SaveGeneratedDesign(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	w.Header().Set("Deprecation", "true")
	w.Header().Set("Link", `</api/v1/campaign-template-designs>; rel="successor-version"`)
	httperror.Write(w, http.StatusGone, "design_commit_retired",
		"Create a durable design draft, review its revision, then save it with revision and output_hash.")
}

func reviewedReferenceIDs(rawIDs []string) ([]string, error) {
	if len(rawIDs) > maxReferenceTemplates {
		return nil, fmt.Errorf("%w: at most three references are supported", ErrInvalidReviewedDesign)
	}
	for _, rawID := range rawIDs {
		if strings.TrimSpace(rawID) == "" {
			return nil, fmt.Errorf("%w: reference ids cannot be blank", ErrInvalidReviewedDesign)
		}
	}
	return uniqueIDs(rawIDs), nil
}

func reviewedDesignCreateInput(in SaveGeneratedDesignInput, referenceIDs []string) (CreateInput, error) {
	in.Slug = strings.TrimSpace(in.Slug)
	if err := validateSlug(in.Slug); err != nil {
		return CreateInput{}, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > MaxNameLength {
		return CreateInput{}, fmt.Errorf("%w: name is required and must be at most %d bytes", ErrInvalidReviewedDesign, MaxNameLength)
	}
	if strings.TrimSpace(in.Subject) == "" || utf8.RuneCountInString(in.Subject) > reviewedDesignMaxSubjectRunes {
		return CreateInput{}, fmt.Errorf("%w: subject is required and too long", ErrInvalidReviewedDesign)
	}
	if utf8.RuneCountInString(in.PreviewText) > reviewedDesignMaxPreviewRunes {
		return CreateInput{}, fmt.Errorf("%w: preview text is too long", ErrInvalidReviewedDesign)
	}
	if strings.TrimSpace(in.BodyHTML) == "" || len(in.BodyHTML) > reviewedDesignMaxBodyBytes ||
		len(in.BodyMJML) > reviewedDesignMaxBodyBytes || len(in.BodyHTML)+len(in.BodyMJML) > reviewedDesignMaxCombinedBodyBytes {
		return CreateInput{}, fmt.Errorf("%w: reviewed body is empty or too large", ErrInvalidReviewedDesign)
	}
	goal, err := canonicalGoal(in.Goal)
	if err != nil {
		return CreateInput{}, err
	}
	if goal == "" {
		goal = "newsletter"
	}
	in.Category = strings.TrimSpace(in.Category)
	if in.Category == "" {
		in.Category = "newsletter"
	}
	for label, value := range map[string]string{
		"category": in.Category, "industry": in.Industry, "style": in.Style, "layout": in.Layout,
	} {
		if utf8.RuneCountInString(strings.TrimSpace(value)) > reviewedDesignMaxTaxonomyRunes {
			return CreateInput{}, fmt.Errorf("%w: %s is too long", ErrInvalidReviewedDesign, label)
		}
	}
	variables, err := reviewedVariableDefinitions(in)
	if err != nil {
		return CreateInput{}, err
	}
	referenceIDs = append([]string(nil), referenceIDs...)
	return CreateInput{
		Slug: in.Slug, Name: in.Name, Subject: in.Subject, PreviewText: in.PreviewText,
		BodyHTML: in.BodyHTML, BodyMJML: in.BodyMJML, Category: in.Category,
		Goal: goal, Industry: strings.TrimSpace(in.Industry), Style: strings.TrimSpace(in.Style),
		Layout: strings.TrimSpace(in.Layout), Variables: variables,
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
		QualityScore: 0.75, ReferenceTemplateIDs: referenceIDs,
		GenerationMetadata: map[string]any{
			"operation": "save_reviewed_design", "reference_template_ids": referenceIDs,
		},
	}, nil
}

// PrepareReviewedDesign validates the exact design a caller has reviewed and
// stamps the only governance/lineage values that may be persisted for it.
// Native MCP and HTTP use this same application boundary so neither surface
// can mint provenance, licensing, review state, or generation metadata.
func PrepareReviewedDesign(in SaveGeneratedDesignInput, referenceIDs []string) (CreateInput, error) {
	return reviewedDesignCreateInput(in, referenceIDs)
}

func reviewedVariableDefinitions(in SaveGeneratedDesignInput) ([]map[string]interface{}, error) {
	if len(in.Variables) > reviewedDesignMaxVariables {
		return nil, fmt.Errorf("%w: too many variable values", ErrInvalidReviewedDesign)
	}
	raw, err := json.Marshal(in.Variables)
	if err != nil || len(raw) > reviewedDesignMaxVariablesJSONBytes {
		return nil, fmt.Errorf("%w: variable values are too large", ErrInvalidReviewedDesign)
	}
	names := make([]string, 0, len(in.Variables))
	seen := map[string]struct{}{}
	addName := func(name string) error {
		if !reviewedVariableNameRE.MatchString(name) {
			return fmt.Errorf("%w: variable name is invalid", ErrInvalidReviewedDesign)
		}
		if variableRole(name) == VariableRoleSendTime {
			// The unsubscribe placeholder is rendered by the send loop. As a
			// template variable it would be offered as an editable field whose
			// value could replace every recipient's working link.
			return nil
		}
		if _, exists := seen[name]; !exists {
			seen[name] = struct{}{}
			names = append(names, name)
		}
		if len(seen) > reviewedDesignMaxVariables {
			return fmt.Errorf("%w: too many variables", ErrInvalidReviewedDesign)
		}
		return nil
	}
	for name, value := range in.Variables {
		if err := addName(name); err != nil {
			return nil, err
		}
		switch typed := value.(type) {
		case nil, bool, float64:
		case string:
			if utf8.RuneCountInString(typed) > reviewedDesignMaxVariableValueRunes {
				return nil, fmt.Errorf("%w: variable value is too long", ErrInvalidReviewedDesign)
			}
		default:
			return nil, fmt.Errorf("%w: variable values must be scalar", ErrInvalidReviewedDesign)
		}
	}
	for _, text := range []string{in.Name, in.Subject, in.PreviewText, in.BodyHTML, in.BodyMJML} {
		for _, match := range placeholderRE.FindAllStringSubmatch(text, -1) {
			if len(match) == 2 {
				if err := addName(match[1]); err != nil {
					return nil, err
				}
			}
		}
	}
	return VariableDefinitions(names, in.Variables), nil
}

func writeReviewedDesignError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	if errors.Is(err, ErrInvalidReviewedDesign) {
		httperror.WriteValidation(w, "invalid_reviewed_design", "reviewed design fields are invalid or exceed their limits")
		return
	}
	if errors.Is(err, ErrInvalidSlug) {
		httperror.WriteValidation(w, "invalid_slug", err.Error())
		return
	}
	writeWorkflowError(w, r, d, err)
}

func (d *Deps) CreateCampaignFromTemplate(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Campaigns == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "campaigns_unavailable", "")
		return
	}
	var in FromTemplateInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &in); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	in.TemplateID = strings.TrimSpace(in.TemplateID)
	pathTemplateID := strings.TrimSpace(chi.URLParam(r, "id"))
	if pathTemplateID != "" {
		if in.TemplateID != "" && in.TemplateID != pathTemplateID {
			httperror.WriteValidation(w, "template_id_mismatch", "template_id must match the route id")
			return
		}
		in.TemplateID = pathTemplateID
	}
	if in.TemplateID == "" {
		httperror.WriteValidation(w, "template_id_required", "template_id is required")
		return
	}
	in.SegmentID = strings.TrimSpace(in.SegmentID)
	in.ListID = AudienceListID(strings.TrimSpace(string(in.ListID)))
	if in.SegmentID != "" && in.ListID != "" {
		httperror.WriteValidation(w, "audience_conflict", "pass segment_id or list_id, not both")
		return
	}
	if in.ListID != "" {
		listID, parseErr := strconv.ParseInt(string(in.ListID), 10, 64)
		if parseErr != nil || listID <= 0 {
			httperror.WriteValidation(w, "invalid_list_id", "list_id must be a positive integer")
			return
		}
	}
	tpl, err := d.Repo.GetByIDOrSlug(r.Context(), tenant.ID, in.TemplateID)
	if err != nil {
		writeWorkflowError(w, r, d, err)
		return
	}
	if templateRequiresAdaptation(tpl) {
		httperror.Write(w, http.StatusUnprocessableEntity, "adaptation_required", "Generate or adapt this reference before creating a draft.")
		return
	}
	if eligibilityErr := ValidateTemplateEligibility(tpl); eligibilityErr != nil {
		writeWorkflowError(w, r, d, eligibilityErr)
		return
	}
	identity, err := d.Repo.WorkspaceIdentity(r.Context(), tenant.ID)
	if err != nil {
		writeWorkflowError(w, r, d, err)
		return
	}
	draft, err := BuildCampaignDraft(r.Context(), tpl, CampaignDraftInput{
		Name: in.Name, Subject: in.Subject, PreviewText: in.PreviewText,
		Variables: in.Variables, Content: in.Content, Brand: in.Brand,
		SegmentID: in.SegmentID, ListID: string(in.ListID),
	}, identity)
	if errors.Is(err, ErrTemplateMJMLNotRendered) {
		httperror.Write(w, http.StatusUnprocessableEntity, "mjml_not_rendered", "The selected template's MJML could not be rendered.")
		return
	}
	if err != nil {
		writeWorkflowError(w, r, d, err)
		return
	}
	campaign, err := d.Campaigns.Create(r.Context(), tenant.ID, draft)
	if err != nil {
		writeWorkflowError(w, r, d, err)
		return
	}
	_ = d.Repo.RecordUse(r.Context(), tenant.ID, tpl.ID)
	writeJSON(w, http.StatusCreated, CampaignDraftResult{
		Campaign: campaign, UnresolvedVariables: DraftUnresolvedVariables(draft),
	})
}

func templateRequiresAdaptation(tpl *Template) bool {
	return tpl != nil &&
		strings.EqualFold(strings.TrimSpace(tpl.TemplateKind), templateKindReference) &&
		ValidateTemplateEligibility(tpl) != nil &&
		ValidateTemplateAdaptationEligibility(tpl) == nil
}

func writeWorkflowBodyError(w http.ResponseWriter, err error) {
	httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
}

func (d *Deps) resolveReferences(ctx context.Context, tenantID string, ids []string) ([]GenerationReference, error) {
	if len(ids) > maxReferenceTemplates {
		return nil, fmt.Errorf("too many references")
	}
	out := make([]GenerationReference, 0, len(ids))
	for _, id := range ids {
		tpl, err := d.Repo.Get(ctx, tenantID, id)
		if err != nil {
			return nil, err
		}
		reference, err := NewGovernedGenerationReference(tpl)
		if err != nil {
			return nil, err
		}
		out = append(out, reference)
	}
	return out, nil
}

// NewGovernedGenerationReference converts a tenant-visible repository result
// into generator input only after applying the package's canonical review and
// adaptation-permission gate. The private marker prevents callers from bypassing this
// constructor with a struct literal when the production HTTP client is used.
func NewGovernedGenerationReference(template *Template) (GenerationReference, error) {
	if err := ValidateTemplateAdaptationEligibility(template); err != nil {
		return GenerationReference{}, err
	}
	return GenerationReference{
		ID: template.ID, Name: template.Name, Brand: template.SourceBrand, Description: template.Description,
		Industry: template.Industry, Style: template.Style, Layout: template.Layout, SourceURL: template.SourceURL,
		ThumbnailURL: template.ThumbnailURL, BodyHTML: boundedString(template.BodyHTML, 12000),
		BodyMJML: boundedString(template.BodyMJML, 12000), DesignMetadata: template.DesignMetadata,
		eligibilityValidated: true,
	}, nil
}

// templateValues returns the draft-time values for a template: the declared
// defaults of its content variables, overlaid with the caller's sets (the
// third set, when present, is the brand map and is also exposed as brand_*).
// Subscriber and send-time tags never receive a value, and a workspace
// token never takes the template's sample default (see draft_tokens.go).
// A blank default is no default: the tag stays visible in the draft and is
// reported as unfilled, where writing "" would leave an empty link or line.
func templateValues(tpl *Template, supplied ...map[string]any) map[string]any {
	values := map[string]any{}
	for _, variable := range tpl.Variables {
		name, _ := variable["name"].(string)
		if name != "" && variableRole(name) == VariableRoleContent && suppliedValue(variable["default"]) {
			values[name] = variable["default"]
		}
	}
	sets := append([]map[string]any(nil), supplied...)
	if len(supplied) >= 3 {
		sets = append(sets, prefixedValues("brand", supplied[2]))
	}
	for key, value := range mergeValueMaps(sets...) {
		values[key] = value
	}
	return values
}

// mergeValueMaps merges draft-time value sets, later sets winning. Subscriber
// and send-time tags are dropped: they are rendered per recipient, so a value
// for one would either be ignored or, worse, written into every email. A
// blank value means the caller left the field empty, not that the tag should
// be erased, so it neither fills a tag nor overrides an earlier value.
func mergeValueMaps(sets ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, set := range sets {
		for key, value := range set {
			if preservedInDraft(key) || !suppliedValue(value) {
				continue
			}
			out[key] = value
		}
	}
	return out
}

// suppliedValue reports whether a variable value says anything: nil and
// whitespace-only strings do not.
func suppliedValue(value any) bool {
	if value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}

// VariableDefinitions preserves unresolved generated placeholders when a
// design is saved, so future campaigns can present them as editable fields.
func VariableDefinitions(names []string, values map[string]any) []map[string]interface{} {
	unique := map[string]struct{}{}
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			unique[name] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(unique))
	for name := range unique {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	definitions := make([]map[string]interface{}, 0, len(ordered))
	for _, name := range ordered {
		defaultValue := any("")
		if value, ok := values[name]; ok && value != nil {
			defaultValue = value
		}
		definitions = append(definitions, map[string]interface{}{
			"name": name, "label": name, "default": defaultValue,
		})
	}
	return definitions
}

func prefixedValues(prefix string, values map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range values {
		out[prefix+"_"+key] = value
	}
	return out
}

// substitute replaces each `{{ name }}` that has a value. Tags rendered per
// recipient (subscriber fields and the send-time unsubscribe placeholder) are
// always left intact, whatever values contains: this is the one chokepoint
// every template, design, and draft path writes through.
func substitute(input string, values map[string]any, escapeHTML bool) string {
	return placeholderRE.ReplaceAllStringFunc(input, func(match string) string {
		parts := placeholderRE.FindStringSubmatch(match)
		if len(parts) != 2 || preservedInDraft(parts[1]) {
			return match
		}
		value, ok := values[parts[1]]
		if !ok || value == nil {
			return match
		}
		text := fmt.Sprint(value)
		if escapeHTML {
			return html.EscapeString(text)
		}
		return text
	})
}

func applyDesignValues(response *DesignResponse, values map[string]any) {
	response.Name = substitute(response.Name, values, false)
	response.Subject = substitute(response.Subject, values, false)
	response.PreviewText = substitute(response.PreviewText, values, false)
	response.BodyHTML = substitute(response.BodyHTML, values, true)
	response.BodyMJML = substitute(response.BodyMJML, values, true)
	// Tags rendered per recipient, and workspace tokens that are filled when
	// a campaign is created, are not something the author still has to supply.
	response.UnresolvedVariables = unresolvedDraftVariables(
		response.Subject, response.PreviewText, response.BodyHTML, response.BodyMJML,
	)
}

func buildAdaptBrief(source *Template, in AdaptInput) string {
	brief := "Create an original reusable newsletter design inspired by the selected catalog item."
	if in.Instructions != "" {
		brief += " Operator instructions: " + boundedString(in.Instructions, 4000)
	}
	brief += promptJSONContext("brand", in.Brand)
	brief += promptJSONContext("content requirements", in.Content)
	if source.TemplateKind == "reference" {
		brief += " The selected item is an inspiration reference, so do not copy it verbatim."
	}
	return boundedString(brief, 8000)
}

func promptContext(label, value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return "\n" + label + ": " + boundedString(value, 1500)
	}
	return ""
}

func promptJSONContext(label string, value map[string]any) string {
	if len(value) == 0 {
		return ""
	}
	raw, _ := json.Marshal(value)
	return "\n" + label + ": " + boundedString(string(raw), 2500)
}

func generationKind(values ...string) string {
	for _, value := range values {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "promo", "promotional", "marketing":
			return "promo"
		case "announcement":
			return "announcement"
		case "newsletter":
			return "newsletter"
		}
	}
	return "newsletter"
}

func normalizeGoal(goal string) string {
	goal = strings.ToLower(strings.TrimSpace(goal))
	if validGoal(goal) {
		return goal
	}
	return "newsletter"
}

func uniqueIDs(ids []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// DerivedSlug returns a collision-resistant, storage-valid slug for workflow
// callers that do not need to choose a stable slug themselves.
func DerivedSlug(name string) string {
	slug := strings.ToLower(strings.TrimSpace(name))
	slug = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" || slug[0] < 'a' || slug[0] > 'z' {
		slug = "template"
	}
	suffix := "-" + randSlugSuffix()
	if len(slug)+len(suffix) > MaxSlugLength {
		slug = strings.TrimRight(slug[:MaxSlugLength-len(suffix)], "-")
	}
	return slug + suffix
}

func boundedString(value string, maxRunes int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= maxRunes {
		return string(runes)
	}
	return string(runes[:maxRunes])
}

func writeWorkflowError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "template_not_found", "")
	case errors.Is(err, ErrSlugConflict):
		httperror.Write(w, http.StatusConflict, "slug_conflict", "")
	case errors.Is(err, ErrSourceConflict):
		httperror.Write(w, http.StatusConflict, "source_conflict", "")
	case errors.Is(err, ErrGeneratorRejected):
		httperror.Write(w, http.StatusUnprocessableEntity, "generation_rejected", "")
	case errors.Is(err, ErrGeneratorUnavailable):
		httperror.Write(w, http.StatusBadGateway, "generator_unavailable", "")
	case errors.Is(err, ErrTemplateIneligible):
		httperror.Write(w, http.StatusUnprocessableEntity, "template_ineligible",
			"Template review and license permissions do not allow this operation.")
	case errors.Is(err, ErrReferenceCloneBlocked):
		httperror.Write(w, http.StatusUnprocessableEntity, "reference_clone_blocked", "Reference templates must be adapted through the governed generation flow.")
	case errors.Is(err, ErrInvalidGoal), errors.Is(err, ErrInvalidTemplateKind), errors.Is(err, ErrInvalidReviewStatus):
		writeTemplateValidationError(w, err)
	case errors.Is(err, campaigns.ErrSegmentNotFound):
		httperror.Write(w, http.StatusUnprocessableEntity, "segment_not_found", "")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}
