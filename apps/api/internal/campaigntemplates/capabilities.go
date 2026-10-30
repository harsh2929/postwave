// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TemplateCapabilities is the request-aware action contract consumed by
// catalog clients. It deliberately distinguishes using captured content
// directly from asking the generator for an original adaptation.
type TemplateCapabilities struct {
	CanPreview        bool `json:"can_preview"`
	CanFavorite       bool `json:"can_favorite"`
	CanAdapt          bool `json:"can_adapt"`
	CanUseDirectly    bool `json:"can_use_directly"`
	CanCreateCampaign bool `json:"can_create_campaign"`
	CanEditDirectly   bool `json:"can_edit_directly"`
	CanClone          bool `json:"can_clone"`
	CanDelete         bool `json:"can_delete"`
	CanArchive        bool `json:"can_archive"`
	CanRestore        bool `json:"can_restore"`
	HasSourceHTML     bool `json:"has_source_html"`
	HasSourceMJML     bool `json:"has_source_mjml"`
	HasDesktopPreview bool `json:"has_desktop_preview"`
	HasMobilePreview  bool `json:"has_mobile_preview"`
}

// TemplateWarning is a stable, machine-readable explanation for a disabled or
// degraded capability. recommended_action names the API/MCP-style recovery
// operation without requiring clients to parse prose.
type TemplateWarning struct {
	Code              string `json:"code"`
	Message           string `json:"message"`
	RecommendedAction string `json:"recommended_action,omitempty"`
}

type templatePresentationAccess struct {
	CanWrite    bool
	CanFavorite bool
}

var unrestrictedTemplatePresentation = templatePresentationAccess{
	CanWrite:    true,
	CanFavorite: true,
}

func templatePresentationAccessFromContext(ctx context.Context) templatePresentationAccess {
	access := templatePresentationAccess{}
	if user, ok := middleware.UserFromContext(ctx); ok && user != nil {
		access.CanFavorite = strings.TrimSpace(user.ID) != ""
		switch strings.ToLower(strings.TrimSpace(user.EffectiveRoleOrDurable())) {
		case "owner", "admin", "editor":
			access.CanWrite = true
		}
	}
	if middleware.IsAPIKeyAuth(ctx) {
		// API keys created by a dashboard user carry that non-impersonable
		// principal in context. Keep personal discovery actions available for
		// those keys; legacy/unbound keys still fail closed because the user
		// block above leaves CanFavorite false.
		access.CanWrite = apikeys.HasScope(ctx, apikeys.ScopeWriteCampaigns)
	}
	return access
}

func projectTemplatesForRequest(ctx context.Context, templates []Template) {
	access := templatePresentationAccessFromContext(ctx)
	for i := range templates {
		projectTemplate(&templates[i], access)
	}
}

// ProjectTemplatesForRequest applies the request-aware capability contract to
// in-process consumers such as native MCP. Repository methods intentionally
// return an unrestricted internal projection; callers crossing a trust
// boundary must use this helper before serializing it.
func ProjectTemplatesForRequest(ctx context.Context, templates []Template) {
	projectTemplatesForRequest(ctx, templates)
}

func projectTemplateForRequest(ctx context.Context, template *Template) {
	projectTemplate(template, templatePresentationAccessFromContext(ctx))
}

// ProjectTemplateForRequest is the single-item variant of
// ProjectTemplatesForRequest.
func ProjectTemplateForRequest(ctx context.Context, template *Template) {
	projectTemplateForRequest(ctx, template)
}

func projectTemplate(template *Template, access templatePresentationAccess) {
	if template == nil {
		return
	}
	template.HasSourceHTML = template.HasSourceHTML || strings.TrimSpace(template.BodyHTML) != ""
	template.HasSourceMJML = template.HasSourceMJML || strings.TrimSpace(template.BodyMJML) != ""

	facts := deriveTemplateProjectionFacts(template)
	template.Capabilities = templateCapabilitiesFor(template, access, facts)
	template.Warnings = templateWarningsFor(template, access, facts)
	if template.Version < 1 {
		template.Version = 1
	}
	template.ETag = templateETag(template)
	// Classified before a reference's captured markup is withheld below. A
	// template is projected once when scanned and again per request; the
	// union keeps what the first pass saw in a body the second no longer has.
	roles := TemplateVariableRoles(template)
	for name, role := range template.VariableRoles {
		roles[name] = role
	}
	template.VariableRoles = roles
	if facts.referenceTemplate {
		// Preserve HasSourceHTML/HasSourceMJML as capability facts while keeping
		// captured third-party markup behind the HTTP, SDK, and MCP response
		// boundary. The adaptation service reads the unprojected repository
		// record internally.
		template.BodyHTML = ""
		template.BodyMJML = ""
	}
	template.RecommendedAction = recommendedTemplateAction(template, access, facts)
}

