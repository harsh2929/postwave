// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"sort"
	"strings"
)

type Badge string

const (
	BadgeNative        Badge = "native"
	BadgePartner       Badge = "partner"
	BadgeZapier        Badge = "zapier"
	BadgeWebhook       Badge = "webhook"
	BadgeAPISDK        Badge = "api_sdk"
	BadgeMigrationOnly Badge = "migration_only"
	BadgePlanned       Badge = "planned"
)

type RuntimeStatus string

const (
	RuntimeAvailable RuntimeStatus = "available"
	RuntimePartial   RuntimeStatus = "partial"
	RuntimeDelegated RuntimeStatus = "delegated"
	RuntimePlanned   RuntimeStatus = "planned"
)

type Capability string

const (
	CapabilityProfiles           Capability = "profiles"
	CapabilityEvents             Capability = "events"
	CapabilityLists              Capability = "lists"
	CapabilitySegments           Capability = "segments"
	CapabilityCommerce           Capability = "commerce"
	CapabilityOrders             Capability = "orders"
	CapabilityProducts           Capability = "products"
	CapabilityReviews            Capability = "reviews"
	CapabilitySubscriptions      Capability = "subscriptions"
	CapabilitySupport            Capability = "support"
	CapabilityAdsAudiences       Capability = "ads_audiences"
	CapabilityWarehouseExport    Capability = "warehouse_export"
	CapabilityWarehouseImport    Capability = "warehouse_import"
	CapabilityAutomationTriggers Capability = "automation_triggers"
)

type Category struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type CatalogItem struct {
	Slug          string        `json:"slug"`
	Name          string        `json:"name"`
	Category      string        `json:"category"`
	Badge         Badge         `json:"badge"`
	RuntimeStatus RuntimeStatus `json:"runtime_status"`
	Summary       string        `json:"summary"`
	Capabilities  []Capability  `json:"capabilities"`
	DocsURL       string        `json:"docs_url,omitempty"`
	SetupPath     string        `json:"setup_path,omitempty"`
	Native        bool          `json:"native"`
	Featured      bool          `json:"featured,omitempty"`
	Phase         string        `json:"phase,omitempty"`
	Sources       []string      `json:"sources,omitempty"`
}

var categories = []Category{
	{Key: "ecommerce", Label: "Ecommerce"},
	{Key: "forms", Label: "Forms"},
	{Key: "crm", Label: "CRM"},
	{Key: "analytics", Label: "Analytics"},
	{Key: "ads", Label: "Ads"},
	{Key: "customer_service", Label: "Customer service"},
	{Key: "reviews", Label: "Reviews"},
	{Key: "loyalty", Label: "Loyalty"},
	{Key: "subscriptions", Label: "Subscriptions"},
	{Key: "shipping", Label: "Shipping"},
	{Key: "payments", Label: "Payments"},
	{Key: "cms", Label: "CMS"},
	{Key: "scheduling", Label: "Scheduling"},
	{Key: "warehouse", Label: "Warehouse"},
	{Key: "developer_tools", Label: "Developer tools"},
	{Key: "social", Label: "Social"},
	{Key: "messaging", Label: "Messaging"},
	{Key: "sending", Label: "Email sending"},
	{Key: "sms", Label: "SMS"},
	{Key: "marketing", Label: "Marketing automation"},
	{Key: "migrations", Label: "Migrations"},
	{Key: "content", Label: "Content"},
	{Key: "events", Label: "Events"},
}

var capabilities = []Capability{
	CapabilityProfiles,
	CapabilityEvents,
	CapabilityLists,
	CapabilitySegments,
	CapabilityCommerce,
	CapabilityOrders,
	CapabilityProducts,
	CapabilityReviews,
	CapabilitySubscriptions,
	CapabilitySupport,
	CapabilityAdsAudiences,
	CapabilityWarehouseExport,
	CapabilityWarehouseImport,
	CapabilityAutomationTriggers,
}

func Categories() []Category {
	out := append([]Category(nil), categories...)
	return out
}

func Capabilities() []Capability {
	out := append([]Capability(nil), capabilities...)
	return out
}

