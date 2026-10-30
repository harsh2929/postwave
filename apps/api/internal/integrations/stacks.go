// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import "sort"

const targetStackCoveragePercent = 90

type StackReport struct {
	SchemaVersion        string                  `json:"schema_version"`
	TargetCoveragePct    int                     `json:"target_coverage_pct"`
	CoveredPct           int                     `json:"covered_pct"`
	CoveredStacks        int                     `json:"covered_stacks"`
	TotalStacks          int                     `json:"total_stacks"`
	Summary              map[string]int          `json:"summary"`
	Stacks               []CustomerStackCoverage `json:"stacks"`
	HighestImpactGaps    []StackGap              `json:"highest_impact_gaps"`
	NewsletterCommerceOK bool                    `json:"newsletter_commerce_ok"`
}

type CustomerStackCoverage struct {
	Key             string           `json:"key"`
	Name            string           `json:"name"`
	Segment         string           `json:"segment"`
	Summary         string           `json:"summary"`
	Status          string           `json:"status"`
	CoveragePct     int              `json:"coverage_pct"`
	RequiredCovered int              `json:"required_covered"`
	RequiredTotal   int              `json:"required_total"`
	OptionalCovered int              `json:"optional_covered"`
	OptionalTotal   int              `json:"optional_total"`
	NativeManaged   int              `json:"native_managed"`
	BridgeReady     int              `json:"bridge_ready"`
	PlannedGaps     []string         `json:"planned_gaps,omitempty"`
	Components      []StackComponent `json:"components"`
	NextActions     []string         `json:"next_actions"`
}

type StackComponent struct {
	Slug            string `json:"slug"`
	Name            string `json:"name"`
	Role            string `json:"role"`
	Required        bool   `json:"required"`
	Category        string `json:"category"`
	Badge           Badge  `json:"badge"`
	RuntimeStatus   string `json:"runtime_status"`
	Available       bool   `json:"available"`
	NativeManaged   bool   `json:"native_managed"`
	BridgeAvailable bool   `json:"bridge_available"`
	SetupPath       string `json:"setup_path,omitempty"`
	Reason          string `json:"reason"`
}

type StackGap struct {
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	Stacks        int    `json:"stacks"`
	RequiredCount int    `json:"required_count"`
	Reason        string `json:"reason"`
}

type stackDefinition struct {
	Key          string
	Name         string
	Segment      string
	Summary      string
	Requirements []stackRequirement
}

type stackRequirement struct {
	Slug     string
	Role     string
	Required bool
}

func StackCoverage() StackReport {
	items := CatalogItems()
	return StackCoverageForItems(items, AllRecipesForItems(items))
}

func StackCoverageForItems(items []CatalogItem, recipes []Recipe) StackReport {
	itemBySlug := make(map[string]CatalogItem, len(items))
	for _, item := range items {
		itemBySlug[item.Slug] = item
	}
	recipeBySource := map[string]int{}
	for _, recipe := range recipes {
		if recipe.Available {
			recipeBySource[recipe.SourceSlug]++
		}
	}

	report := StackReport{
		SchemaVersion:     "2026-06.integrations.stacks.v1",
		TargetCoveragePct: targetStackCoveragePercent,
		TotalStacks:       len(customerStackDefinitions),
		Summary:           map[string]int{},
	}
	gaps := map[string]*StackGap{}
	for _, def := range customerStackDefinitions {
		stack := evaluateStack(def, itemBySlug, recipeBySource, gaps)
		report.Stacks = append(report.Stacks, stack)
		report.Summary["status:"+stack.Status]++
		report.Summary["segment:"+stack.Segment]++
		if stack.Status == "covered" || stack.Status == "ready" {
			report.CoveredStacks++
		}
	}
	sort.SliceStable(report.Stacks, func(i, j int) bool {
		if report.Stacks[i].Status != report.Stacks[j].Status {
			return stackStatusRank(report.Stacks[i].Status) < stackStatusRank(report.Stacks[j].Status)
		}
		return report.Stacks[i].Name < report.Stacks[j].Name
	})

	report.CoveredPct = percent(report.CoveredStacks, report.TotalStacks)
	report.NewsletterCommerceOK = report.CoveredPct >= targetStackCoveragePercent
	report.HighestImpactGaps = stackGaps(gaps)
	return report
}

