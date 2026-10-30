// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

const (
	reviewSyncModelIngest       = "postwave_review_ingest"
	yotpoSyncModelNative        = "yotpo_reviews_rest_token_exchange"
	judgeMeSyncModelNative      = "judge_me_reviews_rest_page_backfill"
	okendoSyncModelNative       = "okendo_reviews_rest_cursor_backfill"
	looxSyncModelNative         = "loox_reviews_rest_page_backfill"
	stampedSyncModelNative      = "stamped_reviews_rest_page_backfill"
	trustpilotSyncModelNative   = "trustpilot_service_reviews_rest_page_backfill"
	reviewsIOSyncModelNative    = "reviews_io_product_reviews_rest_page_backfill"
	bazaarvoiceSyncModelNative  = "bazaarvoice_display_reviews_rest_offset_backfill"
	powerReviewsSyncModelNative = "powerreviews_reviews_rest_page_backfill"
)

var providerSpecs = []ProviderSpec{
	{
		Provider:      ProviderYotpo,
		Name:          "Yotpo",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Yotpo store or account label; the credential secret carries app_key and secret"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing JSON {app_key, secret} credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Yotpo API host override for testing or regional routing"},
			{Key: "page_size", Label: "Page size", Help: "Optional review pull page size, capped at 100"},
			{Key: "commerce_integration_id", Label: "Commerce integration ID", Help: "Optional Moosewave commerce integration used to resolve Yotpo product IDs into review product UUIDs"},
		},
		SyncObjects: []string{"product_reviews", "reviewers", "events"},
		DocsURL:     "/docs/integrations/yotpo",
	},
	{
		Provider:      ProviderJudgeMe,
		Name:          "Judge.me",
		Category:      "reviews",
		AuthMode:      "api_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Judge.me"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Judge.me API token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews:read", "webhooks:write"},
		SyncObjects:   []string{"reviews", "products", "webhooks"},
		WebhookTopics: []string{"review/created", "review/updated"},
		DocsURL:       "/docs/integrations/judge-me",
	},
	{
		Provider:      ProviderOkendo,
		Name:          "Okendo",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Okendo store identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Okendo API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Okendo webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "products.read", "webhooks.write"},
		SyncObjects:   []string{"reviews", "attributes", "media", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated"},
		DocsURL:       "/docs/integrations/okendo",
	},
	{
		Provider:      ProviderLoox,
		Name:          "Loox",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Loox"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Loox API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "webhooks.write"},
		SyncObjects:   []string{"reviews", "photo_reviews", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated"},
		DocsURL:       "/docs/integrations/loox",
	},
	{
		Provider:      ProviderStamped,
		Name:          "Stamped",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Stamped store identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Stamped API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "loyalty.read", "webhooks.write"},
		SyncObjects:   []string{"reviews", "questions", "loyalty_events", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated"},
		DocsURL:       "/docs/integrations/stamped",
	},
	{
		Provider:      ProviderTrustpilot,
		Name:          "Trustpilot",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "business_unit_id", Label: "Business unit ID", Required: true, Help: "Trustpilot business unit identifier to sync reviews from"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Trustpilot API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Trustpilot webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
			{Key: "locale", Label: "Locale", Help: "Optional locale filter for business-unit reviews"},
		},
		Scopes:        []string{"business_units.read", "reviews.read", "invitations.read", "webhooks.write"},
		SyncObjects:   []string{"business_units", "product_reviews", "service_reviews", "review_invitations", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated"},
		DocsURL:       "/docs/integrations/trustpilot",
	},
	{
		Provider:      ProviderReviewsIO,
		Name:          "Reviews.io",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Reviews.io store identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Reviews.io API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Reviews.io webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "questions.read", "invitation.read", "webhooks.write"},
		SyncObjects:   []string{"product_reviews", "company_reviews", "questions", "review_invitations", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated", "question.created"},
		DocsURL:       "/docs/integrations/reviews-io",
	},
	{
		Provider:      ProviderBazaarvoice,
		Name:          "Bazaarvoice",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "commerce", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "client_name", Label: "Client name", Required: true, Help: "Bazaarvoice client name or deployment identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Bazaarvoice API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "environment", Label: "Environment", Help: "Optional Bazaarvoice environment, for example staging or production"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Bazaarvoice webhook verification"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "products.read", "questions.read", "syndication.read"},
		SyncObjects:   []string{"product_reviews", "questions", "answers", "products", "syndication_feeds"},
		WebhookTopics: []string{"review.created", "review.updated", "question.created"},
		DocsURL:       "/docs/integrations/bazaarvoice",
	},
	{
		Provider:      ProviderPowerReviews,
		Name:          "PowerReviews",
		Category:      "reviews",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "reviews", "commerce", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "merchant_id", Label: "Merchant ID", Required: true, Help: "PowerReviews merchant or account identifier"},
			{Key: "page_id", Label: "Product page ID", Required: true, Help: "PowerReviews product page identifier to pull reviews for"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing PowerReviews API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for PowerReviews webhook verification"},
			{Key: "product_id", Label: "Product ID alias", Help: "Optional alias for page_id when mirroring product identifiers"},
			{Key: "default_status", Label: "Default status", Help: "Optional review status for imported rows"},
		},
		Scopes:        []string{"reviews.read", "products.read", "questions.read", "webhooks.write"},
		SyncObjects:   []string{"product_reviews", "questions", "answers", "products", "review_requests", "webhooks"},
		WebhookTopics: []string{"review.created", "review.updated", "question.created"},
		DocsURL:       "/docs/integrations/powerreviews",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := append([]ProviderSpec(nil), providerSpecs...)
	for i := range out {
		out[i] = withRequiredLists(withReviewSpecDefaults(out[i]))
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func ProviderSpecByKey(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range providerSpecs {
		if spec.Provider == key {
			return withReviewSpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

func withReviewSpecDefaults(spec ProviderSpec) ProviderSpec {
	if spec.Provider == ProviderYotpo {
		spec.SyncModel = yotpoSyncModelNative
		spec.VerificationMode = reviewVerificationMode(spec.Provider)
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		spec.Scopes = nil
		spec.SyncObjects = []string{"product_reviews", "reviewers", "events"}
		spec.WebhookTopics = []string{"review_create", "review_updated"}
		return spec
	}
	if isNativeReviewPullerProvider(spec.Provider) {
		spec.SyncModel = nativeReviewPullerSyncModel(spec.Provider)
		spec.VerificationMode = reviewVerificationMode(spec.Provider)
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		spec.Scopes = withoutWebhookClaims(spec.Scopes)
		spec.SyncObjects = withoutWebhookClaims(spec.SyncObjects)
		spec.WebhookTopics = nil
		return spec
	}
	if spec.SyncModel == "" {
		spec.SyncModel = reviewSyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = reviewVerificationMode(spec.Provider)
	}
	if spec.SyncModel == reviewSyncModelIngest {
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		spec.Scopes = nil
		spec.SyncObjects = withoutWebhookClaims(spec.SyncObjects)
		spec.WebhookTopics = nil
	}
	return spec
}

func isNativeReviewPullerProvider(provider string) bool {
	switch provider {
	case ProviderJudgeMe, ProviderOkendo, ProviderLoox, ProviderStamped,
		ProviderTrustpilot, ProviderReviewsIO, ProviderBazaarvoice, ProviderPowerReviews:
		return true
	default:
		return false
	}
}

func nativeReviewPullerSyncModel(provider string) string {
	switch provider {
	case ProviderJudgeMe:
		return judgeMeSyncModelNative
	case ProviderOkendo:
		return okendoSyncModelNative
	case ProviderLoox:
		return looxSyncModelNative
	case ProviderStamped:
		return stampedSyncModelNative
	case ProviderTrustpilot:
		return trustpilotSyncModelNative
	case ProviderReviewsIO:
		return reviewsIOSyncModelNative
	case ProviderBazaarvoice:
		return bazaarvoiceSyncModelNative
	case ProviderPowerReviews:
		return powerReviewsSyncModelNative
	default:
		return reviewSyncModelIngest
	}
}

func reviewVerificationMode(provider string) string {
	switch provider {
	case ProviderYotpo:
		return "yotpo_app_key_secret_reviews_rest_tokenized_review_webhook_ingest_pending_signed_webhooks_live_certification"
	case ProviderJudgeMe:
		return "judgeme_api_token_reviews_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderOkendo:
		return "okendo_merchant_api_key_reviews_rest_cursor_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderLoox:
		return "loox_reviews_api_key_reviews_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderStamped:
		return "stamped_api_key_secret_reviews_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderTrustpilot:
		return "trustpilot_oauth_or_api_key_service_reviews_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderReviewsIO:
		return "reviewsio_api_key_product_reviews_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderBazaarvoice:
		return "bazaarvoice_conversations_api_display_reviews_offset_backfill_scheduled_retry_pending_syndication_webhook_cleanup_live_certification"
	case ProviderPowerReviews:
		return "powerreviews_api_reviews_rest_page_backfill_scheduled_retry_pending_qa_webhook_cleanup_live_certification"
	default:
		return "postwave_review_ingest_token_pending_provider_adapter"
	}
}

func withoutWebhookClaims(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" || strings.Contains(normalized, "webhook") {
			continue
		}
		out = append(out, value)
	}
	return out
}

func withoutProviderField(fields []ProviderField, key string) []ProviderField {
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if strings.EqualFold(strings.TrimSpace(field.Key), key) {
			continue
		}
		out = append(out, field)
	}
	return out
}

func normalizeIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("provider is required")
	}
	spec, ok := ProviderSpecByKey(in.Provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported review provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	delete(settings, "provider_cleanup")
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if spec.SyncModel == reviewSyncModelIngest {
		stripReviewProviderRuntimeSettings(settings)
	} else {
		stripUndeclaredReviewProviderRuntimeSettings(settings, spec)
	}
	credentialsRef := firstString(in.CredentialsRef, settingString(settings, "credentials_ref"), settingString(settings, "credential_ref"))
	if credentialsRef != "" {
		if looksLikeRawCredentialRef(credentialsRef) {
			return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%w: credentials_ref looks like raw credential material", errRawCredentialSetting)
		}
		settings["credentials_ref"] = credentialsRef
		delete(settings, "credential_ref")
	}
	for _, field := range spec.RequiredSettings {
		switch field.Key {
		case "credentials_ref":
			if credentialsRef == "" {
				return IntegrationInput{}, ProviderSpec{}, errors.New("credentials_ref is required")
			}
		default:
			if settingString(settings, field.Key) == "" {
				return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%s is required", field.Key)
			}
		}
	}
	if err := integration_egress.ValidateSettings(integration_egress.FamilyReviews, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "store_id"),
			settingString(settings, "shop_domain"),
			settingString(settings, "business_unit_id"),
			settingString(settings, "client_name"),
			settingString(settings, "merchant_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if spec.Provider == ProviderYotpo || spec.SyncModel == reviewSyncModelIngest {
		in.Scopes = nil
	} else if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	settings["setup_surface"] = "review_integrations"
	settings["egress_policy_version"] = "v1"
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func stripReviewProviderRuntimeSettings(settings map[string]any) {
	for _, key := range reviewProviderRuntimeSettingKeys {
		delete(settings, key)
	}
}

var reviewProviderRuntimeSettingKeys = []string{
	"webhook_secret_ref",
	"webhook_signature_ref",
	"signing_secret_ref",
	"verification_token_ref",
}

func stripUndeclaredReviewProviderRuntimeSettings(settings map[string]any, spec ProviderSpec) {
	for _, key := range reviewProviderRuntimeSettingKeys {
		if reviewSpecDeclaresField(spec, key) {
			continue
		}
		delete(settings, key)
	}
}

func reviewSpecDeclaresField(spec ProviderSpec, key string) bool {
	needle := strings.ToLower(strings.TrimSpace(key))
	for _, field := range append(append([]ProviderField{}, spec.RequiredSettings...), spec.OptionalSettings...) {
		if strings.ToLower(strings.TrimSpace(field.Key)) == needle {
			return true
		}
	}
	return false
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(in.RunMode))
	if in.RunMode == "" {
		in.RunMode = "manual"
	}
	in.Cursor = strings.TrimSpace(in.Cursor)
	for i := range in.Reviews {
		in.Reviews[i].SourceID = strings.TrimSpace(in.Reviews[i].SourceID)
		in.Reviews[i].ReviewerEmail = strings.ToLower(strings.TrimSpace(in.Reviews[i].ReviewerEmail))
		in.Reviews[i].ReviewerName = strings.TrimSpace(in.Reviews[i].ReviewerName)
		in.Reviews[i].ProductID = strings.TrimSpace(in.Reviews[i].ProductID)
		in.Reviews[i].VariantID = strings.TrimSpace(in.Reviews[i].VariantID)
		in.Reviews[i].OrderID = strings.TrimSpace(in.Reviews[i].OrderID)
		in.Reviews[i].CustomerID = strings.TrimSpace(in.Reviews[i].CustomerID)
		in.Reviews[i].Title = strings.TrimSpace(in.Reviews[i].Title)
		in.Reviews[i].Body = strings.TrimSpace(in.Reviews[i].Body)
		in.Reviews[i].ReviewType = strings.TrimSpace(in.Reviews[i].ReviewType)
		in.Reviews[i].Status = strings.ToLower(strings.TrimSpace(in.Reviews[i].Status))
		in.Reviews[i].EventName = strings.TrimSpace(in.Reviews[i].EventName)
	}
	return in
}

