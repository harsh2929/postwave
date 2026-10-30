// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import "strings"

type SetupStep struct {
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	Action         string   `json:"action,omitempty"`
	Path           string   `json:"path,omitempty"`
	RequiredFields []string `json:"required_fields,omitempty"`
}

type Recipe struct {
	ID               string       `json:"id"`
	Name             string       `json:"name"`
	Provider         string       `json:"provider"`
	SourceSlug       string       `json:"source_slug"`
	TargetSlug       string       `json:"target_slug,omitempty"`
	Summary          string       `json:"summary"`
	Badge            Badge        `json:"badge"`
	Available        bool         `json:"available"`
	EstimatedMinutes int          `json:"estimated_minutes"`
	SetupPath        string       `json:"setup_path,omitempty"`
	DocsURL          string       `json:"docs_url,omitempty"`
	Capabilities     []Capability `json:"capabilities"`
	Steps            []SetupStep  `json:"steps"`
	Blueprint        Blueprint    `json:"blueprint"`
}

type FieldMapping struct {
	Source      string `json:"source"`
	Target      string `json:"target"`
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
}

type Blueprint struct {
	Trigger         string         `json:"trigger"`
	Destination     string         `json:"destination"`
	PostwaveSurface string         `json:"postwave_surface"`
	RequiredScopes  []string       `json:"required_scopes,omitempty"`
	RequiredSecrets []string       `json:"required_secrets,omitempty"`
	Events          []string       `json:"events,omitempty"`
	FieldMappings   []FieldMapping `json:"field_mappings,omitempty"`
	SamplePayload   map[string]any `json:"sample_payload,omitempty"`
	DataHandling    []string       `json:"data_handling,omitempty"`
}

func AllRecipes() []Recipe {
	return AllRecipesForItems(CatalogItems())
}

func AllRecipesForItems(items []CatalogItem) []Recipe {
	out := append([]Recipe(nil), recipeCatalog...)
	seen := map[string]struct{}{}
	for _, recipe := range out {
		seen[recipe.SourceSlug] = struct{}{}
	}
	for _, item := range items {
		if _, ok := seen[item.Slug]; ok {
			continue
		}
		if item.Badge == BadgePartner || item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(item, "bridge") {
			out = append(out, genericBridgeRecipe(item))
			seen[item.Slug] = struct{}{}
			continue
		}
		if isMarketingNativeSurface(item) {
			out = append(out, marketingNativeFoundationRecipe(item))
			seen[item.Slug] = struct{}{}
			continue
		}
		if isMarketingMigrationSurface(item) {
			out = append(out, marketingMigrationCutoverRecipe(item))
			seen[item.Slug] = struct{}{}
		}
	}
	for i := range out {
		decorateRecipe(&out[i])
	}
	return out
}

func RecipeByID(id string) (Recipe, bool) {
	return recipeByID(AllRecipes(), id)
}

func recipeByID(recipes []Recipe, id string) (Recipe, bool) {
	for _, recipe := range recipes {
		if recipe.ID == id {
			return recipe, true
		}
	}
	return Recipe{}, false
}

func LifecycleActions(item CatalogItem) []string {
	if hasSource(item, "support_integration") {
		return nil
	}
	if item.RuntimeStatus == RuntimePlanned {
		return []string{"roadmap"}
	}
	if isMarketingNativeSurface(item) {
		if isKlaviyoNativeSurface(item) {
			return []string{"connect/start", "oauth/availability", "oauth/start", "oauth/callback", "sync", "backfill", "pause", "disconnect", "provider-cleanup/acknowledge"}
		}
		return []string{"connect/start", "sync", "backfill", "pause", "disconnect"}
	}
	if meta, ok := managedProviderMetadataForItem(item); ok {
		if isPostwaveIngestSyncModel(meta.SyncModel) || !managedProviderUsesCallback(meta) {
			return []string{"connect/start", "sync", "backfill", "pause", "disconnect"}
		}
		return []string{"connect/start", "connect/callback", "sync", "backfill", "pause", "disconnect"}
	}
	if isKlaviyoMigrationSurface(item) {
		return []string{"connect/start", "sync", "backfill", "pause", "disconnect"}
	}
	switch item.Badge {
	case BadgeMigrationOnly:
		return []string{"connect/start", "backfill", "disconnect"}
	case BadgeAPISDK:
		return []string{"connect/start", "disconnect"}
	default:
		return []string{"connect/start", "connect/callback", "sync", "backfill", "pause", "disconnect"}
	}
}

func managedProviderUsesCallback(meta managedProviderMetadata) bool {
	if meta.ActionPaths != nil && meta.ActionPaths["connect/callback"] != "" {
		return true
	}
	return strings.Contains(strings.ToLower(meta.AuthMode), "oauth")
}

