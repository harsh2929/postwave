// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import "fmt"

type ReadinessReport struct {
	SchemaVersion            string           `json:"schema_version"`
	Ready                    bool             `json:"ready"`
	MarketablePublicClaim    bool             `json:"marketable_public_claim"`
	PublicClaim              string           `json:"public_claim"`
	PublicEntries            int              `json:"public_entries"`
	TargetPublicEntries      int              `json:"target_public_entries"`
	NativeManaged            int              `json:"native_managed"`
	TargetNativeManaged      int              `json:"target_native_managed"`
	NativeVerified           int              `json:"native_verified"`
	TargetNativeVerified     int              `json:"target_native_verified"`
	NativePartial            int              `json:"native_partial"`
	NativeDelegated          int              `json:"native_delegated"`
	BridgeReady              int              `json:"bridge_ready"`
	AvailableRecipes         int              `json:"available_recipes"`
	PublicParity             bool             `json:"public_parity"`
	NativeParity             bool             `json:"native_parity"`
	NativeVerificationParity bool             `json:"native_verification_parity"`
	Checks                   []ReadinessCheck `json:"checks"`
	Issues                   []ReadinessIssue `json:"issues"`
	IssueCounts              map[string]int   `json:"issue_counts"`
	Recommendations          []string         `json:"recommendations"`
}

type ReadinessCheck struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	State    string `json:"state"`
	Severity string `json:"severity"`
	Count    int    `json:"count"`
	Message  string `json:"message"`
}

type ReadinessIssue struct {
	Key         string `json:"key"`
	Severity    string `json:"severity"`
	Slug        string `json:"slug,omitempty"`
	Name        string `json:"name,omitempty"`
	Category    string `json:"category,omitempty"`
	Message     string `json:"message"`
	Remediation string `json:"remediation,omitempty"`
}

func Readiness() ReadinessReport {
	items := CatalogItems()
	recipes := AllRecipesForItems(items)
	return ReadinessForItems(items, recipes)
}

func ReadinessForItems(items []CatalogItem, recipes []Recipe) ReadinessReport {
	coverage := CoverageForItems(items, recipes)
	report := ReadinessReport{
		SchemaVersion:            "2026-06.integrations.readiness.v1",
		PublicEntries:            coverage.PublicEntries,
		TargetPublicEntries:      coverage.TargetPublicEntries,
		NativeManaged:            coverage.NativeManaged,
		TargetNativeManaged:      coverage.TargetNativeManaged,
		NativeVerified:           coverage.NativeVerified,
		TargetNativeVerified:     coverage.TargetNativeVerified,
		NativePartial:            coverage.NativePartial,
		NativeDelegated:          coverage.NativeDelegated,
		BridgeReady:              coverage.BridgeReady,
		AvailableRecipes:         coverage.AvailableRecipes,
		PublicParity:             coverage.PublicParity,
		NativeParity:             coverage.NativeParity,
		NativeVerificationParity: coverage.NativeVerificationParity,
		IssueCounts:              map[string]int{},
	}

	report.auditCatalog(items)
	report.auditRecipes(items, recipes)
	report.addMetricChecks()
	report.Ready = report.blockingIssueCount() == 0
	report.MarketablePublicClaim = report.Ready && report.PublicParity && report.NativeParity && report.NativeVerificationParity
	report.PublicClaim = publicReadinessClaim(report)
	report.Recommendations = readinessRecommendations(report)
	// A nil slice marshals to JSON null. Clients type this field as an array,
	// so the EMPTY case -- the healthy, ordinary one here -- handed them a null
	// that throws on the first .map(). An empty list is [].
	if report.Issues == nil {
		report.Issues = []ReadinessIssue{}
	}
	return report
}