func copySettings(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+4)
	for k, v := range in {
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

func rawCredentialSetting(settings map[string]any) string {
	for _, key := range []string{
		"access_token",
		"api_key",
		"api_secret",
		"client_secret",
		"consumer_secret",
		"password",
		"private_app_token",
		"refresh_token",
		"secret",
		"token",
		"webhook_secret",
	} {
		if _, ok := settings[key]; ok {
			return key
		}
	}
	return ""
}

func looksLikeRawCredentialRef(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return true
	}
	rawPrefixes := []string{
		"bearer ",
		"basic ",
		"sk_live_",
		"sk_test_",
		"rk_live_",
		"pk_live_",
		"shpat_",
		"xoxb-",
		"xoxp-",
		"ya29.",
		"ghp_",
		"gho_",
		"github_pat_",
		"glpat-",
		"pat-",
		"eyj",
	}
	for _, prefix := range rawPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if strings.ContainsAny(trimmed, "\r\n\t ") {
		return true
	}
	if strings.Count(trimmed, ".") >= 2 && strings.HasPrefix(trimmed, "eyJ") {
		return true
	}
	return len(trimmed) >= 80 && !strings.Contains(trimmed, "://") && !strings.Contains(trimmed, ":")
}

func settingString(settings map[string]any, key string) string {
	v, ok := settings[strings.ToLower(strings.TrimSpace(key))]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func firstString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// withRequiredLists gives a spec every list ReviewProviderSpec requires as an
// array (capabilities, required_settings, scopes, sync_objects). Yotpo and the
// ingest-token providers have no OAuth scopes and withReviewSpecDefaults
// clears them; a nil slice marshals to JSON null, which the contract does not
// allow.
func withRequiredLists(spec ProviderSpec) ProviderSpec {
	if spec.Capabilities == nil {
		spec.Capabilities = []string{}
	}
	if spec.RequiredSettings == nil {
		spec.RequiredSettings = []ProviderField{}
	}
	if spec.Scopes == nil {
		spec.Scopes = []string{}
	}
	if spec.SyncObjects == nil {
		spec.SyncObjects = []string{}
	}
	return spec
}
