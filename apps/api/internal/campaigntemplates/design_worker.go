// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"log/slog"
	"strings"
	"time"
)

type DesignDraftWorker struct {
	Store        DesignDraftStore
	Templates    templateRepository
	Generator    TemplateGenerator
	Logger       *slog.Logger
	PollInterval time.Duration
}

func (w *DesignDraftWorker) Run(ctx context.Context) {
	interval := w.PollInterval
	if interval <= 0 {
		interval = 750 * time.Millisecond
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		processed, err := w.RunOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			w.logger().Error("campaign template design worker", "error", err)
		}
		delay := interval
		if processed {
			delay = 10 * time.Millisecond
		}
		timer.Reset(delay)
	}
}

func (w *DesignDraftWorker) RunOnce(ctx context.Context) (bool, error) {
	if w == nil || w.Store == nil || w.Templates == nil {
		return false, errors.New("campaign template design worker dependencies unavailable")
	}
	claim, err := w.Store.ClaimNext(ctx)
	if err != nil || claim == nil {
		return false, err
	}
	workCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	output, validation, warnings, err := w.process(workCtx, *claim)
	if err != nil {
		code, retryable := designDraftFailure(err)
		if failErr := w.Store.Fail(context.WithoutCancel(ctx), *claim, code, err.Error(), retryable); failErr != nil {
			return true, errors.Join(err, failErr)
		}
		return true, nil
	}
	if _, err := w.Store.Complete(context.WithoutCancel(ctx), *claim, output, validation, warnings); err != nil {
		_ = w.Store.Fail(context.WithoutCancel(ctx), *claim,
			"design_commit_failed", err.Error(), true)
		return true, err
	}
	return true, nil
}

func (w *DesignDraftWorker) process(
	ctx context.Context,
	claim claimedDesignDraft,
) (DesignResponse, DesignValidation, []TemplateWarning, error) {
	if w.Generator == nil {
		return DesignResponse{}, DesignValidation{}, nil, ErrGeneratorUnavailable
	}
	draft := claim.Draft
	input := draft.RequestPayload
	references, err := w.resolveReferences(ctx, draft.tenantID, draft.ReferenceTemplateIDs)
	if err != nil {
		return DesignResponse{}, DesignValidation{}, nil, err
	}

	request, fallbackName, fallbackSubject, previewText, values, err :=
		w.generationRequest(ctx, draft, input, references)
	if err != nil {
		return DesignResponse{}, DesignValidation{}, nil, err
	}
	generated, err := w.Generator.GenerateTemplate(ctx, draft.tenantID, request)
	if err != nil {
		return DesignResponse{}, DesignValidation{}, nil, err
	}
	output := DesignResponse{
		Name: generated.Name, Subject: generated.Subject, PreviewText: previewText,
		// Mark here, at the boundary where generated content enters the system.
		// Everything downstream — the revision, the commit, the template, and the
		// campaigns created from it — inherits the marking, and there is only one
		// place to keep correct instead of four.
		BodyHTML: markGeneratedDesignHTML(generated.BodyHTML), BodyMJML: generated.BodyMJML,
		Variables: values, ReferenceTemplateIDs: append([]string(nil), draft.ReferenceTemplateIDs...),
		Warnings: []string{},
	}
	if claim.Draft.pendingOperation == "initial" {
		if strings.TrimSpace(input.Name) != "" {
			output.Name = strings.TrimSpace(input.Name)
		}
		if strings.TrimSpace(input.Subject) != "" {
			output.Subject = strings.TrimSpace(input.Subject)
		}
		if strings.TrimSpace(input.PreviewText) != "" {
			output.PreviewText = strings.TrimSpace(input.PreviewText)
		}
	}
	applyDesignValues(&output, values)
	generated = GeneratedDesign{
		Name: output.Name, Subject: output.Subject,
		PreviewText: output.PreviewText,
		BodyHTML:    output.BodyHTML, BodyMJML: output.BodyMJML,
	}
	repaired, validation, warnings, validationErr :=
		repairAndValidateGeneratedDesign(ctx, generated, fallbackName, fallbackSubject)
	if validationErr != nil {
		repairRequest := request
		repairRequest.Brief = boundedString(
			request.Brief+
				"\nRepair the design and return complete, safe email HTML. "+
				"Do not include scripts, forms, iframes, embeds, event handlers, or javascript URLs. "+
				"Validation failure: "+validationErr.Error(),
			8000,
		)
		second, retryErr := w.Generator.GenerateTemplate(ctx, draft.tenantID, repairRequest)
		if retryErr != nil {
			return DesignResponse{}, validation, warnings, errors.Join(validationErr, retryErr)
		}
		if strings.TrimSpace(second.PreviewText) == "" {
			second.PreviewText = output.PreviewText
		}
		repaired, validation, warnings, validationErr =
			repairAndValidateGeneratedDesign(ctx, second, fallbackName, fallbackSubject)
		if validationErr != nil {
			return DesignResponse{}, validation, warnings, validationErr
		}
		warnings = append([]TemplateWarning{{
			Code:    "automatic_generation_repair",
			Message: "Moosewave regenerated the first unsafe or incomplete result before showing it.",
		}}, warnings...)
	}
	output.Name = repaired.Name
	output.Subject = repaired.Subject
	output.PreviewText = repaired.PreviewText
	output.BodyHTML = repaired.BodyHTML
	output.BodyMJML = repaired.BodyMJML
	applyDesignValues(&output, values)
	output.Warnings = make([]string, 0, len(warnings))
	for _, warning := range warnings {
		output.Warnings = append(output.Warnings, warning.Message)
	}
	return output, validation, warnings, nil
}

