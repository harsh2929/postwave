// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

const (
	loyaltySyncModelIngest       = "postwave_loyalty_ingest"
	smileSyncModelNative         = "smile_customers_points_transactions_rewards_rest_signed_app_webhooks"
	loyaltyLionSyncModelNative   = "loyaltylion_customers_points_tiers_rest_page_backfill"
	rivoSyncModelNative          = "rivo_customers_points_referrals_rest_page_backfill"
	referralCandySyncModelNative = "referralcandy_referrals_rewards_rest_page_backfill"
	friendbuySyncModelNative     = "friendbuy_advocates_referrals_rewards_rest_cursor_backfill"
)

var providerSpecs = []ProviderSpec{
	{
		Provider:      ProviderSmile,
		Name:          "Smile.io",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Smile.io"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Smile.io API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Smile account ID", Help: "Smile account_id used to route signed app webhooks; required when webhook_secret_ref is configured"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference containing the Smile app client secret used for Smile-Signature verification"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Smile.io API host override for testing or regional routing"},
			{Key: "page_size", Label: "Page size", Help: "Optional customer pull page size, capped at 100"},
			{Key: "program_id", Label: "Program ID", Help: "Optional loyalty program identifier"},
			{Key: "sync_points_transactions", Label: "Sync points transactions", Help: "Optional false/off switch for Smile.io /points_transactions event backfill when the token lacks points_transaction:read"},
			{Key: "sync_reward_fulfillments", Label: "Sync reward fulfillments", Help: "Optional false/off switch for Smile.io /reward_fulfillments event backfill when the token lacks reward_fulfillment:read"},
		},
		Scopes:        []string{"customer:read", "points_transaction:read", "reward_fulfillment:read"},
		SyncObjects:   []string{"customers", "points", "vip_tiers", "points_transactions", "loyalty_events", "app_webhooks"},
		WebhookTopics: []string{"ping", "customer/updated"},
		DocsURL:       "/docs/integrations/smile",
	},
	{
		Provider:      ProviderLoyaltyLion,
		Name:          "LoyaltyLion",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "LoyaltyLion site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing LoyaltyLion API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for LoyaltyLion base64 HMAC webhook verification"},
			{Key: "program_id", Label: "Program ID", Help: "Optional loyalty program identifier"},
		},
		Scopes:        []string{"customers.read", "points.read", "tiers.read", "rewards.read", "webhooks.write"},
		SyncObjects:   []string{"customers", "points", "tiers", "reward_events", "webhooks"},
		WebhookTopics: []string{"customer.approved", "points.approved", "reward.claimed", "tier.changed"},
		DocsURL:       "/docs/integrations/loyaltylion",
	},
	{
		Provider:      ProviderRivo,
		Name:          "Rivo",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Rivo"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Rivo API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Rivo webhook verification"},
			{Key: "program_id", Label: "Program ID", Help: "Optional loyalty program identifier"},
		},
		Scopes:        []string{"customers.read", "points.read", "referrals.read", "webhooks.write"},
		SyncObjects:   []string{"customers", "points", "referrals", "reward_events", "webhooks"},
		WebhookTopics: []string{"customer.created", "points.updated", "referral.completed", "reward.redeemed"},
		DocsURL:       "/docs/integrations/rivo",
	},
	{
		Provider:      ProviderReferralCandy,
		Name:          "ReferralCandy",
		Category:      "loyalty",
		AuthMode:      "api_signature_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "access_id", Label: "Access ID", Required: true, Help: "ReferralCandy API access ID"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the ReferralCandy API secret"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional ReferralCandy campaign identifier"},
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional Shopify domain for campaign context"},
		},
		Scopes:        []string{},
		SyncObjects:   []string{"advocates", "referrals", "rewards", "webhooks"},
		WebhookTopics: []string{},
		DocsURL:       "/docs/integrations/referralcandy",
	},
	{
		Provider:      ProviderGrowave,
		Name:          "Growave",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Growave"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Growave API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Growave webhook verification"},
			{Key: "program_id", Label: "Program ID", Help: "Optional Growave loyalty program identifier"},
		},
		Scopes:        []string{"customers.read", "points.read", "vip_tiers.read", "referrals.read", "webhooks.write"},
		SyncObjects:   []string{"customers", "points", "vip_tiers", "referrals", "rewards", "webhooks"},
		WebhookTopics: []string{"customer.created", "points.updated", "reward.redeemed", "referral.completed"},
		DocsURL:       "/docs/integrations/growave",
	},
	{
		Provider:      ProviderMarsello,
		Name:          "Marsello",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Marsello account or merchant identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Marsello API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional Shopify domain for commerce context"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Marsello webhook verification"},
			{Key: "program_id", Label: "Program ID", Help: "Optional loyalty program identifier"},
		},
		Scopes:        []string{"customers.read", "loyalty.read", "marketing.read", "webhooks.write"},
		SyncObjects:   []string{"customers", "points", "tiers", "campaigns", "reward_events", "webhooks"},
		WebhookTopics: []string{"customer.created", "loyalty.points_earned", "loyalty.reward_redeemed", "tier.changed"},
		DocsURL:       "/docs/integrations/marsello",
	},
	{
		Provider:      ProviderAntavo,
		Name:          "Antavo",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "program_id", Label: "Program ID", Required: true, Help: "Antavo loyalty program identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Antavo API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "region", Label: "Region", Help: "Optional Antavo API region"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Antavo webhook verification"},
		},
		Scopes:        []string{"customers.read", "events.read", "rewards.read", "tiers.read", "webhooks.write"},
		SyncObjects:   []string{"customers", "events", "points", "tiers", "rewards", "webhooks"},
		WebhookTopics: []string{"customer.created", "event.created", "points.changed", "reward.redeemed", "tier.changed"},
		DocsURL:       "/docs/integrations/antavo",
	},
	{
		Provider:      ProviderFriendbuy,
		Name:          "Friendbuy",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Required: true, Help: "Friendbuy referral campaign identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Friendbuy API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Friendbuy webhook verification"},
			{Key: "shop_domain", Label: "Shop domain", Help: "Optional Shopify domain for campaign context"},
		},
		Scopes:        []string{"advocates.read", "referrals.read", "rewards.read", "webhooks.write"},
		SyncObjects:   []string{"advocates", "referrals", "offers", "rewards", "webhooks"},
		WebhookTopics: []string{"advocate.created", "referral.created", "referral.converted", "reward.issued"},
		DocsURL:       "/docs/integrations/friendbuy",
	},
	{
		Provider:      ProviderTalkable,
		Name:          "Talkable",
		Category:      "loyalty",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "segments", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Talkable site or campaign site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Talkable API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "campaign_id", Label: "Campaign ID", Help: "Optional Talkable campaign filter"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Talkable webhook verification"},
		},
		Scopes:        []string{"advocates.read", "referrals.read", "offers.read", "webhooks.write"},
		SyncObjects:   []string{"advocates", "referrals", "offers", "rewards", "webhooks"},
		WebhookTopics: []string{"advocate.created", "referral.created", "referral.purchased", "reward.issued"},
		DocsURL:       "/docs/integrations/talkable",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := append([]ProviderSpec(nil), providerSpecs...)
	for i := range out {
		out[i] = withLoyaltySpecDefaults(out[i])
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
			return withLoyaltySpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

func withLoyaltySpecDefaults(spec ProviderSpec) ProviderSpec {
	// Capabilities, RequiredSettings, Scopes and SyncObjects carry no
	// `omitempty`, so a nil slice marshals to JSON null rather than being left
	// out. Clients type all four as arrays, and a provider that simply needs no
	// scopes -- the ordinary case for an API-key integration -- handed them a
	// null that throws on the first .map().
	//
	// OptionalSettings and WebhookTopics are deliberately untouched: they DO
	// carry `omitempty`, so nil means "absent field", which is a shape clients
	// already handle.
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
	if spec.Provider == ProviderSmile {
		spec.SyncModel = smileSyncModelNative
		spec.VerificationMode = loyaltyVerificationMode(spec.Provider)
		spec.SyncObjects = []string{"customers", "points", "vip_tiers", "points_transactions", "loyalty_events", "app_webhooks"}
		spec.WebhookTopics = []string{"ping", "customer/updated"}
		return spec
	}
	if isNativeLoyaltyPullerProvider(spec.Provider) {
		spec.SyncModel = nativeLoyaltyPullerSyncModel(spec.Provider)
		spec.VerificationMode = loyaltyVerificationMode(spec.Provider)
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		spec.Scopes = withoutWebhookClaims(spec.Scopes)
		spec.SyncObjects = withoutWebhookClaims(spec.SyncObjects)
		spec.WebhookTopics = nil
		return spec
	}
	if spec.SyncModel == "" {
		spec.SyncModel = loyaltySyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = loyaltyVerificationMode(spec.Provider)
	}
	if spec.SyncModel == loyaltySyncModelIngest {
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		// []string{}, not nil. This branch means "the ingest model has no OAuth
		// scopes", which is a true statement about an EMPTY set -- but Scopes
		// carries no `omitempty`, so nil says it in JSON as `null`, which is
		// what a client crashes on. The normalisation at the top of this
		// function cannot help: this assignment runs after it.
		//
		// WebhookTopics on the next line stays nil deliberately -- that field
		// DOES carry `omitempty`, so nil means "absent", not "null".
		spec.Scopes = []string{}
		spec.SyncObjects = withoutWebhookClaims(spec.SyncObjects)
		spec.WebhookTopics = nil
	}
	return spec
}

func isNativeLoyaltyPullerProvider(provider string) bool {
	switch provider {
	case ProviderLoyaltyLion, ProviderRivo, ProviderReferralCandy, ProviderFriendbuy:
		return true
	default:
		return false
	}
}

func nativeLoyaltyPullerSyncModel(provider string) string {
	switch provider {
	case ProviderLoyaltyLion:
		return loyaltyLionSyncModelNative
	case ProviderRivo:
		return rivoSyncModelNative
	case ProviderReferralCandy:
		return referralCandySyncModelNative
	case ProviderFriendbuy:
		return friendbuySyncModelNative
	default:
		return loyaltySyncModelIngest
	}
}

func loyaltyVerificationMode(provider string) string {
	switch provider {
	case ProviderSmile:
		return "smile_api_token_customers_points_transactions_rewards_rest_signed_app_webhooks_pending_cleanup_live_certification"
	case ProviderLoyaltyLion:
		return "loyaltylion_program_api_key_customers_points_tiers_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderRivo:
		return "rivo_developer_api_key_customers_points_referrals_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderReferralCandy:
		return "referralcandy_signed_api_referrals_rewards_rest_page_backfill_scheduled_retry_pending_callback_cleanup_live_certification"
	case ProviderGrowave:
		return "growave_oauth_or_api_key_pending_loyalty_adapter"
	case ProviderMarsello:
		return "marsello_api_key_pending_loyalty_adapter"
	case ProviderAntavo:
		return "antavo_api_key_pending_loyalty_adapter"
	case ProviderFriendbuy:
		return "friendbuy_api_key_advocates_referrals_rewards_rest_cursor_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderTalkable:
		return "talkable_api_key_pending_referral_adapter"
	default:
		return "postwave_loyalty_ingest_token_pending_provider_adapter"
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
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported loyalty provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if spec.SyncModel == loyaltySyncModelIngest {
		stripLoyaltyProviderRuntimeSettings(settings)
	} else {
		stripUndeclaredLoyaltyProviderRuntimeSettings(settings, spec)
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
	if err := integration_egress.ValidateSettings(integration_egress.FamilyLoyalty, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if spec.Provider == ProviderSmile &&
		settingString(settings, "webhook_secret_ref") != "" &&
		firstString(settingString(settings, "account_id"), settingString(settings, "smile_account_id")) == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("account_id is required when webhook_secret_ref is configured for Smile.io app webhooks")
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "shop_domain"),
			settingString(settings, "site_id"),
			settingString(settings, "campaign_id"),
			settingString(settings, "access_id"),
			settingString(settings, "account_id"),
			settingString(settings, "program_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if spec.SyncModel == loyaltySyncModelIngest {
		in.Scopes = nil
	} else if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	settings["setup_surface"] = "loyalty_integrations"
	settings["egress_policy_version"] = "v1"
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func stripLoyaltyProviderRuntimeSettings(settings map[string]any) {
	for _, key := range loyaltyProviderRuntimeSettingKeys {
		delete(settings, key)
	}
}

var loyaltyProviderRuntimeSettingKeys = []string{
	"webhook_secret_ref",
	"webhook_signature_ref",
	"signing_secret_ref",
	"verification_token_ref",
}

func stripUndeclaredLoyaltyProviderRuntimeSettings(settings map[string]any, spec ProviderSpec) {
	for _, key := range loyaltyProviderRuntimeSettingKeys {
		if loyaltySpecDeclaresField(spec, key) {
			continue
		}
		delete(settings, key)
	}
}

func loyaltySpecDeclaresField(spec ProviderSpec, key string) bool {
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
	for i := range in.Members {
		in.Members[i].SourceID = strings.TrimSpace(in.Members[i].SourceID)
		in.Members[i].Email = strings.ToLower(strings.TrimSpace(in.Members[i].Email))
		in.Members[i].FirstName = strings.TrimSpace(in.Members[i].FirstName)
		in.Members[i].LastName = strings.TrimSpace(in.Members[i].LastName)
		in.Members[i].FullName = strings.TrimSpace(in.Members[i].FullName)
		in.Members[i].Phone = strings.TrimSpace(in.Members[i].Phone)
		in.Members[i].VIPTier = strings.TrimSpace(in.Members[i].VIPTier)
		in.Members[i].ReferralCode = strings.TrimSpace(in.Members[i].ReferralCode)
	}
	for i := range in.Events {
		in.Events[i].SourceID = strings.TrimSpace(in.Events[i].SourceID)
		in.Events[i].Email = strings.ToLower(strings.TrimSpace(in.Events[i].Email))
		in.Events[i].EventName = strings.TrimSpace(in.Events[i].EventName)
		in.Events[i].RewardID = strings.TrimSpace(in.Events[i].RewardID)
		in.Events[i].RewardName = strings.TrimSpace(in.Events[i].RewardName)
		in.Events[i].VIPTier = strings.TrimSpace(in.Events[i].VIPTier)
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
	for _, prefix := range []string{
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
	} {
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
