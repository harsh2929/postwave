// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import "sort"

type CoverageReport struct {
	SchemaVersion            string             `json:"schema_version"`
	TargetPublicEntries      int                `json:"target_public_entries"`
	TargetNativeManaged      int                `json:"target_native_managed"`
	TargetNativeVerified     int                `json:"target_native_verified"`
	PublicEntries            int                `json:"public_entries"`
	NativeManaged            int                `json:"native_managed"`
	NativeVerified           int                `json:"native_verified"`
	NativePartial            int                `json:"native_partial"`
	NativeDelegated          int                `json:"native_delegated"`
	PublicGap                int                `json:"public_gap"`
	NativeGap                int                `json:"native_gap"`
	NativeVerificationGap    int                `json:"native_verification_gap"`
	PublicParity             bool               `json:"public_parity"`
	NativeParity             bool               `json:"native_parity"`
	NativeVerificationParity bool               `json:"native_verification_parity"`
	BridgeReady              int                `json:"bridge_ready"`
	Planned                  int                `json:"planned"`
	AvailableRecipes         int                `json:"available_recipes"`
	GeneratedRecipes         int                `json:"generated_recipes"`
	BadgeCounts              map[string]int     `json:"badge_counts"`
	PhaseCounts              map[string]int     `json:"phase_counts"`
	MaturityCounts           map[string]int     `json:"maturity_counts"`
	Categories               []CategoryCoverage `json:"categories"`
	PriorityGaps             []PriorityGap      `json:"priority_gaps"`
}

type CategoryCoverage struct {
	Key              string `json:"key"`
	Label            string `json:"label"`
	Total            int    `json:"total"`
	NativeManaged    int    `json:"native_managed"`
	NativeVerified   int    `json:"native_verified"`
	NativePartial    int    `json:"native_partial"`
	NativeDelegated  int    `json:"native_delegated"`
	BridgeReady      int    `json:"bridge_ready"`
	Planned          int    `json:"planned"`
	AvailableRecipes int    `json:"available_recipes"`
	Maturity         string `json:"maturity"`
}

type PriorityGap struct {
	Slug            string `json:"slug"`
	Name            string `json:"name"`
	Category        string `json:"category"`
	Phase           string `json:"phase,omitempty"`
	CurrentBadge    Badge  `json:"current_badge"`
	RuntimeStatus   string `json:"runtime_status"`
	BridgeAvailable bool   `json:"bridge_available"`
	Reason          string `json:"reason"`
}

func Coverage() CoverageReport {
	items := CatalogItems()
	return CoverageForItems(items, AllRecipesForItems(items))
}