func SetupGuide(item CatalogItem) []SetupStep {
	switch {
	case hasSource(item, "support_integration"):
		return nil
	case hasSource(item, "mcp"):
		// The integration-catalog entry is a release-held source record, not a
		// setup surface. Do not synthesize roadmap links, keys, permissions,
		// events, or lifecycle steps for it.
		return nil
	case item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned:
		return []SetupStep{
			{
				Title:       "Track the roadmap entry",
				Description: "This tile is visible for planning and parity accounting, but Moosewave does not yet own auth, sync, and monitoring for it.",
				Action:      "Open docs",
				Path:        item.DocsURL,
			},
		}
	case isKlaviyoNativeSurface(item):
		return []SetupStep{
			{
				Title:          "Create the native Klaviyo provider row",
				Description:    "Save a Klaviyo credential reference through /api/v1/marketing-integrations. Raw private API keys are rejected from public settings.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: []string{"credentials_ref"},
			},
			{
				Title:       "Run native provider-row pulls",
				Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to run native JSON:API profile/source-event pulls, record marketing_sync_runs, and persist klaviyo_native cursor evidence.",
				Action:      "Backfill",
				Path:        "/integrations",
			},
			{
				Title:       "Enable changed-profile monitoring",
				Description: "Let the scheduled Klaviyo worker continue changed-profile polling, configure signed system-webhook receipt through the native provider row, and use integration-writeback for existing-profile properties, list adds, and custom events; managed OAuth refs and allowlisted Klaviyo Webhooks API credentials can reconcile the provider subscription while local provider-cleanup acknowledgement is available and provider-side cleanup certification, OAuth live certification, writeback live certification, and live certification remain pending.",
				Action:      "Sync",
				Path:        "/integrations",
			},
		}
	case item.Badge == BadgeNative && isManagedProviderFamily(item):
		if meta, ok := managedProviderMetadataForItem(item); ok {
			return setupGuideForManagedProvider(item, meta)
		}
		return []SetupStep{
			{
				Title:          "Create the managed integration connection",
				Description:    "Save credential references and provider settings through the existing Integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: []string{"provider", "credentials_ref"},
			},
		}
	case hasSource(item, "commerce"):
		fields := []string{"provider"}
		if item.Slug == "shopify" {
			fields = []string{"shop_domain"}
		}
		return []SetupStep{
			{
				Title:          "Create the commerce connection",
				Description:    "Start from the Commerce surface so credentials are stored through the existing encrypted credential path.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: fields,
			},
			{
				Title:       "Import the first commerce payload",
				Description: "Import provider-exported profiles, products, orders, and commerce events before enabling automations.",
				Action:      "Import",
				Path:        item.SetupPath,
			},
			{
				Title:       "Monitor sync health",
				Description: "Use sync history and error details from the Commerce surface before treating this as production-ready.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	case hasSource(item, "audience_destination"):
		return []SetupStep{
			{
				Title:       "Create an audience destination",
				Description: "Choose the ad network, consented list or segment, and the external audience id.",
				Action:      "Create destination",
				Path:        item.SetupPath,
			},
			{
				Title:       "Validate consent and hashing",
				Description: "Confirm consent gates and hashed identity fields before the first delivery.",
				Action:      "Review mapping",
				Path:        item.SetupPath,
			},
			{
				Title:       "Sync now and watch errors",
				Description: "Trigger a delivery and inspect retry/error details from Audience syncs.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
		}
	case hasSource(item, "warehouse"):
		return []SetupStep{
			{
				Title:       "Create a warehouse connection",
				Description: "Pick export or import direction, select objects, and validate credentials in Data platform.",
				Action:      "Create connection",
				Path:        item.SetupPath,
			},
			{
				Title:       "Choose cadence and backfill",
				Description: "Select object coverage, cadence, and historical window before enabling scheduled sync.",
				Action:      "Configure sync",
				Path:        item.SetupPath,
			},
		}
	case hasSource(item, "outbound_webhooks"):
		return []SetupStep{
			{
				Title:          "Create a signed outbound webhook",
				Description:    "Choose events and destination URL. Moosewave keeps signing material secret after creation.",
				Action:         "Create webhook",
				Path:           item.SetupPath,
				RequiredFields: []string{"url", "events"},
			},
			{
				Title:       "Test with the simulator",
				Description: "Send a signed sample payload and verify your handler before enabling production events.",
				Action:      "Open simulator",
				Path:        "/webhooks",
			},
		}
	case hasSource(item, "inbound_webhooks"):
		return []SetupStep{
			{
				Title:          "Create an inbound endpoint",
				Description:    "Generate a signed endpoint and copy its secret into the source app or bridge provider.",
				Action:         "Create endpoint",
				Path:           item.SetupPath,
				RequiredFields: []string{"name"},
			},
			{
				Title:       "Send a test payload",
				Description: "Verify signature handling, optional transforms, and event creation before publishing.",
				Action:      "Test ingest",
				Path:        item.SetupPath,
			},
		}
	case hasSource(item, "migration"):
		if isKlaviyoMigrationSurface(item) {
			return []SetupStep{
				{
					Title:          "Add the Klaviyo private API key",
					Description:    "Create a migration job for source=klaviyo using a scoped private API key. The adapter validates /accounts, sends Klaviyo-API-Key auth, and pins the current revision header.",
					Action:         "Open migrations",
					Path:           item.SetupPath,
					RequiredFields: []string{"source", "api_key"},
				},
				{
					Title:       "Run the native API import",
					Description: "Backfill profiles, lists, dynamic segments, flows, campaigns, templates, and source-archive rebuild tasks through Klaviyo JSON:API cursor pagination.",
					Action:      "Backfill",
					Path:        item.SetupPath,
				},
				{
					Title:       "Enable source-event monitoring",
					Description: "Start the source-event monitor to poll changed profiles with updated-time filters and page cursors during the cutover shadow window.",
					Action:      "Sync",
					Path:        item.SetupPath,
				},
			}
		}
		return []SetupStep{
			{
				Title:       "Export from the source platform",
				Description: "Bring subscribers, lists, segments, suppression state, and historical engagement exports when available.",
				Action:      "Open migrations",
				Path:        item.SetupPath,
			},
			{
				Title:       "Dry-run field mapping",
				Description: "Validate identity fields and consent state before committing the import.",
				Action:      "Dry run",
				Path:        item.SetupPath,
			},
		}
	case item.Badge == BadgePartner && hasSource(item, "developer_marketplace"):
		return []SetupStep{
			{
				Title:          "Install the partner app",
				Description:    "Start the marketplace OAuth authorization flow and approve the app's reviewed scopes.",
				Action:         "Install app",
				Path:           item.SetupPath,
				RequiredFields: []string{"client_id", "redirect_uri", "state", "code_challenge"},
			},
			{
				Title:       "Review granted access",
				Description: "Confirm granted scopes, app webhook topics, and install status before enabling production automation.",
				Action:      "Review install",
				Path:        item.SetupPath,
			},
			{
				Title:       "Monitor partner health",
				Description: "Use the integration health view and marketplace app monitoring to watch token, install, and webhook status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	case item.Badge == BadgeAPISDK || hasSource(item, "developer_marketplace"):
		return []SetupStep{
			{
				Title:       "Create scoped access",
				Description: "Use API-key scopes, OAuth app scopes, or MCP permissions appropriate to the integration.",
				Action:      "Open developer tools",
				Path:        item.SetupPath,
			},
			{
				Title:       "Subscribe to events",
				Description: "Use outbound webhooks for lifecycle events and inbound webhooks for source-to-Moosewave triggers.",
				Action:      "Open webhooks",
				Path:        "/webhooks",
			},
		}
	default:
		return []SetupStep{
			{
				Title:       "Use a bridge recipe",
				Description: "Connect through Zapier, Make, n8n, Pipedream, inbound webhooks, or the API until a managed connector exists.",
				Action:      "Open webhooks",
				Path:        "/webhooks",
			},
		}
	}
}

func RecipesFor(slug string) []Recipe {
	if item, ok := CatalogItemBySlug(slug); ok {
		return RecipesForItem(item)
	}
	return recipesForSlug(slug, nil)
}

func RecipesForItem(item CatalogItem) []Recipe {
	if hasSource(item, "support_integration") {
		return nil
	}
	return recipesForSlug(item.Slug, &item)
}

func recipesForSlug(slug string, item *CatalogItem) []Recipe {
	out := []Recipe{}
	for _, recipe := range recipeCatalog {
		if recipe.SourceSlug == slug || recipe.TargetSlug == slug || (slug == "zapier" && recipe.Provider == "Zapier") {
			decorateRecipe(&recipe)
			out = append(out, recipe)
		}
	}
	if len(out) == 0 && item != nil && (item.Badge == BadgePartner || item.Badge == BadgeZapier || item.Badge == BadgeWebhook || hasSource(*item, "bridge")) {
		recipe := genericBridgeRecipe(*item)
		decorateRecipe(&recipe)
		out = append(out, recipe)
	}
	if len(out) == 0 && item != nil && isMarketingNativeSurface(*item) {
		recipe := marketingNativeFoundationRecipe(*item)
		decorateRecipe(&recipe)
		out = append(out, recipe)
	}
	if len(out) == 0 && item != nil && isMarketingMigrationSurface(*item) {
		recipe := marketingMigrationCutoverRecipe(*item)
		decorateRecipe(&recipe)
		out = append(out, recipe)
	}
	return out
}

func decorateRecipe(recipe *Recipe) {
	if recipe.Blueprint.Trigger != "" {
		return
	}
	recipe.Blueprint = defaultBlueprint(*recipe)
}

func defaultBlueprint(recipe Recipe) Blueprint {
	surface := recipe.SetupPath
	if surface == "" {
		surface = "/webhooks"
	}
	blueprint := Blueprint{
		Trigger:         recipe.SourceSlug + " event",
		Destination:     "Moosewave",
		PostwaveSurface: surface,
		RequiredScopes:  []string{"read:subscribers", "write:subscribers"},
		Events:          []string{"profile.upserted", "integration.recipe.applied"},
		FieldMappings: []FieldMapping{
			{Source: "email", Target: "profile.email", Required: true, Description: "Primary identity for profile creation or update."},
			{Source: "consent", Target: "profile.email_consent", Required: false, Description: "Preserve opt-in state from the source system."},
			{Source: "properties", Target: "profile.traits", Required: false, Description: "Additional fields are stored as profile traits."},
		},
		SamplePayload: map[string]any{
			"email":      "reader@example.com",
			"consent":    "subscribed",
			"properties": map[string]any{"source": recipe.SourceSlug},
			"event":      recipe.ID,
		},
		DataHandling: []string{"Store secrets through credential references only", "Verify consent before SMS or ad-audience activation"},
	}
	switch recipe.Badge {
	case BadgeNative:
		blueprint.RequiredScopes = []string{"admin"}
		blueprint.RequiredSecrets = []string{"oauth_client_secret or provider_api_token"}
	case BadgeZapier, BadgeWebhook:
		blueprint.RequiredSecrets = []string{"inbound_webhook_secret"}
	case BadgeMigrationOnly:
		blueprint.RequiredScopes = []string{"admin"}
		blueprint.RequiredSecrets = []string{"source_export_file"}
		blueprint.Trigger = "migration import"
		blueprint.Events = []string{"migration.started", "migration.completed"}
	case BadgePlanned:
		blueprint.RequiredScopes = nil
		blueprint.RequiredSecrets = nil
		blueprint.Events = []string{"roadmap.updated"}
	}
	return blueprint
}

func genericBridgeRecipe(item CatalogItem) Recipe {
	return Recipe{
		ID:               item.Slug + "-bridge-recipe",
		Name:             item.Name + " to Moosewave profile/event",
		Provider:         "Webhook/API bridge",
		SourceSlug:       item.Slug,
		TargetSlug:       "inbound-webhooks",
		Summary:          "Use a bridge workflow to send subscribers, custom fields, and events into Moosewave.",
		Badge:            item.Badge,
		Available:        item.RuntimeStatus != RuntimePlanned || item.Badge == BadgePartner,
		EstimatedMinutes: 15,
		SetupPath:        "/webhooks",
		DocsURL:          item.DocsURL,
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create an inbound endpoint", Description: "Generate a Moosewave endpoint and signing secret.", Action: "Open webhooks", Path: "/webhooks"},
			{Title: "Map source fields", Description: "Map email, consent, traits, and event names in the bridge provider."},
			{Title: "Send a test event", Description: "Verify the payload appears as a profile update or product event."},
		},
	}
}

func marketingNativeFoundationRecipe(item CatalogItem) Recipe {
	meta, _ := managedProviderMetadataForItem(item)
	requiredFields := []string{"credentials_ref"}
	for _, field := range meta.RequiredFields {
		if field.Key != "" && !containsString(requiredFields, field.Key) {
			requiredFields = append(requiredFields, field.Key)
		}
	}
	name := item.Name
	if meta.Name != "" {
		name = meta.Name
	}
	handoff := item.Slug + "_handoff"
	return Recipe{
		ID:               item.Slug + "-native-foundation",
		Name:             name + " native foundation",
		Provider:         "Native",
		SourceSlug:       item.Slug,
		Summary:          "Create the separate native " + name + " provider foundation with credential-ref lifecycle, marketing_sync_runs, row-preserving pause/disconnect, provider-cleanup guidance, and delegated " + handoff + " cursor evidence while the full native data plane remains partial.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          item.DocsURL,
		Capabilities:     append([]Capability(nil), item.Capabilities...),
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a " + name + " credential or export-bundle reference through /api/v1/marketing-integrations and keep raw keys, tokens, cookies, secrets, and file paths out of public config.", Action: "Open integrations", Path: "/integrations", RequiredFields: requiredFields},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and " + handoff + " cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until native pull scheduling, webhooks or source-event polling, writeback, cleanup automation, and live provider certification are recorded."},
		},
	}
}

func marketingMigrationCutoverRecipe(item CatalogItem) Recipe {
	name := strings.TrimSuffix(item.Name, " migration")
	if name == item.Name {
		name = strings.TrimSuffix(item.Name, " Migration")
	}
	return Recipe{
		ID:               item.Slug + "-cutover",
		Name:             item.Name + " cutover",
		Provider:         "Migration",
		SourceSlug:       item.Slug,
		TargetSlug:       "migrations",
		Summary:          "Import " + name + " subscriber, list, consent, archive, and migration evidence before switching traffic.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          item.DocsURL,
		Capabilities:     append([]Capability(nil), item.Capabilities...),
		Steps: []SetupStep{
			{Title: "Prepare source credentials or exports", Description: "Create the source export/API credential reference required by the migration adapter."},
			{Title: "Dry-run import", Description: "Review subscriber, list, consent, archive, and source-specific mapping evidence.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Commit and verify", Description: "Run the import, inspect counts, and preserve the native provider-row handoff evidence before cutover."},
		},
	}
}

var recipeCatalog = []Recipe{
	{
		ID:               "shopify-commerce-import",
		Name:             "Shopify commerce import",
		Provider:         "Native",
		SourceSlug:       "shopify",
		TargetSlug:       "commerce",
		Summary:          "Connect Shopify, ingest products/orders/customers from webhooks or export payloads, then enable commerce-triggered automations.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 10,
		SetupPath:        "/commerce",
		DocsURL:          "/docs/integrations/shopify",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Start Shopify OAuth", Description: "Enter the shop domain and approve the requested scopes.", Action: "Connect", Path: "/commerce", RequiredFields: []string{"shop_domain"}},
			{Title: "Import commerce payloads", Description: "Import products, orders, customers, and purchase events from Shopify webhooks or exported payloads.", Action: "Import", Path: "/commerce"},
			{Title: "Enable lifecycle triggers", Description: "Use purchase and product events in automations.", Action: "Open automations", Path: "/automations"},
		},
	},
	{
		ID:               "typeform-leads-inbound-webhook",
		Name:             "Typeform lead capture",
		Provider:         "Moosewave native",
		SourceSlug:       "typeform",
		Summary:          "Capture Typeform responses through Moosewave-managed Responses API pulls and signed Typeform webhooks.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 10,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/typeform",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native Typeform connection", Description: "Save the form ID, credential reference, webhook signing-secret reference, and optional response/webhook settings through the Integrations surface.", Action: "Connect", Path: "/integrations", RequiredFields: []string{"form_id", "credentials_ref", "webhook_secret_ref"}},
			{Title: "Run the Responses API pull", Description: "Pull form metadata and responses through Typeform Retrieve Form and Responses API using after-cursor pagination.", Action: "Sync", Path: "/integrations"},
			{Title: "Verify signed webhooks and cleanup evidence", Description: "Confirm Moosewave stores verified managed-webhook metadata, ingests Typeform-Signature deliveries, and returns provider_cleanup evidence on disconnect.", Action: "Review health", Path: "/integrations"},
		},
		Blueprint: Blueprint{
			Trigger:         "Typeform response received",
			Destination:     "Moosewave native lead integration",
			PostwaveSurface: "/integrations",
			RequiredScopes:  []string{"forms:read", "responses:read", "webhooks:read", "webhooks:write"},
			RequiredSecrets: []string{"credentials_ref", "webhook_secret_ref"},
			Events:          []string{"form_response", "form_response_partial", "lead.submission.upserted"},
			FieldMappings: []FieldMapping{
				{Source: "form_id", Target: "settings.form_id", Required: true, Description: "Typeform form identifier used for response pulls and webhook routing."},
				{Source: "response.answers", Target: "submission.fields", Required: true, Description: "Answers are mapped by field ref, id, and title."},
				{Source: "response.hidden", Target: "submission.hidden_fields", Required: false, Description: "Hidden fields are preserved as submission evidence."},
				{Source: "response.metadata", Target: "submission.provider_payload.metadata", Required: false, Description: "Provider metadata is retained for audit and attribution."},
			},
			SamplePayload: map[string]any{
				"provider":        "typeform",
				"form_id":         "abc123",
				"credentials_ref": "vault://integrations/typeform/newsletter",
				"webhook_tag":     "postwave-prod",
			},
			DataHandling: []string{"Store Typeform token and webhook secret only in referenced secrets", "Verify Typeform-Signature before webhook ingestion", "Retain provider_cleanup evidence on disconnect"},
		},
	},
	{
		ID:               "hubspot-contact-upsert",
		Name:             "HubSpot contact upsert",
		Provider:         "Zapier/Make/API",
		SourceSlug:       "hubspot",
		TargetSlug:       "inbound-webhooks",
		Summary:          "Send new or updated HubSpot contacts into Moosewave while the managed CRM connector is built.",
		Badge:            BadgeZapier,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/webhooks",
		DocsURL:          "/docs/integrations/hubspot",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists},
		Steps: []SetupStep{
			{Title: "Create API key or inbound endpoint", Description: "Use a scoped API key for direct API writes or an inbound endpoint for low-code bridges.", Action: "Open API tools", Path: "/api-playground"},
			{Title: "Map lifecycle fields", Description: "Map email, lifecycle stage, company, owner, and opt-in state."},
			{Title: "Replay a small sample", Description: "Test 10 contacts before enabling continuous sync."},
		},
	},
	{
		ID:               "zapier-new-subscriber",
		Name:             "Zapier new subscriber",
		Provider:         "Zapier",
		SourceSlug:       "zapier",
		TargetSlug:       "inbound-webhooks",
		Summary:          "Create or update a Moosewave subscriber from any Zapier source app.",
		Badge:            BadgeZapier,
		Available:        true,
		EstimatedMinutes: 10,
		SetupPath:        "/webhooks",
		DocsURL:          "/docs/integrations/zapier",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Pick source trigger", Description: "Choose the source app and trigger in Zapier."},
			{Title: "Send to Moosewave", Description: "Use the Moosewave Zapier package or an inbound webhook endpoint.", Action: "Open webhooks", Path: "/webhooks"},
			{Title: "Turn on the Zap", Description: "Test once, verify the subscriber, then enable the recipe."},
		},
	},
	{
		ID:               "meta-custom-audience-sync",
		Name:             "Meta custom audience sync",
		Provider:         "Native",
		SourceSlug:       "meta",
		TargetSlug:       "audience-destinations",
		Summary:          "Sync consented segments to Meta Custom Audiences with resolver-backed ads tokens, EMAIL_SHA256 hashing, 10,000-member chunking, retry monitoring, and readiness checks while live app review remains open.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 15,
		SetupPath:        "/audience-syncs",
		DocsURL:          "/docs/integrations/meta",
		Capabilities:     []Capability{CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences},
		Steps: []SetupStep{
			{Title: "Create Meta destination", Description: "Enter external audience id and select a consented list or segment.", Action: "Create destination", Path: "/audience-syncs"},
			{Title: "Confirm consent gates", Description: "Verify the audience can be used for paid media activation."},
			{Title: "Sync now", Description: "Run a delivery and inspect retry details."},
		},
	},
	{
		ID:               "mailchimp-migration-cutover",
		Name:             "Mailchimp migration cutover",
		Provider:         "Migration",
		SourceSlug:       "mailchimp-migration",
		TargetSlug:       "migrations",
		Summary:          "Import Mailchimp audiences, tags, suppressions, and campaign context before cutover.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/integrations/mailchimp-migration",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilitySegments},
		Steps: []SetupStep{
			{Title: "Export Mailchimp audience data", Description: "Export contacts, tags, unsubscribe state, and engagement history."},
			{Title: "Dry-run import", Description: "Review field mapping and suppression handling.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Commit and verify", Description: "Run the import and spot-check counts before switching forms."},
		},
	},
	{
		ID:               "activecampaign-migration-cutover",
		Name:             "ActiveCampaign migration cutover",
		Provider:         "Migration",
		SourceSlug:       "activecampaign-migration",
		TargetSlug:       "migrations",
		Summary:          "Import ActiveCampaign contacts, lists, tags, segments, campaigns, automation rebuild evidence, and changed-contact source-event evidence before cutover.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/integrations/activecampaign-migration",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Prepare API v3 credentials", Description: "Create a scoped ActiveCampaign API credential and capture the account API URL."},
			{Title: "Dry-run import", Description: "Review contact, list, tag, automation rebuild, campaign, and deal/source-archive mapping.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Monitor changed contacts", Description: "Use source-event polling during the shadow window, then commit and verify counts."},
		},
	},
	{
		ID:               "customerio-migration-cutover",
		Name:             "Customer.io migration cutover",
		Provider:         "Migration",
		SourceSlug:       "customerio-migration",
		TargetSlug:       "migrations",
		Summary:          "Import one exactly bound Customer.io workspace: email-addressable profiles by immutable cio_id, conservative global/email-channel/topic status, frozen segment/topic membership, exact-source Design Studio HTML templates, eligible sent-email newsletter archive, and explicit rebuild/review evidence for every unsupported channel and ecosystem dependency.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/migrations/customerio",
		Capabilities:     []Capability{CapabilityProfiles, CapabilitySegments},
		Steps: []SetupStep{
			{Title: "Bind App API credentials", Description: "Create a dedicated Customer.io App API key (not a Track API site key), select US or EU, and select the numeric workspace when the key exposes more than one."},
			{Title: "Discover and dry-run", Description: "Review immutable-profile identity, duplicate-email ownership, profiles without email, the global + resolved email-channel + applicable-topic eligibility rule, ESP suppressions, separate sender-specific SMS/WhatsApp /v1/optouts, frozen audiences, sent newsletters with an explicit language=\"\" default, deterministic lowest-ID A/B representative, and provable source composition, exact-source Design Studio templates, workflow definitions, and source-archive gaps.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Freeze, reconcile, and certify", Description: "Run a final full snapshot, prove email requires global subscribed + email-channel subscribed/default + applicable topic subscribed/default, keep /v1/optouts separate, then complete the post-delta shadow check, rollback rehearsal, all six Customer.io review gates, and credential cleanup evidence before switching forms; source-event polling is not supported."},
		},
	},
	{
		ID:               "brevo-migration-cutover",
		Name:             "Brevo migration cutover",
		Provider:         "Migration",
		SourceSlug:       "brevo-migration",
		TargetSlug:       "migrations",
		Summary:          "Import Brevo contacts, lists, saved segments, automations, sent campaign archives, and campaign report evidence before cutover.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/integrations/brevo-migration",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Prepare API credentials", Description: "Create a scoped Brevo API key and store it as a credential reference."},
			{Title: "Dry-run import", Description: "Review contact, list, segment, automation, and campaign archive mapping.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Commit and verify", Description: "Run the import and confirm counts before switching signup surfaces."},
		},
	},
	{
		ID:               "convertkit-migration-cutover",
		Name:             "ConvertKit migration cutover",
		Provider:         "Migration",
		SourceSlug:       "convertkit-migration",
		TargetSlug:       "migrations",
		Summary:          "Import ConvertKit subscribers, tags, segments, sequences, broadcasts, forms, landing-page context, and optional Stripe paid-subscription evidence before cutover.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/integrations/convertkit-migration",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Prepare credentials", Description: "Create or reference ConvertKit OAuth/API-secret credentials and optional Stripe account evidence."},
			{Title: "Dry-run import", Description: "Review subscriber, tag, segment, sequence, broadcast, form, and paid-subscription mappings.", Action: "Open migrations", Path: "/migrations"},
			{Title: "Commit and verify", Description: "Run the import and spot-check subscriber, tag, and broadcast counts before cutover."},
		},
	},
	{
		ID:               "mailchimp-native-foundation",
		Name:             "Mailchimp native foundation",
		Provider:         "Native",
		SourceSlug:       "mailchimp",
		Summary:          "Create the separate native Mailchimp provider foundation with credential-ref lifecycle, marketing_sync_runs, row-preserving pause/disconnect, and delegated import/source-archive handoff cursors while API/OAuth import remains delegated to the migration adapter.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/mailchimp",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a Mailchimp credential reference through /api/v1/marketing-integrations and keep raw API keys or OAuth tokens out of public config.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref"}},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and mailchimp_handoff cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until OAuth/public app certification, native webhooks or source-event polling, writeback, cleanup automation, and live account validation are recorded."},
		},
	},
	{
		ID:               "activecampaign-native-foundation",
		Name:             "ActiveCampaign native foundation",
		Provider:         "Native",
		SourceSlug:       "activecampaign",
		Summary:          "Create the separate native ActiveCampaign provider foundation with credential-ref lifecycle, required account API URL, marketing_sync_runs, row-preserving pause/disconnect, and delegated API v3 import plus changed-contact source-event handoff cursors.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/activecampaign",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save an ActiveCampaign credential reference and account API URL through /api/v1/marketing-integrations.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref", "api_url"}},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and activecampaign_handoff source-event cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until native webhooks, writeback, cleanup automation, OAuth/public app install, and live account certification are recorded."},
		},
	},
	{
		ID:               "customerio-native-foundation",
		Name:             "Customer.io native foundation",
		Provider:         "Native",
		SourceSlug:       "customerio",
		Summary:          "Create the separate native Customer.io provider foundation with App API credential-reference lifecycle, region/workspace evidence, marketing_sync_runs, row-preserving pause/disconnect, and delegated immutable-profile/full-snapshot migration handoff cursors.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/customerio",
		Capabilities:     []Capability{CapabilityProfiles, CapabilitySegments},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a Customer.io App API credential reference through /api/v1/marketing-integrations and record the US/EU region plus numeric workspace evidence.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref"}},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and customerio_handoff full-snapshot import cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until native webhooks, Track API writeback, provider cleanup automation, and live workspace certification are recorded; the migration API intentionally does not claim source-event polling."},
		},
	},
	{
		ID:               "brevo-native-foundation",
		Name:             "Brevo native foundation",
		Provider:         "Native",
		SourceSlug:       "brevo",
		Summary:          "Create the separate native Brevo provider foundation with API-key credential-ref lifecycle, marketing_sync_runs, row-preserving pause/disconnect, provider-cleanup guidance, and delegated contacts/lists/segments/campaign import handoff cursors.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/brevo",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a Brevo credential reference through /api/v1/marketing-integrations and keep raw API keys out of public config.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref"}},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and brevo_handoff import cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until source-event polling or native webhooks, writeback/suppression behavior, cleanup automation, and live workspace certification are recorded."},
		},
	},
	{
		ID:               "convertkit-native-foundation",
		Name:             "ConvertKit native foundation",
		Provider:         "Native",
		SourceSlug:       "convertkit",
		Summary:          "Create the separate native ConvertKit/Kit provider foundation with OAuth/API-secret credential-ref lifecycle, marketing_sync_runs, row-preserving pause/disconnect, provider-cleanup guidance, and delegated subscriber/tag/segment/sequence/broadcast import handoff cursors.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/convertkit",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a ConvertKit credential reference through /api/v1/marketing-integrations and record optional account or Stripe evidence when available.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref"}},
			{Title: "Record delegated native run evidence", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to record partial marketing_sync_runs and convertkit_handoff import cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until native webhooks or source-event polling, token refresh/revoke certification, writeback, cleanup automation, and live account validation are recorded."},
		},
	},
	{
		ID:               "klaviyo-native-foundation",
		Name:             "Klaviyo native foundation",
		Provider:         "Native",
		SourceSlug:       "klaviyo",
		Summary:          "Create the separate native Klaviyo provider foundation with credential-ref lifecycle, managed public-app OAuth install/refresh/revoke, marketing_sync_runs, marketing_webhook_events, native JSON:API profile/source-event pulls, signed system-webhook receipt, managed Webhooks API subscription reconciliation for allowlisted credentials, klaviyo_native cursors, scheduled polling, no-create integration-writeback, and local provider-cleanup acknowledgement while provider-side cleanup certification, OAuth live certification, Webhooks API live certification, writeback live certification, and live certification remain open.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 20,
		SetupPath:        "/integrations",
		DocsURL:          "/docs/integrations/klaviyo",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the native provider row", Description: "Save a Klaviyo credential reference through /api/v1/marketing-integrations and keep raw private API keys out of public config.", Action: "Open integrations", Path: "/integrations", RequiredFields: []string{"credentials_ref"}},
			{Title: "Run native provider-row pulls", Description: "Use /api/v1/marketing-integrations/{id}/sync or /backfill to run native JSON:API profile/source-event pulls, record marketing_sync_runs, and persist klaviyo_native cursor evidence.", Action: "Backfill", Path: "/integrations"},
			{Title: "Attach scheduled, webhook, and writeback evidence", Description: "Let the scheduled Klaviyo worker poll changed profiles through the native provider row, route signed Klaviyo system webhooks to the opaque public token URL, reconcile the provider Webhooks API subscription when allowlisted credentials are available, configure integration-writeback for existing profiles, and record local provider-cleanup acknowledgement while provider-side cleanup certification and live certification remain pending.", Action: "Start monitor", Path: "/integrations"},
			{Title: "Track promotion gaps", Description: "Do not promote beyond partial until provider-side cleanup certification, OAuth live certification, Webhooks API live allowlist certification, writeback live certification, and live account certification are recorded."},
		},
	},
	{
		ID:               "klaviyo-migration-cutover",
		Name:             "Klaviyo migration cutover",
		Provider:         "Migration",
		SourceSlug:       "klaviyo-migration",
		TargetSlug:       "migrations",
		Summary:          "Use Klaviyo API-key import plus profile source-event monitoring to run a migration-to-live cutover without claiming a native Klaviyo provider connector.",
		Badge:            BadgeMigrationOnly,
		Available:        true,
		EstimatedMinutes: 30,
		SetupPath:        "/migrations",
		DocsURL:          "/docs/integrations/klaviyo-migration",
		Capabilities:     []Capability{CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers},
		Steps: []SetupStep{
			{Title: "Create the Klaviyo API-key job", Description: "Submit a Klaviyo private API key through /api/v1/migrations/klaviyo/credentials; Moosewave validates /accounts with Klaviyo-API-Key auth and a pinned revision header.", Action: "Open migrations", Path: "/migrations", RequiredFields: []string{"source", "api_key"}},
			{Title: "Dry-run and review mapping", Description: "Preview profile, list, segment, flow, campaign, template, and source-archive rebuild-task output before committing."},
			{Title: "Start source-event monitoring", Description: "Poll changed Klaviyo profiles through /api/v1/migrations/sources/klaviyo/source-events during the shadow window.", Action: "Start monitor", Path: "/migrations"},
			{Title: "Commit and verify", Description: "Commit the migration, inspect verification counts and source-event results, then revoke Klaviyo API keys in the Klaviyo account when cutover is complete."},
		},
	},
	{
		ID:               "snowflake-export-roadmap",
		Name:             "Snowflake warehouse export",
		Provider:         "Native",
		SourceSlug:       "snowflake",
		TargetSlug:       "warehouse",
		Summary:          "Create a managed Snowflake warehouse connection for profiles, events, export manifests, and reverse ETL traits.",
		Badge:            BadgeNative,
		Available:        true,
		EstimatedMinutes: 15,
		SetupPath:        "/data-platform",
		DocsURL:          "/docs/integrations/snowflake",
		Capabilities:     []Capability{CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents},
		Steps: []SetupStep{
			{Title: "Create the Snowflake connection", Description: "Enter account, warehouse, database, schema, and a credential reference.", Action: "Open data platform", Path: "/data-platform", RequiredFields: []string{"account", "warehouse", "database", "schema", "credentials_ref"}},
			{Title: "Run the first manifest sync", Description: "Moosewave records auditable run history while the provider worker attaches to credentials."},
		},
	},
}
