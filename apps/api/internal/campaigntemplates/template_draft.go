// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
)

// ErrTemplateMJMLNotRendered is returned when a template stores only MJML and
// that MJML cannot be compiled into the HTML a campaign needs.
var ErrTemplateMJMLNotRendered = errors.New("campaigntemplates: template MJML could not be rendered")

// CampaignDraftResult is what creating a campaign from a template returns:
// the campaign, and the tags in it the author still has to fill before it
// can be sent (see DraftUnresolvedVariables). The list is never null.
type CampaignDraftResult struct {
	*campaigns.Campaign
	UnresolvedVariables []string `json:"unresolved_variables"`
}

// CampaignDraftInput is what a caller may say about a draft made from a
// template. Every field is optional; audience identifiers are validated by the
// transport that decoded them.
type CampaignDraftInput struct {
	Name        string
	Subject     string
	PreviewText string
	Variables   map[string]any
	Content     map[string]any
	Brand       map[string]any
	SegmentID   string
	ListID      string
}

// BuildCampaignDraft is the one place a template becomes a campaign draft. The
// HTTP route, the native MCP tool, and every future surface call it so that a
// draft always:
//
//   - keeps the send-time unsubscribe placeholder, which the send loop turns
//     into each recipient's own preference-centre link;
//   - keeps subscriber merge tags such as {{ first_name }} in the body (with
//     the declared default as the fallback for subscribers who have none)
//     instead of writing one sample name into every email;
//   - writes a subscriber tag in the subject or preview text as its fallback
//     (see headerText);
//   - fills brand_name, sender_name and reply_to_email from the workspace,
//     unless the caller supplied them;
//   - fills ordinary content variables from the caller, else the template,
//     and leaves a tag nobody filled visible (see DraftUnresolvedVariables).
//
// A name, subject or preview text the caller supplies is template text too:
// clients pre-fill those fields with the template's own subject, so it is
// rendered exactly as the template's would have been.
//
// The caller must already have checked that the template may be used directly.
func BuildCampaignDraft(
	ctx context.Context,
	template *Template,
	in CampaignDraftInput,
	identity WorkspaceIdentity,
) (campaigns.CreateInput, error) {
	if template == nil {
		return campaigns.CreateInput{}, ErrNotFound
	}
	values := draftValuesForTemplate(template, identity, in.Variables, in.Content, in.Brand)
	fallbacks := subscriberFallbacks(template, mergeValueMapsKeepingSubscribers(in.Variables, in.Content))

	render := func(text string, escapeHTML bool) string {
		return withSubscriberFallbacks(substitute(text, values, escapeHTML), fallbacks)
	}
	header := func(templateText, override string) string {
		if override = strings.TrimSpace(override); override != "" {
			templateText = override
		}
		return headerText(substitute(templateText, values, false), fallbacks)
	}
	name := header(template.Name, in.Name)
	subject := header(template.Subject, in.Subject)
	preview := header(template.PreviewText, in.PreviewText)
	bodyHTML := render(template.BodyHTML, true)
	bodyMJML := render(template.BodyMJML, true)
	editorMode := "html"
	if strings.TrimSpace(bodyMJML) != "" {
		editorMode = "mjml"
		rendered, _, renderErr := emailpreview.RenderMJML(ctx, bodyMJML, nil)
		if renderErr != nil && strings.TrimSpace(bodyHTML) == "" {
			return campaigns.CreateInput{}, ErrTemplateMJMLNotRendered
		}
		if renderErr == nil {
			bodyHTML = rendered
		}
	}
	updatedAt := template.UpdatedAt
	return campaigns.CreateInput{
		Name: name, Subject: subject, PreviewText: preview,
		BodyHTML: bodyHTML, BodyMJML: bodyMJML,
		CampaignType: "regular", EditorMode: editorMode,
		SegmentID: strings.TrimSpace(in.SegmentID), ListID: strings.TrimSpace(in.ListID),
		SourceTemplateID:        template.ID,
		SourceTemplateUpdatedAt: &updatedAt,
		ReferenceTemplateIDs:    uniqueIDs(template.ReferenceTemplateIDs),
		TemplateVariables:       values,
	}, nil
}

// draftValuesForTemplate layers, lowest precedence first: the template's
// declared defaults for content variables, the workspace identity, then the
// caller's variables, content, and brand (brand.name → brand_name). Tags that
// are rendered per recipient are never given a value, and a template's sample
// default for a workspace token is never used: "Moosewave" or
// creator@example.invalid is exactly the value that must not reach a draft.
func draftValuesForTemplate(
	template *Template,
	identity WorkspaceIdentity,
	variables, content, brand map[string]any,
) map[string]any {
	values := templateValues(template)
	for key, value := range identity.values() {
		values[key] = value
	}
	for key, value := range mergeValueMaps(variables, content, brand, prefixedValues("brand", brand)) {
		values[key] = value
	}
	return values
}

// mergeValueMapsKeepingSubscribers merges caller maps without dropping the
// subscriber tags, whose values are read as fallbacks rather than content.
func mergeValueMapsKeepingSubscribers(sets ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, set := range sets {
		for key, value := range set {
			if isSubscriberMergeField(key) {
				out[key] = value
			}
		}
	}
	return out
}