func CatalogItems() []CatalogItem {
	out := rawCatalogItems()
	for i := range out {
		decorateCatalogItem(&out[i])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Featured != out[j].Featured {
			return out[i].Featured
		}
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func CatalogItemBySlug(slug string) (CatalogItem, bool) {
	for _, item := range rawCatalogItems() {
		if item.Slug == slug {
			decorateCatalogItem(&item)
			return item, true
		}
	}
	return CatalogItem{}, false
}

// archivedSupportCatalogItemFixture reconstructs the pre-Route41 catalog item
// only for same-package tests of dormant adapter algorithms. Runtime callers
// must use CatalogItemBySlug, which always applies the release hold.
func archivedSupportCatalogItemFixture(slug string) (CatalogItem, bool) {
	for _, item := range rawCatalogItems() {
		if item.Slug != slug {
			continue
		}
		if !hasSource(item, "support_integration") {
			decorateCatalogItem(&item)
			return item, true
		}
		item.Native = item.Badge == BadgeNative
		item.SetupPath = "/integrations"
		if item.DocsURL == "" {
			item.DocsURL = "/docs/integrations/" + item.Slug
		}
		return item, true
	}
	return CatalogItem{}, false
}

func catalogItemBySlug(items []CatalogItem, slug string) (CatalogItem, bool) {
	for _, item := range items {
		if item.Slug == slug {
			return item, true
		}
	}
	return CatalogItem{}, false
}

func rawCatalogItems() []CatalogItem {
	out := append([]CatalogItem(nil), catalogItems...)
	seen := make(map[string]struct{}, len(out)+len(catalogExpansionGroups)*12)
	for _, item := range out {
		seen[item.Slug] = struct{}{}
	}
	for _, generated := range generatedCatalogItems(seen) {
		out = append(out, generated)
		seen[generated.Slug] = struct{}{}
	}
	return out
}

func decorateCatalogItem(item *CatalogItem) {
	item.Native = item.Badge == BadgeNative
	switch {
	case hasSource(*item, "commerce"):
		item.SetupPath = "/commerce"
	case hasSource(*item, "crm"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "lead_capture"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "review_integration"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "loyalty_integration"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "subscription_integration"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "support_integration"):
		// Route41 holds every support-provider effect, callback, and worker
		// while Helpdesk privacy lifecycle coverage is incomplete. The generic
		// catalog is a weaker read:reports surface, so it may expose only static
		// non-tenant release truth—never credentials, connection IDs, history,
		// callbacks, or a runnable setup path.
		item.Badge = BadgePlanned
		item.RuntimeStatus = RuntimePlanned
		item.Native = false
		item.SetupPath = ""
		item.Capabilities = []Capability{}
		item.Summary = "Release-held support-provider catalog entry. Provider setup, pulls, callbacks, sync, backfill, and lifecycle effects are unavailable until Helpdesk tenant authority, immutable evidence, and privacy governance are certified together."
	case hasSource(*item, "analytics_integration"):
		item.SetupPath = "/integrations"
		if isAnalyticsPullerLiveCertificationPending(*item) {
			item.Capabilities = caps(CapabilityProfiles)
			item.Summary = analyticsPullerCatalogSummary(*item)
		} else {
			item.Capabilities = caps(CapabilityProfiles, CapabilityEvents)
			item.Summary = "Managed " + item.Name + " canonical profile/event ingest foundation; provider API, reporting, webhook, and warehouse adapters remain partial."
		}
	case hasSource(*item, "marketing_integration"):
		item.SetupPath = "/integrations"
	case hasSource(*item, "audience_destination"):
		item.SetupPath = "/audience-syncs"
	case hasSource(*item, "warehouse"):
		item.SetupPath = "/data-platform"
	case hasSource(*item, "outbound_webhooks") || hasSource(*item, "inbound_webhooks"):
		item.SetupPath = "/webhooks"
	case hasSource(*item, "zapier_package"):
		item.SetupPath = "/webhooks"
	case hasSource(*item, "developer_marketplace"):
		item.SetupPath = "/api-playground"
	case hasSource(*item, "mcp"):
		// The repository implementation can be evaluated privately, but no
		// supported distribution or integration lifecycle is released.
		item.SetupPath = ""
	case hasSource(*item, "bridge"):
		item.SetupPath = "/webhooks"
	case hasSource(*item, "slack") || hasSource(*item, "discord") || hasSource(*item, "teams"):
		item.SetupPath = "/settings"
	case item.Badge == BadgeMigrationOnly:
		item.SetupPath = "/migrations"
	case item.Badge == BadgeAPISDK:
		item.SetupPath = "/api-playground"
	case hasSource(*item, "migration"):
		item.SetupPath = "/migrations"
	case hasSource(*item, "sending"):
		item.SetupPath = "/sending"
	case hasSource(*item, "sms"):
		// Provider tiles are release-held. The inbox has its own private route,
		// but a provider catalog item must not advertise an executable setup
		// action until tenant-bound credentials and durable effects exist.
		item.SetupPath = ""
	}
	if item.DocsURL == "" {
		item.DocsURL = "/docs/integrations/" + item.Slug
	}
	if item.Capabilities == nil {
		// A catalog-only entry that claims no capability is an empty list.
		// A nil slice marshals to null, which IntegrationCatalogItem (a
		// required array) does not allow.
		item.Capabilities = []Capability{}
	}
}

func analyticsPullerCatalogSummary(item CatalogItem) string {
	common := " with credential refs, scheduled retry continuation, canonical profile mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; event/report/webhook/warehouse expansion, credential cleanup proof, reconnect/data-delete behavior, and live provider certification remain open."
	switch item.Slug {
	case "posthog":
		return "Managed PostHog local-runtime-complete/live-certification-pending profile puller using GET /api/projects/{project_id}/persons and PostHog next-page checkpoints" + common
	case "triple-whale":
		return "Managed Triple Whale local-runtime-complete/live-certification-pending profile puller using customer pages over configured or rolling date windows and triplewhale: checkpoints" + common
	case "mixpanel":
		return "Managed Mixpanel local-runtime-complete/live-certification-pending profile puller using POST /api/query/engage and mixpanel: session checkpoints" + common
	case "amplitude":
		return "Managed Amplitude local-runtime-complete/live-certification-pending profile puller using asynchronous Behavioral Cohort export request/status/download checkpoints" + common
	default:
		return "Managed " + item.Name + " local-runtime-complete/live-certification-pending analytics profile puller" + common
	}
}

func hasSource(item CatalogItem, source string) bool {
	for _, s := range item.Sources {
		if s == source {
			return true
		}
	}
	return false
}

type catalogExpansionGroup struct {
	Category string
	Badge    Badge
	Status   RuntimeStatus
	Phase    string
	Summary  string
	Caps     []Capability
	Sources  []string
	Names    []string
}

func generatedCatalogItems(seen map[string]struct{}) []CatalogItem {
	out := []CatalogItem{}
	for _, group := range catalogExpansionGroups {
		for _, name := range group.Names {
			slug := slugify(name)
			if slug == "" {
				continue
			}
			if _, exists := seen[slug]; exists {
				slug += "-bridge"
			}
			if _, exists := seen[slug]; exists {
				continue
			}
			seen[slug] = struct{}{}
			out = append(out, item(
				slug,
				name,
				group.Category,
				group.Badge,
				group.Status,
				group.Phase,
				strings.ReplaceAll(group.Summary, "{name}", name),
				group.Caps,
				group.Sources...,
			))
		}
	}
	return out
}

func slugify(value string) string {
	value = strings.ToLower(value)
	var b strings.Builder
	previousDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			previousDash = false
			continue
		}
		if !previousDash && b.Len() > 0 {
			b.WriteByte('-')
			previousDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func item(slug, name, category string, badge Badge, status RuntimeStatus, phase, summary string, caps []Capability, sources ...string) CatalogItem {
	featured := map[string]struct{}{
		"shopify":           {},
		"zapier":            {},
		"hubspot":           {},
		"typeform":          {},
		"meta":              {},
		"snowflake":         {},
		"outbound-webhooks": {},
		"inbound-webhooks":  {},
	}
	_, isFeatured := featured[slug]
	return CatalogItem{
		Slug:          slug,
		Name:          name,
		Category:      category,
		Badge:         badge,
		RuntimeStatus: status,
		Summary:       summary,
		Capabilities:  caps,
		Featured:      isFeatured,
		Phase:         phase,
		Sources:       sources,
	}
}

func caps(values ...Capability) []Capability {
	return values
}

var catalogExpansionGroups = []catalogExpansionGroup{
	{
		Category: "ecommerce",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} customers, orders, and storefront events into Moosewave through Zapier, Make, n8n, Pipedream, inbound webhooks, or the API.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"Shopify POS", "Shopify Plus", "Amazon Seller Central", "Amazon Buy with Prime", "eBay", "Etsy", "Walmart Marketplace", "Faire", "TikTok Shop", "Shopware", "PrestaShop", "OpenCart", "Ecwid", "Lightspeed Retail", "Lightspeed eCom", "Vend", "Nuvemshop", "VTEX", "Salesforce Commerce Cloud", "Commercetools", "Medusa", "Shopline", "Shift4Shop", "Volusion", "Big Cartel", "SamCart", "ThriveCart", "Gumroad", "Lemon Squeezy", "Podia", "Teachable Commerce", "Kajabi Commerce", "Memberful", "Uscreen", "Fourthwall",
		},
	},
	{
		Category: "forms",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Capture {name} submissions as Moosewave profiles, events, list joins, and automation triggers through a bridge recipe.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"Google Forms", "Microsoft Forms", "SurveyMonkey", "Paperform", "Formstack", "Formsite", "Cognito Forms", "Ninja Forms", "Formidable Forms", "Leadpages", "Instapage", "OptinMonster", "Privy", "ConvertFlow", "Sleeknote", "Wisepops", "Poptin", "Hello Bar", "Unstack", "Landingi", "KickoffLabs", "ShortStack", "Interact", "Outgrow", "Riddle", "Qualtrics Forms", "Fillout", "Feathery", "Formaloo", "123FormBuilder",
		},
	},
	{
		Category: "crm",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} contacts, lifecycle fields, and activity events into Moosewave profiles and segments.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments),
		Sources:  []string{"bridge"},
		Names: []string{
			"Copper", "Close", "Keap", "Insightly", "Nimble", "Freshsales", "Capsule CRM", "Monday Sales CRM", "Attio", "Folk", "Clay", "Apollo", "Outreach", "Salesloft", "Gainsight", "Vitally", "ChurnZero", "Totango", "ClientSuccess", "Less Annoying CRM", "HighLevel", "Agile CRM", "Nutshell", "OnePageCRM", "Streak", "Teamleader", "Creatio", "SugarCRM", "Microsoft Dynamics 365", "Oracle NetSuite CRM",
		},
	},
	{
		Category: "customer_service",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Connect {name} natively via Moosewave webhook ingest (provision a per-integration URL and point {name}'s webhook at it) or bridge tickets, conversations, and customer-support events through Zapier, Make, n8n, Pipedream, or the API.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport),
		Sources:  []string{"bridge"},
		Names: []string{
			"Help Scout", "Front", "Kustomer", "Freshchat", "LiveChat", "Crisp", "Tidio", "Olark", "Drift", "Ada", "Gladly", "Reamaze", "Groove", "Kayako", "HelpCrunch", "Zoho Desk", "HubSpot Service Hub", "Salesforce Service Cloud", "Jira Service Management", "Linear", "Asana Support", "ClickUp Support",
		},
	},
	{
		Category: "reviews",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Connect {name} natively via Moosewave webhook ingest (provision a per-integration URL and point {name}'s webhook at it) or bridge review activity into events, product segments, and commerce automations through Zapier, Make, n8n, Pipedream, or the API.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityCommerce),
		Sources:  []string{"bridge"},
		Names: []string{
			"Bazaarvoice", "PowerReviews", "Feefo", "Reviews.io", "Google Customer Reviews", "Shopper Approved", "TrustSpot", "Junip", "Fera", "Ryviu", "Growave Reviews", "Ali Reviews", "Opinew", "Vitals Reviews", "Kudobuzz", "Sitejabber", "ResellerRatings", "ProductReview.com.au", "Verified Reviews", "CusRev",
		},
	},
	{
		Category: "loyalty",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Connect {name} natively via Moosewave webhook ingest (provision a per-integration URL and point {name}'s webhook at it) or bridge loyalty, referral, advocate, and reward events into segments and automations through Zapier, Make, n8n, Pipedream, or the API.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"Yotpo Loyalty", "Growave", "Marsello", "Antavo", "Taloon", "Rise.ai", "Stamped Loyalty", "Swell Rewards", "Friendbuy", "Talkable", "Extole", "InviteReferrals", "Viral Loops", "FirstPromoter", "PartnerStack", "Rewardful", "Tapfiliate", "Impact", "Everflow", "Post Affiliate Pro",
		},
	},
	{
		Category: "subscriptions",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Connect {name} natively via Moosewave webhook ingest (provision a per-integration URL and point {name}'s webhook at it) or bridge subscription, billing, and renewal events into commerce automations through Zapier, Make, n8n, Pipedream, or the API.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilitySubscriptions, CapabilityCommerce),
		Sources:  []string{"bridge"},
		Names: []string{
			"Bold Subscriptions", "Ordergroove", "Loop Subscriptions", "Appstle", "Seal Subscriptions", "Subbly", "Sticky.io", "Chargebee", "Zuora", "Paddle", "Braintree Subscriptions",
		},
	},
	{
		Category: "shipping",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} shipment, fulfillment, tracking, and delivery events into Moosewave commerce automations.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityCommerce),
		Sources:  []string{"bridge"},
		Names: []string{
			"Shippo", "Easyship", "ShipBob", "EasyPost", "FedEx", "UPS", "USPS", "DHL", "Narvar", "Route", "Malomo", "Wonderment", "Parcel Panel", "Tracktor", "Sendcloud", "ShippyPro", "Pirate Ship", "ShipHero", "ShipMonk",
		},
	},
	{
		Category: "analytics",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} analytics, attribution, and product events into Moosewave reporting, segments, or warehouse exports.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityWarehouseExport, CapabilityWarehouseImport),
		Sources:  []string{"bridge"},
		Names: []string{
			"Heap", "Hotjar", "FullStory", "PostHog", "Plausible", "Fathom Analytics", "Matomo", "Adobe Analytics", "Looker Studio", "Looker", "Tableau", "Power BI", "Mode", "Metabase", "Sisense", "Kissmetrics", "Woopra", "ChartMogul", "Baremetrics", "ProfitWell", "Triple Whale", "Northbeam", "Daasity", "Glew", "Peel Insights", "Lifetimely", "Littledata", "Elevar", "Rockerbox", "Windsor.ai", "Hightouch", "Census",
		},
	},
	{
		Category: "ads",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} lead, conversion, or audience events into Moosewave with consent-aware profile and segment mapping.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAdsAudiences),
		Sources:  []string{"bridge"},
		Names: []string{
			"Pinterest Ads", "Reddit Ads", "X Ads", "Microsoft Advertising", "Amazon Ads", "Criteo", "Taboola", "Outbrain", "AdRoll", "The Trade Desk", "StackAdapt", "Quora Ads", "Spotify Ads", "Apple Search Ads", "Yelp Ads", "Nextdoor Ads", "Pinterest Lead Ads", "Google Lead Form Extensions", "TikTok Lead Generation", "Snap Lead Ads", "Reddit Lead Gen", "Twitter Lead Gen", "Facebook Conversions API", "TikTok Events API", "LinkedIn Conversions API", "Google Enhanced Conversions", "Pinterest Conversions API", "Reddit Conversions API", "Snap Conversions API", "Quora Conversion Pixel", "Microsoft UET", "Google Display & Video 360", "Campaign Manager 360", "Teads", "MNTN",
		},
	},
	{
		Category: "cms",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} CMS, landing page, asset, or content events into Moosewave profiles and campaigns.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"Contentful", "Sanity", "Strapi", "Prismic", "DatoCMS", "Storyblok", "ButterCMS", "Drupal", "Joomla", "HubSpot CMS", "Craft CMS", "Shopify Blog", "Medium", "Webiny", "Builder.io", "Shogun", "PageFly", "GemPages", "Zipify Pages", "Tapcart", "Vajro", "Plobal Apps", "Shopney", "Canva Teams", "Figma", "Adobe Express", "Dropbox", "Google Drive", "Box", "Bynder",
		},
	},
	{
		Category: "events",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} registrations, attendance, meeting, and webinar events into Moosewave automations.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"Acuity Scheduling", "Google Calendar", "Microsoft Outlook Calendar", "Zoom", "Google Meet", "Microsoft Teams Meetings", "Webex", "GoTo Webinar", "Livestorm", "Demio", "Hopin", "Bizzabo", "Cvent", "Splash", "Luma", "Meetup", "Ticket Tailor", "Humanitix", "Universe", "Tito", "Eventzilla", "Sched", "Airmeet", "Whova", "Goldcast",
		},
	},
	{
		Category: "warehouse",
		Badge:    BadgeWebhook,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} data movement through Moosewave warehouse import, export, webhook, or API recipes.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityWarehouseExport, CapabilityWarehouseImport),
		Sources:  []string{"bridge"},
		Names: []string{
			"Azure Blob Storage", "Google Cloud Storage", "SFTP", "MongoDB", "MySQL", "MariaDB", "ClickHouse", "DuckDB", "MotherDuck", "Delta Lake", "Apache Iceberg", "Apache Kafka", "Confluent Cloud", "Redpanda", "Pub/Sub", "Amazon Kinesis", "Azure Event Hubs", "RabbitMQ",
		},
	},
	{
		Category: "developer_tools",
		Badge:    BadgeAPISDK,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Use {name} with Moosewave through API keys, OAuth apps, webhooks, SDKs, or developer marketplace listings.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers),
		Sources:  []string{"bridge", "developer_marketplace"},
		Names: []string{
			"GitHub", "GitLab", "Bitbucket", "Linear API", "Jira", "Sentry", "Datadog", "New Relic", "Grafana", "PagerDuty", "Opsgenie", "Retool", "Superblocks", "Appsmith", "Bubble", "Softr",
		},
	},
	{
		Category: "messaging",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} messages, channel events, and notification state into Moosewave with consent-aware automation rules.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers),
		Sources:  []string{"bridge"},
		Names: []string{
			"WhatsApp Business", "Messenger", "Telegram", "Viber", "Line", "WeChat", "KakaoTalk", "OneSignal", "Firebase Cloud Messaging", "Airship", "Braze Currents", "Customer.io Journeys", "SlickText", "SimpleTexting", "Klaviyo SMS", "Yotpo SMS", "MessageBird", "Sinch", "Plivo", "Vonage", "Infobip", "Mailjet", "MailerSend",
		},
	},
	{
		Category: "payments",
		Badge:    BadgeZapier,
		Status:   RuntimeDelegated,
		Phase:    "6-12",
		Summary:  "Bridge {name} customers, payment events, invoices, and receipts into Moosewave profiles and commerce automations.",
		Caps:     caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders),
		Sources:  []string{"bridge"},
		Names: []string{
			"Adyen", "Mollie", "Authorize.net", "Checkout.com", "Worldpay", "Payoneer", "Wise", "Klarna", "Afterpay", "Affirm", "Sezzle", "Shop Pay", "Apple Pay", "Google Pay", "GoCardless", "Plaid", "QuickBooks Online", "Xero", "FreshBooks", "Wave",
		},
	},
}