func (w *DesignDraftWorker) resolveReferences(
	ctx context.Context,
	tenantID string,
	ids []string,
) ([]GenerationReference, error) {
	if len(ids) > maxReferenceTemplates {
		return nil, ErrDesignDraftInvalid
	}
	out := make([]GenerationReference, 0, len(ids))
	for _, id := range ids {
		template, err := w.Templates.Get(ctx, tenantID, id)
		if err != nil {
			return nil, err
		}
		reference, err := NewGovernedGenerationReference(template)
		if err != nil {
			return nil, err
		}
		out = append(out, reference)
	}
	return out, nil
}

func (w *DesignDraftWorker) generationRequest(
	ctx context.Context,
	draft DesignDraft,
	input CreateDesignDraftInput,
	references []GenerationReference,
) (
	GenerateDesignRequest,
	string,
	string,
	string,
	map[string]any,
	error,
) {
	if draft.pendingOperation == "refine" {
		if draft.Revision == nil || draft.Revision.Revision != draft.CurrentRevision {
			return GenerateDesignRequest{}, "", "", "", nil, ErrDesignDraftRevisionConflict
		}
		current := draft.Revision.Output
		currentRaw, _ := json.Marshal(map[string]any{
			"name": current.Name, "subject": current.Subject,
			"preview_text": current.PreviewText,
			"body_html":    boundedString(current.BodyHTML, 10000),
			"body_mjml":    boundedString(current.BodyMJML, 10000),
		})
		brief := "Refine the existing original newsletter design. Preserve everything not changed by the instructions."
		brief += "\nRefinement instructions: " + boundedString(draft.pendingPayload.Instructions, 4000)
		brief += "\nCurrent reviewed design: " + string(currentRaw)
		brief += promptJSONContext("approved content requirements", input.Content)
		brief += approvedGroundingRule(input.Content)
		return GenerateDesignRequest{
				Brief: boundedString(brief, 8000), Kind: generationKind(input.Kind, input.Goal, input.Category),
				Tone: strings.TrimSpace(input.Tone), References: references,
			},
			current.Name, current.Subject, current.PreviewText,
			mergeValueMaps(current.Variables, input.Variables), nil
	}

	creativeDirection := ""
	creativeDirection += promptContext("fidelity", fidelityPrompt(input.Fidelity))
	creativeDirection += promptContext("audience", input.Audience)
	creativeDirection += promptContext("industry", input.Industry)
	creativeDirection += promptContext("visual style", input.Style)
	creativeDirection += promptContext("layout", input.Layout)
	if len(input.Sections) > 0 {
		creativeDirection += promptContext("requested sections", strings.Join(input.Sections, ", "))
	}
	creativeDirection += promptContext("primary CTA", input.CTA)
	creativeDirection += promptJSONContext("brand", input.Brand)
	creativeDirection += promptJSONContext("content requirements", input.Content)
	creativeDirection += approvedGroundingRule(input.Content)

	if input.Mode == designDraftModeAdapt {
		source, err := w.Templates.Get(ctx, draft.tenantID, draft.SourceTemplateID)
		if err != nil {
			return GenerateDesignRequest{}, "", "", "", nil, err
		}
		if err := ValidateTemplateAdaptationEligibility(source); err != nil {
			return GenerateDesignRequest{}, "", "", "", nil, err
		}
		brief := buildAdaptBrief(source, AdaptInput{
			Instructions: input.Instructions, Tone: input.Tone,
			Brand: input.Brand, Content: input.Content,
			Variables: input.Variables,
		}) + creativeDirection
		values := templateValues(source, input.Variables, generationContentValues(input.Content), input.Brand)
		return GenerateDesignRequest{
				Brief: boundedString(brief, 8000),
				Kind:  generationKind(input.Kind, source.Goal, source.Category),
				Tone:  strings.TrimSpace(input.Tone), References: references,
			},
			source.Name, source.Subject, source.PreviewText, values, nil
	}

	brief := strings.TrimSpace(input.Brief) + creativeDirection
	values := mergeValueMaps(input.Variables, generationContentValues(input.Content), prefixedValues("brand", input.Brand))
	return GenerateDesignRequest{
			Brief: boundedString(brief, 8000),
			Kind:  generationKind(input.Kind, input.Goal, input.Category),
			Tone:  strings.TrimSpace(input.Tone), References: references,
		},
		input.Name, input.Subject, input.PreviewText, values, nil
}