// templateProjectionFacts are the derived, access-independent facts about a
// template that its capabilities, warnings, and recommended action all read.
type templateProjectionFacts struct {
	kind               string
	kindErr            error
	directEligible     bool
	adaptationEligible bool
	visibleForFavorite bool
	referenceTemplate  bool
	hasDesktopPreview  bool
	hasMobilePreview   bool
	hasAnyPreview      bool
	tenantEditable     bool
	active             bool
}

func deriveTemplateProjectionFacts(template *Template) templateProjectionFacts {
	kind, kindErr := canonicalTemplateKind(template.TemplateKind)
	directEligible := ValidateTemplateEligibility(template) == nil
	adaptationEligible := ValidateTemplateAdaptationEligibility(template) == nil
	visibleForFavorite := template.ReviewStatus != reviewStatusRejected
	hostedDesktopPreview := false
	hostedMobilePreview := false
	for _, asset := range template.PreviewAssets {
		switch asset.Variant {
		case "desktop", "card":
			hostedDesktopPreview = true
		case "mobile":
			hostedMobilePreview = true
		}
	}
	// Provider thumbnails, screenshot metadata, and captured reference markup
	// are provenance/server-side adaptation inputs—not client-renderable
	// previews. References become previewable only after the worker has copied
	// and sanitized a capture into PreviewAssets. Editable owned/platform
	// markup remains previewable in a network-silent sandbox.
	referenceTemplate := kindErr == nil && kind == templateKindReference
	hasRenderableSource := !referenceTemplate &&
		(template.HasSourceHTML || template.HasSourceMJML)
	editableMetadata := kindErr == nil && kind == templateKindEditable
	// Importer design metadata may describe an upstream screenshot candidate,
	// not an object a client can render. Editable-template metadata is
	// server-owned and may independently describe rendered output.
	metadataDesktopPreview :=
		metadataValuePresent(template.DesignMetadata["has_desktop_preview"]) &&
			editableMetadata
	metadataMobilePreview :=
		metadataValuePresent(template.DesignMetadata["has_mobile_preview"]) &&
			editableMetadata
	hasDesktopPreview := hostedDesktopPreview || hasRenderableSource ||
		metadataDesktopPreview
	hasMobilePreview := hostedMobilePreview || metadataMobilePreview
	hasAnyPreview := hasDesktopPreview || hasMobilePreview
	tenantEditable := kindErr == nil && kind == templateKindEditable &&
		strings.TrimSpace(template.TenantID) != ""
	active := template.ArchivedAt == nil
	return templateProjectionFacts{
		kind: kind, kindErr: kindErr,
		directEligible: directEligible, adaptationEligible: adaptationEligible,
		visibleForFavorite: visibleForFavorite, referenceTemplate: referenceTemplate,
		hasDesktopPreview: hasDesktopPreview, hasMobilePreview: hasMobilePreview,
		hasAnyPreview: hasAnyPreview, tenantEditable: tenantEditable, active: active,
	}
}

func templateCapabilitiesFor(template *Template, access templatePresentationAccess, f templateProjectionFacts) TemplateCapabilities {
	return TemplateCapabilities{
		CanPreview:        f.hasAnyPreview,
		CanFavorite:       access.CanFavorite && f.active && f.visibleForFavorite,
		CanAdapt:          access.CanWrite && f.active && f.adaptationEligible,
		CanUseDirectly:    access.CanWrite && f.active && f.directEligible,
		CanCreateCampaign: access.CanWrite && f.active && f.directEligible,
		CanEditDirectly:   access.CanWrite && f.active && f.tenantEditable && f.directEligible,
		CanClone:          access.CanWrite && f.active && f.kindErr == nil && f.kind == templateKindEditable && f.directEligible,
		CanDelete:         access.CanWrite && f.active && f.tenantEditable,
		CanArchive:        access.CanWrite && f.active && f.tenantEditable,
		CanRestore:        access.CanWrite && !f.active && f.tenantEditable,
		HasSourceHTML:     template.HasSourceHTML,
		HasSourceMJML:     template.HasSourceMJML,
		HasDesktopPreview: f.hasDesktopPreview,
		HasMobilePreview:  f.hasMobilePreview,
	}
}