func evaluateStack(def stackDefinition, itemBySlug map[string]CatalogItem, recipeBySource map[string]int, gaps map[string]*StackGap) CustomerStackCoverage {
	stack := CustomerStackCoverage{
		Key:     def.Key,
		Name:    def.Name,
		Segment: def.Segment,
		Summary: def.Summary,
	}
	for _, req := range def.Requirements {
		item, ok := itemBySlug[req.Slug]
		if !ok {
			component := StackComponent{
				Slug:      req.Slug,
				Name:      req.Slug,
				Role:      req.Role,
				Required:  req.Required,
				Available: false,
				Reason:    "Catalog entry is missing.",
			}
			stack.Components = append(stack.Components, component)
			if req.Required {
				stack.RequiredTotal++
				recordStackGap(gaps, req.Slug, req.Slug, true, "Missing catalog entry.")
			} else {
				stack.OptionalTotal++
			}
			continue
		}
		nativeManaged := isNativeManaged(item)
		bridgeAvailable := isBridgeReady(item) || recipeBySource[item.Slug] > 0
		available := nativeManaged || bridgeAvailable || (item.Badge == BadgeMigrationOnly && item.RuntimeStatus != RuntimePlanned)
		component := StackComponent{
			Slug:            item.Slug,
			Name:            item.Name,
			Role:            req.Role,
			Required:        req.Required,
			Category:        item.Category,
			Badge:           item.Badge,
			RuntimeStatus:   string(item.RuntimeStatus),
			Available:       available,
			NativeManaged:   nativeManaged,
			BridgeAvailable: bridgeAvailable,
			SetupPath:       item.SetupPath,
			Reason:          stackComponentReason(item, available, nativeManaged, bridgeAvailable),
		}
		if nativeManaged {
			stack.NativeManaged++
		}
		if bridgeAvailable {
			stack.BridgeReady++
		}
		if req.Required {
			stack.RequiredTotal++
			if available {
				stack.RequiredCovered++
			} else {
				recordStackGap(gaps, item.Slug, item.Name, true, gapReason(item))
			}
		} else {
			stack.OptionalTotal++
			if available {
				stack.OptionalCovered++
			} else if item.RuntimeStatus == RuntimePlanned {
				stack.PlannedGaps = append(stack.PlannedGaps, item.Slug)
				recordStackGap(gaps, item.Slug, item.Name, false, gapReason(item))
			}
		}
		stack.Components = append(stack.Components, component)
	}
	stack.CoveragePct = percent(stack.RequiredCovered, stack.RequiredTotal)
	stack.Status = stackStatus(stack)
	stack.NextActions = stackNextActions(stack)
	return stack
}

func stackComponentReason(item CatalogItem, available, nativeManaged, bridgeAvailable bool) string {
	switch {
	case isNativeVerified(item):
		return "Verified native Moosewave-managed connector is available."
	case nativeManaged && item.RuntimeStatus == RuntimePartial:
		return "Native Moosewave-managed foundation is cataloged; provider API verification remains pending."
	case nativeManaged:
		return "Native Moosewave-managed connector is available."
	case bridgeAvailable:
		return "Covered through bridge, webhook, API, or recipe path."
	case item.RuntimeStatus == RuntimePlanned:
		return "Planned connector without an available bridge recipe."
	case available:
		return "Available through migration or setup surface."
	default:
		return "Catalog-visible but not ready for this stack."
	}
}

func gapReason(item CatalogItem) string {
	if item.RuntimeStatus == RuntimePlanned {
		return "Native connector is planned and no ready bridge recipe covers this requirement."
	}
	return "Connector needs a managed or bridge-ready implementation."
}

func recordStackGap(gaps map[string]*StackGap, slug, name string, required bool, reason string) {
	gap := gaps[slug]
	if gap == nil {
		gap = &StackGap{Slug: slug, Name: name, Reason: reason}
		gaps[slug] = gap
	}
	gap.Stacks++
	if required {
		gap.RequiredCount++
	}
}