var catalogItems = []CatalogItem{
	item("shopify", "Shopify", "ecommerce", BadgeNative, RuntimePartial, "0-1", "OAuth, registered signed webhooks including bulk-operation finish, mandatory privacy webhook handling, encrypted install secrets, scheduled Admin GraphQL backfill, async bulk-operation launch/poll/import, cart recovery, discount-code capture, and returned/persisted provider_cleanup evidence for customers, products, and orders; live store certification remains before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilityAutomationTriggers), "commerce"),
	item("woocommerce", "WooCommerce", "ecommerce", BadgeNative, RuntimePartial, "1-3", "Managed WooCommerce REST API credential refs, Customers/Products/Orders/Refunds REST backfill, variable-product variation enrichment, managed webhook reconciliation, X-WC-Webhook-Signature verification, coupon/delete/refund evidence, optional WooCommerce Subscriptions evidence, scheduled retry cursors, and provider webhook cleanup evidence.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilitySubscriptions), "commerce"),
	item("bigcommerce", "BigCommerce", "ecommerce", BadgeNative, RuntimePartial, "1-3", "Managed BigCommerce API-account credential refs, Customers/Catalog Products/Orders REST backfill, product variant and order products/coupons enrichment, managed /v3/hooks reconciliation, custom-secret webhook verification, delete/archive routing, scheduled retry cursors, and refund/transaction evidence.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilityAutomationTriggers), "commerce"),
	item("adobe-commerce", "Adobe Commerce", "ecommerce", BadgeNative, RuntimePartial, "3-6", "Managed Adobe Commerce/Magento bearer-token auth, PaaS/SaaS REST backfill for customers/products/orders/credit memos, merchant-configured webhook ingest, scheduled retry cursors, refund evidence, and persisted operator-managed provider_cleanup readiness evidence on disconnect.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilityAutomationTriggers), "commerce"),
	item("wix-stores", "Wix Stores", "ecommerce", BadgeNative, RuntimePartial, "3-6", "Managed Wix Stores app-instance OAuth, signed JWT app webhooks, lifecycle recovery, retry cursors, REST backfill for contacts, Catalog V1/V3 products and orders, delete evidence, and adjacent payment, subscription, booking, and ticket provider events.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts, CapabilitySubscriptions), "commerce"),
	item("squarespace-commerce", "Squarespace Commerce", "ecommerce", BadgeNative, RuntimePartial, "3-6", "Managed Squarespace Commerce API/OAuth credential refs, Contacts/Products/Orders REST backfill, product-detail enrichment, signed webhook ingest, contact delete evidence, scheduled retry cursors, extension-uninstall lifecycle recovery, and persisted operator-managed provider_cleanup readiness evidence on disconnect.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts), "commerce"),
	item("shopify-migration", "Shopify customer import", "ecommerce", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import Shopify customer lists into Moosewave during migration.", caps(CapabilityProfiles, CapabilityLists), "migration"),

	item("stripe", "Stripe", "payments", BadgeNative, RuntimePartial, "1-3", "Managed Stripe restricted-key auth, Customers/Checkout/PaymentIntent/Charges/Disputes/Invoice/Credit Notes/Subscription/Refund REST backfill, charge/payment-method/dispute/credit-note evidence, paginated invoice line enrichment, signed webhook ingest, customer delete evidence, scheduled retry cursors, payment lifecycle provider events, and persisted operator-managed provider_cleanup readiness evidence on disconnect.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders), "commerce"),
	item("square", "Square", "payments", BadgeNative, RuntimePartial, "1-3", "Managed Square OAuth/app-token credential refs, Customers, Catalog ITEM products/variations/deletions, Orders, Payments, and Refunds REST backfill, active-location discovery, signed webhook ingest, catalog-version product refresh, customer/product delete evidence, scheduled retry cursors, and payment/refund lifecycle evidence.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilityProducts), "commerce"),
	item("paypal", "PayPal", "payments", BadgeNative, RuntimePartial, "3-6", "Managed PayPal OAuth client-credential auth, Transaction Search backfill, verified webhook ingest with sparse Orders/Captures/Refunds/Subscriptions/Invoices resource hydration, scheduled retry cursors, customer/order/refund mapping, and subscription/invoice provider-event evidence.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders, CapabilitySubscriptions), "commerce"),
	item("razorpay", "Razorpay", "payments", BadgeNative, RuntimePartial, "3-6", "Managed Razorpay Basic Auth credential refs, Customers, Orders, Payments, and Refunds REST backfill, signed webhook ingest, scheduled retry cursors, payment/refund lifecycle evidence, and persisted operator-managed provider_cleanup readiness evidence on disconnect.", caps(CapabilityProfiles, CapabilityEvents, CapabilityCommerce, CapabilityOrders), "commerce"),

	item("meta", "Meta Custom Audiences", "ads", BadgeNative, RuntimePartial, "0-1", "Resolver-backed Meta Custom Audiences local runtime with consent filtering, vault-hydrated ads access tokens, chunked Graph v25.0 /users delivery, EMAIL_SHA256 payload shaping, Retry-After-aware transient chunk retry, safe Meta response counters, partial-failure evidence, and persisted operator-managed provider_cleanup evidence on disconnect; live app review, provider certification, and provider-side cleanup certification remain open.", caps(CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences), "audience_destination"),
	item("google-ads", "Google Ads Customer Match", "ads", BadgeNative, RuntimePartial, "0-1", "Local runtime-complete Google Data Manager Customer Match slice with default chunked audienceMembers:ingest delivery, explicit audienceMembers:remove cleanup delivery, Retry-After-aware transient chunk retry, consent and Customer Match terms gates, persisted single or multi-requestId evidence, on-demand/background request-status polling, and persisted operator-managed provider_cleanup evidence on disconnect; live Google Ads/Data Manager certification remains before full availability, while legacy OfflineUserDataJob stays an explicitly gated fallback outside this local-complete slice.", caps(CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences), "audience_destination"),
	item("tiktok", "TikTok Audiences", "ads", BadgeNative, RuntimePartial, "0-1", "Local runtime-complete TikTok Customer File audience slice with credential-ref hydration, targeted-ads consent filtering, SHA-256 email hashing, multipart DMP file upload, custom-audience create/update calls, Retry-After-aware transient retry, on-demand/background custom-audience status readback, and persisted operator-managed provider_cleanup evidence on disconnect; live TikTok advertiser certification, REMOVE/REPLACE provider-side certification, quota validation, and provider-side cleanup remain before full availability.", caps(CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences), "audience_destination"),
	item("linkedin", "LinkedIn Matched Audiences", "ads", BadgeNative, RuntimePartial, "0-1", "Local runtime-complete LinkedIn Matched Audiences slice with credential-ref hydration, targeted-ads consent filtering, SHA-256 email hashing with whitespace removal, sequential 5,000-user DMP segment add/remove batch delivery, per-element batch failure handling, Retry-After-aware transient retry, segment readback evidence, on-demand/background DMP segment status polling, and persisted operator-managed provider_cleanup evidence on disconnect; live LinkedIn Audiences-program certification, account-role/quota validation, replacement semantics, and provider-side cleanup remain before full availability.", caps(CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences), "audience_destination"),
	item("snap", "Snap Audiences", "ads", BadgeNative, RuntimePartial, "0-1", "Local runtime-complete Snap Audiences slice with credential-ref hydration, targeted-ads consent filtering, SHA-256 email hashing, nested EMAIL_SHA256 payload shaping, sequential 100,000-user add/remove batch delivery, explicit REMOVE/REPLACE request construction, Retry-After-aware transient retry, on-demand/background segment status readback, request-id/partial-failure evidence, and persisted operator-managed provider_cleanup evidence on disconnect; live Snap account certification, remove/replace provider-side certification, quota validation, and provider-side cleanup remain before full availability.", caps(CapabilityProfiles, CapabilitySegments, CapabilityAdsAudiences), "audience_destination"),
	item("facebook-lead-ads", "Facebook Lead Ads", "ads", BadgeNative, RuntimePartial, "1-3", "Managed Meta Graph lead-form REST puller with credential refs, Page leadgen subscription reconciliation/cleanup evidence, signed leadgen webhook ingest, lead-ID follow-up fetch through a bounded HTTP client, canonical submission mapping, durable webhook claims, connect-time backfill, and scheduled retry cursors; ownership certification and live app-review evidence remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("linkedin-lead-gen", "LinkedIn Lead Gen Forms", "ads", BadgeNative, RuntimePartial, "1-3", "Managed LinkedIn Lead Gen Forms ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("google-lead-form-extensions", "Google Lead Form Extensions", "ads", BadgeNative, RuntimePartial, "1-3", "Local runtime-complete Google Ads Search puller for lead_form_submission_data with OAuth/developer-token credential refs, canonical submission mapping, GAQL watermark cursors, explicit sync/backfill, connect-time history import, scheduled retry cursors, and returned/persisted operator-managed provider_cleanup evidence on disconnect; live Google Ads account/API certification, ownership/export-window evidence, duplicate/manual CRM export audit, and data-delete proof remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("tiktok-lead-generation", "TikTok Lead Generation", "ads", BadgeNative, RuntimePartial, "1-3", "Managed TikTok instant form ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("snap-lead-ads", "Snap Lead Ads", "ads", BadgeNative, RuntimePartial, "3-6", "Managed Snap lead form ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("reddit-lead-gen", "Reddit Lead Gen", "ads", BadgeNative, RuntimePartial, "3-6", "Managed Reddit lead form ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("pinterest-lead-ads", "Pinterest Lead Ads", "ads", BadgeNative, RuntimePartial, "3-6", "Managed Pinterest lead form ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),

	item("wordpress", "WordPress", "cms", BadgeNative, RuntimePartial, "1-3", "Managed CMS and subscriber capture connector foundation for WordPress.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("webflow", "Webflow", "cms", BadgeNative, RuntimePartial, "1-3", "Managed Webflow form submissions API backfill plus signed form-submission webhook ingest and cleanup evidence for profiles, lists, and lead events.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("wix", "Wix", "cms", BadgeNative, RuntimePartial, "1-3", "Managed Wix Forms and Contacts REST backfill, signed Wix app-webhook JWT ingest, lifecycle install/remove handling, contact-delete evidence, retry cursors, and durable idempotency.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("squarespace", "Squarespace", "cms", BadgeWebhook, RuntimeDelegated, "1-3", "Capture Squarespace form submissions through webhooks or bridge recipes until public native form APIs are verified.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "inbound_webhooks"),
	item("framer", "Framer", "cms", BadgeWebhook, RuntimeDelegated, "6-12", "Capture Framer leads through webhook or Zapier recipes.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "inbound_webhooks"),
	item("ghost", "Ghost", "cms", BadgeMigrationOnly, RuntimeAvailable, "6-12", "Import Ghost subscribers during migration.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("wordpress-subscribers", "WordPress subscribers", "cms", BadgeMigrationOnly, RuntimeAvailable, "6-12", "Import WordPress subscribers during migration.", caps(CapabilityProfiles, CapabilityLists), "migration"),

	item("typeform", "Typeform", "forms", BadgeNative, RuntimePartial, "1-3", "Managed Typeform Responses API backfill plus auto-registered signed webhook ingestion and cleanup evidence for form submissions.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("jotform", "Jotform", "forms", BadgeNative, RuntimePartial, "1-3", "Managed Jotform submissions API backfill plus shared-secret webhook ingest and cleanup evidence for forms, questions, profiles, lists, and lead events.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("gravity-forms", "Gravity Forms", "forms", BadgeNative, RuntimePartial, "1-3", "Managed Gravity Forms Entries REST puller with WordPress/GF Basic credential refs, offset/page-size backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live WordPress/Gravity Forms certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("wpforms", "WPForms", "forms", BadgeNative, RuntimePartial, "1-3", "Managed WPForms Pro Abilities API entry puller with WordPress Application Password credential refs, get-form field hydration, search-entries page cursors, scheduled retry continuation, canonical profile/list/event import, and operator-managed cleanup evidence; live WordPress/WPForms certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("tally", "Tally", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Tally submissions REST puller with page/limit backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Tally certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("google-forms", "Google Forms", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Google Forms Responses API puller with form/question label hydration, pageToken/timestamp backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Google Forms certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("microsoft-forms", "Microsoft Forms", "forms", BadgeNative, RuntimePartial, "6-12", "Managed Microsoft Forms response ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("surveymonkey", "SurveyMonkey", "forms", BadgeNative, RuntimePartial, "6-12", "Managed SurveyMonkey bulk responses REST puller is local-runtime-complete with scheduled retry and cleanup evidence; live account/app certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("unbounce", "Unbounce", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Unbounce Leads API puller with form-field label hydration, offset/limit backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Unbounce certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("leadpages", "Leadpages", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Leadpages form-submissions REST puller with Bearer credential refs, flexible provider cursor/next-link/watermark continuation, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Leadpages certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("instapage", "Instapage", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Instapage submissions REST puller with workspace/page filters, nextPageToken backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Instapage certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("carrd", "Carrd", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Carrd Custom URL form receiver with route-token verification, canonical lead import, webhook idempotency, and operator-managed cleanup evidence; live Carrd Pro Plus site certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("paperform", "Paperform", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Paperform submissions REST puller with skip/limit backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Paperform certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("formstack", "Formstack", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Formstack submissions REST puller with pageNumber/pageSize backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Formstack certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("fillout", "Fillout", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Fillout submissions API backfill plus auto-registered URL-token webhook ingest and cleanup evidence for forms, profiles, lists, and lead events.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("optinmonster", "OptinMonster", "forms", BadgeNative, RuntimePartial, "3-6", "Managed OptinMonster Webhook receiver with route-token JSON lead ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("privy", "Privy", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Privy custom Webhook receiver with Basic-authenticated signup/contact JSON ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("convertflow", "ConvertFlow", "forms", BadgeNative, RuntimePartial, "3-6", "Managed ConvertFlow custom Webhook receiver with route-token fields-submitted/contact/conversion JSON ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("sleeknote", "Sleeknote", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Sleeknote custom integration receiver with route-token GET/form/JSON signup ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("wisepops", "Wisepops", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Wisepops signed Webhook receiver with HMAC contact ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("poptin", "Poptin", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Poptin Webhooks receiver with route-token popup lead ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("hello-bar", "Hello Bar", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Hello Bar Webhook receiver with route-token GET/POST subscriber ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("unstack", "Unstack", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Unstack form submission ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("landingi", "Landingi", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Landingi Webhook receiver with route-token GET/POST lead ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("kickofflabs", "KickoffLabs", "forms", BadgeNative, RuntimePartial, "3-6", "Managed KickoffLabs outbound Webhook receiver with route-token lead/referral/reward ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("shortstack", "ShortStack", "forms", BadgeNative, RuntimePartial, "3-6", "Managed ShortStack signed Webhook form integration receiver with HMAC-SHA1 entry ingest; live certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("formsite", "Formsite", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Formsite results REST puller with page/limit backfill, Pagination-* continuation headers, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Formsite certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("cognito-forms", "Cognito Forms", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Cognito Forms OData grid-view entry ID puller with REST entry hydration, local last-ID batching, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Cognito Forms certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("ninja-forms", "Ninja Forms", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Ninja Forms Webhooks add-on receiver with route-token GET/POST submission ingest; live WordPress/Ninja Forms certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("formidable-forms", "Formidable Forms", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Formidable Forms Entries REST puller with WordPress/Application Password or Formidable API-key credential refs, form/field hydration, page/page_size backfill, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live WordPress/Formidable certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("interact", "Interact", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Interact quiz, assessment, and lead ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("outgrow", "Outgrow", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Outgrow Webhook receiver with Basic-or-route-token JSON/form lead, visit, and result ingest; live Outgrow certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("riddle", "Riddle", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Riddle Webhook receiver with signature-or-route-token JSON lead/result ingest; live Riddle certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("qualtrics-forms", "Qualtrics Forms", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Qualtrics survey response ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("feathery", "Feathery", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Feathery submissions REST puller is local-runtime-complete with scheduled retry and cleanup evidence; live workspace certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("formaloo", "Formaloo", "forms", BadgeNative, RuntimePartial, "3-6", "Managed Formaloo rows REST puller with x-api-key/JWT credential refs, page/page_size continuation, row data identity mapping, scheduled retry cursors, canonical profile/list/event import, and operator-managed cleanup evidence; live Formaloo certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),
	item("123formbuilder", "123FormBuilder", "forms", BadgeNative, RuntimePartial, "3-6", "Managed 123FormBuilder REST API v2 submissions puller with JWT credential refs or login token exchange, page/per_page continuation, start_submission_id checkpoints, canonical profile/list/event import, scheduled retry cursors, and operator-managed cleanup evidence; live 123FormBuilder certification remains pending.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "lead_capture"),

	item("hubspot", "HubSpot", "crm", BadgeNative, RuntimePartial, "1-3", "Managed HubSpot contact REST backfill via polling-only private-app references or managed OAuth, integration-scoped contact binding that adopts exact raw/URI migration source identities without claiming unrelated subscriber external IDs, configured list-membership fanout with provider-list evidence and owned-membership stale repair, optional deal association events, token refresh, and OAuth-install-only v3-signed contact webhooks routed by exact appId + portalId. Deleted/no-primary contacts retain the subscriber while marking the binding inactive and detaching only connector-owned memberships; the current 2026-03 app settings/property-subscription reconciler and lifecycle behavior still require live portal proof. Private-app rows do not receive app-level webhooks.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists), "crm"),
	item("salesforce", "Salesforce", "crm", BadgeNative, RuntimePartial, "1-3", "Managed Salesforce connected-app OAuth, proactive/reactive token refresh, SOQL contact/lead backfill, CampaignMember event fanout with provider-segment evidence, opt-in native Moosewave list membership adds, explicit removal-signal soft-removes, complete-scan stale repair for owned mapped Campaign memberships, Task activity event fanout, scheduled retry cursors, and managed disconnect cleanup; live org certification remains before full availability, with CDC/Platform Events tracked as a future streaming enhancement.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists), "crm"),
	item("pipedrive", "Pipedrive", "crm", BadgeNative, RuntimePartial, "1-3", "Managed Pipedrive OAuth install/storage automation, /users/me install identity capture, refresh-token revocation, uninstall callback cleanup, persons/deals/organizations/activities REST backfill, automatic token refresh, scheduled retry cursors, row-preserving disconnect evidence, and Moosewave-owned person/deal/organization/activity webhooks with credential refs, route identity checks, and integration-scoped body-checked idempotency; live certification remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "crm"),
	item("zoho-crm", "Zoho CRM", "crm", BadgeNative, RuntimePartial, "6-12", "Local-runtime-complete/live-certification-pending Zoho CRM OAuth/credential-ref V8 Contacts/Leads puller with page/page-token checkpoints, token refresh, scheduled retry cursors, manual retry preservation, disconnect-safe writes, disconnect refresh-token revocation, and local credential cleanup evidence; Accounts, Deals, activities, notifications, connected-app/notification cleanup certification, and live certification remain outside the implemented slice.", caps(CapabilityProfiles), "crm"),
	item("microsoft-dynamics-365", "Microsoft Dynamics 365", "crm", BadgeNative, RuntimePartial, "6-12", "Local-runtime-complete/live-certification-pending Microsoft Dynamics 365 OAuth/credential-ref Dataverse Contacts/Leads puller with OData paging, token refresh, scheduled retry cursors, manual retry preservation, disconnect-safe writes, local credential cleanup evidence, and canonical profile mapping; Accounts, Opportunities, activities, marketing lists, change tracking, Microsoft Entra/app cleanup certification, and live certification remain outside the implemented slice.", caps(CapabilityProfiles), "crm"),
	item("keap", "Keap", "crm", BadgeNative, RuntimePartial, "6-12", "Local-runtime-complete/live-certification-pending Keap REST v2 Contacts puller with OAuth/PAT/SAK credential refs, OAuth token refresh when applicable, token pagination, optional tagged-contact reads, scheduled retry cursors, manual retry preservation, disconnect-safe writes, local credential cleanup evidence, and canonical profile mapping; full tag membership fanout, campaign, order, appointment, webhook, provider credential cleanup certification, and live certification remain outside the implemented slice.", caps(CapabilityProfiles), "crm"),
	item("close", "Close", "crm", BadgeNative, RuntimePartial, "6-12", "Managed Close contacts REST backfill plus route-token signed webhook ingest for contact/opportunity/task/activity callbacks, scheduled retry cursors, durable webhook idempotency, and operator-managed provider_cleanup evidence on disconnect; live workspace certification, webhook subscription cleanup proof, credential/signature-key rotation, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("copper", "Copper", "crm", BadgeNative, RuntimePartial, "6-12", "Managed Copper people/company REST backfill, opportunity/project/activity event backfill, route-token person/company/opportunity/project/activity webhook hydration, scheduled retry cursors, and operator-managed provider_cleanup evidence on disconnect; provider webhook cleanup proof, credential rotation/reconnect proof, data-delete behavior, and live workspace certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("freshsales", "Freshsales", "crm", BadgeNative, RuntimePartial, "6-12", "Managed Freshsales contacts-view REST backfill, optional account-view contact enrichment, optional deal-view event backfill, contact/deal/account-targeted sales-activity and task event backfill, route-token workflow contact webhooks with sparse contact hydration, scheduled retry cursors, and operator-managed provider_cleanup evidence on disconnect; managed workflow cleanup, credential rotation proof, reconnect, and live workspace certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("highlevel", "HighLevel", "crm", BadgeNative, RuntimePartial, "6-12", "Managed HighLevel contacts REST backfill plus opt-in opportunity, calendar, appointment, and conversation REST event pulls, route-token contact/opportunity/appointment/conversation/message webhook hydration, manual/scheduled retry cursors, local managed OAuth credential deletion on disconnect, and provider_cleanup evidence; provider webhook cleanup proof, credential rotation/reconnect proof, data-delete behavior, and live location certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("postscript", "Postscript", "crm", BadgeNative, RuntimePartial, "6-12", "Managed Postscript SMS runtime: API-key credential refs, manual/scheduled cursor-paged /subscribers pulls, phone-keyed identity for SMS-only subscribers, route-token public webhook ingest with Postscript-Signature verification for incoming-message and subscriber opt-in/opt-out events, integration-scoped webhook idempotency, and operator-managed provider_cleanup evidence on disconnect; live Postscript certification, provider-console webhook setup proof, credential rotation/reconnect proof, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("attentive", "Attentive", "crm", BadgeNative, RuntimePartial, "6-12", "Managed Attentive SMS runtime: API-key credential refs, manual/scheduled cursor-paged /subscribers pulls, phone-keyed identity for SMS-only subscribers, route-token public webhook ingest with x-attentive-hmac-sha256 verification for SMS subscribe/unsubscribe/inbound/sent/click and custom-attribute events, integration-scoped webhook idempotency, and operator-managed provider_cleanup evidence on disconnect; live Attentive certification, provider-console webhook setup proof, credential rotation/reconnect proof, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "crm"),
	item("airtable", "Airtable", "crm", BadgeZapier, RuntimeDelegated, "3-6", "Sync lightweight CRM tables through Zapier or Make.", caps(CapabilityProfiles, CapabilityEvents), "bridge"),
	item("google-sheets", "Google Sheets", "crm", BadgeZapier, RuntimeDelegated, "3-6", "Import and update profile rows through bridge recipes.", caps(CapabilityProfiles, CapabilityLists), "bridge"),
	item("notion", "Notion", "crm", BadgeZapier, RuntimeDelegated, "6-12", "Bridge Notion databases into profile and event updates.", caps(CapabilityProfiles, CapabilityEvents), "bridge"),

	item("zendesk", "Zendesk", "customer_service", BadgeNative, RuntimePartial, "1-3", "Managed Zendesk OAuth/API-token Tickets REST backfill plus opt-in Incremental Export pulls with side-loaded requester users, sparse ticket-id callback refresh, cursor checkpoints, scheduled retry cursors, signed Zendesk webhook ingest, durable callback idempotency, canonical support mapping, run history, and best-effort stored-webhook deletion with persisted provider_cleanup evidence on disconnect; live workspace certification remains before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("intercom", "Intercom", "customer_service", BadgeNative, RuntimePartial, "1-3", "Managed Intercom OAuth-token Conversations REST backfill with cursor checkpoints, cached contact lookup fallback, per-conversation /conversations/{id} detail hydration for source plus retrieved conversation-part support-message rows up to Intercom's 500-part API limit, signed app webhook ingest, sparse conversation refresh, durable callback idempotency, scheduled retry cursors, canonical support/profile/message/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; richer admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live workspace certification remain before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("gorgias", "Gorgias", "customer_service", BadgeNative, RuntimePartial, "1-3", "Managed Gorgias API-key Tickets REST backfill with cursor pagination, embedded customer mapping, bounded payload-present Shopify/Recharge/order evidence preservation plus lookup-only order/customer/product UUID resolution when commerce_integration_id is configured, scheduled retry cursors, authenticated HTTP integration callbacks, sparse ticket-id callback refresh, durable callback idempotency, canonical support/profile/event sinks, run history, and best-effort stored HTTP integration deletion with persisted provider_cleanup evidence on disconnect; official hmac_secret header certification, stored HTTP integration deletion certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityCommerce, CapabilityAutomationTriggers), "support_integration"),
	item("freshdesk", "Freshdesk", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Freshdesk API-key Tickets REST backfill with account-domain normalization, include=requester enrichment, local product_id filtering, authenticated automation-webhook ingest, sparse ticket refresh, durable callback idempotency, page checkpoints, scheduled retry cursors, canonical support/profile/event mapping, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed cleanup automation and live helpdesk certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("help-scout", "Help Scout", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Help Scout OAuth client-credential Conversations REST backfill with mailbox routing, embedded thread/message mapping, signed app webhook ingest, sparse conversation refresh, durable callback idempotency, page checkpoints, scheduled retry cursors, canonical support/profile/message/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed cleanup automation and live mailbox certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("front", "Front", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Front Bearer Conversations REST backfill with optional inbox-scoped pulls plus signed webhook callback ingest with sparse conversation refresh, contact/email mapping, page-token checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live inbox certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("zoho-desk", "Zoho Desk", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Zoho Desk OAuth Tickets REST backfill plus ticket Threads REST detail pulls with organization routing, optional department filtering, contact/email mapping, signed JWT webhook ingest with sparse ticket refresh, durable webhook idempotency, thread HTML/plain-text preservation, page checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed notification cleanup readiness evidence on disconnect; managed notification registration/cleanup, token lifecycle cleanup, and live helpdesk certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("kustomer", "Kustomer", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Kustomer Bearer Conversations REST backfill plus signed outbound webhook ingest with sparse conversation refresh, customer lookup fallback, cursor checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("freshchat", "Freshchat", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Freshchat Bearer Users REST page pulls, per-user Conversation ID discovery, conversation detail and Messages REST hydration, signed webhook sparse conversation refresh, optional channel filtering, page checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("livechat", "LiveChat", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed LiveChat Bearer Archives REST backfill with optional group filters plus payload-secret authenticated webhook ingest, opt-in Configuration API webhook registration and owned unregister cleanup, embedded customer/message mapping, date/page checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted provider_cleanup evidence on disconnect; live account certification, token cleanup proof, and duplicate/manual webhook audit remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("crisp", "Crisp", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Crisp plugin-token Conversations REST backfill plus signed plugin-hook ingest with sparse session metadata refresh, website routing, people/email enrichment, page checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live website certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("tidio", "Tidio", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Tidio OpenAPI Tickets page pulls with per-ticket message detail hydration, Contacts page pulls with per-contact conversation message hydration, project_public_key-routed signed webhook ingest, sparse ticket/contact refresh, optional custom-channel filtering, cursor checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live Plus/Premium project certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("olark", "Olark", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Olark Bearer Transcripts REST backfill, route-token authenticated form-posted transcript webhook ingest, transcript item message mapping, visitor/email mapping, offset checkpoints, durable webhook idempotency, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live site certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("drift", "Drift", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Drift OAuth Conversations REST backfill with contact lookup fallback, verification-token webhook ingest, sparse conversation refresh, cursor checkpoints, Retry-After-aware scheduled retry cursors, canonical support/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("ada", "Ada", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Ada Data Export conversation pulls with created-window checkpoints, per-conversation message hydration, end-user email enrichment, ai_agent_domain-routed Svix/Webhooks Standard signed callback ingest, sparse conversation refresh, optional channel/handoff filtering, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup, Native Social channel parity, and live AI Agent certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("gladly", "Gladly", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Gladly Basic-auth customer profile REST hydration with customer-scoped conversation pulls, conversation item message mapping, optional task event mapping, recent Events API JSONL sparse hydration, organization-domain routed Basic/header-token webhook ingest, durable callback idempotency, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; broad historical org export, managed webhook registration/cleanup, API-token cleanup proof, and live organization certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("reamaze", "Reamaze", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Reamaze Basic-auth Conversations REST backfill plus scoped conversation Messages REST thread pulls with contact/email mapping, message HTML preservation, route-token webhook sparse conversation refresh, durable callback idempotency, page checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; signed callback certification, managed webhook registration/cleanup, API-token cleanup proof, and live account certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("groove", "Groove", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Groove Bearer-token REST Tickets backfill with per-ticket Messages hydration, customer-email extraction, optional state/folder/customer filters, route-token webhook sparse ticket refresh, durable callback idempotency, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; GraphQL v2 parity, documented signed webhook verification, managed webhook registration/cleanup, API-token cleanup proof, export-assisted historical backfill, and live organization certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("kayako", "Kayako", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Kayako Basic-auth Cases REST backfill plus per-case Posts REST message pulls with requester resource/email mapping, route-token webhook sparse case refresh, durable callback idempotency, offset checkpoints, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; live account certification and provider-console cleanup posture remain before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("helpcrunch", "HelpCrunch", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed HelpCrunch Bearer-token REST Chats backfill with per-chat Messages hydration, customer/profile mapping, optional application/widget and status filters, HMAC-SHA1 signed webhook sparse chat refresh, durable callback idempotency using provider event ids, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup, Public API key cleanup proof, broad high-volume backfill throttling, and live organization certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("hubspot-service-hub", "HubSpot Service Hub", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed HubSpot Service Hub OAuth Tickets REST backfill plus signed app-webhook ticket ingest with sparse ticket refresh, optional ticket pipeline filtering, contact association lookup, after-cursor checkpoints, Retry-After-aware scheduled retry cursors, canonical support/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup and live portal certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("salesforce-service-cloud", "Salesforce Service Cloud", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Salesforce Service Cloud SOQL Cases and CaseComments backfill with contact email mapping, Case owner/queue routing evidence, optional queue-owner filtering, operator-managed CDC/Pub/Sub relay ingest, canonical support messages, managed OAuth refresh, durable webhook idempotency, and Retry-After-aware scheduled retry worker; support-side OAuth install parity, managed Salesforce subscription cleanup, and live org certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("jira-service-management", "Jira Service Management", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Jira Service Management OAuth/API-token Requests REST backfill with per-request Comment hydration, service-desk/project/organization/status filters, route-token Jira issue/comment webhook sparse request refresh, Atlassian delivery idempotency, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; OAuth dynamic-webhook JWT verification, managed 30-day webhook refresh/cleanup, broad issue-search backfill, token cleanup proof, and live site certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("linear", "Linear", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Linear GraphQL Issues backfill with bounded Comment hydration, team-scoped filtering, customer-need/email evidence mapping, HMAC-SHA256 signed webhook sparse issue refresh, Linear delivery idempotency, Retry-After/reset-aware scheduled retry cursors for GraphQL rate limits, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup, full comment pagination, app-actor writeback, OAuth token refresh certification, and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("asana-support", "Asana Support", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed Asana OAuth/PAT Tasks REST backfill with project/workspace pulls, per-task Stories hydration, custom-field/notes requester email mapping, official X-Hook-Secret webhook handshake, HMAC-SHA256 signed webhook sparse task refresh, durable callback idempotency, Retry-After-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup, resource export parity, task-search pagination, token cleanup proof, and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),
	item("clickup-support", "ClickUp Support", "customer_service", BadgeNative, RuntimePartial, "6-12", "Managed ClickUp REST Tasks backfill with list/workspace pulls, per-task Comment hydration, custom-field/text requester email mapping, HMAC-SHA256 signed webhook sparse task refresh, durable callback idempotency, X-RateLimit-Reset-aware scheduled retry cursors, canonical support/message/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed webhook registration/cleanup, full comment pagination, OAuth token cleanup proof, hierarchy discovery expansion, and live workspace certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers), "support_integration"),

	item("yotpo", "Yotpo", "reviews", BadgeNative, RuntimePartial, "3-6", "Managed Yotpo Reviews REST puller with app-key/secret token exchange, paged review backfill, scheduled retry cursors, lookup-only product/order UUID enrichment with order-line product fallback, resolved review customer_id linkage plus customer evidence, tokenized review_create/review_updated ingest with integration-scoped WebhookMessageId idempotency and body-hash conflict checks, canonical review/reviewer/event mapping, unresolved product-refresh handoff metadata, disconnect-safe local write guards, persisted operator-managed provider_cleanup readiness evidence on disconnect, and local cleanup acknowledgment for operator attestation; signed/provider-managed webhook certification, provider-side cleanup proof, live brand certification, and any future provider-certified product refresh path remain before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("judge-me", "Judge.me", "reviews", BadgeNative, RuntimePartial, "3-6", "Managed Judge.me reviews REST page backfill with credential refs, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; live shop certification, webhook registration/callback proof, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("okendo", "Okendo", "reviews", BadgeNative, RuntimePartial, "3-6", "Managed Okendo reviews REST cursor backfill with credential refs, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; live store certification, webhook registration/callback proof, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("loox", "Loox", "reviews", BadgeNative, RuntimePartial, "3-6", "Managed Loox reviews REST page backfill with credential refs, scheduled retry cursors, media evidence, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; live shop certification, webhook registration/callback proof, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("stamped", "Stamped", "reviews", BadgeNative, RuntimePartial, "3-6", "Managed Stamped reviews REST page backfill with credential refs, store-id/store-hash setup, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; questions, loyalty extensions, webhooks, live store certification, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("trustpilot", "Trustpilot", "reviews", BadgeNative, RuntimePartial, "6-12", "Managed Trustpilot service reviews REST page backfill with credential refs, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; live business-unit certification, OAuth/app certification, webhooks, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("reviews-io", "Reviews.io", "reviews", BadgeNative, RuntimePartial, "6-12", "Managed Reviews.io product reviews REST page backfill with credential refs, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; company reviews, questions, webhooks, live store certification, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityAutomationTriggers), "review_integration"),
	item("bazaarvoice", "Bazaarvoice", "reviews", BadgeNative, RuntimePartial, "6-12", "Managed Bazaarvoice Display API offset backfill with credential refs, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; Q&A, syndication, webhooks, live client certification, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityCommerce, CapabilityAutomationTriggers), "review_integration"),
	item("powerreviews", "PowerReviews", "reviews", BadgeNative, RuntimePartial, "6-12", "Managed PowerReviews reviews REST page backfill with credential refs, required product page ID setup, scheduled retry cursors, canonical review/reviewer/event mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; Q&A, review requests, webhooks, live merchant certification, credential cleanup proof, reconnect, and data-delete behavior remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilityReviews, CapabilityCommerce, CapabilityAutomationTriggers), "review_integration"),

	item("smile", "Smile.io", "loyalty", BadgeNative, RuntimePartial, "3-6", "Managed Smile.io Customers plus historical and incremental points/reward REST polling with API-token auth, account-id-routed signed app webhook ingest, integration-scoped delivery idempotency with body-hash conflict checks, scheduled retry cursors with SYNC_FAILED preservation, points balance/VIP tier profile mapping, loyalty event mapping including reward pending state, disconnect-safe local write guards, run history, persisted operator-managed provider_cleanup readiness evidence on disconnect, and local cleanup acknowledgment for operator attestation; managed cleanup automation and live store certification remain partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("loyaltylion", "LoyaltyLion", "loyalty", BadgeNative, RuntimePartial, "3-6", "Managed LoyaltyLion customers/points/tiers REST page backfill with credential refs, scheduled retry cursors, canonical loyalty profile mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; reward-event expansion, managed webhooks, OAuth refresh, credential cleanup proof, reconnect, data-delete behavior, and live program certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("rivo", "Rivo", "loyalty", BadgeNative, RuntimePartial, "3-6", "Managed Rivo customers/points/referrals REST page backfill with credential refs, scheduled retry cursors, canonical loyalty profile mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; reward-event expansion, managed webhooks, credential cleanup proof, reconnect, data-delete behavior, and live store certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("referralcandy", "ReferralCandy", "loyalty", BadgeNative, RuntimePartial, "3-6", "Managed ReferralCandy signed referrers REST page backfill with credential refs, scheduled retry cursors, canonical loyalty profile/referral-code mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; callback authenticity, campaign deepening, reward-event expansion, credential cleanup proof, reconnect, data-delete behavior, and live campaign certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("growave", "Growave", "loyalty", BadgeNative, RuntimePartial, "6-12", "Managed Growave canonical loyalty ingest foundation; provider API/webhook adapters remain to be verified.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("marsello", "Marsello", "loyalty", BadgeNative, RuntimePartial, "6-12", "Managed Marsello canonical loyalty ingest foundation; provider API/webhook adapters remain to be verified.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("antavo", "Antavo", "loyalty", BadgeNative, RuntimePartial, "6-12", "Managed Antavo canonical loyalty ingest foundation; provider API/webhook adapters remain to be verified.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("friendbuy", "Friendbuy", "loyalty", BadgeNative, RuntimePartial, "6-12", "Managed Friendbuy token-exchange customer/referral-code REST cursor backfill with credential refs, scheduled retry cursors, canonical loyalty profile mapping, run history, disconnect-safe writes, and operator-managed provider_cleanup evidence; referral/reward event expansion, webhooks, credential cleanup proof, reconnect, data-delete behavior, and live campaign certification remain before full availability.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),
	item("talkable", "Talkable", "loyalty", BadgeNative, RuntimePartial, "6-12", "Managed Talkable canonical referral-event ingest foundation; provider API/webhook adapters remain to be verified.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySegments, CapabilityAutomationTriggers), "loyalty_integration"),

	item("recharge", "Recharge", "subscriptions", BadgeNative, RuntimePartial, "3-6", "Managed Recharge API-token subscription REST backfill with cursor pagination, scheduled retry cursors, tokenized webhook ingest with optional Recharge signature verification and durable delivery claims for subscription/charge events, canonical subscription/event mapping, run history, persisted operator-managed provider_cleanup readiness evidence, and local cleanup acknowledgment on disconnect; live merchant certification remains before RuntimeAvailable promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("skio", "Skio", "subscriptions", BadgeNative, RuntimePartial, "3-6", "Managed Skio local-runtime-complete/live-certification-pending GraphQL subscription puller with credential refs, offset checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; Shopify lifecycle webhooks, credential cleanup proof, reconnect/data-delete behavior, and live store certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("aftership", "AfterShip", "shipping", BadgeNative, RuntimePartial, "3-6", "Managed AfterShip local-runtime-complete/live-certification-pending tracking REST puller with credential refs, page checkpoints, scheduled retry continuation, canonical shipment/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; tracking webhooks, credential cleanup proof, reconnect/data-delete behavior, and live account certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("shipstation", "ShipStation", "shipping", BadgeNative, RuntimePartial, "3-6", "Managed ShipStation local-runtime-complete/live-certification-pending order-to-shipment REST puller with credential refs, page checkpoints, scheduled retry continuation, canonical shipment/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; fulfillment webhooks, credential cleanup proof, reconnect/data-delete behavior, and live account certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("shippo", "Shippo", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Shippo shipment, transaction, and tracker ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("easyship", "Easyship", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Easyship shipment, order, and tracking ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("shipbob", "ShipBob", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed ShipBob order, fulfillment, inventory, and shipment ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("easypost", "EasyPost", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed EasyPost shipment, tracker, and batch ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("narvar", "Narvar", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Narvar order, shipment, return, and tracking ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("route", "Route", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Route order, shipment, tracking, and claim ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("malomo", "Malomo", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Malomo order, fulfillment, shipment, and tracking ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("wonderment", "Wonderment", "shipping", BadgeNative, RuntimePartial, "6-12", "Managed Wonderment order, shipment, tracking, and delivery-promise ingest/import foundation; provider-side polling remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("bold-subscriptions", "Bold Subscriptions", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Bold Subscriptions local-runtime-complete/live-certification-pending REST subscription puller with credential refs, shop_identifier-scoped page checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; webhooks, line-item/order expansion, credential cleanup proof, reconnect/data-delete behavior, and live store certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("ordergroove", "Ordergroove", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Ordergroove customer, subscription, order, and offer ingest/import foundation; provider-side pagination remains partial.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("loop-subscriptions", "Loop Subscriptions", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Loop Subscriptions local-runtime-complete/live-certification-pending REST subscription puller with credential refs, page checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; webhooks, contract/order expansion, credential cleanup proof, reconnect/data-delete behavior, and live store certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("appstle", "Appstle", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Appstle local-runtime-complete/live-certification-pending REST subscription-contract puller with credential refs, page checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; plan/order expansion, webhooks, credential cleanup proof, reconnect/data-delete behavior, and live store certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("seal-subscriptions", "Seal Subscriptions", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Seal Subscriptions local-runtime-complete/live-certification-pending REST subscription puller with credential refs, page checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; rules/order expansion, webhooks, credential cleanup proof, reconnect/data-delete behavior, and live store certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),
	item("chargebee", "Chargebee", "subscriptions", BadgeNative, RuntimePartial, "6-12", "Managed Chargebee local-runtime-complete/live-certification-pending REST subscription puller with credential refs, site_id-scoped offset checkpoints, scheduled retry continuation, canonical subscription/profile/event mapping, run history, disconnect-safe local writes, and operator-managed provider_cleanup evidence; invoice expansion, webhooks, credential cleanup proof, reconnect/data-delete behavior, and live site certification remain open.", caps(CapabilityProfiles, CapabilityEvents, CapabilitySubscriptions, CapabilityCommerce, CapabilityOrders, CapabilityAutomationTriggers), "subscription_integration"),

	item("ga4", "Google Analytics 4", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed GA4 canonical profile/event ingest foundation; Measurement Protocol, Data API, and webhook/reporting adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("google-tag-manager", "Google Tag Manager", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed GTM canonical profile/event ingest foundation; Tag Manager API publishing and container adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("segment", "Segment", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed Segment canonical profile/event ingest foundation; Tracking API, Public API, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("rudderstack", "RudderStack", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed RudderStack canonical profile/event ingest foundation; data-plane and provider API adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("mixpanel", "Mixpanel", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed Mixpanel local-runtime-complete/live-certification-pending profile puller using POST /api/query/engage and mixpanel: session checkpoints; event import/export, reporting, webhooks, cleanup proof, and live project certification remain partial.", caps(CapabilityProfiles), "analytics_integration"),
	item("amplitude", "Amplitude", "analytics", BadgeNative, RuntimePartial, "3-6", "Managed Amplitude local-runtime-complete/live-certification-pending profile puller using asynchronous Behavioral Cohort export checkpoints; HTTP event ingest, broader reporting/export, webhooks, cleanup proof, and live project certification remain partial.", caps(CapabilityProfiles), "analytics_integration"),
	item("posthog", "PostHog", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed PostHog local-runtime-complete/live-certification-pending profile puller using GET /api/projects/{project_id}/persons and next-page checkpoints; capture, query/reporting, webhooks, cleanup proof, and live project certification remain partial.", caps(CapabilityProfiles), "analytics_integration"),
	item("heap", "Heap", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Heap canonical profile/event ingest foundation; track, export, segment, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("hotjar", "Hotjar", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Hotjar canonical profile/event ingest foundation; survey, feedback, events, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("fullstory", "FullStory", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed FullStory canonical profile/event ingest foundation; server API, export, and signed webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("plausible", "Plausible", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Plausible canonical profile/event ingest foundation; Events, Stats, and Sites API adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("fathom-analytics", "Fathom Analytics", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Fathom canonical profile/event ingest foundation; sites, events, and report API adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("matomo", "Matomo", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Matomo canonical profile/event ingest foundation; Tracking and Reporting API adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("adobe-analytics", "Adobe Analytics", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Adobe Analytics canonical profile/event ingest foundation; Analytics 2.0 reporting adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("looker-studio", "Looker Studio", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Looker Studio canonical profile/event ingest foundation; Data Studio API and connector adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("looker", "Looker", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Looker canonical profile/event ingest foundation; query, dashboard, schedule, and model adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("tableau", "Tableau", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Tableau canonical profile/event ingest foundation; REST API, refresh, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("power-bi", "Power BI", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Power BI canonical profile/event ingest foundation; REST API, refresh, and reporting adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("mode", "Mode", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Mode canonical profile/event ingest foundation; report, run, schedule, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("metabase", "Metabase", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Metabase canonical profile/event ingest foundation; question, dashboard, database, and collection adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("sisense", "Sisense", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Sisense canonical profile/event ingest foundation; dashboard, widget, datamodel, and job adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("kissmetrics", "Kissmetrics", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Kissmetrics canonical profile/event ingest foundation; workflow/API and reporting adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("woopra", "Woopra", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Woopra canonical profile/event ingest foundation; tracking, profile, journey, and trigger adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("chartmogul", "ChartMogul", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed ChartMogul canonical profile/event ingest foundation; customer, subscription, metrics, and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("baremetrics", "Baremetrics", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Baremetrics canonical profile/event ingest foundation; source, customer, subscription, and metrics adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("profitwell", "ProfitWell", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed ProfitWell canonical profile/event ingest foundation; Paddle/ProfitWell metrics and webhook adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("triple-whale", "Triple Whale", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Triple Whale local-runtime-complete/live-certification-pending profile puller using customer pages and triplewhale: checkpoints; attribution metrics, order/reporting, webhooks, cleanup proof, and live account certification remain partial.", caps(CapabilityProfiles), "analytics_integration"),
	item("northbeam", "Northbeam", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Northbeam canonical profile/event ingest foundation; orders, spend, and data-export adapters remain partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("daasity", "Daasity", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Daasity canonical profile/event ingest foundation; source, model, report, and export adapters remain gated or partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("glew", "Glew", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Glew canonical profile/event ingest foundation; public API, commerce metric, and export adapters remain gated or partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),
	item("peel-insights", "Peel Insights", "analytics", BadgeNative, RuntimePartial, "6-12", "Managed Peel Insights canonical profile/event ingest foundation; public API and reporting adapters remain gated or partial.", caps(CapabilityProfiles, CapabilityEvents), "analytics_integration"),

	item("s3", "Amazon S3", "warehouse", BadgeNative, RuntimeDelegated, "0-1", "Warehouse export/import handoff through Moosewave's configured S3-compatible storage adapter; tenant-bucket delivery remains driver-gated.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("r2", "Cloudflare R2", "warehouse", BadgeNative, RuntimeDelegated, "3-6", "Warehouse export/import handoff through Moosewave's configured R2/S3-compatible storage adapter; tenant-bucket delivery remains driver-gated.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("bigquery", "BigQuery", "warehouse", BadgeNative, RuntimePartial, "3-6", "Managed BigQuery control plane with auditable manifests; REST jobs/load execution remains provider-driver work.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("snowflake", "Snowflake", "warehouse", BadgeNative, RuntimePartial, "3-6", "Local-runtime-complete/live-certification-pending Snowflake warehouse export and health slice with auditable manifests, JSONL artifacts, ordered DDL/COPY/query plans, linked SQL executor, dry-run guards, run history, and local cleanup acknowledgment; remote import materialization, schema discovery, Snowflake-side cleanup proof, and live account certification remain outside the implemented slice.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("redshift", "Redshift", "warehouse", BadgeNative, RuntimePartial, "3-6", "Managed Redshift control plane with auditable manifests; Data API/COPY/UNLOAD execution remains provider-driver work.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("postgres", "Postgres", "warehouse", BadgeNative, RuntimePartial, "3-6", "Managed Postgres control plane with auditable manifests; direct COPY/database execution remains provider-driver work.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("databricks", "Databricks", "warehouse", BadgeNative, RuntimePartial, "3-6", "Managed Databricks control plane with auditable manifests; Statement Execution and lakehouse loading remain provider-driver work.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),
	item("azure-blob", "Azure Blob Storage", "warehouse", BadgePlanned, RuntimePlanned, "6-12", "Planned Azure Blob warehouse export/import listing; native Blob REST driver is not shipped.", caps(CapabilityWarehouseExport, CapabilityWarehouseImport, CapabilityProfiles, CapabilityEvents), "warehouse"),

	item("outbound-webhooks", "Outbound webhooks", "developer_tools", BadgeWebhook, RuntimeDelegated, "0-1", "Send signed subscriber, list, campaign, commerce, and audit events to your app.", caps(CapabilityEvents, CapabilityAutomationTriggers), "outbound_webhooks"),
	item("inbound-webhooks", "Inbound webhooks", "developer_tools", BadgeWebhook, RuntimeDelegated, "0-1", "Receive signed profile, event, list, and automation-trigger payloads.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "inbound_webhooks"),
	item("zapier", "Zapier", "developer_tools", BadgeZapier, RuntimeDelegated, "0-1", "Public Zapier package and recipes for broad app coverage.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilityAutomationTriggers), "zapier_package"),
	item("make", "Make", "developer_tools", BadgeWebhook, RuntimeDelegated, "1-3", "Bridge apps through Make scenarios powered by webhooks and API keys.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "bridge"),
	item("n8n", "n8n", "developer_tools", BadgeWebhook, RuntimeDelegated, "1-3", "Bridge apps through n8n workflows powered by webhooks and API keys.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "bridge"),
	item("pipedream", "Pipedream", "developer_tools", BadgeWebhook, RuntimeDelegated, "1-3", "Bridge apps through Pipedream components powered by webhooks and API keys.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "bridge"),
	item("mcp", "Model Context Protocol", "developer_tools", BadgePlanned, RuntimePlanned, "0-1", "Release-held MCP source candidate for unsupported private evaluation; no public distribution, setup lifecycle, capability availability, or governed-write guarantee is published.", caps(), "mcp"),
	item("openapi", "OpenAPI", "developer_tools", BadgeAPISDK, RuntimeAvailable, "0-1", "Use the canonical OpenAPI surface for custom integrations.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "developer_marketplace"),
	item("typescript-sdk", "TypeScript SDK", "developer_tools", BadgeAPISDK, RuntimeAvailable, "0-1", "Build custom apps with the Moosewave TypeScript SDK.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments), "sdk"),
	item("python-sdk", "Python SDK", "developer_tools", BadgeAPISDK, RuntimeAvailable, "0-1", "Build custom apps and data jobs with the Moosewave Python SDK.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments), "sdk"),
	item("php-sdk", "PHP SDK", "developer_tools", BadgeAPISDK, RuntimeAvailable, "0-1", "Build CMS and commerce plugins with the Moosewave PHP SDK.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists), "sdk"),
	item("developer-marketplace", "Developer marketplace", "developer_tools", BadgeNative, RuntimeDelegated, "0-1", "Register OAuth apps, partner listings, app webhooks, and test accounts.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments), "developer_marketplace"),

	item("slack", "Slack", "messaging", BadgeNative, RuntimeDelegated, "0-1", "Send operator alerts and workflow notifications to Slack.", caps(CapabilityEvents, CapabilityAutomationTriggers), "slack"),
	item("discord", "Discord", "messaging", BadgeNative, RuntimeDelegated, "0-1", "Send operator alerts and workflow notifications to Discord.", caps(CapabilityEvents, CapabilityAutomationTriggers), "discord"),
	item("microsoft-teams", "Microsoft Teams", "messaging", BadgeNative, RuntimeDelegated, "0-1", "Send operator alerts and workflow notifications to Teams.", caps(CapabilityEvents, CapabilityAutomationTriggers), "teams"),
	item("canva", "Canva", "content", BadgeZapier, RuntimeDelegated, "0-1", "Move creative assets through bridge recipes.", caps(CapabilityEvents), "bridge"),
	item("eventbrite", "Eventbrite", "events", BadgeZapier, RuntimeDelegated, "3-6", "Sync attendee and registration events through bridge recipes.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists), "bridge"),
	item("calendly", "Calendly", "scheduling", BadgeZapier, RuntimeDelegated, "3-6", "Trigger automations from booked meetings through bridge recipes.", caps(CapabilityProfiles, CapabilityEvents, CapabilityAutomationTriggers), "bridge"),

	item("postmark", "Postmark", "sending", BadgeNative, RuntimePartial, "0-1", "Partial Postmark foundation: server/message-stream provisioning and deliverability ingestion exist, while campaign sending still routes through Listmonk/SMTP and the direct Postmark Email API driver remains unverified.", caps(CapabilityEvents), "sending"),
	item("ses", "Amazon SES", "sending", BadgeNative, RuntimePartial, "0-1", "Partial SES foundation: transactional SES mailer and SNS deliverability ingestion exist, while tenant campaign sending and provider setup remain delegated to the existing send loop and AWS configuration.", caps(CapabilityEvents), "sending"),
	item("sendgrid", "SendGrid", "sending", BadgeNative, RuntimePartial, "0-1", "Partial SendGrid foundation: deliverability event ingestion exists, while Mail Send API delivery and official ECDSA webhook verification remain provider-driver work.", caps(CapabilityEvents), "sending"),
	item("mailgun", "Mailgun", "sending", BadgeNative, RuntimePartial, "0-1", "Partial Mailgun foundation: signed event webhook ingestion exists, while Messages API sending, domain setup, and provider-side lifecycle remain provider-driver work.", caps(CapabilityEvents), "sending"),
	item("smtp", "SMTP", "sending", BadgeNative, RuntimeDelegated, "0-1", "Delegated SMTP sending through the Listmonk messenger/send-loop surface; tenant-visible SMTP credential lifecycle is not a standalone native provider yet.", caps(CapabilityEvents), "sending"),

	item("twilio", "Twilio", "sms", BadgePlanned, RuntimePlanned, "0-1", "Release-held SMS provider surface. Live sends, A2P effects, end-to-end MMS, and hosted multi-tenant callback/credential ownership are unavailable until durable reconciliation, financial settlement, and a tenant-bound provider-vault runtime are deployed.", caps(), "sms"),
	item("telnyx", "Telnyx", "sms", BadgePlanned, RuntimePlanned, "0-1", "Release-held SMS provider surface. Live sends, A2P effects, end-to-end MMS, and hosted multi-tenant callback/credential ownership are unavailable until durable reconciliation, financial settlement, and a tenant-bound provider-vault runtime are deployed.", caps(), "sms"),
	item("bandwidth", "Bandwidth", "sms", BadgePlanned, RuntimePlanned, "0-1", "Release-held SMS provider surface. Live sends, A2P effects, end-to-end MMS, and hosted multi-tenant callback/credential ownership are unavailable until durable reconciliation, financial settlement, and a tenant-bound provider-vault runtime are deployed.", caps(), "sms"),

	item("klaviyo", "Klaviyo", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Klaviyo connector foundation separated from the migration tile: provider-row credential refs, managed public-app OAuth install/refresh/revoke, row-preserving pause/disconnect, provider-cleanup guidance plus local acknowledgement, marketing_sync_runs, marketing_webhook_events, native JSON:API profile/list/segment/source-event pulls, signed Klaviyo system-webhook receipt, managed Klaviyo Webhooks API subscription reconciliation/cleanup for allowlisted credentials, versioned klaviyo_native cursors, scheduled provider-row polling, and no-create integration-writeback for existing-profile properties, list adds, and custom events are attached; OAuth live certification, Webhooks API live allowlist certification, writeback live certification, provider-side cleanup certification, and live account certification remain required before promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("mailchimp", "Mailchimp", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Mailchimp provider-row foundation with credential refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and mailchimp_handoff delegated import/source-archive cursor evidence; Mailchimp OAuth/public app certification, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("activecampaign", "ActiveCampaign", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native ActiveCampaign provider-row foundation with credential refs, required account API URL, marketing_sync_runs, row-preserving pause/disconnect, provider-cleanup guidance, and activecampaign_handoff delegated API v3 import plus changed-contact source-event cursor evidence; native webhooks, writeback, cleanup automation, OAuth/public app install, and live account certification remain required before promotion.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("customerio", "Customer.io", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Customer.io provider-row foundation with App API credential refs, US/EU region plus workspace evidence, row-preserving pause/disconnect, marketing_sync_runs, and customerio_handoff delegated full-snapshot import cursors; workflow definitions remain rebuild evidence rather than executable automation triggers. Track API writeback, native webhooks, cleanup automation, and live workspace certification remain required before promotion. Customer.io migration source-event polling is intentionally unsupported.", caps(CapabilityProfiles, CapabilitySegments), "marketing_integration"),
	item("brevo", "Brevo", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Brevo provider-row foundation with API-key credential refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and brevo_handoff delegated contacts/lists/segments/campaign import cursor evidence; source-event polling, native webhooks, writeback, suppression mirror, cleanup automation, and live workspace certification remain required before promotion.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("convertkit", "ConvertKit", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native ConvertKit/Kit provider-row foundation with OAuth/API-secret credential refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and convertkit_handoff delegated subscriber/tag/segment/sequence/broadcast import cursor evidence; source-event polling, native webhooks, token refresh/revoke certification, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("substack", "Substack", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Substack provider-row foundation with export-bundle credential refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and substack_handoff delegated ZIP/CSV subscriber, post-archive, aggregate-stat, and parity-evidence cursors. Signup dates are not consent; paid tiers are metadata, not Stripe/Apple billing objects. Native provider API, source-event polling, webhooks, writeback, cleanup automation, billing continuity, and live publication validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("beehiiv", "beehiiv", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native beehiiv provider-row foundation with API-key credential refs, exact workspace/publication binding evidence, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and beehiiv_handoff cursor evidence. The delegated API v2 path imports subscribers/custom fields, exact newsletter-list and frozen-segment memberships, condition-set definitions, rebuild-only automation/email metadata, non-replayed automation journey history, eligible sent-post archive/reports, and premium-membership metadata; multi-publication workspaces require an explicit publication ID because no chooser exists. Stripe billing objects or continuity, executable segment rules or automations, native webhooks, source-event polling, writeback, cleanup automation, and live publication certification are not provided.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments), "marketing_integration"),
	item("mailerlite", "MailerLite", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native MailerLite provider-row foundation with API-key credential refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and mailerlite_handoff delegated Connect API subscriber/group/segment/automation/campaign cursor evidence; native webhooks, source-event polling, writeback, cleanup automation, and live workspace certification remain required before promotion.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "marketing_integration"),
	item("sendy", "Sendy", "marketing", BadgeNative, RuntimePartial, "0-1", "Managed native Sendy provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and sendy_handoff delegated subscriber CSV cursor evidence; provider API export, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("constant-contact", "Constant Contact", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native Constant Contact provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and constant-contact_handoff delegated contact CSV cursor evidence; OAuth/API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("aweber", "AWeber", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native AWeber provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and aweber_handoff delegated subscriber CSV cursor evidence; OAuth/API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("drip", "Drip", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native Drip provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and drip_handoff delegated people CSV cursor evidence; API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("campaign-monitor", "Campaign Monitor", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native Campaign Monitor provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and campaign-monitor_handoff delegated subscriber CSV cursor evidence; API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("omnisend", "Omnisend", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native Omnisend provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and omnisend_handoff delegated contact CSV cursor evidence; API import, native webhooks, source-event polling, writeback, cleanup automation, and live store validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments), "marketing_integration"),
	item("loops", "Loops", "marketing", BadgeNative, RuntimePartial, "3-6", "Managed native Loops provider-row foundation with CSV-export bundle refs, row-preserving pause/disconnect, provider-cleanup guidance, marketing_sync_runs, and loops_handoff delegated contact CSV cursor evidence; API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain required before promotion.", caps(CapabilityProfiles, CapabilityLists), "marketing_integration"),
	item("klaviyo-migration", "Klaviyo migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "API-backed Klaviyo migration-to-live source for profiles, lists, segments, flows, campaigns, templates, source archives, and incremental profile source events; managed provider-row lifecycle, public-app OAuth, native-provider Webhooks API live certification, and writeback live certification belong to the separate native row.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "migration"),
	item("mailchimp-migration", "Mailchimp migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "API/OAuth-backed Mailchimp migration source for audiences, tags, groups, automations, campaigns, templates, reports, forms, landing pages, ecommerce source archives, and rebuild tasks; native provider-row lifecycle, source-event polling, native webhooks, and writeback remain separate partial work.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "migration"),
	item("convertkit-migration", "ConvertKit migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import subscribers, tags, segments, sequences, broadcasts, forms, landing-page context, and optional Stripe Connect paid-subscription evidence from ConvertKit/Kit.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "migration"),
	item("substack-migration", "Substack migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import a conservative subscriber snapshot, tier/status provenance, email-sent post archive, aggregate delivery/open evidence, and explicit consent/billing/ecosystem parity records from the official Substack ZIP or subscriber CSV. Live Stripe/Apple billing and destination entitlements are not migrated.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("beehiiv-migration", "beehiiv migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import subscribers/custom fields, exact newsletter-list and frozen-segment memberships, condition-set definitions, rebuild-only automation/email metadata, non-replayed automation journey history, eligible sent-post archive/reports, premium-membership metadata, and source-archive review evidence from one exactly bound beehiiv API v2 publication. Multi-publication workspaces require an explicit publication ID. Stripe billing objects or continuity and executable segment or automation behavior are not migrated; cutover requires a frozen-source final delta, source-automation retirement plus final journey evidence, strict shadow/pilot parity, and live publication certification.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments), "migration"),
	item("mailerlite-migration", "MailerLite migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Assisted-beta Connect API import for authoritative subscriber status, portable opted_in_at evidence, custom-field definitions and values, exact group tags/tag-backed segments, saved-segment and automation rebuild definitions, sent campaign metadata/plain text/email variants/preview references with aggregate reports, and draft/ready campaign, form, and ecommerce-shop source evidence. MailerLite does not expose saved-segment predicates, rendered campaign HTML, reusable templates, sites/landing-page inventory, or a token-to-account identity endpoint; native webhooks, source-event polling/final delta, writeback, provider cleanup automation, and live workspace certification remain absent.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments), "migration"),
	item("activecampaign-migration", "ActiveCampaign migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "API-backed ActiveCampaign migration-to-live source for contacts, lists, tags, segments, automation rebuild evidence, campaigns, forms, deals/source archives, and incremental changed-contact source events.", caps(CapabilityProfiles, CapabilityEvents, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "migration"),
	item("brevo-migration", "Brevo migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import Brevo contacts, lists, saved segments, automations, and sent email campaign archive through the migration adapter; templates, SMS/WhatsApp, native webhooks, and suppression mirror remain future work.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments, CapabilityAutomationTriggers), "migration"),
	item("customerio-migration", "Customer.io migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import one bound Customer.io App API workspace: email-addressable profiles by immutable cio_id, conservative global/email-channel/topic status, ESP suppressions, frozen segment/topic membership, exact-source Design Studio HTML templates, and eligible sent email newsletters. Email is enabled only when global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default; portable consent is not inferred. Sent-newsletter history requires at least one explicit language=\"\" default and provably composable source HTML; the lowest stable content ID represents a multi-default/A-B set with an explicit warning, translations are never silently selected, and neither newsletter nor Design Studio HTML is provider-rendered output. Campaigns, API broadcasts, transactional/non-email definitions, sender-specific SMS/WhatsApp /v1/optouts, object-type metadata, and ecosystem gaps are retained as rebuild/review evidence; /v1/optouts is separate from subscription-center channel preferences, and no source-event feed, Track API writeback, automation trigger, or executable workflow/custom-object migration is claimed.", caps(CapabilityProfiles, CapabilitySegments), "migration"),
	item("sendy-migration", "Sendy migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "0-1", "Import subscribers, consent state, and list evidence from Sendy CSV exports.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("csv", "CSV import", "migrations", BadgeNative, RuntimeAvailable, "0-1", "Import subscribers, attributes, and opt-in state from CSV.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("constant-contact-migration", "Constant Contact migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Constant Contact contact CSV exports into Moosewave profiles and lists.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("aweber-migration", "AWeber migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload AWeber subscriber CSV exports into Moosewave profiles and lists.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("drip-migration", "Drip migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Drip people CSV exports into Moosewave profiles and tags.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("campaign-monitor-migration", "Campaign Monitor migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Campaign Monitor subscriber CSV exports into Moosewave profiles and lists.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("omnisend-migration", "Omnisend migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Omnisend contact CSV exports into Moosewave profiles and segments.", caps(CapabilityProfiles, CapabilityLists, CapabilitySegments), "migration"),
	item("loops-migration", "Loops migration", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Loops contact CSV exports into Moosewave profiles and lists.", caps(CapabilityProfiles, CapabilityLists), "migration"),
	item("flodesk", "Flodesk", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Flodesk subscriber CSV exports into Moosewave profiles.", caps(CapabilityProfiles), "migration"),
	item("bento", "Bento", "migrations", BadgeMigrationOnly, RuntimeAvailable, "3-6", "Upload Bento people CSV exports into Moosewave profiles.", caps(CapabilityProfiles), "migration"),
}