func CoverageForItems(items []CatalogItem, recipes []Recipe) CoverageReport {
	recipeBySource := map[string]int{}
	for _, recipe := range recipes {
		if recipe.Available {
			recipeBySource[recipe.SourceSlug]++
		}
	}

	byCategory := map[string]*CategoryCoverage{}
	for _, category := range Categories() {
		byCategory[category.Key] = &CategoryCoverage{Key: category.Key, Label: category.Label}
	}

	report := CoverageReport{
		SchemaVersion:        "2026-06.integrations.coverage.v1",
		TargetPublicEntries:  targetPublicEntries,
		TargetNativeManaged:  targetNativeManaged,
		TargetNativeVerified: targetNativeManaged,
		PublicEntries:        len(items),
		BadgeCounts:          map[string]int{},
		PhaseCounts:          map[string]int{},
		MaturityCounts:       map[string]int{},
		GeneratedRecipes:     len(recipes) - len(recipeCatalog),
	}
	if report.GeneratedRecipes < 0 {
		report.GeneratedRecipes = 0
	}

	for _, recipe := range recipes {
		if recipe.Available {
			report.AvailableRecipes++
		}
	}

	for _, item := range items {
		bridgeReady := isBridgeReady(item) || recipeBySource[item.Slug] > 0
		report.BadgeCounts[string(item.Badge)]++
		if item.Phase != "" {
			report.PhaseCounts[item.Phase]++
		}
		if isNativeManaged(item) {
			report.NativeManaged++
		}
		if isNativeVerified(item) {
			report.NativeVerified++
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial {
			report.NativePartial++
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimeDelegated {
			report.NativeDelegated++
		}
		if bridgeReady {
			report.BridgeReady++
		}
		if item.RuntimeStatus == RuntimePlanned {
			report.Planned++
		}
		cov, ok := byCategory[item.Category]
		if !ok {
			cov = &CategoryCoverage{Key: item.Category, Label: item.Category}
			byCategory[item.Category] = cov
		}
		cov.Total++
		if isNativeManaged(item) {
			cov.NativeManaged++
		}
		if isNativeVerified(item) {
			cov.NativeVerified++
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimePartial {
			cov.NativePartial++
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimeDelegated {
			cov.NativeDelegated++
		}
		if bridgeReady {
			cov.BridgeReady++
		}
		if item.RuntimeStatus == RuntimePlanned {
			cov.Planned++
		}
		cov.AvailableRecipes += recipeBySource[item.Slug]
	}

	for _, category := range Categories() {
		cov := byCategory[category.Key]
		cov.Maturity = coverageMaturity(*cov)
		report.MaturityCounts[cov.Maturity]++
		report.Categories = append(report.Categories, *cov)
	}
	sort.SliceStable(report.Categories, func(i, j int) bool {
		if report.Categories[i].Maturity != report.Categories[j].Maturity {
			return maturityRank(report.Categories[i].Maturity) < maturityRank(report.Categories[j].Maturity)
		}
		if report.Categories[i].Total != report.Categories[j].Total {
			return report.Categories[i].Total > report.Categories[j].Total
		}
		return report.Categories[i].Label < report.Categories[j].Label
	})

	report.PublicGap = maxInt(0, targetPublicEntries-report.PublicEntries)
	report.NativeGap = maxInt(0, targetNativeManaged-report.NativeManaged)
	report.NativeVerificationGap = maxInt(0, report.TargetNativeVerified-report.NativeVerified)
	report.PublicParity = report.PublicGap == 0
	report.NativeParity = report.NativeGap == 0
	report.NativeVerificationParity = report.NativeVerificationGap == 0
	report.PriorityGaps = priorityGaps(items, recipeBySource)
	return report
}

func isNativeManaged(item CatalogItem) bool {
	return item.Badge == BadgeNative && item.RuntimeStatus != RuntimePlanned
}

func isNativeVerified(item CatalogItem) bool {
	return item.Badge == BadgeNative && item.RuntimeStatus == RuntimeAvailable
}

func isBridgeReady(item CatalogItem) bool {
	return item.RuntimeStatus != RuntimePlanned && (item.RuntimeStatus == RuntimeDelegated || item.Badge == BadgeZapier || item.Badge == BadgeWebhook || item.Badge == BadgeAPISDK || hasSource(item, "bridge") || hasSource(item, "zapier_package"))
}

func coverageMaturity(cov CategoryCoverage) string {
	switch {
	case cov.NativeVerified > 0 && cov.BridgeReady > 0:
		return "verified_hybrid_ready"
	case cov.NativeVerified > 0:
		return "verified_native_ready"
	case cov.NativeManaged > 0 && cov.BridgeReady > 0:
		return "foundation_hybrid_ready"
	case cov.NativeManaged > 0:
		return "foundation_cataloged"
	case cov.BridgeReady > 0:
		return "bridge_ready"
	case cov.Planned > 0 && cov.Total == cov.Planned:
		return "planned_only"
	case cov.Total > 0:
		return "catalog_only"
	default:
		return "empty"
	}
}

func maturityRank(value string) int {
	switch value {
	case "catalog_only":
		return 0
	case "planned_only":
		return 1
	case "bridge_ready":
		return 2
	case "foundation_cataloged":
		return 3
	case "foundation_hybrid_ready":
		return 4
	case "verified_native_ready":
		return 5
	case "verified_hybrid_ready":
		return 6
	default:
		return 9
	}
}

func priorityGaps(items []CatalogItem, recipeBySource map[string]int) []PriorityGap {
	bySlug := map[string]CatalogItem{}
	for _, item := range items {
		bySlug[item.Slug] = item
	}
	out := []PriorityGap{}
	for _, target := range nativePriorityTargets {
		item, ok := bySlug[target.Slug]
		if !ok || isNativeManaged(item) {
			continue
		}
		out = append(out, PriorityGap{
			Slug:            item.Slug,
			Name:            item.Name,
			Category:        item.Category,
			Phase:           item.Phase,
			CurrentBadge:    item.Badge,
			RuntimeStatus:   string(item.RuntimeStatus),
			BridgeAvailable: recipeBySource[item.Slug] > 0 || isBridgeReady(item),
			Reason:          target.Reason,
		})
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

var nativePriorityTargets = []struct {
	Slug   string
	Reason string
}{
	{Slug: "bigcommerce", Reason: "Must-have managed commerce connector for Mailchimp/Klaviyo parity."},
	{Slug: "adobe-commerce", Reason: "Magento and Adobe Commerce connector expected by mid-market commerce teams."},
	{Slug: "hubspot", Reason: "High-demand CRM connector for newsletter plus sales-led stacks."},
	{Slug: "salesforce", Reason: "Enterprise CRM connector expected by larger teams."},
	{Slug: "pipedrive", Reason: "CRM connector expected by SMB sales-led stacks."},
	{Slug: "zoho-crm", Reason: "Common SMB CRM connector expected for Mailchimp parity."},
	{Slug: "microsoft-dynamics-365", Reason: "Enterprise CRM connector expected by Microsoft-heavy organizations."},
	{Slug: "keap", Reason: "Small-business CRM connector expected by creator and service businesses."},
	{Slug: "close", Reason: "Sales-led CRM connector expected by B2B growth teams."},
	{Slug: "copper", Reason: "Google Workspace CRM connector expected by SMB sales teams."},
	{Slug: "freshsales", Reason: "Freshworks CRM connector expected by SMB support and sales stacks."},
	{Slug: "highlevel", Reason: "Agency and local-business CRM connector expected by service businesses."},
	{Slug: "wordpress", Reason: "Core CMS and subscriber capture surface."},
	{Slug: "webflow", Reason: "Core creator and SaaS site lead-capture surface."},
	{Slug: "wix", Reason: "Core small-business website and forms surface."},
	{Slug: "squarespace", Reason: "Core creator website and commerce surface."},
	{Slug: "typeform", Reason: "Common lead-capture form source."},
	{Slug: "jotform", Reason: "Common forms source for SMB lead capture."},
	{Slug: "google-forms", Reason: "Common lightweight lead-capture form source."},
	{Slug: "microsoft-forms", Reason: "Common Microsoft-stack lead-capture form source."},
	{Slug: "surveymonkey", Reason: "Survey and quiz lead source commonly expected in Mailchimp parity."},
	{Slug: "facebook-lead-ads", Reason: "Paid social lead-capture connector expected in Meta acquisition stacks."},
	{Slug: "linkedin-lead-gen", Reason: "B2B paid acquisition teams expect native LinkedIn lead form capture."},
	{Slug: "google-lead-form-extensions", Reason: "Google Ads lead form capture rounds out search and demand-generation stacks."},
	{Slug: "tiktok-lead-generation", Reason: "Creator and DTC acquisition teams expect TikTok instant form capture."},
	{Slug: "snap-lead-ads", Reason: "Mobile-first commerce teams expect Snap lead form capture."},
	{Slug: "reddit-lead-gen", Reason: "Community-led acquisition teams expect Reddit lead form capture."},
	{Slug: "pinterest-lead-ads", Reason: "Visual commerce acquisition teams expect Pinterest lead form capture."},
	{Slug: "unbounce", Reason: "Landing-page lead capture source expected by growth teams."},
	{Slug: "leadpages", Reason: "Landing-page lead capture source expected by creators and SMBs."},
	{Slug: "instapage", Reason: "Conversion landing-page connector expected by paid acquisition teams."},
	{Slug: "carrd", Reason: "Lightweight landing-page form capture source common in creator stacks."},
	{Slug: "paperform", Reason: "Modern form builder expected in no-code lead capture stacks."},
	{Slug: "formstack", Reason: "Business form builder expected in mid-market lead capture stacks."},
	{Slug: "fillout", Reason: "Modern form source increasingly common in product-led and no-code stacks."},
	{Slug: "optinmonster", Reason: "Popup and onsite conversion capture connector expected by SMB growth teams."},
	{Slug: "privy", Reason: "Commerce popup and coupon capture connector expected by Shopify-adjacent stacks."},
	{Slug: "convertflow", Reason: "Onsite CTA and segmentation capture connector expected by growth teams."},
	{Slug: "sleeknote", Reason: "Onsite campaign capture connector expected by ecommerce marketers."},
	{Slug: "wisepops", Reason: "Onsite popup and personalization capture connector expected by DTC teams."},
	{Slug: "poptin", Reason: "Popup and embedded form capture source expected by SMB sites."},
	{Slug: "hello-bar", Reason: "Top-bar and popup capture connector expected by creator and SMB sites."},
	{Slug: "unstack", Reason: "No-code site and form capture connector expected by startup teams."},
	{Slug: "landingi", Reason: "Landing-page lead capture connector expected by performance marketers."},
	{Slug: "kickofflabs", Reason: "Referral campaign lead capture connector expected by launch and giveaway stacks."},
	{Slug: "shortstack", Reason: "Contest and giveaway lead capture connector expected by campaign marketers."},
	{Slug: "formsite", Reason: "Established hosted form builder expected in long-tail SMB stacks."},
	{Slug: "cognito-forms", Reason: "Business form builder expected by operations-heavy SMB teams."},
	{Slug: "ninja-forms", Reason: "WordPress form source expected alongside Gravity Forms and WPForms."},
	{Slug: "formidable-forms", Reason: "WordPress form source expected by advanced WordPress sites."},
	{Slug: "interact", Reason: "Quiz and assessment lead source expected in creator and ecommerce stacks."},
	{Slug: "outgrow", Reason: "Calculator and quiz lead source expected by performance marketers."},
	{Slug: "riddle", Reason: "Quiz and poll lead capture source expected in publisher and creator stacks."},
	{Slug: "qualtrics-forms", Reason: "Enterprise survey and form source expected by larger teams."},
	{Slug: "feathery", Reason: "Modern product-led form source expected by SaaS teams."},
	{Slug: "formaloo", Reason: "No-code form and app source expected in SMB lead capture stacks."},
	{Slug: "123formbuilder", Reason: "Long-tail form builder expected for Mailchimp-style breadth parity."},
	{Slug: "tally", Reason: "Lightweight form source increasingly common in creator and SaaS lead capture."},
	{Slug: "gravity-forms", Reason: "WordPress form source expected in newsletter migrations."},
	{Slug: "wpforms", Reason: "WordPress form source expected by creator and SMB sites."},
	{Slug: "databricks", Reason: "Enterprise lakehouse connector expected by larger data teams."},
	{Slug: "zendesk", Reason: "Support context connector for customer lifecycle segmentation."},
	{Slug: "intercom", Reason: "Support and lifecycle messaging context connector."},
	{Slug: "gorgias", Reason: "Commerce helpdesk connector expected in Shopify stacks."},
	{Slug: "freshdesk", Reason: "SMB support connector expected by commerce and SaaS customer stacks."},
	{Slug: "help-scout", Reason: "Common support inbox for creator, SaaS, and commerce teams."},
	{Slug: "front", Reason: "Shared-inbox connector expected by sales-led and support-led teams."},
	{Slug: "zoho-desk", Reason: "Support connector expected by Zoho CRM and SMB stacks."},
	{Slug: "kustomer", Reason: "Customer-service CRM connector expected by support-led commerce teams."},
	{Slug: "freshchat", Reason: "Freshworks chat connector expected alongside Freshdesk."},
	{Slug: "livechat", Reason: "Common live-chat source for support and sales conversations."},
	{Slug: "crisp", Reason: "SMB live-chat and inbox source expected by SaaS and creator teams."},
	{Slug: "tidio", Reason: "Popular chat and automation support source for SMB commerce."},
	{Slug: "olark", Reason: "Established live-chat transcript source expected for long-tail support parity."},
	{Slug: "drift", Reason: "Conversational marketing and support connector expected by B2B teams."},
	{Slug: "ada", Reason: "AI support handoff connector expected by larger support teams."},
	{Slug: "gladly", Reason: "Enterprise customer-service connector expected by retail support teams."},
	{Slug: "reamaze", Reason: "Commerce support inbox connector expected by Shopify-adjacent brands."},
	{Slug: "groove", Reason: "Shared support inbox connector expected by SMB SaaS teams."},
	{Slug: "kayako", Reason: "Support case connector expected in legacy helpdesk migrations."},
	{Slug: "helpcrunch", Reason: "Chat and support inbox connector expected in SMB lifecycle stacks."},
	{Slug: "hubspot-service-hub", Reason: "HubSpot support connector expected by CRM-led teams."},
	{Slug: "salesforce-service-cloud", Reason: "Enterprise service case connector expected by Salesforce customers."},
	{Slug: "jira-service-management", Reason: "IT and service-desk request connector expected by Atlassian-heavy teams."},
	{Slug: "linear", Reason: "Issue-based customer support connector expected by product-led teams."},
	{Slug: "asana-support", Reason: "Task-based support workflow connector expected by operations teams."},
	{Slug: "clickup-support", Reason: "Task-based support workflow connector expected by SMB operations teams."},
	{Slug: "yotpo", Reason: "Reviews and loyalty connector expected in commerce stacks."},
	{Slug: "judge-me", Reason: "Popular Shopify review connector."},
	{Slug: "okendo", Reason: "Premium commerce review connector."},
	{Slug: "loox", Reason: "Photo review connector for Shopify stacks."},
	{Slug: "trustpilot", Reason: "Public review connector expected by DTC and marketplace brands."},
	{Slug: "reviews-io", Reason: "Popular commerce review connector expected by DTC brands."},
	{Slug: "bazaarvoice", Reason: "Enterprise review syndication connector expected by larger commerce teams."},
	{Slug: "powerreviews", Reason: "Enterprise product review connector expected by retail brands."},
	{Slug: "smile", Reason: "Loyalty connector expected by commerce marketers."},
	{Slug: "loyaltylion", Reason: "Loyalty connector expected by larger commerce teams."},
	{Slug: "growave", Reason: "All-in-one Shopify loyalty and referral connector expected by commerce brands."},
	{Slug: "marsello", Reason: "POS and ecommerce loyalty connector expected by omnichannel merchants."},
	{Slug: "antavo", Reason: "Enterprise loyalty connector expected by larger commerce teams."},
	{Slug: "friendbuy", Reason: "Referral connector expected by DTC growth teams."},
	{Slug: "talkable", Reason: "Referral connector expected by mature ecommerce referral programs."},
	{Slug: "recharge", Reason: "Subscription connector expected by repeat-purchase brands."},
	{Slug: "skio", Reason: "Modern subscription connector for Shopify brands."},
	{Slug: "shippo", Reason: "Shipping API connector expected by commerce fulfillment stacks."},
	{Slug: "easyship", Reason: "Cross-border shipping connector expected by international commerce teams."},
	{Slug: "shipbob", Reason: "3PL fulfillment connector expected by DTC brands."},
	{Slug: "easypost", Reason: "Shipping API connector expected by engineering-led commerce stacks."},
	{Slug: "narvar", Reason: "Post-purchase experience connector expected by larger retail teams."},
	{Slug: "route", Reason: "Package protection and tracking connector expected by DTC brands."},
	{Slug: "malomo", Reason: "Shopify tracking experience connector expected by retention marketers."},
	{Slug: "wonderment", Reason: "Post-purchase tracking connector expected by Shopify retention stacks."},
	{Slug: "bold-subscriptions", Reason: "Subscription connector expected by Shopify brands using Bold."},
	{Slug: "ordergroove", Reason: "Subscription connector expected by larger repeat-purchase brands."},
	{Slug: "loop-subscriptions", Reason: "Modern Shopify subscription connector expected by DTC brands."},
	{Slug: "appstle", Reason: "Popular Shopify subscription connector for SMB commerce stacks."},
	{Slug: "seal-subscriptions", Reason: "Popular Shopify subscription connector for SMB repeat-purchase brands."},
	{Slug: "chargebee", Reason: "B2B and SaaS subscription connector expected by non-Shopify stacks."},
	{Slug: "segment", Reason: "CDP import/export connector expected by data-mature customers."},
	{Slug: "rudderstack", Reason: "Open CDP connector expected by engineering-led teams."},
	{Slug: "ga4", Reason: "Campaign attribution and event forwarding connector."},
	{Slug: "posthog", Reason: "Product analytics connector expected by product-led SaaS teams."},
	{Slug: "heap", Reason: "Behavior analytics connector expected by data-mature growth teams."},
	{Slug: "hotjar", Reason: "Behavior and feedback connector expected by website optimization stacks."},
	{Slug: "fullstory", Reason: "Session analytics connector expected by larger product teams."},
	{Slug: "plausible", Reason: "Privacy-friendly web analytics connector expected by creator and SaaS teams."},
	{Slug: "fathom-analytics", Reason: "Privacy-friendly web analytics connector expected by creator and SaaS teams."},
	{Slug: "matomo", Reason: "Self-hosted and privacy-friendly analytics connector expected by data-conscious teams."},
	{Slug: "adobe-analytics", Reason: "Enterprise analytics connector expected by larger marketing organizations."},
	{Slug: "looker-studio", Reason: "Google reporting connector expected by analytics and marketing teams."},
	{Slug: "looker", Reason: "BI connector expected by data-mature growth teams."},
	{Slug: "tableau", Reason: "Enterprise BI connector expected by larger data teams."},
	{Slug: "power-bi", Reason: "Microsoft BI connector expected by Microsoft-heavy organizations."},
	{Slug: "mode", Reason: "Analytics workspace connector expected by SQL-heavy data teams."},
	{Slug: "metabase", Reason: "Open BI connector expected by engineering-led teams."},
	{Slug: "sisense", Reason: "Embedded analytics connector expected by enterprise data teams."},
	{Slug: "kissmetrics", Reason: "Behavior and funnel analytics connector expected in growth stacks."},
	{Slug: "woopra", Reason: "Customer journey analytics connector expected by lifecycle teams."},
	{Slug: "chartmogul", Reason: "Subscription revenue analytics connector expected by SaaS teams."},
	{Slug: "baremetrics", Reason: "Subscription metrics connector expected by SaaS founders and finance teams."},
	{Slug: "profitwell", Reason: "Subscription retention and revenue analytics connector expected by SaaS teams."},
	{Slug: "triple-whale", Reason: "Commerce attribution connector expected by Shopify retention teams."},
	{Slug: "northbeam", Reason: "Commerce attribution connector expected by DTC acquisition teams."},
	{Slug: "daasity", Reason: "Commerce data model and analytics connector expected by mature retail teams."},
	{Slug: "glew", Reason: "Commerce analytics connector expected by omnichannel and Shopify brands."},
	{Slug: "peel-insights", Reason: "Commerce cohort and retention analytics connector expected by DTC brands."},
	{Slug: "bigquery", Reason: "Core warehouse destination for data teams."},
	{Slug: "snowflake", Reason: "Core warehouse destination for enterprise customers."},
	{Slug: "redshift", Reason: "Core warehouse destination for AWS-heavy teams."},
	{Slug: "postgres", Reason: "Operational data connector for self-serve exports and imports."},
}