func (r *ReadinessReport) auditCatalog(items []CatalogItem) {
	categories := map[string]struct{}{}
	for _, category := range Categories() {
		categories[category.Key] = struct{}{}
	}
	capabilities := map[Capability]struct{}{}
	for _, capability := range Capabilities() {
		capabilities[capability] = struct{}{}
	}

	slugCounts := map[string]int{}
	for _, item := range items {
		slugCounts[item.Slug]++
	}
	for slug, count := range slugCounts {
		if count > 1 {
			r.addIssue(ReadinessIssue{
				Key:         "duplicate_slug",
				Severity:    "blocker",
				Slug:        slug,
				Message:     fmt.Sprintf("Catalog slug appears %d times.", count),
				Remediation: "Keep one canonical catalog entry per public slug.",
			})
		}
	}

	for _, item := range items {
		if item.Slug == "" || item.Name == "" || item.Summary == "" {
			r.addIssue(ReadinessIssue{
				Key:         "catalog_identity_incomplete",
				Severity:    "blocker",
				Slug:        item.Slug,
				Name:        item.Name,
				Category:    item.Category,
				Message:     "Catalog item is missing slug, name, or summary.",
				Remediation: "Add a stable slug, display name, and customer-facing summary.",
			})
		}
		if _, ok := categories[item.Category]; !ok {
			r.addIssue(ReadinessIssue{
				Key:         "unknown_category",
				Severity:    "blocker",
				Slug:        item.Slug,
				Name:        item.Name,
				Category:    item.Category,
				Message:     "Catalog item uses a category that is not in the public category list.",
				Remediation: "Use an existing category key or add it to Categories().",
			})
		}
		if item.DocsURL == "" {
			r.addIssue(ReadinessIssue{
				Key:         "missing_docs",
				Severity:    "blocker",
				Slug:        item.Slug,
				Name:        item.Name,
				Category:    item.Category,
				Message:     "Catalog item is missing a docs URL.",
				Remediation: "Add docs_url or let decorateCatalogItem generate /docs/integrations/{slug}.",
			})
		}
		if item.RuntimeStatus != RuntimePlanned && item.SetupPath == "" {
			r.addIssue(ReadinessIssue{
				Key:         "missing_setup_path",
				Severity:    "blocker",
				Slug:        item.Slug,
				Name:        item.Name,
				Category:    item.Category,
				Message:     "Available catalog item is missing an owning setup surface.",
				Remediation: "Map the source to an existing Moosewave setup surface.",
			})
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimePlanned {
			r.addIssue(ReadinessIssue{
				Key:         "native_claim_planned",
				Severity:    "blocker",
				Slug:        item.Slug,
				Name:        item.Name,
				Category:    item.Category,
				Message:     "Planned item is using the native badge.",
				Remediation: "Use the planned badge until Moosewave owns auth, sync, monitoring, and disconnect.",
			})
		}
		for _, capability := range item.Capabilities {
			if _, ok := capabilities[capability]; !ok {
				r.addIssue(ReadinessIssue{
					Key:         "unknown_capability",
					Severity:    "blocker",
					Slug:        item.Slug,
					Name:        item.Name,
					Category:    item.Category,
					Message:     fmt.Sprintf("Catalog item uses unknown capability %q.", capability),
					Remediation: "Use a standardized capability or add it to Capabilities().",
				})
			}
		}
		if isNativeManaged(item) {
			r.auditNativeConnector(item)
		}
	}
}

func (r *ReadinessReport) auditNativeConnector(item CatalogItem) {
	contract := ContractFor(item)
	actions := LifecycleActions(item)
	report := healthReport(item, connectionFromItem(item))
	if !contract.NativeManaged || contract.Owner != "postwave" {
		r.addIssue(ReadinessIssue{
			Key:         "native_contract_incomplete",
			Severity:    "blocker",
			Slug:        item.Slug,
			Name:        item.Name,
			Category:    item.Category,
			Message:     "Native foundation does not expose a Moosewave-owned contract.",
			Remediation: "Ensure ContractFor marks native-managed foundations as owner=postwave.",
		})
	}
	if len(contract.AuthModes) == 0 || len(contract.Monitoring) == 0 || len(contract.DataObjects) == 0 {
		r.addIssue(ReadinessIssue{
			Key:         "native_contract_metadata_missing",
			Severity:    "blocker",
			Slug:        item.Slug,
			Name:        item.Name,
			Category:    item.Category,
			Message:     "Native foundation contract is missing auth, monitoring, or data-object metadata.",
			Remediation: "Fill auth modes, monitoring surfaces, and data objects from connector capabilities.",
		})
	}
	if !containsString(actions, "disconnect") {
		r.addIssue(ReadinessIssue{
			Key:         "native_disconnect_missing",
			Severity:    "blocker",
			Slug:        item.Slug,
			Name:        item.Name,
			Category:    item.Category,
			Message:     "Native connector is missing the disconnect lifecycle action.",
			Remediation: "Expose disconnect through the owning integration surface and facade.",
		})
	}
	if len(report.Checks) == 0 || report.RetryPolicy.Mode == "" || len(report.SyncHistory) == 0 || len(report.DataDelete) == 0 {
		r.addIssue(ReadinessIssue{
			Key:         "native_health_metadata_missing",
			Severity:    "blocker",
			Slug:        item.Slug,
			Name:        item.Name,
			Category:    item.Category,
			Message:     "Native connector health report is missing checks, retry policy, sync history, or data-delete details.",
			Remediation: "Complete healthReport metadata before claiming native support.",
		})
	}
	if delegatedEndpoint(item, "sync") == "" {
		r.addIssue(ReadinessIssue{
			Key:         "native_sync_endpoint_missing",
			Severity:    "warning",
			Slug:        item.Slug,
			Name:        item.Name,
			Category:    item.Category,
			Message:     "Native connector does not advertise a delegated sync endpoint.",
			Remediation: "Map sync to the owning surface or document why sync is not applicable.",
		})
	}
}

func (r *ReadinessReport) auditRecipes(items []CatalogItem, recipes []Recipe) {
	itemBySlug := map[string]struct{}{}
	for _, item := range items {
		itemBySlug[item.Slug] = struct{}{}
	}
	internalTargets := map[string]struct{}{
		"commerce":              {},
		"audience-destinations": {},
		"migrations":            {},
		"warehouse":             {},
	}
	recipeIDs := map[string]int{}
	for _, recipe := range recipes {
		recipeIDs[recipe.ID]++
	}
	for id, count := range recipeIDs {
		if count > 1 {
			r.addIssue(ReadinessIssue{
				Key:         "duplicate_recipe_id",
				Severity:    "blocker",
				Slug:        id,
				Message:     fmt.Sprintf("Recipe id appears %d times.", count),
				Remediation: "Keep one canonical recipe per id.",
			})
		}
	}
	for _, recipe := range recipes {
		if recipe.ID == "" || recipe.Name == "" || recipe.Provider == "" {
			r.addIssue(ReadinessIssue{
				Key:         "recipe_identity_incomplete",
				Severity:    "blocker",
				Slug:        recipe.ID,
				Message:     "Recipe is missing id, name, or provider.",
				Remediation: "Add stable recipe identity fields before exposing it publicly.",
			})
		}
		if _, ok := itemBySlug[recipe.SourceSlug]; !ok {
			r.addIssue(ReadinessIssue{
				Key:         "recipe_source_missing",
				Severity:    "blocker",
				Slug:        recipe.ID,
				Message:     fmt.Sprintf("Recipe source %q is not in the catalog.", recipe.SourceSlug),
				Remediation: "Add the source catalog tile or remove the recipe.",
			})
		}
		if recipe.TargetSlug != "" {
			if _, ok := itemBySlug[recipe.TargetSlug]; !ok {
				if _, internal := internalTargets[recipe.TargetSlug]; !internal {
					r.addIssue(ReadinessIssue{
						Key:         "recipe_target_missing",
						Severity:    "blocker",
						Slug:        recipe.ID,
						Message:     fmt.Sprintf("Recipe target %q is not in the catalog or internal target allowlist.", recipe.TargetSlug),
						Remediation: "Add the target catalog tile or register it as an internal setup target.",
					})
				}
			}
		}
		if recipe.Available && (recipe.SetupPath == "" || len(recipe.Steps) == 0) {
			r.addIssue(ReadinessIssue{
				Key:         "available_recipe_setup_missing",
				Severity:    "warning",
				Slug:        recipe.ID,
				Message:     "Available recipe is missing setup path or setup steps.",
				Remediation: "Add a setup path and at least one operator step.",
			})
		}
		if recipe.Blueprint.Trigger == "" || recipe.Blueprint.Destination == "" || recipe.Blueprint.PostwaveSurface == "" {
			r.addIssue(ReadinessIssue{
				Key:         "recipe_blueprint_incomplete",
				Severity:    "warning",
				Slug:        recipe.ID,
				Message:     "Recipe blueprint is missing trigger, destination, or Moosewave surface.",
				Remediation: "Complete the blueprint so partners can implement the bridge without tribal knowledge.",
			})
		}
	}
}

func (r *ReadinessReport) addMetricChecks() {
	r.addCheck(
		"public_catalog_parity",
		"Public catalog parity",
		r.PublicParity,
		r.PublicEntries,
		fmt.Sprintf("%d/%d visible integrations cataloged.", r.PublicEntries, r.TargetPublicEntries),
	)
	r.addCheck(
		"native_managed_parity",
		"Native-managed parity",
		r.NativeParity,
		r.NativeManaged,
		fmt.Sprintf("%d/%d native-managed connectors cataloged.", r.NativeManaged, r.TargetNativeManaged),
	)
	r.addCheckWithSeverity(
		"native_api_verified_parity",
		"Native API verification parity",
		r.NativeVerificationParity,
		"warning",
		r.NativeVerified,
		fmt.Sprintf("%d/%d native connectors are API-verified as available; %d partial and %d delegated connectors still need provider-by-provider proof.", r.NativeVerified, r.TargetNativeVerified, r.NativePartial, r.NativeDelegated),
	)
	r.addCheck(
		"bridge_recipe_readiness",
		"Bridge recipe readiness",
		r.AvailableRecipes > 0,
		r.AvailableRecipes,
		fmt.Sprintf("%d available bridge/native recipes.", r.AvailableRecipes),
	)
	r.addCheck(
		"blocking_issues",
		"Blocking readiness issues",
		r.blockingIssueCount() == 0,
		r.blockingIssueCount(),
		fmt.Sprintf("%d blocker issue(s) found.", r.blockingIssueCount()),
	)
}

func (r *ReadinessReport) addCheck(key, label string, ok bool, count int, message string) {
	r.addCheckWithSeverity(key, label, ok, "blocker", count, message)
}

func (r *ReadinessReport) addCheckWithSeverity(key, label string, ok bool, failureSeverity string, count int, message string) {
	state := "pass"
	severity := "ok"
	if !ok {
		state = "fail"
		severity = failureSeverity
	}
	r.Checks = append(r.Checks, ReadinessCheck{
		Key:      key,
		Label:    label,
		State:    state,
		Severity: severity,
		Count:    count,
		Message:  message,
	})
}

func (r *ReadinessReport) addIssue(issue ReadinessIssue) {
	if issue.Severity == "" {
		issue.Severity = "warning"
	}
	r.Issues = append(r.Issues, issue)
	r.IssueCounts["total"]++
	r.IssueCounts["severity:"+issue.Severity]++
	r.IssueCounts["key:"+issue.Key]++
	if issue.Category != "" {
		r.IssueCounts["category:"+issue.Category]++
	}
}

func (r ReadinessReport) blockingIssueCount() int {
	return r.IssueCounts["severity:blocker"]
}

func publicReadinessClaim(report ReadinessReport) string {
	if report.MarketablePublicClaim {
		return "350+ integrations, including 60 API-verified native Moosewave-managed connectors."
	}
	if report.PublicParity && report.NativeParity {
		return "350+ integrations and 60 Moosewave-owned native connector foundations are cataloged; full native API verification is still in progress."
	}
	return "Integration parity is in progress; use readiness checks before making public parity claims."
}

func readinessRecommendations(report ReadinessReport) []string {
	recs := []string{}
	if !report.PublicParity {
		recs = append(recs, "Add or partner-list more public catalog tiles until the 350+ visible integration target is reached.")
	}
	if !report.NativeParity {
		recs = append(recs, "Promote the highest-impact priority gaps to native-managed connector foundations until the 60 connector target is reached.")
	}
	if !report.NativeVerificationParity {
		recs = append(recs, "Complete official API-doc audits, contract tests, and runtime verification before claiming 60 fully native integrations.")
	}
	if report.IssueCounts["severity:blocker"] > 0 {
		recs = append(recs, "Resolve blocker issues before using the public parity marketing claim.")
	}
	if report.IssueCounts["severity:warning"] > 0 {
		recs = append(recs, "Clear warning issues before launch review so setup recipes and native metadata are complete.")
	}
	if len(recs) == 0 {
		recs = append(recs, "Readiness checks pass; keep this endpoint in release gates as new integrations are added.")
	}
	return recs
}
