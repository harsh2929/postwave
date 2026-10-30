// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type providerCleanupDisconnectStore interface {
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, map[string]any) error
}

type providerCleanupAcknowledgementStore interface {
	AcknowledgeProviderCleanup(context.Context, string, string, ProviderCleanupAcknowledgementInput, time.Time) (*Integration, error)
}

type ProviderCleanupAcknowledgementInput struct {
	CompletedActions []string `json:"completed_actions,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	AcknowledgedBy   string   `json:"acknowledged_by,omitempty"`
}

func analyticsProviderCleanupEligible(provider string) bool {
	switch strings.TrimSpace(provider) {
	case ProviderPostHog, ProviderTripleWhale, ProviderMixpanel, ProviderAmplitude:
		return true
	default:
		return false
	}
}

func analyticsDisconnectCleanupEvidence(integration Integration, recordedAt time.Time) map[string]any {
	scopeType, scopeID := analyticsProviderCleanupScope(integration)
	name := analyticsProviderDisplayName(integration.Provider)
	return map[string]any{
		"provider":                 integration.Provider,
		"status":                   "operator_action_required",
		"recorded_at":              recordedAt.UTC(),
		"postwave_status":          "disconnected",
		"provider_cleanup_posture": "operator_managed_provider_console",
		"managed_provider_cleanup": false,
		"provider_scope_type":      scopeType,
		"provider_scope_id":        scopeID,
		"credential_ref_present":   analyticsCredentialRef(integration) != "",
		"postwave_effects": []string{
			"local analytics integration is marked disconnected",
			"scheduled " + name + " provider pulls exclude disconnected rows",
			"manual analytics sync/backfill rejects disconnected rows before provider calls or local writes",
			"analytics sync run history and cursor audit evidence are retained",
		},
		"provider_console_actions": []string{
			"rotate or revoke the " + name + " credential referenced by credentials_ref if it is no longer used",
			"review " + name + " project, cohort, report, export, or service-account access granted for this Moosewave connection",
			"remove duplicate or manually configured " + name + " export jobs, report shares, or API credentials outside Moosewave",
			"record provider-side cleanup evidence in the customer change ticket before considering the analytics disconnect complete",
		},
		"provider_cleanup_evidence": []string{
			"Moosewave recorded row-preserving disconnect cleanup evidence for this analytics integration",
			"No provider-side analytics credentials, cohorts, reports, export jobs, webhooks, or project access were deleted by this API call",
		},
	}
}

func analyticsProviderCleanupScope(integration Integration) (string, string) {
	switch integration.Provider {
	case ProviderPostHog:
		return "posthog_project", settingString(integration.Settings, "project_id")
	case ProviderMixpanel:
		return "mixpanel_project", settingString(integration.Settings, "project_id")
	case ProviderAmplitude:
		return "amplitude_cohort_or_project", firstString(settingString(integration.Settings, "cohort_id"), settingString(integration.Settings, "project_id"))
	case ProviderTripleWhale:
		return "triple_whale_store_or_account", firstString(settingString(integration.Settings, "shop_id"), settingString(integration.Settings, "shop_domain"), settingString(integration.Settings, "store_id"), settingString(integration.Settings, "account_id"))
	default:
		return "analytics_provider_account", ""
	}
}

func analyticsProviderDisplayName(provider string) string {
	if spec, ok := ProviderSpecByKey(provider); ok && strings.TrimSpace(spec.Name) != "" {
		return spec.Name
	}
	return strings.TrimSpace(provider)
}

func normalizeProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:          truncateAnalyticsCleanupString(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy: truncateAnalyticsCleanupString(strings.TrimSpace(in.AcknowledgedBy), 200),
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = truncateAnalyticsCleanupString(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !analyticsProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported analytics cleanup action key")
		}
		if seen[action] {
			continue
		}
		seen[action] = true
		out.CompletedActions = append(out.CompletedActions, action)
		if len(out.CompletedActions) >= 20 {
			break
		}
	}
	if len(out.CompletedActions) == 0 && out.Notes == "" {
		return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions or notes is required")
	}
	return out, nil
}

var analyticsProviderCleanupActionKeys = map[string]bool{
	"provider_api_credentials_rotated":                true,
	"provider_project_or_cohort_access_removed":       true,
	"provider_export_or_report_jobs_reviewed":         true,
	"duplicate_manual_provider_jobs_reviewed":         true,
	"provider_console_cleanup_reviewed_no_action_due": true,
}

func analyticsProviderCleanupAcknowledgedBy(ctx context.Context, fallback string) string {
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		if strings.TrimSpace(u.Email) != "" {
			return strings.TrimSpace(u.Email)
		}
		if strings.TrimSpace(u.ID) != "" {
			return strings.TrimSpace(u.ID)
		}
	}
	return strings.TrimSpace(fallback)
}

func truncateAnalyticsCleanupString(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}