func generationContentValues(content map[string]any) map[string]any {
	if len(content) == 0 {
		return nil
	}
	values := make(map[string]any, len(content))
	for key, value := range content {
		if key == "approved_facts" || key == "approved_urls" || key == "approved_assets" {
			continue
		}
		values[key] = value
	}
	return values
}

func approvedGroundingRule(content map[string]any) string {
	_, hasFacts := content["approved_facts"]
	_, hasURLs := content["approved_urls"]
	_, hasAssets := content["approved_assets"]
	if !hasFacts && !hasURLs && !hasAssets {
		return ""
	}
	return "\nGrounding rule: Treat approved_facts as the only approved factual claims, approved_urls as the only approved external link destinations, and approved_assets as the only approved image assets. Do not invent prices, dates, statistics, guarantees, testimonials, citations, or image URLs. If the brief requires unsupported content, omit it and leave a review warning. URLs and assets are operator-provided references, not fetched or independently verified.\n"
}

func fidelityPrompt(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "close":
		return "Keep the broad hierarchy and density recognizable while producing original copy, assets, and implementation. Do not reproduce the source verbatim."
	case "inspired":
		return "Use only the general visual mood as inspiration and explore a clearly different original composition."
	default:
		return "Keep the source's strongest layout ideas while creating a distinct original design."
	}
}

func designDraftFailure(err error) (string, bool) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "generation_timeout", true
	case errors.Is(err, ErrGeneratorUnavailable):
		return "generator_unavailable", true
	case errors.Is(err, ErrGeneratorRejected):
		return "generation_rejected", false
	case errors.Is(err, ErrGeneratedDesignInvalid):
		return "generated_design_invalid", false
	case errors.Is(err, ErrTemplateIneligible):
		return "template_ineligible", false
	case errors.Is(err, ErrNotFound):
		return "reference_not_found", false
	case errors.Is(err, ErrDesignDraftRevisionConflict):
		return "revision_conflict", false
	default:
		return "design_generation_failed", true
	}
}

func (w *DesignDraftWorker) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// markGeneratedDesignHTML applies EU AI Act Article 50(2) content marking to a
// body the template generator produced.
//
// aicompose marks its output for the stated reason that the marking "travels
// with the content (survives editing/sending)". A generated template body is
// the same artifact reaching the same place — a subscriber's inbox — by a
// longer route, so it carries the same marking.
//
// Idempotent, and empty in means empty out: a refinement pass re-runs the
// generator over a body that may already be marked, and stacking comments would
// change the output hash every time and break the revision's immutability
// check.
func markGeneratedDesignHTML(html string) string {
	if strings.TrimSpace(html) == "" {
		return html
	}
	return aidisclosure.MarkHTML(html)
}
