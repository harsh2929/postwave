// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"strings"

	marketingintegrations "github.com/postwave/postwave/apps/api/internal/marketing_integrations"
)

type ConnectorContract struct {
	Slug                string   `json:"slug"`
	Owner               string   `json:"owner"`
	Badge               Badge    `json:"badge"`
	RuntimeStatus       string   `json:"runtime_status"`
	NativeManaged       bool     `json:"native_managed"`
	NativeVerified      bool     `json:"native_verified"`
	ImplementationDepth string   `json:"implementation_depth"`
	PublicClaim         string   `json:"public_claim"`
	AuthModes           []string `json:"auth_modes"`
	CredentialStorage   string   `json:"credential_storage"`
	SecretPolicy        string   `json:"secret_policy"`
	SetupSurface        string   `json:"setup_surface"`
	Monitoring          []string `json:"monitoring"`
	LifecycleActions    []string `json:"lifecycle_actions"`
	BridgeChannels      []string `json:"bridge_channels,omitempty"`
	RequiredScopes      []string `json:"required_scopes,omitempty"`
	DataObjects         []string `json:"data_objects"`
	EventTopics         []string `json:"event_topics"`
	ComplianceGates     []string `json:"compliance_gates"`
	PrivacyActions      []string `json:"privacy_actions"`
	RateLimitPolicy     string   `json:"rate_limit_policy"`
	PartnerReview       string   `json:"partner_review"`
}

func ContractFor(item CatalogItem) ConnectorContract {
	if hasSource(item, "support_integration") {
		return ConnectorContract{
			Slug:                item.Slug,
			Owner:               "roadmap",
			Badge:               BadgePlanned,
			RuntimeStatus:       "held",
			ImplementationDepth: "release_held",
			PublicClaim:         "Release-held support-provider source record; runtime unavailable.",
			AuthModes:           []string{},
			CredentialStorage:   "unavailable",
			SecretPolicy:        "no_credentials_accepted",
			SetupSurface:        "unavailable",
			Monitoring:          []string{},
			LifecycleActions:    []string{},
			BridgeChannels:      []string{},
			RequiredScopes:      []string{},
			DataObjects:         []string{},
			EventTopics:         []string{},
			ComplianceGates:     []string{},
			PrivacyActions:      []string{},
			RateLimitPolicy:     "unavailable",
			PartnerReview:       "release_held",
		}
	}
	return runtimeConnectorContractFixture(item)
}

// runtimeConnectorContractFixture retains the archived pre-hold composition
// for same-package algorithm tests. Public code must call ContractFor so a
// support-provider source can never regain live claims through helper order.
func runtimeConnectorContractFixture(item CatalogItem) ConnectorContract {
	contract := ConnectorContract{
		Slug:                item.Slug,
		Owner:               contractOwner(item),
		Badge:               item.Badge,
		RuntimeStatus:       string(item.RuntimeStatus),
		NativeManaged:       item.Badge == BadgeNative && item.RuntimeStatus != RuntimePlanned,
		NativeVerified:      isNativeVerified(item),
		ImplementationDepth: implementationDepthFor(item),
		PublicClaim:         publicClaim(item),
		AuthModes:           authModesFor(item),
		CredentialStorage:   credentialStorageFor(item),
		SecretPolicy:        secretPolicyFor(item),
		SetupSurface:        surfaceLabel(item),
		Monitoring:          monitoringFor(item),
		LifecycleActions:    LifecycleActions(item),
		BridgeChannels:      bridgeChannelsFor(item),
		RequiredScopes:      requiredScopesFor(item),
		DataObjects:         dataObjectsFor(item),
		EventTopics:         eventTopicsFor(item),
		ComplianceGates:     complianceGatesFor(item),
		PrivacyActions:      privacyActionsFor(item),
		RateLimitPolicy:     rateLimitPolicyFor(item),
		PartnerReview:       partnerReviewFor(item),
	}
	return contract
}

func contractOwner(item CatalogItem) string {
	switch {
	case item.Badge == BadgePlanned:
		return "roadmap"
	case item.Badge == BadgeNative:
		return "postwave"
	case item.Badge == BadgePartner:
		return "partner"
	case item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge"):
		return "bridge"
	case item.Badge == BadgeAPISDK:
		return "developer"
	case item.Badge == BadgeMigrationOnly:
		return "postwave_migration"
	default:
		return "unknown"
	}
}

func publicClaim(item CatalogItem) string {
	switch {
	case item.Badge == BadgePlanned:
		return "Planned integration listing; no native support claim."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimeAvailable:
		return "Native Moosewave-managed connector with verified auth, sync, monitoring, and lifecycle coverage."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimeDelegated:
		return "Native Moosewave-managed connector delegated to an existing Moosewave surface; verify surface-specific runtime evidence before treating it as fully built out."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "salesforce":
		return "Native Moosewave-managed Salesforce connector with local connected-app OAuth, SOQL sync, monitoring, retry, and lifecycle runtime complete; public full-availability claims require live Salesforce org certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "meta":
		return "Native Moosewave-managed Meta Custom Audiences connector with local credential resolution, consent-filtered Graph delivery, monitoring, retry, and lifecycle runtime complete; public full-availability claims require live Meta app review and provider certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "google-ads":
		return "Native Moosewave-managed Google Ads Customer Match connector with local Data Manager credential resolution, consent-filtered add/remove delivery, request-status monitoring, retry, and lifecycle runtime complete; public full-availability claims require live Google Ads/Data Manager certification evidence. Legacy OfflineUserDataJob remains a separate partial surface; Google Lead Form Extensions is tracked as a separate local-runtime-complete lead-capture slice."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "google-lead-form-extensions":
		return "Native Moosewave-managed Google Lead Form Extensions connector with local Google Ads credential references, GoogleAdsService.Search lead_form_submission_data pull/import, retry continuation, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Google Ads certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "carrd":
		return "Native Moosewave-managed Carrd Custom URL form receiver with local route-token verification, GET/POST/JSON/form/XML submission ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Carrd Pro Plus site certification evidence plus Custom URL destination cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "optinmonster":
		return "Native Moosewave-managed OptinMonster Webhook receiver with local account/campaign route-token verification, JSON lead/campaign/meta/smart_tags submission ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live OptinMonster Pro account certification evidence plus Webhook destination cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "privy":
		return "Native Moosewave-managed Privy custom Webhook receiver with local account/campaign Basic Auth verification, signup/contact JSON ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Privy account certification evidence plus custom Webhook destination cleanup, Basic Auth rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "convertflow":
		return "Native Moosewave-managed ConvertFlow custom Webhook receiver with local account/campaign route-token verification, fields-submitted/contact/conversion JSON ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live ConvertFlow account certification evidence plus webhook automation cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "sleeknote":
		return "Native Moosewave-managed Sleeknote custom integration receiver with local account/campaign route-token verification, GET/form/JSON signup ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Sleeknote account certification evidence plus custom integration cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "wisepops":
		return "Native Moosewave-managed Wisepops signed Webhook receiver with local account/campaign HMAC-SHA256 verification, contact-array submission ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Wisepops account certification evidence plus hook cleanup, API-key rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "poptin":
		return "Native Moosewave-managed Poptin Webhooks receiver with local account/popup route-token verification, GET/form/JSON popup lead ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Poptin account certification evidence plus Webhooks integration cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "hello-bar":
		return "Native Moosewave-managed Hello Bar Webhook receiver with local site/campaign route-token verification, GET/form/JSON subscriber ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Hello Bar account certification evidence plus Webhook destination cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "landingi":
		return "Native Moosewave-managed Landingi Webhook receiver with local account/page route-token verification, GET/form/JSON lead ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Landingi account certification evidence plus Webhook integration cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "kickofflabs":
		return "Native Moosewave-managed KickoffLabs outbound Webhook receiver with local account/campaign route-token verification, GET/form/JSON lead/referral/reward ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live KickoffLabs account certification evidence plus outbound Webhook cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "ninja-forms":
		return "Native Moosewave-managed Ninja Forms Webhooks add-on receiver with local WordPress site/form route-token verification, GET/form/JSON submission ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live WordPress/Ninja Forms certification evidence plus Webhooks action cleanup, token rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "outgrow":
		return "Native Moosewave-managed Outgrow Webhook receiver with local account/campaign Basic-or-route-token verification, JSON/form lead/visit/result ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Outgrow account certification evidence plus Webhook destination cleanup, credential rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "shortstack":
		return "Native Moosewave-managed ShortStack Webhook form integration receiver with local account/campaign X-SS-Signature HMAC-SHA1 verification, form/JSON entry ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live ShortStack account certification evidence plus Webhook form integration cleanup, secret rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "riddle":
		return "Native Moosewave-managed Riddle Webhook receiver with local account/quiz signature-or-route-token verification, JSON lead/result ingest, durable webhook idempotency, canonical profile/event/list import, run history, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Riddle account certification evidence plus Webhook destination cleanup, credential rotation, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isLeadPullerLiveCertificationPending(item):
		return "Native Moosewave-managed lead-capture connector with local credential-reference REST submission pulls, scheduled retry continuation, canonical profile/event/list import, run history, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete for the implemented puller slice; public full-availability claims require live provider certification evidence plus provider-managed webhook, credential cleanup, reconnect, data-delete, and broader form-object proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "postscript":
		return "Native Moosewave-managed Postscript SMS connector with local API-key credential refs, phone-keyed subscriber sync, signed route-token webhook ingest, retry, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Postscript certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "attentive":
		return "Native Moosewave-managed Attentive SMS connector with local API-key credential refs, phone-keyed subscriber sync, HMAC route-token webhook ingest, retry, and lifecycle cleanup evidence runtime complete; public full-availability claims require live Attentive certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && hasSource(item, "sms"):
		return "Release-held SMS provider foundation; it must not be represented as send-, callback-, A2P-, billing-, or end-to-end-MMS-ready until durable provider reconciliation and tenant-bound credential ownership are deployed."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isSnowflakeWarehouseLiveCertificationPending(item):
		return "Native Moosewave-managed Snowflake warehouse connector with local account/database/schema/warehouse validation, credential-reference SQL executor wiring, stored export manifests and JSONL artifacts, deterministic DDL/COPY/query plans, SQL export/health execution, dry-run guards, run history, row-preserving disconnect, and lifecycle cleanup evidence runtime complete for the implemented warehouse export/health slice; public full-availability claims require live Snowflake account certification evidence plus remote import row materialization, schema discovery, provider-aware retry, and Snowflake-side cleanup proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isCRMPullerLiveCertificationPending(item):
		return "Native Moosewave-managed CRM connector with local credential-reference REST read pulls, OAuth refresh where supported, scheduled retry continuation, canonical profile import, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete for the implemented puller slice; public full-availability claims require live provider certification evidence plus any provider-managed webhook, account/deal/activity, list, tag, order, appointment, and cleanup expansion proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isReviewPullerLiveCertificationPending(item):
		return "Native Moosewave-managed review connector with local credential-reference REST review pulls, scheduled retry continuation, canonical review/reviewer/event import, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete for the implemented review-puller slice; public full-availability claims require live provider certification evidence and any provider-managed webhook/Q&A/syndication expansion proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isLoyaltyPullerLiveCertificationPending(item):
		return "Native Moosewave-managed loyalty connector with local credential-reference REST loyalty pulls, scheduled retry continuation, canonical loyalty profile/event import for the implemented provider slice, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete; public full-availability claims require live provider certification evidence and any provider-managed webhook/reward/referral expansion proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isSubscriptionPullerLiveCertificationPending(item):
		return "Native Moosewave-managed subscription/shipping connector with local credential-reference read pulls, scheduled retry continuation, canonical subscription or shipment import, run history, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete for the implemented provider-puller slice; public full-availability claims require live provider certification evidence plus provider-managed webhook/callback, credential cleanup, reconnect, data-delete, and extended-object expansion proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isAnalyticsPullerLiveCertificationPending(item):
		return "Native Moosewave-managed analytics connector with local credential-reference profile pulls, scheduled retry continuation, canonical profile import, run history, disconnect-safe local writes, and lifecycle cleanup evidence runtime complete for the implemented provider-puller slice; public full-availability claims require live provider certification evidence plus provider-managed webhook/event/report/warehouse expansion, credential cleanup, reconnect, and data-delete proof."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "tiktok":
		return "Native Moosewave-managed TikTok Audiences connector with local credential resolution, consent-filtered Customer File upload/create/update delivery, provider-status readback, retry, and lifecycle runtime complete; public full-availability claims require live TikTok advertiser certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "snap":
		return "Native Moosewave-managed Snap Audiences connector with local credential resolution, consent-filtered segment-user add/remove/replace delivery, provider-status readback, retry, and lifecycle runtime complete; public full-availability claims require live Snap account certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && item.Slug == "linkedin":
		return "Native Moosewave-managed LinkedIn Matched Audiences connector with local credential resolution, consent-filtered DMP segment-user add/remove delivery, provider-status readback, retry, and lifecycle runtime complete; public full-availability claims require live LinkedIn Audiences-program certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isNativeRuntimeCompleteLiveCertificationPending(item):
		return "Native Moosewave-managed connector with local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete; public full-availability claims require live provider certification evidence."
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial:
		return "Native Moosewave-managed connector foundation; full API verification and runtime coverage are still in progress."
	case item.Badge == BadgeNative:
		return "Native Moosewave-managed connector; runtime verification status is unspecified."
	case item.Badge == BadgePartner:
		return "Partner or marketplace integration listing."
	case item.Badge == BadgeZapier:
		return "Zapier or bridge recipe integration."
	case item.Badge == BadgeWebhook:
		return "Webhook or API bridge integration."
	case item.Badge == BadgeAPISDK:
		return "API/SDK integration surface."
	case item.Badge == BadgeMigrationOnly:
		return "Migration-only adapter."
	default:
		return "Integration catalog entry."
	}
}

func implementationDepthFor(item CatalogItem) string {
	switch {
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimeAvailable:
		return "verified_native"
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimeDelegated:
		return "delegated_native_surface"
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial && isNativeRuntimeCompleteLiveCertificationPending(item):
		return "native_runtime_complete_live_certification_pending"
	case item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial:
		return "native_foundation"
	case item.Badge == BadgeNative:
		return "native_unclassified"
	case item.Badge == BadgePartner:
		return "partner_managed"
	case item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge"):
		return "bridge_managed"
	case item.Badge == BadgeAPISDK:
		return "developer_surface"
	case item.Badge == BadgeMigrationOnly:
		return "migration_adapter"
	case item.Badge == BadgePlanned:
		return "planned"
	default:
		return "catalog_listing"
	}
}

func isNativeRuntimeCompleteLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "123formbuilder", "ada", "adobe-commerce", "aftership", "amplitude", "appstle", "asana-support", "attentive", "bandwidth", "bazaarvoice", "bigcommerce", "bold-subscriptions", "carrd", "chargebee", "clickup-support", "close", "cognito-forms", "convertflow", "copper", "crisp", "drift", "facebook-lead-ads", "feathery", "fillout", "formidable-forms", "formaloo", "formstack", "formsite", "freshchat", "freshdesk", "freshsales", "friendbuy", "front", "gladly", "google-ads", "google-forms", "google-lead-form-extensions", "gorgias", "gravity-forms", "groove", "hello-bar", "help-scout", "helpcrunch", "highlevel", "hubspot", "hubspot-service-hub", "instapage", "intercom", "jira-service-management", "jotform", "judge-me", "kayako", "keap", "kickofflabs", "klaviyo", "kustomer", "landingi", "leadpages", "linear", "linkedin", "livechat", "loox", "loop-subscriptions", "loyaltylion", "meta", "microsoft-dynamics-365", "mixpanel", "ninja-forms", "okendo", "olark", "optinmonster", "outgrow", "paperform", "paypal", "pipedrive", "poptin", "posthog", "postscript", "powerreviews", "privy", "razorpay", "reamaze", "recharge", "referralcandy", "reviews-io", "riddle", "rivo", "salesforce", "salesforce-service-cloud", "seal-subscriptions", "shipstation", "shopify", "shortstack", "skio", "sleeknote", "smile", "snowflake", "snap", "square", "squarespace-commerce", "stamped", "stripe", "surveymonkey", "tally", "telnyx", "tidio", "tiktok", "triple-whale", "trustpilot", "twilio", "typeform", "unbounce", "webflow", "wisepops", "woocommerce", "wix-stores", "wix", "wpforms", "yotpo", "zendesk", "zoho-crm", "zoho-desk":
		return true
	default:
		return false
	}
}

func isLeadPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "123formbuilder", "cognito-forms", "feathery", "formidable-forms", "formaloo", "formstack", "formsite", "google-forms", "gravity-forms", "instapage", "leadpages", "paperform", "surveymonkey", "tally", "unbounce", "wpforms":
		return true
	default:
		return false
	}
}

func isCRMPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "zoho-crm", "microsoft-dynamics-365", "keap":
		return true
	default:
		return false
	}
}

func isReviewPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "judge-me", "okendo", "loox", "stamped", "trustpilot", "reviews-io", "bazaarvoice", "powerreviews":
		return true
	default:
		return false
	}
}

func isLoyaltyPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "loyaltylion", "rivo", "referralcandy", "friendbuy":
		return true
	default:
		return false
	}
}

func isSubscriptionPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "skio", "aftership", "shipstation", "chargebee", "loop-subscriptions", "appstle", "seal-subscriptions", "bold-subscriptions":
		return true
	default:
		return false
	}
}

func isShippingPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "aftership", "shipstation":
		return true
	default:
		return false
	}
}

func isAnalyticsPullerLiveCertificationPending(item CatalogItem) bool {
	switch item.Slug {
	case "posthog", "triple-whale", "mixpanel", "amplitude":
		return true
	default:
		return false
	}
}

func isSnowflakeWarehouseLiveCertificationPending(item CatalogItem) bool {
	return item.Slug == "snowflake"
}

// isPlannedCatalogItem reports whether the catalog marks the item as planned,
// either by runtime status or by badge.
func isPlannedCatalogItem(item CatalogItem) bool {
	return item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned
}

// webhookLeadAuthModesBySlug lists the credential contracts for the lead and
// on-site growth providers that deliver through authenticated inbound
// webhooks. authModesFor consults it after the planned/pending checks and
// before the managed-provider table, exactly where the per-slug branches it
// replaces used to sit; the first entry of each list is the primary mode.
var webhookLeadAuthModesBySlug = map[string][]string{
	"optinmonster": {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"privy":        {"basic_auth_ref_webhook", "credentials_ref", "credential_ref_alias"},
	"convertflow":  {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"sleeknote":    {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"wisepops":     {"api_key_ref_hmac_webhook", "credentials_ref", "credential_ref_alias"},
	"poptin":       {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"hello-bar":    {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"landingi":     {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"kickofflabs":  {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"ninja-forms":  {"webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"outgrow":      {"webhook_basic_or_route_token_ref", "basic_auth_ref_webhook", "webhook_route_token_ref", "credentials_ref", "credential_ref_alias"},
	"shortstack":   {"webhook_secret_ref_hmac_sha1", "credentials_ref", "credential_ref_alias"},
}

func authModesFor(item CatalogItem) []string {
	if hasSource(item, "mcp") {
		return []string{}
	}
	if hasSource(item, "sms") && isPlannedCatalogItem(item) {
		// No process-global provider secret is a tenant credential contract.
		// Canonical hosted deployment intentionally exposes no SMS auth mode
		// until a tenant-bound encrypted provider-vault resolver is deployed.
		return []string{}
	}
	if isPlannedCatalogItem(item) {
		return []string{"not_implemented"}
	}
	if isKlaviyoNativeSurface(item) {
		return []string{"klaviyo_oauth_public_app", "klaviyo_managed_oauth_credential_ref", "klaviyo_private_api_key_ref", "klaviyo_signed_webhook_secret_ref", "klaviyo_webhook_token", "credentials_ref", "credential_ref_alias"}
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		return []string{"credentials_ref", "api_key_ref", "api_token_ref", "access_token_ref"}
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		return []string{"credentials_ref", "api_key_ref", "api_secret_ref", "service_account_ref"}
	}
	if isLeadPullerLiveCertificationPending(item) {
		return []string{"credentials_ref", "api_key_ref", "credential_ref_alias"}
	}
	if modes, ok := webhookLeadAuthModesBySlug[item.Slug]; ok {
		return append([]string(nil), modes...)
	}
	if modes, ok := managedProviderAuthModes(item); ok {
		return modes
	}
	switch {
	case item.Slug == "meta" && hasSource(item, "audience_destination"):
		return []string{"ads_access_token_ref", "credential_ref"}
	case item.Slug == "google-ads" && hasSource(item, "audience_destination"):
		return []string{"data_manager_oauth_access_token_ref", "developer_token_ref_for_legacy_google_ads_api", "credential_ref"}
	case item.Slug == "linkedin" && hasSource(item, "audience_destination"):
		return []string{"linkedin_ads_access_token_ref", "credential_ref"}
	case item.Slug == "snap" && hasSource(item, "audience_destination"):
		return []string{"snap_ads_access_token_ref", "credential_ref"}
	case item.Slug == "postscript":
		return []string{"postscript_api_key_ref", "postscript_webhook_signing_token_ref", "webhook_route_token", "credential_ref"}
	case item.Slug == "attentive":
		return []string{"attentive_api_key_ref", "attentive_webhook_hmac_secret_ref", "webhook_route_token", "credential_ref"}
	case item.Slug == "twilio":
		return []string{"twilio_account_sid_env", "twilio_auth_token_env", "twilio_webhook_signature", "messaging_service_sid", "sender_profile"}
	case item.Slug == "telnyx":
		return []string{"telnyx_api_key_env", "telnyx_ed25519_public_key_env", "messaging_profile_id", "sender_profile"}
	case item.Slug == "bandwidth":
		return []string{"bandwidth_basic_auth_env", "bandwidth_webhook_token_or_basic_auth", "application_id", "sender_profile"}
	case isSnowflakeWarehouseLiveCertificationPending(item):
		return []string{"snowflake_auth_ref", "credentials_ref", "dsn_ref", "key_pair_or_oauth_or_pat_ref"}
	case item.Slug == "shopify" || hasSource(item, "slack"):
		return []string{"oauth"}
	case isCRMPullerLiveCertificationPending(item):
		return crmPullerAuthModes(item)
	case hasSource(item, "crm"):
		return []string{"private_app_ref", "webhook_secret"}
	case hasSource(item, "lead_capture"):
		return []string{"oauth_ref", "api_key_ref", "webhook_secret_ref"}
	case isReviewPullerLiveCertificationPending(item):
		return []string{"credentials_ref", "api_key_ref", "api_token_ref"}
	case hasSource(item, "review_integration"):
		return []string{"api_key_ref", "api_token_ref", "webhook_secret_ref"}
	case isLoyaltyPullerLiveCertificationPending(item):
		return []string{"credentials_ref", "api_key_ref", "api_signature_ref"}
	case hasSource(item, "loyalty_integration"):
		return []string{"api_key_ref", "api_token_ref", "webhook_secret_ref"}
	case hasSource(item, "subscription_integration"):
		return []string{"api_key_ref", "api_token_ref", "webhook_secret_ref"}
	case hasSource(item, "support_integration"):
		return []string{"oauth_ref", "api_key_ref", "api_token_ref", "webhook_secret_ref"}
	case hasSource(item, "analytics_integration"):
		return []string{"oauth_ref", "api_key_ref", "write_key_ref", "api_secret_ref", "webhook_secret_ref"}
	case hasSource(item, "commerce") || hasSource(item, "audience_destination") || hasSource(item, "warehouse"):
		return []string{"oauth", "api_key"}
	case hasSource(item, "outbound_webhooks") || hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		return []string{"api_key", "webhook_secret"}
	case hasSource(item, "developer_marketplace"):
		return []string{"oauth_app", "api_key"}
	case hasSource(item, "migration"):
		return []string{"file_import", "api_key"}
	case hasSource(item, "sending"):
		return sendingAuthModesFor(item)
	case hasSource(item, "sms"):
		return []string{"api_key", "provider_token"}
	default:
		return []string{"api_key"}
	}
}

func crmPullerAuthModes(item CatalogItem) []string {
	switch item.Slug {
	case "zoho-crm":
		return []string{"zoho_managed_oauth_ref", "credentials_ref", "credential_ref_alias"}
	case "microsoft-dynamics-365":
		return []string{"dataverse_managed_oauth_ref", "credentials_ref", "credential_ref_alias"}
	case "keap":
		return []string{"keap_managed_oauth_ref", "keap_api_key_ref", "keap_personal_access_token_ref", "keap_service_account_key_ref", "credentials_ref", "credential_ref_alias"}
	default:
		return []string{"managed_oauth_ref", "credentials_ref"}
	}
}

func sendingAuthModesFor(item CatalogItem) []string {
	switch item.Slug {
	case "postmark":
		return []string{"postmark_account_token_env", "postmark_server_token_ref", "webhook_basic_auth_or_edge_token"}
	case "ses":
		return []string{"aws_iam_default_chain", "ses_configuration_set", "sns_topic_allowlist"}
	case "sendgrid":
		return []string{"sendgrid_event_public_key_pending", "edge_webhook_token"}
	case "mailgun":
		return []string{"mailgun_webhook_signing_key", "mailgun_api_key_ref_pending"}
	case "smtp":
		return []string{"listmonk_messenger_config", "smtp_credentials_operator_managed"}
	default:
		return []string{"provider_config", "edge_webhook_token"}
	}
}

func credentialStorageFor(item CatalogItem) string {
	switch {
	case hasSource(item, "sms") && (item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned):
		return "Unavailable: hosted multi-tenant SMS has no tenant-bound encrypted provider credential/account resolver. Process-global environment credentials are deliberately not advertised as tenant storage."
	case item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned:
		return "No credentials are stored until the connector ships."
	case isKlaviyoNativeSurface(item):
		return "Klaviyo native provider rows store only credential references for private API keys or managed public-app OAuth envelopes, plus webhook secret references and opaque webhook route tokens for signed system-webhook receipt; raw key/token material is rejected from public settings. The provider row owns lifecycle, marketing_sync_runs, marketing_webhook_events, versioned klaviyo_native cursors, native JSON:API profile/segment/source-event pulls over private-key or OAuth Bearer auth, signed webhook evidence, managed Klaviyo Webhooks API subscription reconciliation/cleanup for allowlisted credentials, scheduled provider-row polling, Klaviyo integration-writeback targets for existing-profile property updates/list adds/custom events, and local provider-cleanup acknowledgement while Webhooks API live allowlist certification, writeback live certification, OAuth live certification, provider-side cleanup certification, and live account certification remain open."
	case isMarketingNativeSurface(item):
		meta, _ := managedProviderMetadataForItem(item)
		return meta.Name + " native provider rows store only credential references and non-secret provider settings; raw key/token material is rejected from public settings. The provider row owns lifecycle, marketing_sync_runs, and delegated handoff cursor evidence while provider API import remains delegated to the migration adapter until native webhooks, writeback, cleanup automation, and live certification are promoted."
	case isKlaviyoMigrationSurface(item):
		return "Klaviyo private API keys are accepted by the migration runtime for API-backed import jobs; this is not yet a managed native provider credential-reference lifecycle."
	case item.Slug == "meta" && hasSource(item, "audience_destination"):
		return "Meta audience destinations store only audience ids and credential references in public config; the audience sync runner hydrates ads access tokens through the shared Moosewave runtime secret resolver at delivery time."
	case item.Slug == "google-ads" && hasSource(item, "audience_destination"):
		return "Google Ads Customer Match destinations store only account/list ids, transport selection, consent/terms flags, and credential references in public config; the audience sync runner hydrates OAuth tokens, and developer tokens only for legacy OfflineUserDataJob uploads, through the shared Moosewave runtime secret resolver at delivery time."
	case item.Slug == "linkedin" && hasSource(item, "audience_destination"):
		return "LinkedIn Matched Audience destinations store only sponsored-account ids, DMP segment ids, approval flags, and credential references in public config; the audience sync runner hydrates LinkedIn Marketing API access tokens through the shared Moosewave runtime secret resolver at delivery time."
	case item.Slug == "snap" && hasSource(item, "audience_destination"):
		return "Snap audience destinations store only ad-account ids, segment ids, and credential references in public config; the audience sync runner hydrates Snap Marketing API access tokens through the shared Moosewave runtime secret resolver at delivery time."
	case item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge"):
		return "Bridge credentials stay in the bridge provider; Moosewave stores only webhook/API-key references."
	case hasSource(item, "sending"):
		return "Email sending is a partial/delegated foundation: direct provider send API credentials are not accepted by this catalog facade, and deliverability tokens remain write-only/redacted until credential-reference storage is enforced."
	case hasSource(item, "sms"):
		return "First-party SMS provider credentials are operator-managed environment secrets and sender-profile identifiers; public SMS APIs store sender, registration, consent, suppression, delivery, and callback evidence, not raw provider tokens. Live provider/carrier certification remains required before full native availability."
	case isSnowflakeWarehouseLiveCertificationPending(item):
		return "Snowflake warehouse connections store only credential references and non-secret target settings. The warehouse runtime resolves Snowflake DSNs, key-pair/OAuth/PAT/password material, or workload-identity payloads through the shared secret resolver at execution time; public warehouse APIs reject raw credential material, and SQL export/health execution evidence stays on warehouse_sync_runs while live account certification, remote import row materialization, and Snowflake-side cleanup proof remain open."
	case isReviewPullerLiveCertificationPending(item):
		return "Native review provider rows store only credential references plus non-secret provider scope settings for the implemented REST puller. Raw API keys, API tokens, webhook secrets, and provider credentials are rejected from public settings; scheduled review pulls, retry cursors, sync runs, canonical review imports, and operator-managed provider_cleanup evidence stay on the review integration row while live account/webhook/Q&A/syndication certification remains open."
	case isLoyaltyPullerLiveCertificationPending(item):
		return "Native loyalty provider rows store only credential references plus non-secret provider scope settings for the implemented REST puller. Raw API keys, signature secrets, webhook secrets, and provider credentials are rejected from public settings; scheduled loyalty pulls, retry cursors, sync runs, canonical loyalty imports, and operator-managed provider_cleanup evidence stay on the loyalty integration row while live account/webhook/reward/referral certification remains open."
	case isSubscriptionPullerLiveCertificationPending(item):
		return "Native subscription and shipping provider rows store only credential references plus non-secret provider scope settings for the implemented read puller. Raw API keys, API tokens, access tokens, webhook secrets, and provider credentials are rejected from public settings; scheduled provider pulls, retry cursors, sync runs, canonical subscription/shipment imports, and operator-managed provider_cleanup evidence stay on the subscription integration row while live account/webhook/extended-object certification remains open."
	case isAnalyticsPullerLiveCertificationPending(item):
		return "Native analytics provider rows store only credential references plus non-secret project, cohort, page, and window settings for the implemented profile puller. Raw API keys, API secrets, service-account passwords, webhook secrets, and provider credentials are rejected from public settings; scheduled analytics pulls, retry cursors, sync runs, canonical profile imports, and operator-managed provider_cleanup evidence stay on the analytics integration row while live account/webhook/event/report/warehouse certification remains open."
	case isLeadPullerLiveCertificationPending(item):
		return "Native lead-capture provider rows store only credential references plus non-secret form and paging settings for the implemented REST submissions puller. Raw API keys, access tokens, webhook secrets, and provider credentials are rejected from public settings; scheduled lead pulls, retry cursors, sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account/webhook/reconnect/data-delete certification remains open."
	case item.Slug == "optinmonster":
		return "Native OptinMonster provider rows store only account/campaign settings plus a credential reference for the Moosewave-owned route token configured on the OptinMonster Webhook URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, destination cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "privy":
		return "Native Privy provider rows store only account/campaign settings plus a credential reference for the Basic auth username/password configured on the Privy custom Webhook destination. Raw usernames, passwords, and tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, custom Webhook cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "convertflow":
		return "Native ConvertFlow provider rows store only account/campaign settings plus a credential reference for the Moosewave-owned route token configured on the ConvertFlow webhook automation URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, automation cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "sleeknote":
		return "Native Sleeknote provider rows store only account/campaign settings plus a credential reference for the Moosewave-owned route token configured on the Sleeknote custom integration URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, custom integration cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "wisepops":
		return "Native Wisepops provider rows store only account/campaign settings plus a credential reference for the Wisepops API key used to verify X-Wisepops-Signature HMAC-SHA256 callbacks. Raw API keys are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, hook cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "poptin":
		return "Native Poptin provider rows store only account/popup settings plus a credential reference for the Moosewave-owned route token configured on the Poptin Webhooks integration URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, Webhooks integration cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "hello-bar":
		return "Native Hello Bar provider rows store only site/campaign settings plus a credential reference for the Moosewave-owned route token configured on the Hello Bar Webhook URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, Webhook destination cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "landingi":
		return "Native Landingi provider rows store only account/page/form settings plus a credential reference for the Moosewave-owned route token configured on the Landingi Webhook URL or request header. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, Webhook integration cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "kickofflabs":
		return "Native KickoffLabs provider rows store only account/campaign/page settings plus a credential reference for the Moosewave-owned route token configured on the KickoffLabs outbound Webhook URL. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, outbound Webhook cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "ninja-forms":
		return "Native Ninja Forms provider rows store only WordPress site/form settings plus a credential reference for the Moosewave-owned route token configured in the Ninja Forms Webhooks action. Raw tokens are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live WordPress/Ninja Forms setup, Webhooks action cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "outgrow":
		return "Native Outgrow provider rows store only account/campaign/calculator settings plus a credential reference for the Moosewave-owned route token or Basic auth credentials configured on the Outgrow Webhook destination. Raw usernames, passwords, tokens, and secrets are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live Outgrow setup, Webhook cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "shortstack":
		return "Native ShortStack provider rows store only account/campaign/form settings plus a credential reference for the ShortStack Webhook form integration secret key used to verify X-SS-Signature HMAC-SHA1 callbacks. Raw secret keys are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, Webhook form integration cleanup, reconnect, and data-delete certification remain open."
	case item.Slug == "riddle":
		return "Native Riddle provider rows store only account/quiz settings plus a credential reference for the Riddle signature key or Moosewave-owned route token configured on the webhook destination. Raw signature keys, tokens, and signatures are rejected from public settings; webhook delivery claims, webhook-mode sync runs, canonical profile/list/event imports, and operator-managed provider_cleanup evidence stay on the lead integration row while live account, Webhook cleanup, reconnect, and data-delete certification remain open."
	case isCRMPullerLiveCertificationPending(item):
		return "Native CRM provider rows store only credential references plus non-secret provider scope settings for the implemented REST puller. Raw OAuth tokens, API keys, webhook secrets, and provider credentials are rejected from public settings; scheduled CRM pulls, retry cursors, sync runs, canonical profile imports, and operator-managed provider_cleanup evidence stay on the CRM integration row while live account/webhook/object-expansion certification remains open."
	case func() bool {
		meta, ok := managedProviderMetadataForItem(item)
		return ok && isPostwaveIngestSyncModel(meta.SyncModel)
	}():
		return "This foundation stores only a credential reference identifier; raw credential material in settings or credentials_ref is rejected."
	default:
		return "Secrets are stored through existing encrypted credential references, never raw config JSON."
	}
}

func secretPolicyFor(item CatalogItem) string {
	if hasSource(item, "sms") && (item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned) {
		return "No active hosted SMS provider secret contract. A future release requires tenant-bound encrypted credential references, provider-account ownership, verifier selection, and rotation evidence."
	}
	if item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned {
		return "No active secret handling; implementation must use the existing envelope/credential reference pattern."
	}
	if isKlaviyoNativeSurface(item) {
		return "Raw Klaviyo private API keys, OAuth access/refresh tokens, client secrets, and webhook secrets must not be exposed through public native config; the marketing integration row accepts vault credential references, managed marketing:klaviyo OAuth refs, webhook secret references, and opaque webhook tokens. Klaviyo writeback targets can resolve both shared vault refs and managed OAuth refs through the runtime credential resolver."
	}
	if isMarketingNativeSurface(item) {
		return "Raw provider secrets must not be exposed through public native config; the marketing integration row accepts credential references and non-secret settings only, and future OAuth/webhook/writeback credentials must use the shared credential resolver before runtime promotion."
	}
	if isKlaviyoMigrationSurface(item) {
		return "Klaviyo migration jobs use write-only API-key submission and redacted migration session state; provider-side key revocation remains a Klaviyo account action."
	}
	if item.Slug == "meta" && hasSource(item, "audience_destination") {
		return "Raw Meta ads access tokens and tenant-supplied API hosts are rejected by public audience-destination APIs; only references are stored, and resolved tokens are merged into an in-memory adapter config for the delivery call."
	}
	if item.Slug == "google-ads" && hasSource(item, "audience_destination") {
		return "Raw Google OAuth/developer tokens and tenant-supplied Google Ads/Data Manager API hosts are rejected by public audience-destination APIs; only credential references are stored, and resolved secrets are merged into an in-memory adapter config immediately before delivery."
	}
	if meta, ok := managedProviderMetadataForItem(item); ok && isPostwaveIngestSyncModel(meta.SyncModel) {
		return "Raw provider secrets are not accepted by this facade; credential reference IDs may appear in inventory responses for operator audit."
	}
	if hasSource(item, "sending") {
		return "Provider send keys must stay in the owning mailer/credential system; deliverability webhook tokens are write-only, redacted on read, and do not prove full native sending support."
	}
	if hasSource(item, "sms") {
		return "Raw Twilio/Telnyx/Bandwidth provider credentials stay in environment-managed SMS provider config; public sender/campaign APIs accept operational identifiers and registration evidence only. Provider callback secrets are env-managed and verified before inbound or delivery mutations."
	}
	if isSnowflakeWarehouseLiveCertificationPending(item) {
		return "Raw Snowflake passwords, private keys, OAuth/PAT tokens, DSNs, and workload-identity material must stay in referenced secret envelopes. The warehouse connection accepts credential-reference IDs plus non-secret account/database/schema/warehouse/stage/import-table settings only; the SQL executor resolves secrets in memory for export COPY/query/health execution."
	}
	if isReviewPullerLiveCertificationPending(item) {
		return "Raw review-provider API credentials and webhook secrets are not accepted in public settings for the REST-puller slice. The row accepts credential references and provider scope identifiers only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	if isLoyaltyPullerLiveCertificationPending(item) {
		return "Raw loyalty-provider API credentials, signature secrets, and webhook secrets are not accepted in public settings for the REST-puller slice. The row accepts credential references and provider scope identifiers only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		return "Raw subscription/shipping-provider API credentials and webhook secrets are not accepted in public settings for the provider-puller slice. The row accepts credential references and provider scope identifiers only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		return "Raw analytics-provider API keys, API secrets, service-account passwords, and webhook secrets are not accepted in public settings for the provider-puller slice. The row accepts credential references plus non-secret project, cohort, host, page-size, and date-window settings only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	if isLeadPullerLiveCertificationPending(item) {
		return "Raw lead-provider API keys, access tokens, and webhook secrets are not accepted in public settings for the REST-puller slice. The row accepts credential references plus non-secret form_id, form_name, page_size, and API host settings only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	if item.Slug == "optinmonster" {
		return "Raw OptinMonster route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, campaign_name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "privy" {
		return "Raw Privy Basic auth usernames, passwords, tokens, and secrets are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, campaign_name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved Basic auth credentials before writing any lead data."
	}
	if item.Slug == "convertflow" {
		return "Raw ConvertFlow route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, site_id, campaign_name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "sleeknote" {
		return "Raw Sleeknote route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, site_id, campaign_name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "wisepops" {
		return "Raw Wisepops API keys and signature material are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, hook_id, campaign_name, identity mapping, default tag, and list routing settings only; the public receiver verifies X-Wisepops-Signature against the raw body before writing any lead data."
	}
	if item.Slug == "poptin" {
		return "Raw Poptin route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, popup_id, site_id, popup name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "hello-bar" {
		return "Raw Hello Bar route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret site_id, campaign_id, bar name, account_id, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "landingi" {
		return "Raw Landingi route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, page_id, form_id, page/form name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "kickofflabs" {
		return "Raw KickoffLabs route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, page_id, campaign/page name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "ninja-forms" {
		return "Raw Ninja Forms route tokens are not accepted in public settings. The row accepts credentials_ref plus non-secret site_url, form_id, form_name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved route token before writing any lead data."
	}
	if item.Slug == "outgrow" {
		return "Raw Outgrow route tokens, Basic auth usernames, Basic auth passwords, and authorization headers are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, calculator/quiz name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved Basic auth pair or route token before writing any lead data."
	}
	if item.Slug == "shortstack" {
		return "Raw ShortStack webhook secret keys and signatures are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, campaign_id, form_id, form/campaign name, identity mapping, default tag, and list routing settings only; the public receiver verifies X-SS-Signature against the raw body before writing any lead data."
	}
	if item.Slug == "riddle" {
		return "Raw Riddle signature keys, route tokens, and signatures are not accepted in public settings. The row accepts credentials_ref plus non-secret account_id, quiz_id, campaign/riddle name, identity mapping, default tag, and list routing settings only; the public receiver verifies the resolved signature key or route token before writing any lead data."
	}
	if isCRMPullerLiveCertificationPending(item) {
		return "Raw CRM OAuth tokens, API keys, PATs, service-account keys, and webhook secrets are not accepted in public settings for the REST-puller slice. The row accepts credential references and provider scope identifiers only; callback/webhook secrets remain excluded until provider-managed webhook adapters are certified."
	}
	return "Secrets are write-only after creation, redacted in responses, and rotated or revoked through the owning surface."
}

func monitoringFor(item CatalogItem) []string {
	if item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned {
		return []string{"roadmap_status", "catalog_truthfulness_checks"}
	}
	out := []string{"health_endpoint", "connection_inventory", "audit_trail"}
	switch {
	case isKlaviyoNativeSurface(item):
		out = append(out, "marketing_sync_runs", "marketing_webhook_events", "writeback_runs", "native_provider_row_lifecycle", "klaviyo_native_scheduler", "klaviyo_source_event_monitor", "klaviyo_signed_webhook_receiver", "klaviyo_writeback_adapter")
	case isMarketingNativeSurface(item):
		out = append(out, "marketing_sync_runs", "native_provider_row_lifecycle", "delegated_migration_handoff")
		if meta, ok := managedProviderMetadataForItem(item); ok && (containsString(meta.SyncObjects, "profile_source_events") || containsString(meta.SyncObjects, "contact_source_events")) {
			out = append(out, "source_event_monitor")
		}
	case hasSource(item, "commerce"):
		out = append(out, "commerce_sync_status", "webhook_dedupe")
	case isCRMPullerLiveCertificationPending(item):
		out = append(out, "crm_sync_runs", "crm_profile_upsert_status", "crm_provider_backfill_worker", "crm_provider_retry_cursors", "provider_cleanup_evidence")
	case hasSource(item, "crm"):
		out = append(out, "crm_sync_runs", "subscriber_upsert_status", "timeline_event_status")
	case isLeadPullerLiveCertificationPending(item):
		out = append(out, "lead_sync_runs", "subscriber_upsert_status", "lead_event_status", "lead_provider_backfill_worker", "lead_provider_retry_cursors", "provider_cleanup_evidence")
	case hasSource(item, "lead_capture"):
		out = append(out, "lead_sync_runs", "subscriber_upsert_status", "lead_event_status", "webhook_ingest_status")
	case hasSource(item, "review_integration"):
		out = append(out, "review_sync_runs", "product_review_import_status", "reviewer_profile_status", "review_event_status")
		if item.Slug == "yotpo" || isReviewPullerLiveCertificationPending(item) {
			out = append(out, "review_provider_backfill_worker", "review_provider_retry_cursors", "provider_cleanup_evidence")
		}
	case hasSource(item, "loyalty_integration"):
		out = append(out, "loyalty_sync_runs", "loyalty_profile_status", "points_event_status", "reward_event_status")
		if item.Slug == "smile" || isLoyaltyPullerLiveCertificationPending(item) {
			out = append(out, "loyalty_provider_backfill_worker", "loyalty_provider_retry_cursors", "provider_cleanup_evidence")
		}
	case isSubscriptionPullerLiveCertificationPending(item):
		out = append(out, "subscription_sync_runs", "subscription_profile_status", "shipment_profile_status", "lifecycle_event_status", "subscription_provider_backfill_worker", "subscription_provider_retry_cursors", "provider_cleanup_evidence")
	case hasSource(item, "subscription_integration"):
		out = append(out, "subscription_sync_runs", "subscription_profile_status", "shipment_profile_status", "lifecycle_event_status")
	case hasSource(item, "support_integration"):
		out = append(out, "support_sync_runs", "service_suite_mirror_status", "support_profile_status", "support_event_status")
	case hasSource(item, "analytics_integration"):
		out = append(out, "analytics_sync_runs", "profile_pipe_status", "event_pipe_status")
		if isAnalyticsPullerLiveCertificationPending(item) {
			out = append(out, "analytics_provider_backfill_worker", "analytics_provider_retry_cursors", "provider_cleanup_evidence")
		}
	case hasSource(item, "audience_destination"):
		out = append(out, "audience_delivery_runs", "consent_gate_status")
	case isSnowflakeWarehouseLiveCertificationPending(item):
		out = append(out, "warehouse_job_status", "cursor_progress", "provider_driver_attachment", "snowflake_provider_job", "snowflake_provider_execution", "snowflake_provider_health", "provider_cleanup_evidence")
	case hasSource(item, "warehouse"):
		out = append(out, "warehouse_job_status", "cursor_progress", "provider_driver_attachment")
	case hasSource(item, "sending"):
		out = append(out, "send_loop_status", "deliverability_webhook_status", "provider_driver_attachment")
	case hasSource(item, "sms"):
		out = append(out, "sms_setup_readiness", "sms_campaign_recipients", "sms_message_delivery", "sms_provider_callbacks", "sms_suppression_ledger", "a2p_registration_status")
	case hasSource(item, "outbound_webhooks"):
		out = append(out, "delivery_attempts", "signature_failures", "dead_letter_inspector")
	case hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		out = append(out, "ingest_events", "signature_verification", "replay_queue")
	case hasSource(item, "developer_marketplace"):
		out = append(out, "app_review_status", "oauth_install_status", "webhook_subscription_status")
	case hasSource(item, "migration"):
		out = append(out, "dry_run_ledger", "import_error_export")
		if isKlaviyoMigrationSurface(item) {
			out = append(out, "source_event_monitor", "source_archive_rebuild_tasks")
		}
	}
	return out
}

func bridgeChannelsFor(item CatalogItem) []string {
	if item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned {
		return nil
	}
	if item.Badge == BadgePartner && hasSource(item, "developer_marketplace") {
		return []string{"marketplace_oauth", "app_webhooks", "inbound_webhooks", "api"}
	}
	if item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge") || hasSource(item, "zapier_package") {
		return []string{"zapier", "make", "n8n", "pipedream", "inbound_webhooks", "api"}
	}
	return nil
}

func requiredScopesFor(item CatalogItem) []string {
	if item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned {
		return nil
	}
	scopes := []string{"read:reports"}
	if hasCapability(item, CapabilityProfiles) || hasCapability(item, CapabilityLists) || hasCapability(item, CapabilitySegments) {
		scopes = append(scopes, "read:subscribers", "write:subscribers")
	}
	if hasCapability(item, CapabilityEvents) || hasCapability(item, CapabilityAutomationTriggers) {
		scopes = append(scopes, "write:events")
	}
	if hasCapability(item, CapabilityCommerce) || hasCapability(item, CapabilityOrders) || hasCapability(item, CapabilityProducts) {
		scopes = append(scopes, "read:commerce", "write:commerce")
	}
	if hasCapability(item, CapabilityAdsAudiences) {
		scopes = append(scopes, "write:audiences")
	}
	if hasCapability(item, CapabilityWarehouseExport) || hasCapability(item, CapabilityWarehouseImport) {
		scopes = append(scopes, "read:exports", "write:imports")
	}
	if item.Badge == BadgeNative || item.Badge == BadgeMigrationOnly {
		scopes = append(scopes, "admin")
	}
	return uniqueStrings(scopes)
}

func dataObjectsFor(item CatalogItem) []string {
	if hasSource(item, "sms") {
		return []string{"sms_sender_profiles", "sms_campaigns", "sms_broadcasts", "sms_messages", "sms_subscriptions", "sms_suppressions", "sms_registration_evidence", "profiles", "events"}
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		if isShippingPullerLiveCertificationPending(item) {
			return []string{"profiles", "events", "shipments"}
		}
		return []string{"profiles", "events", "subscriptions"}
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		return []string{"profiles"}
	}
	if isLeadPullerLiveCertificationPending(item) {
		return []string{"forms", "submissions", "profiles", "events", "lists"}
	}
	if isKlaviyoNativeSurface(item) {
		return []string{"profiles", "lists", "segments", "flows", "campaigns", "templates", "source_archive_rebuild_tasks", "profile_source_events", "system_webhook_events", "writeback_targets"}
	}
	if isKlaviyoMigrationSurface(item) {
		return []string{"profiles", "lists", "segments", "flows", "campaigns", "templates", "source_archive_rebuild_tasks", "profile_source_events"}
	}
	if objects := marketingMigrationDataObjects(item); len(objects) > 0 {
		return objects
	}
	if meta, ok := managedProviderMetadataForItem(item); ok && isPostwaveIngestSyncModel(meta.SyncModel) {
		return uniqueStrings(meta.SyncObjects)
	}
	out := []string{}
	for _, cap := range item.Capabilities {
		switch cap {
		case CapabilityProfiles:
			out = append(out, "profiles")
		case CapabilityEvents:
			out = append(out, "events")
		case CapabilityLists:
			out = append(out, "lists")
		case CapabilitySegments:
			out = append(out, "segments")
		case CapabilityCommerce:
			out = append(out, "commerce_customers")
		case CapabilityOrders:
			out = append(out, "orders")
		case CapabilityProducts:
			out = append(out, "products", "variants")
		case CapabilityReviews:
			out = append(out, "reviews")
		case CapabilitySubscriptions:
			out = append(out, "subscriptions")
		case CapabilitySupport:
			out = append(out, "support_tickets", "conversations")
		case CapabilityAdsAudiences:
			out = append(out, "hashed_audience_members")
		case CapabilityWarehouseExport:
			out = append(out, "warehouse_exports")
		case CapabilityWarehouseImport:
			out = append(out, "warehouse_imports")
		case CapabilityAutomationTriggers:
			out = append(out, "automation_triggers")
		}
	}
	out = append(out, managedProviderDataObjects(item)...)
	return uniqueStrings(out)
}

func eventTopicsFor(item CatalogItem) []string {
	if isKlaviyoNativeSurface(item) {
		return []string{"profile.upserted", "event.created", "list.member.added", "list.member.removed", "automation.triggered", "klaviyo.source_event.profile_changed", "klaviyo.system_webhook.event", "klaviyo.system_webhook.profile"}
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		if isShippingPullerLiveCertificationPending(item) {
			return []string{"shipment.imported", "shipment.updated"}
		}
		return []string{"subscription.imported", "subscription.updated"}
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		return []string{"profile.upserted"}
	}
	if isLeadPullerLiveCertificationPending(item) {
		return []string{"profile.upserted", "event.created", "list.member.added"}
	}
	if isKlaviyoMigrationSurface(item) {
		return []string{"migration.profile.upserted", "migration.source_event.profile_changed", "migration.rebuild_task.created"}
	}
	if meta, ok := managedProviderMetadataForItem(item); ok && isPostwaveIngestSyncModel(meta.SyncModel) {
		return uniqueStrings(meta.WebhookTopics)
	}
	switch item.Slug {
	case "postscript":
		return []string{"shop.incoming_message", "shop.subscriber.opt_in", "shop.subscriber.opt_out", "sms.inbound_message", "sms.subscribed", "sms.unsubscribed"}
	case "attentive":
		return []string{"sms.subscribed", "sms.unsubscribed", "sms.inbound_message", "sms.sent", "sms.message_link_click", "custom_attribute.set"}
	case "twilio":
		return []string{"sms.inbound_message", "sms.delivery.status", "sms.stop_keyword", "sms.help_keyword", "sms.keyword_response"}
	case "telnyx":
		return []string{"message.received", "message.finalized", "sms.inbound_message", "sms.delivery.status", "sms.keyword_response"}
	case "bandwidth":
		return []string{"message-received", "message-delivered", "message-failed", "sms.inbound_message", "sms.delivery.status", "sms.keyword_response"}
	}
	out := []string{}
	if hasCapability(item, CapabilityProfiles) {
		out = append(out, "profile.upserted", "profile.deleted")
	}
	if hasCapability(item, CapabilityEvents) {
		out = append(out, "event.created")
	}
	if hasCapability(item, CapabilityLists) {
		out = append(out, "list.member.added", "list.member.removed")
	}
	if hasCapability(item, CapabilityCommerce) || hasCapability(item, CapabilityOrders) {
		out = append(out, "commerce.order.created")
	}
	if hasCapability(item, CapabilityCommerce) {
		out = append(out, "commerce.cart.updated")
	}
	if hasCapability(item, CapabilityProducts) {
		out = append(out, "commerce.product.updated")
	}
	if hasCapability(item, CapabilityReviews) {
		out = append(out, "review.created")
	}
	if hasCapability(item, CapabilitySubscriptions) {
		out = append(out, "subscription.updated")
	}
	if hasCapability(item, CapabilitySupport) {
		out = append(out, "support.ticket.created")
	}
	if hasCapability(item, CapabilityAdsAudiences) {
		out = append(out, "audience.delivery.completed", "audience.delivery.failed")
	}
	if hasCapability(item, CapabilityWarehouseExport) || hasCapability(item, CapabilityWarehouseImport) {
		out = append(out, "warehouse.job.completed", "warehouse.job.failed")
	}
	if hasCapability(item, CapabilityAutomationTriggers) {
		out = append(out, "automation.triggered")
	}
	if item.RuntimeStatus == RuntimePlanned {
		out = append(out, "roadmap.updated")
	}
	out = append(out, managedProviderEventTopics(item)...)
	return uniqueStrings(out)
}

func marketingMigrationDataObjects(item CatalogItem) []string {
	if !hasSource(item, "migration") {
		return nil
	}
	switch item.Slug {
	case "mailchimp-migration":
		return []string{"profiles", "lists", "segments", "groups", "automations", "campaigns", "templates", "reports", "forms", "landing_pages", "ecommerce_stores", "source_archive_rebuild_tasks"}
	case "activecampaign-migration":
		return []string{"profiles", "lists", "segments", "tags", "automation_rebuild_tasks", "campaigns", "forms", "deals", "pipelines", "custom_objects", "sms_campaigns", "contact_source_events"}
	case "customerio-migration":
		return []string{
			"email_addressable_profiles",
			"frozen_segment_memberships",
			"subscription_topics",
			"subscription_channels",
			"design_studio_email_templates",
			"sent_email_newsletter_archive",
			"campaign_and_broadcast_workflow_rebuild_evidence",
			"transactional_message_evidence",
			"esp_suppressions",
			"sms_whatsapp_opt_out_evidence",
			"object_type_metadata",
			"migration_gap_checklists",
		}
	case "brevo-migration":
		return []string{"profiles", "lists", "segments", "automations", "campaigns", "reports"}
	case "convertkit-migration":
		return []string{"subscribers", "tags", "segments", "sequences", "broadcasts", "forms", "landing_pages", "paid_subscriptions_stripe_connect"}
	default:
		if provider := strings.TrimSuffix(item.Slug, "-migration"); provider != item.Slug {
			if spec, ok := marketingintegrations.ProviderSpecByKey(provider); ok {
				return append([]string(nil), spec.SyncObjects...)
			}
		}
		return nil
	}
}

func complianceGatesFor(item CatalogItem) []string {
	out := []string{"tenant_rls", "api_key_scopes"}
	if item.Category == "sms" || hasSource(item, "sms") {
		out = append(out, "sms_operational_ledgers")
	} else {
		out = append(out, "audit_logging")
	}
	if hasSource(item, "outbound_webhooks") || hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package") {
		out = append(out, "webhook_signature_verification", "ssrf_safe_delivery")
	}
	if hasCapability(item, CapabilityProfiles) || hasCapability(item, CapabilityLists) {
		out = append(out, "email_consent_preservation", "suppression_state_respected")
	}
	if hasCapability(item, CapabilityAdsAudiences) {
		out = append(out, "ads_consent_gate", "hashed_identity_only")
	}
	if item.Category == "sms" || hasSource(item, "sms") {
		out = append(out, "sms_consent_gate", "quiet_hours_policy", "provider_callback_verification")
	}
	if hasCapability(item, CapabilityWarehouseExport) || hasCapability(item, CapabilityWarehouseImport) {
		out = append(out, "export_scope_review", "pii_minimization")
	}
	if hasSource(item, "sending") {
		out = append(out, "suppression_state_respected", "one_click_unsubscribe_headers", "deliverability_webhook_authenticity")
	}
	if isReviewPullerLiveCertificationPending(item) {
		out = append(out, "review_credential_ref_required", "provider_cleanup_operator_managed", "review_webhook_certification_pending")
	}
	if isLoyaltyPullerLiveCertificationPending(item) {
		out = append(out, "loyalty_credential_ref_required", "provider_cleanup_operator_managed", "loyalty_webhook_certification_pending")
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		out = append(out, "subscription_credential_ref_required", "provider_cleanup_operator_managed", "subscription_webhook_certification_pending", "live_provider_certification_pending")
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		out = append(out, "analytics_credential_ref_required", "provider_cleanup_operator_managed", "analytics_webhook_event_report_certification_pending", "live_provider_certification_pending")
	}
	if isLeadPullerLiveCertificationPending(item) {
		out = append(out, "lead_credential_ref_required", "provider_cleanup_operator_managed", "lead_webhook_certification_pending", "live_provider_certification_pending")
	}
	if item.Slug == "carrd" {
		out = append(out, "webhook_route_token_required", "custom_url_destination_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "optinmonster" {
		out = append(out, "webhook_route_token_required", "optinmonster_webhook_destination_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "privy" {
		out = append(out, "privy_basic_auth_required", "privy_custom_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "convertflow" {
		out = append(out, "convertflow_route_token_required", "convertflow_webhook_automation_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "sleeknote" {
		out = append(out, "sleeknote_route_token_required", "sleeknote_custom_integration_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "wisepops" {
		out = append(out, "wisepops_hmac_signature_required", "wisepops_hook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "poptin" {
		out = append(out, "poptin_route_token_required", "poptin_webhook_integration_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "hello-bar" {
		out = append(out, "hello_bar_route_token_required", "hello_bar_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "landingi" {
		out = append(out, "landingi_route_token_required", "landingi_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "kickofflabs" {
		out = append(out, "kickofflabs_route_token_required", "kickofflabs_outbound_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "ninja-forms" {
		out = append(out, "ninja_forms_route_token_required", "ninja_forms_webhook_action_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "outgrow" {
		out = append(out, "outgrow_basic_or_route_token_required", "outgrow_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "shortstack" {
		out = append(out, "shortstack_hmac_signature_required", "shortstack_webhook_integration_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if item.Slug == "riddle" {
		out = append(out, "riddle_signature_or_route_token_required", "riddle_webhook_cleanup_operator_managed", "live_provider_certification_pending")
	}
	if isCRMPullerLiveCertificationPending(item) {
		out = append(out, "crm_credential_ref_required", "provider_cleanup_operator_managed", "crm_webhook_and_extended_object_certification_pending")
	}
	if isSnowflakeWarehouseLiveCertificationPending(item) {
		out = append(out, "snowflake_credential_ref_required", "snowflake_sql_driver_linked", "snowflake_live_account_certification_pending", "snowflake_provider_cleanup_operator_managed", "remote_import_materialization_pending")
	}
	if hasSource(item, "migration") {
		out = append(out, "dry_run_required", "suppression_import_review")
	}
	if isKlaviyoNativeSurface(item) {
		out = append(out, "klaviyo_revision_pin", "credential_ref_required", "signed_webhook_receiver", "managed_webhook_subscription_reconcile_cleanup", "klaviyo_writeback_no_create", "klaviyo_webhooks_api_live_certification_pending")
	} else if isMarketingNativeSurface(item) {
		out = append(out, "credential_ref_required", "native_webhook_certification_pending", "provider_cleanup_operator_managed")
	}
	if item.RuntimeStatus == RuntimePlanned {
		out = append(out, "no_native_claim_until_auth_sync_monitoring_ship")
	}
	return uniqueStrings(out)
}

func privacyActionsFor(item CatalogItem) []string {
	out := []string{"disconnect", "credential_revoke", "audit_record_preserved"}
	if meta, ok := managedProviderMetadataForItem(item); ok && isPostwaveIngestSyncModel(meta.SyncModel) {
		out = []string{"disconnect", "local_connection_delete", "audit_record_preserved", "provider_console_cleanup"}
	}
	if item.Slug == "wix-stores" {
		out = append(out, "wix_app_uninstall_lifecycle", "signed_delete_event_evidence")
	}
	if item.Slug == "wix" {
		out = append(out, "wix_app_uninstall_lifecycle", "signed_contact_delete_evidence")
	}
	if hasCapability(item, CapabilityProfiles) || hasSource(item, "migration") {
		out = append(out, "profile_delete_or_export", "suppression_retention")
	}
	if isLeadPullerLiveCertificationPending(item) {
		out = append(out, "lead_provider_pull_pause", "provider_console_cleanup")
	}
	if item.Slug == "carrd" {
		out = append(out, "custom_url_receiver_disable", "carrd_custom_url_destination_cleanup", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "optinmonster" {
		out = append(out, "optinmonster_webhook_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "privy" {
		out = append(out, "privy_custom_webhook_disable", "basic_auth_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "convertflow" {
		out = append(out, "convertflow_webhook_automation_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "sleeknote" {
		out = append(out, "sleeknote_custom_integration_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "wisepops" {
		out = append(out, "wisepops_hook_disable", "wisepops_api_key_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "poptin" {
		out = append(out, "poptin_webhook_integration_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "hello-bar" {
		out = append(out, "hello_bar_webhook_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "landingi" {
		out = append(out, "landingi_webhook_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "kickofflabs" {
		out = append(out, "kickofflabs_outbound_webhook_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "ninja-forms" {
		out = append(out, "ninja_forms_webhook_action_disable", "route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "outgrow" {
		out = append(out, "outgrow_webhook_disable", "credential_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "shortstack" {
		out = append(out, "shortstack_webhook_integration_disable", "webhook_secret_rotation", "provider_cleanup_acknowledgement")
	}
	if item.Slug == "riddle" {
		out = append(out, "riddle_webhook_disable", "signature_or_route_token_rotation", "provider_cleanup_acknowledgement")
	}
	if hasCapability(item, CapabilityCommerce) || hasCapability(item, CapabilityOrders) || hasCapability(item, CapabilityProducts) {
		out = append(out, "commerce_cache_retention_cleanup")
	}
	if hasCapability(item, CapabilityAdsAudiences) {
		out = append(out, "audience_member_delete")
	}
	if hasCapability(item, CapabilityWarehouseExport) || hasCapability(item, CapabilityWarehouseImport) {
		out = append(out, "warehouse_job_disable", "export_artifact_expiry")
	}
	if hasSource(item, "sending") {
		out = append(out, "sending_provider_pause", "suppression_retention", "provider_console_cleanup")
	}
	if hasSource(item, "sms") {
		out = append(out, "sender_profile_pause", "sms_suppression_retention", "provider_app_profile_number_cleanup", "carrier_registration_cleanup")
	}
	if isReviewPullerLiveCertificationPending(item) {
		out = append(out, "review_provider_pull_pause", "provider_console_key_revoke", "provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isLoyaltyPullerLiveCertificationPending(item) {
		out = append(out, "loyalty_provider_pull_pause", "provider_console_key_revoke", "provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isSubscriptionPullerLiveCertificationPending(item) {
		out = append(out, "subscription_provider_pull_pause", "provider_console_key_revoke", "provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isAnalyticsPullerLiveCertificationPending(item) {
		out = append(out, "analytics_provider_pull_pause", "provider_console_key_revoke", "provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isCRMPullerLiveCertificationPending(item) {
		out = append(out, "crm_provider_pull_pause", "provider_console_oauth_or_key_revoke", "provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isSnowflakeWarehouseLiveCertificationPending(item) {
		out = append(out, "snowflake_warehouse_pause", "snowflake_export_artifact_expiry", "snowflake_provider_console_cleanup", "provider_cleanup_acknowledgement")
	}
	if isKlaviyoNativeSurface(item) {
		out = append(out, "managed_oauth_revoke", "provider_console_key_revoke", "managed_provider_webhook_cleanup", "writeback_target_disconnect", "provider_side_writeback_cleanup_certification_pending", "duplicate_manual_webhook_audit")
	} else if isMarketingNativeSurface(item) {
		out = append(out, "provider_console_key_revoke", "native_webhook_cleanup_pending", "writeback_cleanup_pending")
	}
	return uniqueStrings(out)
}

func rateLimitPolicyFor(item CatalogItem) string {
	switch {
	case item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned:
		return "Defined during connector implementation."
	case isKlaviyoNativeSurface(item):
		return "Klaviyo native provider-row sync/backfill records completed or failed marketing_sync_runs with versioned klaviyo_native cursors. The native puller uses the revision-pinned JSON:API adapter for profile pages, list/segment discovery, and changed-profile source-event polling; requests send the required revision header, use cursor pagination, cap profile/list/source-event pages to provider limits, emit timestamped changed-profile source-event IDs with bounded profile payload evidence, default to a conservative token bucket, and honor Retry-After on 429. Public-app OAuth availability/start/callback uses PKCE, encrypted marketing credential envelopes, proactive refresh, and disconnect-time token revocation for managed OAuth refs. Signed Klaviyo system webhooks are received through opaque route tokens, verified with Klaviyo-Signature/Klaviyo-Timestamp HMAC, deduped in marketing_webhook_events, and recorded as webhook-mode marketing_sync_runs without advancing the polling cursor. Allowlisted Klaviyo Webhooks API credentials can reconcile/create/update the provider system-webhook subscription with a vault-backed secret_key and delete the managed subscription on disconnect. Klaviyo integration-writeback targets resolve shared credential refs or managed OAuth refs, look up existing profiles by email, update custom profile properties, optionally add matched profiles to a list, optionally create custom events by profile ID, preserve no-create semantics, and honor Retry-After on 429. Disconnect persists provider_cleanup evidence and local acknowledgement records operator attestation after private-key, duplicate-webhook, and writeback cleanup review. Webhooks API live allowlist certification, writeback live certification, OAuth live certification, provider-side cleanup certification, and live account certification remain open before RuntimeAvailable promotion."
	case isMarketingNativeSurface(item):
		meta, _ := managedProviderMetadataForItem(item)
		suffix := "source-event polling, native webhooks, writeback, active provider-row scheduler handoff, cleanup automation, and live account certification remain future connector work."
		if containsString(meta.SyncObjects, "contact_source_events") {
			suffix = "native webhooks, writeback, active provider-row scheduler handoff, cleanup automation, OAuth/public app install, and live account certification remain future connector work; changed-contact polling remains delegated to the migration source-event adapter."
		}
		return meta.Name + " native provider-row sync/backfill records partial marketing_sync_runs plus " + meta.Provider + "_handoff delegated retry cursors and delegates provider API import to the migration adapter with provider-specific pagination/rate-limit behavior inherited from that adapter; " + suffix
	case isKlaviyoMigrationSurface(item):
		return "Klaviyo migration imports send the required revision header, use JSON:API cursor pagination, cap profile/list/source-event pages to provider limits, default to a conservative profile-import token bucket, and honor Retry-After on 429; native-provider webhooks and writeback are owned by the separate Klaviyo native row, not the migration surface."
	case hasSource(item, "outbound_webhooks"):
		return "Delivery workers use bounded retries and destination-safe backoff."
	case hasSource(item, "inbound_webhooks") || hasSource(item, "bridge") || hasSource(item, "zapier_package"):
		return "Inbound ingest is bounded by tenant API limits and idempotency keys."
	case func() bool {
		meta, ok := managedProviderMetadataForItem(item)
		return ok && isPostwaveIngestSyncModel(meta.SyncModel)
	}():
		return "Manual imports and ingest payloads are bounded by tenant API limits, idempotency keys, and owning-surface row caps; provider pullers define rate limits when implemented."
	case item.Slug == "shopify":
		return "Shopify Admin GraphQL backfill reads query-cost throttleStatus and HTTP Retry-After; /backfill?mode=bulk advances bounded cursor pages, and mode=bulk_async launches, polls, and imports Admin GraphQL Bulk Operations through shopify_bulk: cursors with retry metadata and JSONL line-offset checkpoints. The scheduled worker continues both cursor pages and async bulk poll/import retries."
	case item.Slug == "wix-stores":
		return "Wix Stores REST pulls honor Retry-After for token, Contacts, Catalog V1/V3, and eCommerce order requests; retry cursors persist object, provider cursor, attempt count, next attempt time, status, and truncated errors."
	case item.Slug == "woocommerce":
		return "WooCommerce REST pulls honor X-WP-TotalPages pagination for Customers, Products, product variations, Orders, Refunds, optional Subscriptions, manual provider pulls, and webhook reconciliation; retry cursors persist object, page cursor, attempt count, next attempt time, status, and truncated errors, with Retry-After or bounded exponential backoff for transient provider failures. Disconnect returns and persists provider_cleanup evidence for Moosewave-managed webhook deletion or skipped legacy/manual cleanup when stored endpoint evidence is absent."
	case item.Slug == "bigcommerce":
		return "BigCommerce REST pulls honor X-Rate-Limit-Time-Reset-Ms for Customers, Catalog Products/variants, Orders/products/coupons, /v3/hooks, and webhook fetch fanout; retry cursors persist object, page cursor, attempt count, next attempt time, status, and truncated errors, with manual/scheduled due retries preserving prior attempt history. Reconnects reuse existing local webhook secrets before hook reconciliation, and disconnect returns/persists provider_cleanup evidence for Moosewave-managed hook deletion or operator-required API-account cleanup."
	case item.Slug == "adobe-commerce":
		return "Adobe Commerce REST pulls honor Retry-After for Customers, Products, Orders, Credit Memos, and merchant-configured webhook delivery failures; retry cursors persist object, page cursor, attempt count, next attempt time, status, and truncated errors. Disconnect returns and persists operator-managed provider_cleanup readiness evidence for local shutdown; Adobe Commerce admin-token/IMS-token revocation, shared-secret rotation, duplicate/manual webhook audit, and Adobe/Magento webhook definition cleanup remain operator-managed until a certified managed module or SaaS Admin flow is attached."
	case item.Slug == "squarespace-commerce":
		return "Squarespace Commerce REST pulls honor Retry-After for Contacts, product list/detail, Orders, and webhook subscription requests; retry cursors persist object, provider cursor, attempt count, next attempt time, status, and truncated errors. Disconnect returns and persists operator-managed provider_cleanup readiness evidence for local shutdown; Squarespace API-key/OAuth token revocation, webhook secret rotation, duplicate/manual target audit, and OAuth-only webhook subscription cleanup remain operator-managed until managed OAuth subscription cleanup is certified."
	case item.Slug == "stripe":
		return "Stripe REST pulls honor Retry-After for Customers, Checkout Sessions, PaymentIntents, Charges, disputes, invoices, invoice line pagination, credit notes, subscriptions, refunds, and webhook delivery failures; retry cursors persist object, starting_after cursor, attempt count, next attempt time, status, and truncated errors. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown; Stripe restricted-key revocation, webhook endpoint deletion, duplicate endpoint audit, and signing-secret rotation remain operator-managed provider-dashboard actions until managed app/webhook provisioning is certified."
	case item.Slug == "square":
		return "Square REST pulls honor Retry-After for Customers, Catalog Search ITEM products/variations/deletions, catalog.version.updated product refreshes, Locations, Orders, Payments, Refunds, manual provider pulls, and webhook delivery failures; retry cursors persist object, provider cursor, attempt count, next attempt time, status, and truncated errors, with manual/scheduled due retries preserving prior attempt history."
	case item.Slug == "paypal":
		return "PayPal OAuth token, Transaction Search pulls, webhook verification, and sparse webhook resource hydration calls honor Retry-After for token exchange, reporting pages, allowlisted Orders/Captures/Refunds/Subscriptions/Invoices REST resources, and webhook verification failures; retry cursors persist reporting window, page, attempt count, next attempt time, status, and truncated errors, with manual/scheduled due retries preserving prior attempt history."
	case item.Slug == "razorpay":
		return "Razorpay REST pulls honor Retry-After for Customers, Orders, Payments, Refunds, and webhook delivery failures; retry cursors persist object, skip cursor, attempt count, next attempt time, status, and truncated errors. Disconnect returns and persists operator-managed provider_cleanup readiness evidence for local shutdown; Razorpay key-secret revocation, webhook endpoint deletion, duplicate endpoint audit, and signing-secret rotation remain operator-managed Razorpay Dashboard actions until managed cleanup is certified."
	case item.Slug == "fillout":
		return "Fillout REST pulls honor the documented 5 requests/second per account/API key limit and submissions limit/offset pagination; retry cursors persist offset, attempt count, next attempt time, status, and truncated errors, with bounded exponential backoff for provider failures. Disconnect returns and persists provider_cleanup evidence for Moosewave-managed webhook deletion when a stored webhook ID exists."
	case item.Slug == "surveymonkey":
		return "SurveyMonkey REST pulls use OAuth Bearer credential references, GET /v3/surveys/{survey_id}/details for question/answer labels, GET /v3/surveys/{survey_id}/responses/bulk with documented per_page pagination capped at 100, links.next continuation checkpoints, optional collector/status/created/modified filters, and Retry-After-aware provider errors; surveymonkey_retry cursors persist next URL, timestamp watermark, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, OAuth app review/token revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live SurveyMonkey account certification remain before RuntimeAvailable promotion."
	case item.Slug == "unbounce":
		return "Unbounce REST pulls use OAuth Bearer or API-key Basic credential references, the required application/vnd.unbounce.api.v0.4+json media type, the documented 500 requests/minute account/IP rate limit, GET /pages/{page_id}/form_fields for labels, GET /pages/{page_id}/leads with documented from/to/offset/limit pagination capped at 1000, timestamp watermark checkpoints, and Retry-After-aware provider errors; unbounce_retry cursors persist offset, timestamp watermark, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, OAuth/API-key revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live Unbounce account/API access certification remain before RuntimeAvailable promotion."
	case item.Slug == "leadpages":
		return "Leadpages REST pulls use Bearer API-key or OAuth access-token credential references and GET /api/forms/{form_id}/submissions for the implemented form-submissions slice. leadpages cursors persist provider cursor/next URL/page hints plus last submitted-at/ID watermarks, while leadpages_retry cursors persist the underlying cursor, attempt count, next attempt time, status, and truncated errors with Retry-After-aware scheduled continuation. Disconnect returns and persists operator-managed provider_cleanup evidence; live Leadpages response schema, pagination parameter/next-link behavior, rate limits, API-key/OAuth revocation proof, dashboard webhook/export cleanup, reconnect proof, data-delete proof, and live account certification remain before RuntimeAvailable promotion."
	case item.Slug == "123formbuilder":
		return "123FormBuilder REST API v2 pulls use vault-backed JWT refs or token-exchange login refs, POST /token when needed, and GET /forms/{form_id}/submissions with documented JWT query auth, page/per_page pagination capped at 1000, optional start_date/include_recipients filters, duplicate-safe start_submission_id checkpoints, and Retry-After-aware provider errors. 123formbuilder cursors persist page, total-page evidence, submission ID/date watermarks, and in-flight high-water marks, while 123formbuilder_retry cursors persist the underlying cursor, attempt count, next attempt time, status, and truncated errors with scheduled continuation. Disconnect returns and persists operator-managed provider_cleanup evidence; live US/EU account certification, JWT/login credential rotation proof, provider-side webhook/export cleanup, reconnect proof, data-delete proof, and live incremental semantics certification remain before RuntimeAvailable promotion."
	case item.Slug == "instapage":
		return "Instapage REST pulls use Bearer personal API token credential references, POST /v1/workspaces/{workspaceId}/submissions with documented page filters, UNIX-second timeframe windows, nextPageToken continuation checkpoints, a 100-submission page cap, documented 200 requests/minute API limits, and Retry-After-aware provider errors; instapage_retry cursors persist nextPageToken, timestamp watermark, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, token revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live Instapage workspace/API-token certification remain before RuntimeAvailable promotion."
	case item.Slug == "carrd":
		return "Carrd Custom URL form ingest accepts route-token authenticated GET, POST, AJAX JSON, form-encoded, multipart, and XML submission payloads at the public lead receiver. The runtime resolves rows by site_id/form_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Carrd fields into canonical profiles/events/lists, records webhook-mode sync history, and fails closed after disconnect. Carrd Pro Plus live-site setup, Custom URL destination removal proof, route-token rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live Carrd certification remain before RuntimeAvailable promotion."
	case item.Slug == "optinmonster":
		return "OptinMonster Webhook ingest accepts route-token authenticated JSON payloads containing lead, campaign, meta, and smart_tags objects at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps OptinMonster lead fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. OptinMonster Pro account setup, Webhook destination removal proof, route-token rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live OptinMonster certification remain before RuntimeAvailable promotion."
	case item.Slug == "privy":
		return "Privy custom Webhook ingest accepts Basic-authenticated JSON signup/contact payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies vault-backed Basic auth username/password credentials, dedupes deliveries through lead webhook idempotency, maps signup/contact and campaign fields into canonical profiles/events/lists, records webhook-mode sync history, redacts credential-like fields from provider evidence, and fails closed after disconnect. Privy live account setup, custom Webhook destination removal proof, Basic auth rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live Privy certification remain before RuntimeAvailable promotion."
	case item.Slug == "convertflow":
		return "ConvertFlow custom Webhook ingest accepts route-token authenticated JSON payloads for fields-submitted, contact updated, conversion, or webhook automation events at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps contact, field, and campaign/CTA/form evidence into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. ConvertFlow live account setup, webhook automation removal proof, route-token rotation, duplicate/manual automation audit, reconnect proof, data-delete proof, and live ConvertFlow certification remain before RuntimeAvailable promotion."
	case item.Slug == "sleeknote":
		return "Sleeknote custom integration ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON signup payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Sleeknote signup fields including guid, CustomerId, SleeknoteId, SignupPage, and identity fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. Sleeknote live account setup, custom integration removal proof, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live Sleeknote certification remain before RuntimeAvailable promotion."
	case item.Slug == "wisepops":
		return "Wisepops signed Webhook ingest accepts JSON contact-array or wrapper payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies X-Wisepops-Signature as a raw-body HMAC-SHA256 hex digest with the vault-backed Wisepops API key, dedupes deliveries through lead webhook idempotency, maps contact fields into canonical profiles/events/lists, records webhook-mode sync history, redacts secret-like fields from provider evidence, and fails closed after disconnect. Wisepops live account setup, hook removal proof, API-key rotation, duplicate/manual hook audit, reconnect proof, data-delete proof, and live Wisepops certification remain before RuntimeAvailable promotion."
	case item.Slug == "poptin":
		return "Poptin Webhooks ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON popup lead payloads at the public lead receiver. The runtime resolves rows by account_id/popup_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Poptin lead fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. Poptin live account setup, Webhooks integration removal proof, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live Poptin certification remain before RuntimeAvailable promotion."
	case item.Slug == "hello-bar":
		return "Hello Bar Webhook ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON subscriber payloads at the public lead receiver. The runtime resolves rows by site_id/campaign_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Hello Bar subscriber fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. Hello Bar live account setup, Webhook destination removal proof, route-token rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Hello Bar certification remain before RuntimeAvailable promotion."
	case item.Slug == "landingi":
		return "Landingi Webhook ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON lead payloads at the public lead receiver. The runtime resolves rows by account_id/page_id, optionally enforces configured form_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Landingi form fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. Landingi live account setup, Webhook integration delivery proof, Webhook removal proof, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live Landingi certification remain before RuntimeAvailable promotion."
	case item.Slug == "kickofflabs":
		return "KickoffLabs outbound Webhook ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON lead, referral, repeat-signup, tag, score, opt-out, fraud, and reward payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, optionally enforces configured page_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps KickoffLabs lead/referral/reward fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. KickoffLabs live account setup, outbound Webhook delivery proof, Webhook removal proof, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live KickoffLabs certification remain before RuntimeAvailable promotion."
	case item.Slug == "ninja-forms":
		return "Ninja Forms Webhooks add-on ingest accepts route-token authenticated GET, application/x-www-form-urlencoded POST, and JSON submission payloads at the public lead receiver. The runtime resolves rows by WordPress site_url/form_id, verifies vault-backed route tokens, dedupes deliveries through lead webhook idempotency, maps Ninja Forms fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like fields from provider evidence, and fails closed after disconnect. Ninja Forms live WordPress setup, Webhooks action delivery proof, Webhooks action removal proof, route-token rotation, duplicate/manual action audit, reconnect proof, data-delete proof, and live WordPress/Ninja Forms certification remain before RuntimeAvailable promotion."
	case item.Slug == "outgrow":
		return "Outgrow Webhook ingest accepts Basic-authenticated or route-token authenticated JSON/form lead, visit, and result payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, optionally enforces configured calculator_id or quiz_id, verifies vault-backed route tokens or Basic auth credentials, dedupes deliveries through lead webhook idempotency, maps Outgrow fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token-like and authorization fields from provider evidence, and fails closed after disconnect. Outgrow live account setup, Webhook delivery proof, Webhook removal proof, credential rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Outgrow certification remain before RuntimeAvailable promotion."
	case item.Slug == "shortstack":
		return "ShortStack Webhook form integration ingest accepts X-SS-Signature authenticated application/x-www-form-urlencoded and JSON entry payloads at the public lead receiver. The runtime resolves rows by account_id/campaign_id, verifies the raw body with HMAC-SHA1 using the vault-backed ShortStack secret key, dedupes deliveries through lead webhook idempotency, maps ShortStack entry fields into canonical profiles/events/lists, records webhook-mode sync history, redacts secret-like fields from provider evidence, and fails closed after disconnect. ShortStack live account setup, form-integration delivery proof, webhook integration removal proof, secret rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live ShortStack certification remain before RuntimeAvailable promotion."
	case item.Slug == "riddle":
		return "Riddle Webhook ingest accepts signature-key or route-token authenticated JSON lead/result payloads at the public lead receiver. The runtime resolves rows by account_id/quiz_id, optionally enforces configured campaign_id when Riddle deliveries include one, verifies the raw body with the vault-backed signature key or a Moosewave-owned route token, dedupes deliveries through lead webhook idempotency, maps Riddle form, question, answer, and result fields into canonical profiles/events/lists, records webhook-mode sync history, redacts token/signature-like fields from provider evidence, and fails closed after disconnect. Riddle live account setup, Webhook delivery proof, Webhook removal proof, credential rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Riddle certification remain before RuntimeAvailable promotion."
	case item.Slug == "paperform":
		return "Paperform REST pulls use Bearer credential references, GET /forms/{slug_or_id}/submissions with documented skip/limit pagination capped at 100, ASC created_at ordering, has_more continuation checkpoints, optional after/before date or ID filters, and Retry-After-aware provider errors; paperform_retry cursors persist skip, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, API-key revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live Paperform account certification remain before RuntimeAvailable promotion."
	case item.Slug == "formstack":
		return "Formstack REST pulls use Bearer Personal Access Token credential references, GET /api/v2025/forms/{formId}/submissions with documented pageNumber/pageSize pagination capped at 100 for this runtime, ASC ordering, expanded legacy field data, page.totalPages continuation checkpoints, and Retry-After-aware provider errors; formstack_retry cursors persist page, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, PAT revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, encrypted-form password certification, and live Formstack account certification remain before RuntimeAvailable promotion."
	case item.Slug == "formsite":
		return "Formsite REST pulls use bearer access-token credential references, the shard-specific /api/v2/{user_dir}/forms/{form_dir}/results endpoint, documented page/limit pagination capped at 500, Pagination-Page-Current/Pagination-Page-Last continuation headers, optional after/before date or ID filters, and Retry-After-aware provider errors; formsite_retry cursors persist page, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks/server posts, token revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, Professional-plan access, and live Formsite account certification remain before RuntimeAvailable promotion."
	case item.Slug == "cognito-forms":
		return "Cognito Forms pulls use Bearer API-key credential references, GET /api/odata/Forms({form_id}) for form metadata, GET /api/forms/{form_id}/schema for field/schema metadata, GET /api/odata/Forms({form_id})/Views({view_id})/Entries?$select=Id&$count=true for documented OData grid-view entry ID discovery, and GET /api/forms/{form_id}/entries/{entry_id} for REST entry hydration; cognito_forms cursors persist form_id, view_id, last_id, and total_count for local ID batching capped at 50 hydrated entries per pull, while cognito_forms_retry cursors persist the underlying cursor, attempt count, next attempt time, status, and truncated errors with Retry-After-aware scheduled continuation. Disconnect returns and persists operator-managed provider_cleanup evidence; API-key rotation/revocation proof, selected-view field visibility proof, ID monotonicity/updated-entry certification, duplicate OData/export/webhook cleanup, reconnect proof, data-delete proof, and live Cognito Forms account certification remain before RuntimeAvailable promotion."
	case item.Slug == "gravity-forms":
		return "Gravity Forms REST pulls use credential references for WordPress Application Password Basic auth or Gravity Forms REST key/secret Basic auth, GET /wp-json/gf/v2/forms/{form_id}/entries with documented _labels, sorting, status/search, paging[page_size], and paging[offset] parameters, total_count/entries response cursors, conservative page-size caps, and Retry-After-aware generic provider errors for WordPress/host 429 or 5xx responses; gravity_forms_retry cursors persist offset, total_count, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; REST API enablement proof, credential revocation proof, provider-managed webhook/feed cleanup, reconnect proof, data-delete proof, and live WordPress/Gravity Forms certification remain before RuntimeAvailable promotion."
	case item.Slug == "wpforms":
		return "WPForms pulls use WordPress Application Password Basic auth credential references against the WordPress Abilities API, GET /wp-json/wp-abilities/v1/abilities/wpforms/get-form/run for form/field metadata, and GET /wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run with documented input[form_id], input[include_fields], input[limit], input[page], input[orderby], input[order], search, field, date, status, and type parameters for Pro entry pages capped at 100; wpforms_retry cursors persist page, total_pages, total_count, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; WordPress 6.9+, WPForms 1.9.9+ Pro entry access, Application Password revocation proof, provider-managed webhook/feed cleanup, reconnect proof, data-delete proof, and live WordPress/WPForms certification remain before RuntimeAvailable promotion."
	case item.Slug == "formidable-forms":
		return "Formidable Forms REST pulls use WordPress Application Password Basic auth or Formidable API-key Basic auth credential references, GET /wp-json/frm/v2/forms/{form_id} and /wp-json/frm/v2/forms/{form_id}/fields for form/field metadata, and GET /wp-json/frm/v2/forms/{form_id}/entries with documented page, page_size, order, order_by, and search parameters capped at 200 for this runtime; formidable_forms_retry cursors persist page, total_pages, total_count, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; Formidable API add-on/license proof, WordPress Application Password or API-key revocation proof, provider-managed webhook/API-action/feed cleanup, reconnect proof, data-delete proof, and live WordPress/Formidable certification remain before RuntimeAvailable promotion."
	case item.Slug == "feathery":
		return "Feathery REST pulls use Token credential references, GET /api/form/submission/?form_id=... with documented page_size/next pagination capped at 1000, start_time/created/completed filters, next-URL continuation checkpoints, field-value identity mapping, and Retry-After-aware provider errors; feathery_retry cursors persist next URL, timestamp watermark, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, API-key revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live Feathery workspace certification remain before RuntimeAvailable promotion."
	case item.Slug == "formaloo":
		return "Formaloo rows pulls use vault-backed x-api-key plus API secret token exchange refs or preissued authorization-token refs, POST /v3.0/oauth2/authorization-token/ when needed, and GET /v3.0/forms/{slug}/rows/ with page/page_size pagination, optional workspace headers, created/updated/submit-time filters, row data identity mapping, and Retry-After-aware provider errors. formaloo cursors persist page or next-URL evidence plus row slug/date watermarks, while formaloo_retry cursors persist the underlying cursor, attempt count, next attempt time, status, and truncated errors with scheduled continuation. Disconnect returns and persists operator-managed provider_cleanup evidence; live workspace certification, API-key/API-secret rotation proof, provider-side webhook/export cleanup, reconnect proof, data-delete proof, and live incremental semantics certification remain before RuntimeAvailable promotion."
	case item.Slug == "google-forms":
		return "Google Forms REST pulls use OAuth Bearer credential references, GET /v1/forms/{formId} for form/question labels, GET /v1/forms/{formId}/responses with documented pageSize/pageToken pagination and RFC3339 timestamp filters, nextPageToken continuation checkpoints, collected respondent email plus question-answer identity mapping, and Retry-After-aware provider errors; google_forms_retry cursors persist page token, timestamp watermark, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; Cloud Pub/Sub watch reconciliation, OAuth app verification, token revocation proof, duplicate Apps Script/Sheet/webhook cleanup, reconnect proof, data-delete proof, and live Google Workspace certification remain before RuntimeAvailable promotion."
	case item.Slug == "tally":
		return "Tally REST pulls use Bearer credential references, GET /forms/{formId}/submissions with documented page/limit pagination capped at 500, hasMore continuation checkpoints, and Retry-After-aware provider errors; tally_retry cursors persist page, attempt count, next attempt time, status, and truncated errors, with scheduled continuation and bounded exponential backoff. Disconnect returns and persists operator-managed provider_cleanup evidence; provider-managed webhooks, token revocation proof, duplicate/manual export cleanup, reconnect proof, data-delete proof, and live Tally account certification remain before RuntimeAvailable promotion."
	case item.Slug == "jotform":
		return "Jotform REST pulls respect plan-based daily API call limits and submissions offset/limit pagination across Standard, EU, HIPAA, or custom API hosts; retry cursors persist offset, attempt count, next attempt time, status, and truncated errors, with bounded exponential backoff for provider failures. Disconnect returns and persists provider_cleanup evidence for Moosewave-managed webhook deletion or already-absent provider responses when a stored webhook ID exists."
	case item.Slug == "webflow":
		return "Webflow Data API pulls respect forms:read scope, documented 429 responses, form-submission limit/offset pagination with max page size 100, and optional elementId filtering; retry cursors persist offset, attempt count, next attempt time, status, and truncated errors, honoring Retry-After when present and otherwise using bounded exponential backoff for provider failures. Disconnect returns and persists provider_cleanup evidence for stored-ID deletion or exact endpoint/filter cleanup fallback."
	case item.Slug == "typeform":
		return "Typeform Responses API pulls honor the documented page_size maximum of 1000, response_type filters, after-cursor traversal, and Retry-After-aware 429 handling; retry cursors persist response token, attempt count, next attempt time, status, and truncated errors. Disconnect returns and persists provider_cleanup evidence for Moosewave-managed webhook deletion or already-absent provider responses."
	case item.Slug == "wix":
		return "Wix Forms and Contacts REST pulls honor Retry-After for app-instance token, submissions, and contacts requests; retry cursors persist object, provider cursor, attempt count, next attempt time, status, and truncated errors."
	case item.Slug == "facebook-lead-ads":
		return "Facebook Lead Ads Graph pulls use /{form_id}/leads for explicit sync/backfill plus scheduled facebook_lead_ads_retry continuation, with page-size caps, after-cursor checkpoints, credential-reference Bearer auth, and Retry-After-aware provider errors. Managed Page leadgen subscriptions are reconciled on connect and cleaned on disconnect when Moosewave-owned evidence exists, with returned and persisted provider_cleanup evidence for the Page subscription cleanup. Leadgen webhooks verify X-Hub-Signature-256 with a vault-backed Meta app secret, claim page/form/lead delivery IDs in lead_webhook_events, fetch /{leadgen_id} before canonical mapping, and record webhook-mode lead sync runs; page/form ownership certification and live Meta app-review evidence remain partial."
	case item.Slug == "google-lead-form-extensions":
		return "Google Lead Form Extensions pulls use GoogleAdsService.Search /customers/{customer_id}/googleAds:search for lead_form_submission_data with fixed Google Ads Search pages, GAQL LIMIT 1000 batches, submission_date_time/id watermark checkpoints, OAuth Bearer plus developer-token credential refs, optional login-customer-id, Retry-After-aware provider errors, scheduled google_lead_forms_retry cursors, connect-time history import, and returned/persisted operator-managed provider_cleanup evidence on disconnect. Google Ads API exports are limited to recent lead form data, documented as up to 60 days, and Google's API export path removes any dependency on CSV downloads or provider webhook delivery for this slice. Live Google Ads account/API certification, ownership/export-window evidence, OAuth/developer-token rotation, duplicate/manual CRM export audit, and data-delete proof remain before full availability."
	case isAnalyticsPullerLiveCertificationPending(item):
		return analyticsPullerRateLimitPolicy(item)
	case isReviewPullerLiveCertificationPending(item):
		return "Native review provider pulls use credential references, provider-specific REST pagination or cursor checkpoints, empty sync/backfill provider dispatch, scheduled review backfill workers, review_provider retry cursors with Retry-After-aware backoff, canonical product-review/reviewer/event imports, run history, disconnect-safe local write guards, and returned/persisted operator-managed provider_cleanup evidence on disconnect. Provider-managed webhook registration/callback certification, provider-console credential cleanup proof, live merchant/account certification, and broader Q&A/syndication/review-request slices where applicable remain before RuntimeAvailable promotion."
	case isLoyaltyPullerLiveCertificationPending(item):
		return "Native loyalty provider pulls use credential references, provider-specific REST pagination or cursor checkpoints, empty sync/backfill provider dispatch, scheduled loyalty backfill workers, loyalty_provider retry cursors with Retry-After-aware backoff, canonical loyalty profile/event imports for the implemented slice, run history, disconnect-safe local write guards, and returned/persisted operator-managed provider_cleanup evidence on disconnect. Provider-managed webhook registration/callback certification, provider-console credential cleanup proof, live program/account certification, and broader reward/referral/event slices where applicable remain before RuntimeAvailable promotion."
	case isSubscriptionPullerLiveCertificationPending(item):
		return subscriptionPullerRateLimitPolicy(item)
	case item.Slug == "close":
		return "Close CRM pulls use API-key credential references, Basic auth, /api/v1/contact/ offset pagination, close: checkpoints, scheduled close_retry continuation with Retry-After-aware provider errors, and canonical CRM contact/profile mapping. Route-token public webhooks verify Close close-sig-hash/close-sig-timestamp HMAC-SHA256 signatures with the vault-backed subscription signature_key, claim deliveries in crm_webhook_events, map contact create/update/delete callbacks, and map opportunity/task/activity callbacks into CRM events when identity is present or can be hydrated through /api/v1/contact/{id}. Disconnect stops local pulls and provider-routed webhook resolution and persists operator-managed provider_cleanup evidence; live Close workspace certification, managed webhook subscription registration/cleanup proof, API-key/signature-key rotation, duplicate/manual webhook audit, reconnect, disconnect, and data-delete behavior remain before full availability."
	case item.Slug == "postscript":
		return "Postscript SMS pulls use /subscribers with credential-reference Bearer auth, bounded page sizes, provider cursors persisted as postscript: checkpoints, scheduled postscript_retry continuation with Retry-After-aware provider errors, and phone-keyed identify for SMS-only subscribers. Route-token public webhooks verify Postscript-Signature against the vault-backed webhook signing token, claim deliveries in crm_webhook_events, and map shop.incoming_message plus subscriber opt-in/opt-out events into CRM contacts/events without requiring email. Disconnect returns and persists operator-managed provider_cleanup evidence; live shop certification, provider-console webhook registration proof, duplicate/manual webhook audit, API-key/signing-token rotation, reconnect, and data-delete behavior remain before full availability."
	case item.Slug == "attentive":
		return "Attentive SMS pulls use /subscribers with credential-reference Bearer auth, bounded page sizes, provider cursors persisted as attentive: checkpoints, scheduled attentive_retry continuation with Retry-After-aware provider errors, and phone-keyed identify for SMS-only subscribers. Route-token public webhooks verify x-attentive-hmac-sha256 against the vault-backed signing key, claim deliveries in crm_webhook_events, and map SMS subscribe/unsubscribe/inbound/sent/click plus custom-attribute events into CRM contacts/events without requiring email. Disconnect returns and persists operator-managed provider_cleanup evidence; live company/app certification, provider-console webhook registration proof, duplicate/manual webhook audit, API-key/signing-key rotation, reconnect, and data-delete behavior remain before full availability."
	case item.Slug == "front":
		return "Front Conversations REST pulls honor Retry-After for 429/5xx responses, use /inboxes/{inbox_id}/conversations for scoped first pages when configured, follow Front's returned next-page URLs through front: cursor checkpoints, skip no-email conversations before canonical writes, and continue due installs with scheduled front_retry cursors. Signed Front webhooks resolve inbox-scoped rows, verify X-Front-Signature with timestamp freshness against a vault-backed secret, claim deliveries in support_webhook_events, map dense conversation/message payloads, and sparse-refresh conversation IDs through /conversations/{id}. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Front-side token/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live inbox behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "crisp":
		return "Crisp Conversations REST pulls honor Retry-After for 429/5xx responses, use plugin-token Basic auth with X-Crisp-Tier, page through /v1/website/{website_id}/conversations/{page}, persist crisp: page checkpoints, and continue due installs with scheduled crisp_retry cursors. Signed Crisp plugin-hook callbacks resolve website-scoped rows, verify X-Crisp-Signature plus timestamp against a vault-backed secret, claim deliveries in support_webhook_events, map dense session/message payloads, and sparse-refresh session IDs through /v1/website/{website_id}/conversation/{session_id}/meta. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Crisp-side token/plugin-hook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live website behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "drift":
		return "Drift Conversations REST pulls honor Retry-After for 429/5xx responses, use /conversations/list with returned links.next URL pagination, resolve missing email identity through /contacts/{id}, persist drift: cursor checkpoints, and continue due installs with scheduled drift_retry cursors. Verification-token app webhooks resolve workspace-scoped rows, verify X-Verification-Token or JSON token against a vault-backed secret, redact verifier evidence, claim deliveries in support_webhook_events, map dense new_message/new_conversation payloads, and sparse-refresh conversation IDs through /conversations/{id} plus contact lookup. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Drift-side token/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "kustomer":
		return "Kustomer Conversations REST pulls honor Retry-After for 429/5xx responses, use /v1/conversations page cursors, resolve missing customer email evidence through /v1/customers/{id}, persist kustomer: page checkpoints, and continue due installs with scheduled kustomer_retry cursors. Signed Kustomer outbound webhooks resolve organization-scoped rows, verify HMAC-SHA256 signatures against a vault-backed secret, claim deliveries in support_webhook_events, map dense conversation/message payloads, and sparse-refresh conversation IDs through /v1/conversations/{id} plus customer lookup. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Kustomer-side token/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "freshchat":
		return "Freshchat Users/Conversations/Messages REST pulls honor Retry-After for 429/5xx responses, page /v2/users, hydrate per-user /v2/users/{user_id}/conversations, /v2/conversations/{conversation_id}, and /v2/conversations/{conversation_id}/messages, apply optional channel filtering after detail hydration, persist freshchat: page checkpoints, and continue due installs with scheduled freshchat_retry cursors. Signed Freshchat callbacks resolve normalized Freshchat/Freshworks account domains plus exact route tokens, verify X-Freshchat-Signature with the configured RSA public key, claim deliveries in support_webhook_events, and sparse-refresh user/conversation/message evidence through the REST runtime. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Freshchat-side token/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "tidio":
		return "Tidio OpenAPI pulls honor Retry-After for 429/5xx responses, page /tickets and /contacts, hydrate /tickets/{ticketId} and /contacts/{contactId}/messages, apply optional channel filtering, persist encoded tidio:tickets and tidio:contacts checkpoints, and continue due installs with scheduled tidio_retry cursors. Signed Tidio webhooks resolve project_public_key plus optional webhook IDs, verify x-tidio-signature HMAC-SHA256 over raw body and timestamp with a vault-backed secret, claim deliveries in support_webhook_events, and sparse-refresh ticket/contact data through OpenAPI when needed. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Tidio-side credential/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live Plus/Premium project behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "gladly":
		return "Gladly customer-scoped REST pulls use documented Basic auth with API User email plus API token, hydrate /api/v1/customer-profiles/{customerId}, /api/v1/customers/{customerId}/conversations, /api/v1/conversations/{conversationId}/items, optional task endpoints, and recent /api/v1/events windows, preserve Gladly-Limited-Data evidence, persist gladly: and gladly_retry cursors with Retry-After timing, and continue due installs through the scheduled support worker. Authenticated Gladly webhooks resolve organization-domain rows with optional webhook IDs, verify documented Basic Authentication or static header-token auth, claim deliveries in support_webhook_events, sparse-refresh conversation/customer/task IDs, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; broad historical organization export, managed webhook registration/cleanup, API-token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live organization behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "groove":
		return "Groove REST pulls use Bearer credential refs, page GET /tickets with page/per_page plus optional state, folder_id, and customer filters, hydrate per-ticket GET /tickets/{ticket_number}/messages, extract customer email evidence from Groove links, persist groove: page checkpoints, and continue due installs with scheduled groove_retry cursors that honor provider Retry-After. Route-token Groove webhooks resolve mailbox-scoped rows with stored groove_webhook_id, claim deliveries in support_webhook_events, sparse-refresh ticket numbers through /tickets/{ticket_number}, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; GraphQL v2 parity, documented signed callback verification or certified route-token posture, export-assisted historical backfill, managed webhook registration/cleanup, API-token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live organization behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "reamaze":
		return "Reamaze Conversations REST pulls use Basic-auth credential refs, page GET /api/v1/conversations with updated-sort checkpoints, hydrate each conversation through GET /api/v1/conversations/{slug}/messages?include=original_body, preserve message HTML, persist reamaze: page checkpoints, and continue due installs with scheduled reamaze_retry cursors that honor provider Retry-After. Route-token Reamaze webhooks resolve normalized account-domain rows with stored reamaze_webhook_id, claim deliveries in support_webhook_events, sparse-refresh conversation slugs through the Messages runtime, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; signed callback certification, managed webhook registration/cleanup, API-token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live account behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "jira-service-management":
		return "Jira Service Management pulls use OAuth Bearer or operator API-token credential refs, route to https://api.atlassian.com/ex/jira/{cloudId} or configured site_url/api_base_url, page GET /rest/servicedeskapi/request with service_desk_id, project_key, organization_id, and request_status filters, hydrate GET /rest/servicedeskapi/request/{issueIdOrKey}/comment, persist jira-service-management: checkpoints, and continue due installs with scheduled jira_service_management_retry cursors that honor provider Retry-After. Route-token Jira issue/comment webhooks resolve site-scoped rows with stored jira_service_management_webhook_id, claim Atlassian delivery IDs or body-hash fallbacks in support_webhook_events, sparse-refresh issue IDs/keys through the request/comment runtime, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; OAuth dynamic-webhook JWT verification, managed 30-day webhook refresh/cleanup, broader issue-search backfill, token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live Atlassian site behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "linear":
		return "Linear GraphQL pulls use OAuth/API Bearer credential refs, page issues(first, after, includeArchived, orderBy: updatedAt) with optional team_id filtering, hydrate bounded issue.comments(first: 25), preserve customer-need/requester email evidence, persist linear: cursor checkpoints, and continue due installs with scheduled linear_retry cursors that honor Retry-After and Linear reset timing. Signed Linear webhooks resolve workspace-scoped rows with optional webhook IDs, verify Linear-Signature HMAC-SHA256 and Linear-Timestamp skew when present, claim Linear delivery IDs or body-hash fallbacks in support_webhook_events, sparse-refresh issue IDs through GraphQL, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; managed webhook registration/cleanup, full comment pagination, OAuth/app-actor refresh certification, app-actor writeback, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "asana-support":
		return "Asana Support pulls use OAuth/PAT Bearer credential refs, page GET /projects/{project_gid}/tasks or GET /tasks?workspace={workspace_id}, hydrate GET /tasks/{task_gid}/stories, preserve creator/custom-field/notes requester email evidence, persist asana-support: offset checkpoints, and continue due installs with scheduled asana_support_retry cursors that honor provider Retry-After. Signed Asana webhooks resolve workspace-scoped rows with optional webhook IDs, echo X-Hook-Secret during provider handshake, verify X-Hook-Signature HMAC-SHA256 over the raw body, claim deliveries in support_webhook_events, sparse-refresh task IDs through the task/story runtime, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; managed webhook creation/secret storage/cleanup, Resource Export parity, workspace task-search pagination, token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "clickup-support":
		return "ClickUp Support pulls use personal-token or OAuth Bearer credential refs, page GET /list/{list_id}/task or GET /team/{workspace_id}/task, hydrate GET /task/{task_id}/comment, preserve creator/custom-field/text requester email evidence, persist clickup-support: page checkpoints, and continue due installs with scheduled clickup_support_retry cursors that honor Retry-After and X-RateLimit-Reset. Signed ClickUp webhooks resolve workspace-scoped rows with optional webhook IDs, verify X-Signature HMAC-SHA256 over the raw body, claim deliveries in support_webhook_events, sparse-refresh task IDs through the task/comment runtime, and fail closed after disconnect. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; managed webhook registration/cleanup, full task-comment pagination with start/start_id, hierarchy discovery across Spaces/Folders/Lists, OAuth token cleanup proof, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "helpcrunch":
		return "HelpCrunch REST pulls honor Retry-After when returned for 429/5xx responses, page /chats with offset/limit filters, hydrate /chats/{chat_id}/messages, persist helpcrunch: offset checkpoints, and continue due installs with scheduled helpcrunch_retry cursors. Signed HelpCrunch webhooks resolve organization-scoped rows, verify X-HelpCrunch-Signature HMAC-SHA1 over the raw body with a vault-backed signing key, claim deliveries in support_webhook_events, and sparse-refresh chat IDs through the REST runtime. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; HelpCrunch-side API-key/webhook cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, high-volume live throttling behavior, and live organization behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "ada":
		return "Ada Data Export pulls honor Retry-After for 429/5xx responses, page /v2/export/conversations across created windows, enrich missing emails through /v2/end-users/{end_user_id}, hydrate /v2/export/messages per conversation, persist ada: next-page checkpoints, and continue due installs with scheduled ada_retry cursors. Signed Ada/Svix webhooks resolve ai_agent_domain plus optional endpoint IDs, verify webhook-id/webhook-timestamp/webhook-signature with a vault-backed signing secret, claim deliveries in support_webhook_events, and sparse-refresh conversations through the Conversations API or direct-map fully identified payloads. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Ada-side API-key/webhook cleanup, duplicate/manual endpoint audit, reconnect, disconnect, data-delete, Native Social limitations, and live AI Agent behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "olark":
		return "Olark Transcripts REST pulls honor Retry-After for 429/5xx responses, page /api/v1/transcripts with offset checkpoints, map transcript items into support messages, persist olark: cursor checkpoints, and continue due installs with scheduled olark_retry cursors. Operator-configured Olark transcript webhooks resolve site-scoped rows with exact route tokens, accept form-posted transcript JSON from the data field or direct JSON test payloads, claim deliveries in support_webhook_events, and reuse the REST transcript mapper for tickets and item messages. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Olark-side token/webhook cleanup, duplicate/manual target audit, first-party signing posture, reconnect, disconnect, data-delete, and live site behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "zoho-desk":
		return "Zoho Desk Tickets REST pulls honor Retry-After for 429/5xx responses, send orgId headers, request /api/v1/tickets?include=contacts with optional departmentId filters, hydrate /api/v1/tickets/{ticket_id}/threads/{thread_id}?include=plainText message detail, persist zoho-desk: offset checkpoints, and continue due installs with scheduled zoho_desk_retry cursors. Signed Zoho Desk webhooks resolve organization-scoped rows, verify X-ZDesk-JWT against provider JWKS with issuer/audience checks when present, claim deliveries in support_webhook_events, sparse-refresh ticket IDs through /api/v1/tickets/{ticket_id}?include=contacts, and reuse thread hydration while honoring department filters. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; Zoho-side OAuth/notification cleanup, duplicate/manual target audit, reconnect, disconnect, data-delete, and live helpdesk behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "livechat":
		return "LiveChat Archives REST pulls honor Retry-After for 429/5xx responses, post to /v3.6/agent/action/list_archives with optional group filters, persist livechat: page checkpoints, and continue due installs with scheduled livechat_retry cursors. Payload-secret authenticated callbacks resolve account-scoped rows, verify the JSON secret_key through a vault-backed webhook secret reference, scrub verifier evidence before persistence, claim deliveries in support_webhook_events, and map incoming_chat/incoming_event payloads into support tickets, messages, profiles, and events. Opt-in managed webhook setup calls the LiveChat Configuration API register_webhook for Moosewave-owned route tokens, stores returned provider webhook IDs, rolls back newly-created webhooks when local persistence fails, and disconnect unregisters stored provider webhook IDs before persisting provider_cleanup evidence; live Configuration API certification, token rotation/revocation proof, duplicate/manual target audit, reconnect, disconnect, and data-delete validation remain open before RuntimeAvailable promotion."
	case item.Slug == "hubspot-service-hub":
		return "HubSpot Service Hub Tickets REST pulls honor Retry-After for 429/5xx responses, use /crm/v3/objects/tickets with associations=contacts, optional hs_pipeline filters, after-cursor checkpoints, contact lookup through /crm/v3/objects/contacts/{id}, and scheduled hubspot_service_hub_retry cursors. Signed HubSpot app webhooks route through scoped portal targets or the app-level target, verify v3 signatures with the resolved app secret, claim per-event deliveries in support_webhook_events, sparse-refresh ticket IDs, honor pipeline filters, and preserve deletion callbacks as replay-safe no-op evidence until support tombstones land. Disconnect stops local pulls and provider-routed webhook resolution and persists provider_cleanup readiness evidence; HubSpot-side webhook subscription cleanup, duplicate/manual target audit, token rotation/revocation proof, reconnect, disconnect, data-delete, and live portal behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "salesforce-service-cloud":
		return "Salesforce Service Cloud SOQL Case and CaseComment pulls honor Retry-After for 429/5xx responses, use /services/data/{version}/query with nextRecordsUrl checkpoints, support case_record_type_id and case_queue_id filters, map Contact email plus Case owner/queue evidence, hydrate bounded CaseComments for each fetched page, share managed crm:salesforce OAuth credential refresh, and continue due installs with scheduled salesforce_service_cloud_retry cursors. Operator-managed CDC/Pub/Sub relay callbacks resolve instance-scoped rows, verify shared relay secrets, require exact relay IDs when configured, claim deliveries in support_webhook_events, sparse-refresh Case IDs through SOQL, and map CaseComments into support messages. Disconnect stops local pulls and provider-routed relay resolution and persists provider_cleanup readiness evidence; Salesforce-side CDC/Pub/Sub subscription cleanup, duplicate/manual relay audit, connected-app/token cleanup proof, reconnect, disconnect, data-delete, and live org behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "hubspot":
		return "HubSpot CRM contact, configured list-membership, and opt-in deal association event REST pulls honor Retry-After for 429/5xx responses, persist HubSpot after-cursor checkpoints including list_id/deal state, batch-read member contacts and deal-associated contact/company records by ID, carry provider-list segment evidence, materialize mapped proven HubSpot list memberships into native Moosewave lists, stale-repair owned mapped memberships on terminal list scans, continue due installs with scheduled hubspot_retry cursors, refresh managed OAuth tokens before expiry, revoke managed refresh tokens on Moosewave disconnect, and claim app-level v3-signed contact webhooks by portalId/eventId; live HubSpot portal certification remains required before runtime promotion, while historical coarse source=integration reconciliation and broader deal/account materialization stay optional operator migration or future product scope."
	case item.Slug == "salesforce":
		return "Salesforce SOQL Contact, Lead, CampaignMember, and Task pulls honor Retry-After for 429/5xx responses, use Sforce-Query-Options batch sizing, persist nextRecordsUrl query locators, map CampaignMembers and Tasks into canonical CRM events by Contact/Lead email, materialize mapped CampaignMember identities into native Moosewave list adds and explicit removal-signal soft-removes, stale-repair owned mapped Campaign memberships on complete scans, continue due installs with scheduled salesforce_retry cursors, refresh managed OAuth tokens before expiry and reactively after INVALID_SESSION_ID responses, and revoke managed refresh tokens on Moosewave disconnect; live Salesforce org certification remains required before runtime promotion, while CDC/Platform Events are tracked as a future streaming enhancement outside this SOQL runtime slice."
	case item.Slug == "pipedrive":
		return "Pipedrive Persons, Deals, Organizations, and Activities API pulls honor Retry-After for 429/5xx responses, use documented v2 limit/cursor pagination with a 500 item cap, persist Pipedrive cursor checkpoints, refresh managed OAuth credentials before expiry, revoke refresh tokens on Moosewave disconnect, delete local managed credential envelopes before marking rows disconnected, accept Pipedrive OAuth uninstall callbacks by unique client/user/company identity, claim managed person/deal/organization/activity webhooks by provider webhook id plus integration-scoped body hash after Basic Auth and payload route checks, and continue due installs with scheduled pipedrive_retry cursors; live certification remains required before runtime promotion."
	case item.Slug == "zoho-crm":
		return "Zoho CRM V8 Contacts and Leads pulls honor Retry-After for 429/5xx responses, use the documented 200 record per_page cap, page pagination for the first 2,000 records, page_token checkpoints beyond that, managed OAuth refresh before expiry, scheduled zoho_retry continuation with retry-attempt preservation, manual retry-cursor skip/resume/failure preservation, disconnected-row guards before provider calls and local writes, managed refresh-token revocation on Moosewave disconnect, and local managed OAuth credential cleanup. Accounts, Deals, activities, Notification API channels, connected-app/notification cleanup certification, and live org certification remain outside the implemented local-complete puller slice."
	case item.Slug == "microsoft-dynamics-365":
		return "Microsoft Dynamics 365 Dataverse Contacts and Leads pulls honor Retry-After for 429/5xx responses, use Prefer: odata.maxpagesize capped at 5,000 rows, persist @odata.nextLink checkpoints, refresh managed OAuth credentials before expiry, continue due installs with scheduled dynamics365_retry cursors and retry-attempt preservation, preserve manual retry cursors across skip/resume/provider-failure/local-failure paths, use disconnected-row guards before provider calls and local writes, and delete local managed OAuth credential envelopes on Moosewave disconnect while recording that provider revocation is operator-managed because this connector has no provider revocation endpoint. Accounts, Opportunities, activities, marketing lists, change tracking/webhooks, Microsoft Entra/app cleanup certification, and live environment certification remain outside the implemented local-complete puller slice."
	case item.Slug == "keap":
		return "Keap REST v2 Contacts pulls honor Retry-After for 429/5xx responses, use page_size capped at 1,000 records, persist page_token checkpoints, optionally use tag_id only for the tagged-contact read path, refresh managed OAuth credentials before expiry when OAuth credentials are used, continue due installs with scheduled keap_retry cursors and retry-attempt preservation, preserve manual retry cursors across skip/resume/provider-failure/local-failure paths, use disconnected-row guards before provider calls and local writes, delete local managed OAuth/PAT/SAK credential envelopes on Moosewave disconnect while recording that provider revocation is operator-managed because this connector has no provider revocation endpoint, and should monitor Keap throttle/quota headers. Full tag membership fanout, campaigns, orders, appointments, webhooks, provider credential cleanup certification, and live account certification remain outside the implemented local-complete Contacts puller slice."
	case item.Slug == "meta":
		return "Meta audience deliveries run through the audience sync job, consent firewall, shared credential resolver, and Graph v25.0 /{audience_id}/users requests using EMAIL_SHA256 payload rows. The adapter chunks Custom Audience users uploads at 10,000 members per request, retries transient 429/5xx/network chunk failures with bounded Retry-After-aware backoff, records batch counts, stores safe Meta response counters such as num_received and invalid-entry counts without invalid samples, and preserves accepted member/batch evidence when a later chunk fails; disconnect marks the local destination disconnected, preserves job history, and returns/persists operator-managed provider_cleanup readiness evidence, while live app-review, quota certification, and provider-side audience/token/app cleanup remain before runtime promotion."
	case item.Slug == "google-ads":
		return "Google Ads Customer Match deliveries run through the audience sync job, consent firewall, shared credential resolver, and Data Manager API audienceMembers:ingest or audienceMembers:remove requests using SHA-256 HEX email identifiers plus request-level consent and Customer Match terms acknowledgement for uploads. The adapter defaults new rows to Data Manager, chunks Data Manager add/remove calls at the 10,000-member request cap, retries transient 429/5xx/network failures with bounded Retry-After-aware backoff, stores raw single requestIds or compact multi-requestId evidence, checks each request on demand through requestStatus:retrieve, and polls provider_status/provider_next_check_at in the background with bounded backoff. Disconnect marks the local destination disconnected, preserves job history, and returns/persists operator-managed provider_cleanup readiness evidence. Existing allowlisted legacy integrations remain behind the explicit OfflineUserDataJob worker gate, and legacy job lifecycle plus provider-side list/token/account cleanup remain outside the Data Manager local-complete slice until separately certified."
	case item.Slug == "tiktok":
		return "TikTok Audiences deliveries run through the audience sync job, consent firewall, shared credential resolver, SHA-256 email hashing, TikTok Marketing API multipart Customer File upload, and custom-audience create/update calls. The adapter retries transient 429/5xx/network failures with bounded Retry-After-aware backoff, stores returned request IDs plus custom audience IDs as provider evidence, retrieves custom-audience status on demand through /dmp/custom_audience/get/, and lets the background diagnostics poller roll provider_status/provider_next_check_at into job/run history. Disconnect marks the local destination disconnected, preserves job history, and returns/persists operator-managed provider_cleanup readiness evidence. Live TikTok advertiser certification, quota validation, REMOVE/REPLACE provider-side certification, and provider-side audience/token/app cleanup remain before full availability."
	case item.Slug == "linkedin":
		return "LinkedIn Matched Audience deliveries run through the audience sync job, consent firewall, shared credential resolver, SHA-256 email hashing with whitespace removal, and LinkedIn Marketing API DMP segment-users BATCH_CREATE calls. The adapter chunks segment-user add/remove calls at 5,000 members per request, retries transient 429/5xx/network failures with bounded Retry-After-aware backoff, treats per-element batch errors as provider failures, stores segment readback keys because LinkedIn's streaming users endpoint does not return per-batch request IDs, retrieves DMP segment status on demand through GET /dmpSegments/{segment_id}, and lets the background diagnostics poller roll provider_status/provider_next_check_at into job/run history. The readiness gate requires explicit Audiences-program approval evidence before delivery. Disconnect marks the local destination disconnected, preserves job history, and returns/persists operator-managed provider_cleanup readiness evidence. Live LinkedIn Audiences-program certification, account-role validation, quota validation, replacement semantics, and provider-side segment/token/app cleanup remain before full availability."
	case item.Slug == "snap":
		return "Snap Audience deliveries run through the audience sync job, consent firewall, shared credential resolver, SHA-256 email hashing, and Snap Marketing API /segments/{segment_id}/users requests using nested EMAIL_SHA256 payload rows. The adapter chunks segment-user add/remove calls at 100,000 members per request, supports explicit REMOVE and REPLACE request construction with /segments/{segment_id}/users and /segments/{segment_id}/all_users, retries transient 429/5xx/network failures with bounded Retry-After-aware backoff, records batch counts, stores returned request IDs when present, retrieves segment status on demand through GET /segments/{segment_id}, and lets the background diagnostics poller roll provider_status/provider_next_check_at into job/run history. Disconnect marks the local destination disconnected, preserves job history, and returns/persists operator-managed provider_cleanup readiness evidence. Live Snap account certification, quota validation, remove/replace provider-side certification, and provider-side segment/token/app cleanup remain before full availability."
	case item.Slug == "snowflake":
		return "Snowflake warehouse runs are bounded by Moosewave scheduled job limits, object selection, backfill windows, dry_run no-side-effect planning, stored manifest handoff artifacts, per-object JSONL load-plan artifacts, ordered provider-job statement plans, linked database/sql Snowflake execution, retry_count prior-failure evidence, local cleanup acknowledgment, and manifest-worker idempotency. SQL export COPY and SELECT 1 health execution are locally runnable through the attached executor when stage/storage/credential prerequisites are present; live Snowflake account certification, provider-error/backoff proof, remote table polling/materialization, schema discovery, and Snowflake-side cleanup proof remain before RuntimeAvailable promotion."
	case hasSource(item, "warehouse") && item.RuntimeStatus == RuntimePartial:
		return "Warehouse manifest runs are bounded by tenant job limits; provider-specific load/query rate limits apply only after the provider driver attaches."
	case hasSource(item, "warehouse") && item.RuntimeStatus == RuntimeDelegated:
		return "Object-storage handoff runs are bounded by Moosewave storage adapter limits and cursor checkpoints; direct tenant-bucket provider limits apply only after that driver attaches."
	case hasSource(item, "sending"):
		return "Campaign delivery is bounded by Moosewave send-loop rate limits and Listmonk messenger behavior; provider-specific send API quota handling applies only after direct provider drivers attach."
	case hasSource(item, "sms"):
		return "SMS provider effects and hosted callbacks are release-held. No quota or availability claim is made until durable reconciliation, financial settlement, and tenant-bound provider credential/account ownership are deployed."
	case item.Slug == "recharge":
		return "Recharge /subscriptions pulls honor Retry-After for 429/5xx responses, use Recharge limit/cursor pagination with a 250 item cap, persist recharge: cursor checkpoints, continue due installs with scheduled recharge_retry cursors, accept tokenized subscription/charge webhooks with durable delivery claims, verify X-Recharge-Hmac-Sha256 when webhook_secret_ref is configured, return plus persist operator-managed provider_cleanup readiness evidence on disconnect, and expose local provider-cleanup acknowledgment for operator attestation; live merchant certification remains required, while provider-console webhook/token cleanup is the documented operator-managed posture unless a future certified cleanup API path is adopted."
	case item.Slug == "yotpo":
		return "Yotpo review pulls exchange app_key/secret through /oauth/token, honor Retry-After for token and reviews REST failures, use /v1/apps/{app_key}/reviews count/page pagination with a 100 item cap, persist yotpo: cursor checkpoints, continue due installs with scheduled yotpo_retry cursors, perform lookup-only Yotpo product/order evidence resolution to existing commerce UUIDs, resolve product_id from matched existing order line items after order lookup, map customer evidence to a canonical review customer_id column plus metadata/profile/event properties when commerce_integration_id is configured, and accept tokenized review_create/review_updated public ingest with integration-scoped WebhookMessageId idempotency and body-hash conflict checks. Review payload product evidence does not create or refresh commerce product rows; unresolved product misses carry product_refresh_required handoff metadata, provider-pulled local write failures preserve SYNC_FAILED retry cursors, and disconnect-safe guards re-check rows before local writes. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown, and the acknowledgment endpoint records local operator attestation after Yotpo console cleanup; signed/provider-managed webhook certification, provider-side cleanup proof, live brand certification, and any future provider-certified product refresh path remain before RuntimeAvailable promotion."
	case item.Slug == "smile":
		return "Smile.io customer and event pulls honor Retry-After for 429/5xx responses, use /v1/customers page/page_size pagination plus /v1/points_transactions and /v1/reward_fulfillments cursor pagination, carry updated_at_min incremental event watermarks after smile:complete, map points balance and VIP tier state into loyalty profiles, refresh member state during event phases, map points earned/redeemed and reward issued/pending/used rows into loyalty events, persist smile: cursor checkpoints, preserve SYNC_FAILED retry cursors for fully failed local writes, skip not-yet-due retry cursors before consuming scheduled runnable capacity, and continue due installs with scheduled smile_retry cursors. Signed Smile app webhooks require account_id routing plus webhook_secret_ref setup, verify Smile-Signature over Smile-Timestamp plus raw body with a vault-backed app client secret, claim deliveries in loyalty_webhook_events by tenant/integration/provider/delivery ID with body-hash conflict checks, ignore ping, and map customer/updated payloads into loyalty member updates and loyalty.customer_updated events. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown, re-checks current row state before provider calls and local writes, and the acknowledgment endpoint records local operator attestation after Smile console cleanup; Smile-side cleanup proof/automation decision and live store certification remain open before RuntimeAvailable promotion."
	case item.Slug == "zendesk":
		return "Zendesk Tickets API pulls honor Retry-After for 429/5xx responses, use page[size]/page[after] cursor pagination with a 100 item cap by default, can opt into /api/v2/incremental/tickets/cursor with per_page capped at 1000 plus zendesk_incremental: checkpoints, side-load requester users with include=users, persist cursors, stop scheduled loops at Incremental Export end_of_stream, continue due installs with scheduled zendesk_retry cursors, verify signed Zendesk webhook bodies with X-Zendesk-Webhook-Signature plus X-Zendesk-Webhook-Signature-Timestamp, claim callback deliveries in support_webhook_events, and refresh sparse ticket-id callbacks through /api/v2/tickets/{id}.json with include=users when webhook_secret_ref is configured. Disconnected rows reject manual sync/backfill and admin ingest while provider webhook lookups fail closed. Disconnect best-effort deletes the stored zendesk_webhook_id through DELETE /api/v2/webhooks/{id}, treats provider 404 as already absent, and persists provider_cleanup evidence for local shutdown; Zendesk credential, trigger, and duplicate/manual cleanup remain operator-managed provider-console actions until live workspace certification lands."
	case item.Slug == "intercom":
		return "Intercom Conversations REST pulls honor Retry-After for 429/5xx responses, use per_page/starting_after cursor pagination with a 150 item cap, retrieve each listed conversation through /conversations/{id} for source plus conversation-part detail up to Intercom's 500-part API limit, persist intercom: cursor checkpoints, continue due installs with scheduled intercom_retry cursors, and map safe source-author or cached /contacts/{id} requester emails into canonical support profiles/events plus support messages with author/contact/assignee and conversation-part count/limit evidence. Signed Intercom app webhooks verify X-Hub-Signature HMAC-SHA1/hex, claim deliveries in support_webhook_events, map full conversation payloads including embedded messages, and refresh sparse conversation-id callbacks through /conversations/{id} when webhook_secret_ref is configured. Disconnected rows reject manual sync/backfill and admin ingest while provider webhook lookups fail closed. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, reconnect, disconnect, data-delete, and live workspace behavior remain open before RuntimeAvailable promotion."
	case item.Slug == "freshdesk":
		return "Freshdesk Tickets REST pulls use API-key Basic auth, normalize account_domain values such as acme.freshdesk.com into the correct API host, request include=requester from /api/v2/tickets, honor Retry-After for 429/5xx responses, use per_page/page pagination with a 100 item cap, apply optional local product_id filtering against returned ticket product_id values while preserving raw-page cursor progress, persist freshdesk: page checkpoints, continue due installs with scheduled freshdesk_retry cursors, and map ticket or embedded-requester email/name fields into canonical support profiles/events. Authenticated Freshdesk automation webhooks require a vault-backed shared secret header, claim callback deliveries in support_webhook_events, map full ticket payloads, and refresh sparse ticket-id callbacks through /api/v2/tickets/{id}?include=requester when webhook_secret_ref is configured. Disconnected rows reject manual sync/backfill and admin ingest while provider webhook lookups fail closed. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown; Freshdesk API-key, automation webhook, and duplicate/manual cleanup remain operator-managed provider-console actions until managed cleanup automation and live helpdesk certification land."
	case item.Slug == "help-scout":
		return "Help Scout Conversations REST pulls exchange OAuth client credentials through /v2/oauth2/token, honor Retry-After and X-RateLimit-Retry-After for 429/5xx responses, use mailbox/status filters, embed=threads, and page checkpoints for /v2/conversations, fall back to paginated /v2/conversations/{id}/threads when list rows omit thread embeds, persist help-scout: cursor checkpoints, continue due installs with scheduled help_scout_retry cursors, and map primary-customer or thread-customer emails plus thread messages into canonical support profiles/events. Signed Help Scout app webhooks verify X-HelpScout-Signature HMAC-SHA1/base64, claim deliveries in support_webhook_events, map conversation payloads, and refresh sparse conversation-id callbacks through /v2/conversations/{id}?embed=threads when webhook_secret_ref is configured. Disconnected rows reject manual sync/backfill and admin ingest while provider webhook lookups fail closed. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown; Help Scout app credential, webhook, and duplicate/manual cleanup remain operator-managed provider-console actions until managed cleanup automation and live mailbox certification land."
	case item.Slug == "kayako":
		return "Kayako Cases REST pulls use Basic-auth credential refs, account_domain routing, /api/v1/cases.json?include=requester offset pagination, per-case /api/v1/cases/{case_id}/posts.json?filters=MESSAGES message hydration with before_id pagination, requester resource/email mapping, kayako: cursor checkpoints, and scheduled kayako_retry continuation with Retry-After-aware provider errors. route-token Kayako callbacks require the stored kayako_webhook_id, claim deliveries in support_webhook_events, sparse-refresh cases, and fail closed for disconnected rows. Disconnect returns and persists provider_cleanup readiness evidence for local shutdown; Kayako API-key rotation, provider-console webhook deletion, duplicate/manual callback audit, and live account certification remain operator-managed provider-console actions before RuntimeAvailable promotion."
	case item.Slug == "gorgias":
		return "Gorgias Tickets API pulls honor Retry-After for 429/5xx responses, use limit/cursor pagination with a 100 item cap, persist gorgias: cursor checkpoints, continue due installs with scheduled gorgias_retry cursors, and map embedded customer tickets into support profiles/events while preserving bounded payload-present Shopify/Recharge/order evidence in ticket/message properties. When commerce_integration_id is configured, Gorgias ticket/message/event properties perform lookup-only order, customer, and product UUID resolution against existing commerce rows, including single-order-line product fallback and refresh-required handoff metadata for misses. Gorgias HTTP integration callbacks can authenticate with a vault-backed shared secret or compatible HMAC-SHA256 header, claim deliveries in support_webhook_events, map ticket/message payloads, and refresh sparse ticket-id callbacks through /api/tickets/{id}. Disconnected rows reject manual sync/backfill and admin ingest while provider webhook lookups fail closed. Disconnect best-effort deletes stored gorgias_http_integration_id values through DELETE /api/integrations/{id}, treats provider 404 as already absent, records provider cleanup failures without blocking local shutdown, and persists provider_cleanup evidence; official hmac_secret header certification, stored HTTP integration deletion certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain before RuntimeAvailable promotion."
	case hasSource(item, "commerce") || hasSource(item, "subscription_integration") || hasSource(item, "support_integration") || hasSource(item, "analytics_integration") || hasSource(item, "audience_destination"):
		return "Managed jobs respect provider rate limits and checkpoint progress."
	default:
		return "Requests are bounded by tenant API limits and owning-surface throttles."
	}
}

func subscriptionPullerRateLimitPolicy(item CatalogItem) string {
	common := " Empty sync/backfill provider dispatch, scheduled subscription backfill workers, subscription_provider retry cursors with Retry-After-aware backoff, run history, disconnected-row guards before provider calls and local writes, and returned/persisted operator-managed provider_cleanup evidence are implemented for this slice. Provider-managed webhook/callback registration, credential cleanup proof, reconnect/data-delete proof, live provider certification, and broader objects beyond the mapped subscription/shipment rows remain before RuntimeAvailable promotion."
	switch item.Slug {
	case "skio":
		return "Skio GraphQL pulls use credential references, POST /v1/graphql Subscriptions with limit/offset pagination, bounded page sizes, skio: offset checkpoints, and canonical subscription imports." + common
	case "aftership":
		return "AfterShip REST pulls use credential references, /v4/trackings page/limit pagination, aftership: checkpoints, Retry-After-aware provider errors, and canonical shipment imports from tracking rows." + common
	case "shipstation":
		return "ShipStation REST pulls use credential references, /orders page/pageSize pagination with optional order_status filtering, shipstation: checkpoints, Retry-After-aware provider errors, and canonical shipment imports from order shipment evidence." + common
	case "chargebee":
		return "Chargebee REST pulls use credential references, site_id-scoped /api/v2/subscriptions offset pagination, chargebee: checkpoints, a 100 item page cap, and canonical subscription imports from subscription plus customer rows." + common
	case "loop-subscriptions":
		return "Loop Subscriptions REST pulls use credential references, /admin/2023-10/subscription pageNo/pageSize pagination, loop: checkpoints, and canonical subscription imports from subscription rows." + common
	case "appstle":
		return "Appstle REST pulls use credential references, /api/external/v2/subscription-contracts page/size pagination, appstle: checkpoints, and canonical subscription imports from subscription-contract rows." + common
	case "seal-subscriptions":
		return "Seal Subscriptions REST pulls use credential references, /subscriptions page pagination, seal: checkpoints, and canonical subscription imports from subscription rows." + common
	case "bold-subscriptions":
		return "Bold Subscriptions REST pulls use credential references, shop_identifier-scoped /subscriptions/v1/shops/{shop}/subscriptions page/per_page pagination, bold: checkpoints, and canonical subscription imports from customer-expanded subscription rows." + common
	default:
		return "Native subscription/shipping provider pulls use credential references, provider-specific REST or GraphQL pagination, scheduled retry cursors, canonical subscription/shipment imports, and operator-managed provider_cleanup evidence while live certification and webhook/callback expansion remain pending."
	}
}

func analyticsPullerRateLimitPolicy(item CatalogItem) string {
	common := " Empty sync/backfill provider dispatch, connect-time history import, scheduled analytics backfill workers, analytics_provider retry cursors with Retry-After-aware backoff, run history, disconnected-row guards before provider calls and local writes, and returned/persisted operator-managed provider_cleanup evidence are implemented for this slice. Provider-managed webhooks, event ingestion expansion, reporting/warehouse export expansion, credential cleanup proof, reconnect/data-delete proof, live provider certification, and broader analytics objects remain before RuntimeAvailable promotion."
	switch item.Slug {
	case "posthog":
		return "PostHog pulls use credential references, GET /api/projects/{project_id}/persons limit pagination, PostHog next-page URL checkpoints, and canonical profile imports from person properties." + common
	case "triple-whale":
		return "Triple Whale pulls use credential references, POST customer pages over configured or rolling date windows, triplewhale: page checkpoints, and canonical profile imports from customer attribution rows." + common
	case "mixpanel":
		return "Mixpanel pulls use credential references, POST /api/query/engage with project_id, session_id/page pagination, mixpanel: session checkpoints, and canonical profile imports from Engage profiles." + common
	case "amplitude":
		return "Amplitude pulls use credential references, asynchronous Behavioral Cohort export request/status/file download, amplitude:poll attempt checkpoints, bounded poll attempts, and canonical profile imports from cohort CSV users." + common
	default:
		return "Native analytics provider pulls use credential references, provider-specific pagination or async-export checkpoints, scheduled retry cursors, canonical profile imports, and operator-managed provider_cleanup evidence while live certification and webhook/event/report expansion remain pending."
	}
}

func partnerReviewFor(item CatalogItem) string {
	switch {
	case item.Badge == BadgeNative:
		return "internal_postwave_release_review"
	case item.Badge == BadgePartner:
		return "marketplace_listing_review_required"
	case item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge"):
		return "recipe_template_review"
	case item.Badge == BadgeAPISDK:
		return "developer_app_scope_review"
	case item.Badge == BadgeMigrationOnly:
		return "migration_mapping_review"
	case item.Badge == BadgePlanned || item.RuntimeStatus == RuntimePlanned:
		return "roadmap_review"
	default:
		return "standard_review"
	}
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