func templateWarningsFor(template *Template, access templatePresentationAccess, f templateProjectionFacts) []TemplateWarning {
	warnings := make([]TemplateWarning, 0, 4)
	if !f.active {
		warnings = append(warnings, TemplateWarning{
			Code: "template_archived", Message: "This template is archived and cannot be edited or used.",
			RecommendedAction: "campaign_template_restore",
		})
	}
	switch template.ReviewStatus {
	case reviewStatusPending:
		warnings = append(warnings, TemplateWarning{
			Code: "review_pending", Message: "This reference is awaiting a rights review.",
			RecommendedAction: "campaign_template_review",
		})
	case reviewStatusRejected:
		warnings = append(warnings, TemplateWarning{
			Code: "review_rejected", Message: "This reference was rejected and cannot be used.",
		})
	}
	if f.kindErr == nil && f.kind == templateKindReference {
		if !template.HasSourceHTML && !template.HasSourceMJML {
			warnings = append(warnings, TemplateWarning{
				Code:              "metadata_only_reference",
				Message:           "Only visual or metadata inspiration is available; generated output may not closely match the source.",
				RecommendedAction: "campaign_template_adapt",
			})
		}
		if f.adaptationEligible && !f.directEligible {
			warnings = append(warnings, TemplateWarning{
				Code:              "adaptation_only",
				Message:           "This reference may inspire an original design but its captured content cannot be used directly.",
				RecommendedAction: "campaign_template_adapt",
			})
		}
	}
	if !f.hasAnyPreview {
		warnings = append(warnings, TemplateWarning{
			Code: "preview_unavailable", Message: "No visual or rendered preview is available for this template.",
		})
	}
	if !access.CanWrite && (f.adaptationEligible || f.directEligible || f.tenantEditable) {
		warnings = append(warnings, TemplateWarning{
			Code:              "write_permission_required",
			Message:           "Your current role can browse this template but cannot modify or use it.",
			RecommendedAction: "request_campaign_write_access",
		})
	}
	return warnings
}

func recommendedTemplateAction(template *Template, access templatePresentationAccess, f templateProjectionFacts) string {
	switch {
	case !f.active && access.CanWrite && f.tenantEditable:
		return "campaign_template_restore"
	case access.CanWrite && f.kindErr == nil && f.kind == templateKindReference && f.adaptationEligible && !f.directEligible:
		return "campaign_template_adapt"
	case access.CanWrite && f.directEligible:
		return "campaign_template_create_campaign"
	case !access.CanWrite && (f.adaptationEligible || f.directEligible || f.tenantEditable):
		return "request_campaign_write_access"
	case template.ReviewStatus == reviewStatusPending:
		return "await_review"
	default:
		return "none"
	}
}

// metadataValuePresent interprets renderer-owned preview metadata. Provider
// screenshot metadata is deliberately excluded by the caller until a hosted,
// sanitized preview asset exists. MJML source alone is not evidence that a
// mobile screenshot was actually rendered.
func metadataValuePresent(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		return normalized != "" && normalized != "false" &&
			normalized != "0" && normalized != "null" && normalized != "none"
	case float64:
		return typed != 0
	case float32:
		return typed != 0
	case int:
		return typed != 0
	case int32:
		return typed != 0
	case int64:
		return typed != 0
	case uint:
		return typed != 0
	case uint32:
		return typed != 0
	case uint64:
		return typed != 0
	case []any:
		for _, item := range typed {
			if metadataValuePresent(item) {
				return true
			}
		}
		return false
	case map[string]any:
		for _, item := range typed {
			if metadataValuePresent(item) {
				return true
			}
		}
		return false
	default:
		return true
	}
}