func stackGaps(gaps map[string]*StackGap) []StackGap {
	out := make([]StackGap, 0, len(gaps))
	for _, gap := range gaps {
		out = append(out, *gap)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].RequiredCount != out[j].RequiredCount {
			return out[i].RequiredCount > out[j].RequiredCount
		}
		if out[i].Stacks != out[j].Stacks {
			return out[i].Stacks > out[j].Stacks
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

func stackStatus(stack CustomerStackCoverage) string {
	switch {
	case stack.RequiredTotal == 0:
		return "empty"
	case stack.RequiredCovered == stack.RequiredTotal && len(stack.PlannedGaps) == 0:
		return "ready"
	case stack.RequiredCovered == stack.RequiredTotal:
		return "covered"
	case stack.RequiredCovered*2 >= stack.RequiredTotal:
		return "partial"
	default:
		return "gap"
	}
}

func stackStatusRank(status string) int {
	switch status {
	case "gap":
		return 0
	case "partial":
		return 1
	case "covered":
		return 2
	case "ready":
		return 3
	default:
		return 9
	}
}

func stackNextActions(stack CustomerStackCoverage) []string {
	if stack.Status == "ready" {
		return []string{"Maintain connector health and keep recipes certified."}
	}
	out := []string{}
	for _, component := range stack.Components {
		if component.Required && !component.Available {
			out = append(out, "Ship native or bridge-ready coverage for "+component.Name+".")
		}
	}
	if len(out) == 0 && len(stack.PlannedGaps) > 0 {
		out = append(out, "Promote optional planned gaps into native or certified bridge recipes.")
	}
	if len(out) == 0 {
		out = append(out, "Review stack readiness and partner certification.")
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

func percent(numerator, denominator int) int {
	if denominator <= 0 {
		return 0
	}
	return (numerator*100 + denominator/2) / denominator
}

var customerStackDefinitions = []stackDefinition{
	{
		Key:     "dtc_shopify_growth",
		Name:    "DTC Shopify growth",
		Segment: "commerce",
		Summary: "The common Shopify newsletter plus commerce growth stack: commerce sync, payments, reviews, support, subscriptions, and paid audiences.",
		Requirements: []stackRequirement{
			{Slug: "shopify", Role: "commerce_source", Required: true},
			{Slug: "stripe", Role: "payments", Required: true},
			{Slug: "meta", Role: "ads_audience", Required: true},
			{Slug: "google-ads", Role: "ads_audience", Required: true},
			{Slug: "gorgias", Role: "support", Required: true},
			{Slug: "klaviyo", Role: "marketing_automation", Required: false},
			{Slug: "yotpo", Role: "reviews", Required: false},
			{Slug: "recharge", Role: "subscriptions", Required: false},
			{Slug: "klaviyo-migration", Role: "migration", Required: false},
		},
	},
	{
		Key:     "creator_newsletter",
		Name:    "Creator newsletter",
		Segment: "newsletter",
		Summary: "Creator, solo publisher, and small media stacks that need forms, CMS capture, payments, events, and newsletter migration.",
		Requirements: []stackRequirement{
			{Slug: "convertkit-migration", Role: "migration", Required: true},
			{Slug: "substack-migration", Role: "migration", Required: true},
			{Slug: "webflow", Role: "site_forms", Required: true},
			{Slug: "typeform", Role: "lead_capture", Required: true},
			{Slug: "stripe", Role: "payments", Required: true},
			{Slug: "zapier", Role: "breadth_bridge", Required: true},
			{Slug: "calendly", Role: "scheduling", Required: false},
			{Slug: "canva", Role: "content", Required: false},
		},
	},
	{
		Key:     "b2b_saas_lifecycle",
		Name:    "B2B SaaS lifecycle",
		Segment: "saas",
		Summary: "SaaS and sales-led newsletter stacks that need CRM, support, product analytics, billing, API, and workspace alerts.",
		Requirements: []stackRequirement{
			{Slug: "hubspot", Role: "crm", Required: true},
			{Slug: "salesforce", Role: "crm_enterprise", Required: false},
			{Slug: "stripe", Role: "billing", Required: true},
			{Slug: "intercom", Role: "support", Required: true},
			{Slug: "segment", Role: "cdp", Required: true},
			{Slug: "openapi", Role: "developer_api", Required: true},
			{Slug: "slack", Role: "alerts", Required: true},
			{Slug: "zendesk", Role: "support_enterprise", Required: false},
		},
	},
	{
		Key:     "commerce_loyalty_reviews",
		Name:    "Commerce loyalty and reviews",
		Segment: "commerce",
		Summary: "Klaviyo-style commerce depth across reviews, loyalty, referrals, subscriptions, shipping, and automations.",
		Requirements: []stackRequirement{
			{Slug: "shopify", Role: "commerce_source", Required: true},
			{Slug: "judge-me", Role: "reviews", Required: true},
			{Slug: "smile", Role: "loyalty", Required: true},
			{Slug: "referralcandy", Role: "referrals", Required: true},
			{Slug: "recharge", Role: "subscriptions", Required: true},
			{Slug: "aftership", Role: "shipping", Required: true},
			{Slug: "klaviyo", Role: "marketing_automation", Required: false},
			{Slug: "shipstation", Role: "fulfillment", Required: false},
			{Slug: "loox", Role: "photo_reviews", Required: false},
		},
	},
	{
		Key:     "data_warehouse_reverse_etl",
		Name:    "Data warehouse and reverse ETL",
		Segment: "data",
		Summary: "Data-mature stacks that need exports, imports, warehouse loading, event streams, API, and webhook delivery.",
		Requirements: []stackRequirement{
			{Slug: "s3", Role: "warehouse_export", Required: true},
			{Slug: "outbound-webhooks", Role: "event_delivery", Required: true},
			{Slug: "inbound-webhooks", Role: "event_ingest", Required: true},
			{Slug: "openapi", Role: "developer_api", Required: true},
			{Slug: "segment", Role: "cdp", Required: true},
			{Slug: "bigquery", Role: "warehouse", Required: false},
			{Slug: "snowflake", Role: "warehouse", Required: false},
			{Slug: "postgres", Role: "operational_db", Required: false},
		},
	},
	{
		Key:     "migration_cutover",
		Name:    "Migration cutover",
		Segment: "migration",
		Summary: "Newsletter migration stacks from legacy ESPs with imports, suppressions, tags, lists, and bridge fallbacks.",
		Requirements: []stackRequirement{
			{Slug: "mailchimp-migration", Role: "migration", Required: true},
			{Slug: "klaviyo-migration", Role: "migration", Required: true},
			{Slug: "csv", Role: "fallback_import", Required: true},
			{Slug: "constant-contact-migration", Role: "migration", Required: false},
			{Slug: "aweber-migration", Role: "migration", Required: false},
			{Slug: "drip-migration", Role: "migration", Required: false},
			{Slug: "omnisend-migration", Role: "migration", Required: false},
			{Slug: "wordpress-subscribers", Role: "subscriber_import", Required: false},
		},
	},
	{
		Key:     "omnichannel_alerts_sms",
		Name:    "Omnichannel alerts and SMS",
		Segment: "messaging",
		Summary: "Messaging stacks that need SMS consent, workspace alerts, and bridge-ready chat/push channels.",
		Requirements: []stackRequirement{
			{Slug: "twilio", Role: "sms", Required: true},
			{Slug: "telnyx", Role: "sms", Required: true},
			{Slug: "slack", Role: "workspace_alerts", Required: true},
			{Slug: "discord", Role: "community_alerts", Required: true},
			{Slug: "microsoft-teams", Role: "workspace_alerts", Required: true},
			{Slug: "whatsapp-business", Role: "chat", Required: false},
			{Slug: "onesignal", Role: "push", Required: false},
			{Slug: "messagebird", Role: "messaging_provider", Required: false},
		},
	},
	{
		Key:     "ads_retargeting_growth",
		Name:    "Ads retargeting growth",
		Segment: "ads",
		Summary: "Paid growth stacks for consent-aware cohort delivery, lead capture, conversion APIs, and bridge recipes.",
		Requirements: []stackRequirement{
			{Slug: "meta", Role: "audience", Required: true},
			{Slug: "google-ads", Role: "audience", Required: true},
			{Slug: "tiktok", Role: "audience", Required: true},
			{Slug: "linkedin", Role: "audience", Required: true},
			{Slug: "facebook-lead-ads", Role: "lead_capture", Required: true},
			{Slug: "linkedin-lead-gen", Role: "lead_capture", Required: false},
			{Slug: "pinterest-ads", Role: "ads", Required: false},
			{Slug: "microsoft-advertising", Role: "ads", Required: false},
		},
	},
	{
		Key:     "agency_multi_client",
		Name:    "Agency multi-client ops",
		Segment: "agency",
		Summary: "Agency stacks that need broad bridges, forms, CMS, reporting, approvals, and developer extensibility across clients.",
		Requirements: []stackRequirement{
			{Slug: "zapier", Role: "breadth_bridge", Required: true},
			{Slug: "make", Role: "breadth_bridge", Required: true},
			{Slug: "google-sheets", Role: "lightweight_crm", Required: true},
			{Slug: "typeform", Role: "lead_capture", Required: true},
			{Slug: "wordpress", Role: "cms", Required: true},
			{Slug: "openapi", Role: "developer_api", Required: true},
			{Slug: "looker-studio", Role: "reporting", Required: false},
			{Slug: "airtable", Role: "client_ops", Required: false},
		},
	},
	{
		Key:     "enterprise_data_compliance",
		Name:    "Enterprise data and compliance",
		Segment: "enterprise",
		Summary: "Enterprise stacks that need CRM, warehouse, support, audit-friendly APIs, SSO-ready developer surfaces, and controlled exports.",
		Requirements: []stackRequirement{
			{Slug: "salesforce", Role: "crm", Required: true},
			{Slug: "zendesk", Role: "support", Required: true},
			{Slug: "s3", Role: "export", Required: true},
			{Slug: "openapi", Role: "developer_api", Required: true},
			{Slug: "developer-marketplace", Role: "oauth_apps", Required: true},
			{Slug: "snowflake", Role: "warehouse", Required: false},
			{Slug: "databricks", Role: "lakehouse", Required: false},
		},
	},
}
