// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	targetPublicEntries = 350
	targetNativeManaged = 70
)

type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

type catalogResponse struct {
	SchemaVersion       string         `json:"schema_version"`
	TargetPublicEntries int            `json:"target_public_entries"`
	TargetNativeManaged int            `json:"target_native_managed"`
	HonestBadges        []Badge        `json:"honest_badges"`
	Categories          []Category     `json:"categories"`
	Capabilities        []Capability   `json:"capabilities"`
	Items               []CatalogItem  `json:"items"`
	Counts              map[string]int `json:"counts"`
}

type Connection struct {
	Slug                string        `json:"slug"`
	Name                string        `json:"name"`
	Category            string        `json:"category"`
	Badge               Badge         `json:"badge"`
	RuntimeStatus       RuntimeStatus `json:"runtime_status"`
	Connected           bool          `json:"connected"`
	Status              string        `json:"status"`
	Count               int           `json:"count"`
	PrimaryConnectionID string        `json:"primary_connection_id,omitempty"`
	ConnectionIDs       []string      `json:"connection_ids,omitempty"`
	LastSyncAt          *time.Time    `json:"last_sync_at,omitempty"`
	LastError           string        `json:"last_error,omitempty"`
	ManagePath          string        `json:"manage_path,omitempty"`
	Source              string        `json:"source,omitempty"`
	HealthState         string        `json:"health_state"`
	HealthMessage       string        `json:"health_message"`
}

type connectionsResponse struct {
	Items []Connection `json:"items"`
	// Summary is always computed over the WHOLE catalog, never over the
	// filtered page. The counts answer "how much of my workspace is
	// connected / failing", which is a property of the workspace and not of
	// whatever the caller happened to ask for; filtering them alongside
	// Items would turn "3 failing" into "3 failing among the rows you can
	// see", which is the same number with a quietly different meaning.
	Summary map[string]int `json:"summary"`
	// Returned is len(Items) after filtering. Present so a caller can tell
	// "the filter matched nothing" apart from "the catalog is empty" without
	// having to compare against Summary["total"] itself.
	Returned int `json:"returned"`
}

type recipesResponse struct {
	Items   []Recipe       `json:"items"`
	Summary map[string]int `json:"summary"`
}

type recipeDetailResponse struct {
	Recipe Recipe       `json:"recipe"`
	Source CatalogItem  `json:"source"`
	Target *CatalogItem `json:"target,omitempty"`
}

type detailResponse struct {
	Item             CatalogItem       `json:"item"`
	Connection       Connection        `json:"connection"`
	Setup            []SetupStep       `json:"setup"`
	Recipes          []Recipe          `json:"recipes"`
	LifecycleActions []string          `json:"lifecycle_actions"`
	Health           HealthReport      `json:"health"`
	Contract         ConnectorContract `json:"contract"`
}

type actionResponse struct {
	Slug                string   `json:"slug"`
	Action              string   `json:"action"`
	Status              string   `json:"status"`
	Message             string   `json:"message"`
	DelegatedTo         string   `json:"delegated_to,omitempty"`
	PrimaryConnectionID string   `json:"primary_connection_id,omitempty"`
	ConnectionIDs       []string `json:"connection_ids,omitempty"`
	RequiredFields      []string `json:"required_fields,omitempty"`
	DocsURL             string   `json:"docs_url,omitempty"`
	ManagePath          string   `json:"manage_path,omitempty"`
}

type recipeApplyResponse struct {
	RecipeID       string      `json:"recipe_id"`
	Status         string      `json:"status"`
	Message        string      `json:"message"`
	DelegatedTo    string      `json:"delegated_to,omitempty"`
	ManagePath     string      `json:"manage_path,omitempty"`
	RequiredFields []string    `json:"required_fields,omitempty"`
	NextSteps      []SetupStep `json:"next_steps,omitempty"`
	Blueprint      Blueprint   `json:"blueprint"`
}

type sourceStatus struct {
	Count      int
	Connected  bool
	Status     string
	LastSyncAt *time.Time
	LastError  string
}

type HealthCheck struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	State   string `json:"state"`
	Message string `json:"message"`
}

type RetryPolicy struct {
	Mode        string `json:"mode"`
	MaxAttempts int    `json:"max_attempts"`
	Backoff     string `json:"backoff"`
	DeadLetter  string `json:"dead_letter"`
	Idempotency string `json:"idempotency"`
}

type SyncHistoryEntry struct {
	At       *time.Time `json:"at,omitempty"`
	Action   string     `json:"action"`
	Status   string     `json:"status"`
	Attempts int        `json:"attempts,omitempty"`
	Message  string     `json:"message"`
	Error    string     `json:"error,omitempty"`
}

type AuditTrailEntry struct {
	At      *time.Time `json:"at,omitempty"`
	Action  string     `json:"action"`
	Actor   string     `json:"actor"`
	Message string     `json:"message"`
}

type DataDeleteAction struct {
	Method      string `json:"method"`
	Path        string `json:"path"`
	Description string `json:"description"`
}

type HealthReport struct {
	State             string             `json:"state"`
	Severity          string             `json:"severity"`
	Message           string             `json:"message"`
	MonitoringSurface string             `json:"monitoring_surface"`
	DocsURL           string             `json:"docs_url,omitempty"`
	Checks            []HealthCheck      `json:"checks"`
	RetryPolicy       RetryPolicy        `json:"retry_policy"`
	SyncHistory       []SyncHistoryEntry `json:"sync_history"`
	AuditTrail        []AuditTrailEntry  `json:"audit_trail"`
	DataDelete        []DataDeleteAction `json:"data_delete"`
}

func MountRoutes(r chi.Router, deps *Deps) {
	h := &handler{}
	if deps != nil {
		h.pool = deps.Pool
		h.logger = deps.Logger
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)

	r.With(read).Get("/api/v1/integrations/catalog", h.catalog)
	r.With(read).Get("/api/v1/integrations/connections", h.connections)
	r.With(read).Get("/api/v1/integrations/coverage", h.coverage)
	r.With(read).Get("/api/v1/integrations/stacks", h.stacks)
	r.With(read).Get("/api/v1/integrations/readiness", h.readiness)
	r.With(read).Get("/api/v1/integrations/recipes", h.recipes)
	r.With(read).Get("/api/v1/integrations/recipes/{id}", h.recipeDetail)
	r.With(read).Get("/api/v1/integrations/{slug}/contract", h.contract)
	r.With(read).Get("/api/v1/integrations/{slug}/health", h.health)
	r.With(read).Get("/api/v1/integrations/{slug}", h.detail)
	r.With(admin).Post("/api/v1/integrations/recipes/{id}/apply", h.applyRecipe)
	r.With(admin).Post("/api/v1/integrations/{slug}/connect/start", h.action("connect/start"))
	r.With(admin).Post("/api/v1/integrations/{slug}/connect/callback", h.action("connect/callback"))
	r.With(admin).Post("/api/v1/integrations/{slug}/sync", h.action("sync"))
	r.With(admin).Post("/api/v1/integrations/{slug}/backfill", h.action("backfill"))
	r.With(admin).Post("/api/v1/integrations/{slug}/pause", h.action("pause"))
	r.With(admin).Delete("/api/v1/integrations/{slug}", h.action("disconnect"))
}

type handler struct {
	pool   *db.Pool
	logger *slog.Logger
}

func (h *handler) catalog(w http.ResponseWriter, r *http.Request) {
	items := filterCatalog(h.catalogItemsForHTTPRequest(r.Context()), r)
	counts := countCatalog(items)
	writeJSON(w, http.StatusOK, catalogResponse{
		SchemaVersion:       "2026-06.integrations.v1",
		TargetPublicEntries: targetPublicEntries,
		TargetNativeManaged: targetNativeManaged,
		HonestBadges: []Badge{
			BadgeNative,
			BadgePartner,
			BadgeZapier,
			BadgeWebhook,
			BadgeAPISDK,
			BadgeMigrationOnly,
			BadgePlanned,
		},
		Categories:   Categories(),
		Capabilities: Capabilities(),
		Items:        items,
		Counts:       counts,
	})
}

func (h *handler) coverage(w http.ResponseWriter, r *http.Request) {
	items := h.catalogItemsForHTTPRequest(r.Context())
	writeJSON(w, http.StatusOK, CoverageForItems(items, AllRecipesForItems(items)))
}

func (h *handler) stacks(w http.ResponseWriter, r *http.Request) {
	items := h.catalogItemsForHTTPRequest(r.Context())
	writeJSON(w, http.StatusOK, StackCoverageForItems(items, AllRecipesForItems(items)))
}

func (h *handler) readiness(w http.ResponseWriter, r *http.Request) {
	items := h.catalogItemsForHTTPRequest(r.Context())
	writeJSON(w, http.StatusOK, ReadinessForItems(items, AllRecipesForItems(items)))
}

func (h *handler) recipes(w http.ResponseWriter, r *http.Request) {
	catalogItems := h.catalogItemsForHTTPRequest(r.Context())
	items := filterRecipes(AllRecipesForItems(catalogItems), r)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Available != items[j].Available {
			return items[i].Available
		}
		if items[i].Provider != items[j].Provider {
			return items[i].Provider < items[j].Provider
		}
		return items[i].Name < items[j].Name
	})
	writeJSON(w, http.StatusOK, recipesResponse{
		Items:   items,
		Summary: countRecipes(items),
	})
}

func (h *handler) recipeDetail(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	catalogItems := h.catalogItemsForHTTPRequest(r.Context())
	recipe, ok := recipeByID(AllRecipesForItems(catalogItems), id)
	if !ok {
		writeError(w, http.StatusNotFound, "recipe_not_found", "recipe not found")
		return
	}
	source, ok := catalogItemBySlug(catalogItems, recipe.SourceSlug)
	if !ok {
		writeError(w, http.StatusNotFound, "recipe_source_not_found", "recipe source integration not found")
		return
	}
	var target *CatalogItem
	if recipe.TargetSlug != "" {
		if t, ok := catalogItemBySlug(catalogItems, recipe.TargetSlug); ok {
			target = &t
		}
	}
	writeJSON(w, http.StatusOK, recipeDetailResponse{
		Recipe: recipe,
		Source: source,
		Target: target,
	})
}

func (h *handler) applyRecipe(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	catalogItems := h.catalogItemsForHTTPRequest(r.Context())
	recipe, ok := recipeByID(AllRecipesForItems(catalogItems), id)
	if !ok {
		writeError(w, http.StatusNotFound, "recipe_not_found", "recipe not found")
		return
	}
	resp := recipeApplyResponse{
		RecipeID:       recipe.ID,
		Blueprint:      recipe.Blueprint,
		ManagePath:     recipe.SetupPath,
		NextSteps:      recipe.Steps,
		RequiredFields: recipeRequiredFields(recipe),
	}
	resp.Status = "delegated"
	resp.Message = "Open the owning Moosewave surface and configure this recipe with the provided blueprint."
	resp.DelegatedTo = recipeDelegatedEndpoint(recipe)
	writeJSON(w, http.StatusAccepted, resp)
}

func (h *handler) detail(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))
	item, ok := h.catalogItemBySlugForRequest(r.Context(), slug)
	if !ok {
		writeError(w, http.StatusNotFound, "integration_not_found", "integration not found")
		return
	}
	if hasSource(item, "support_integration") {
		writeJSON(w, http.StatusOK, detailResponse{
			Item: item,
			Connection: Connection{
				Slug:          item.Slug,
				Name:          item.Name,
				Category:      item.Category,
				Badge:         BadgePlanned,
				RuntimeStatus: RuntimePlanned,
				Status:        "release_held",
				HealthState:   "held",
				HealthMessage: "Support-provider runtime is release-held.",
			},
			Setup:            []SetupStep{},
			Recipes:          []Recipe{},
			LifecycleActions: []string{},
			Health:           supportProviderHeldHealth(item),
			Contract:         ContractFor(item),
		})
		return
	}
	conn := connectionFromItem(item)
	var history []SyncHistoryEntry
	if h.pool != nil {
		tenant, ok := middleware.TenantFromContext(r.Context())
		if !ok || tenant.ID == "" {
			writeError(w, http.StatusUnauthorized, "tenant_required", "tenant context is required")
			return
		}
		tx, err := db.WithTenant(r.Context(), h.pool, tenant.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "tenant_tx_failed", "could not open tenant-scoped transaction")
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		connections := map[string]Connection{item.Slug: conn}
		h.applyRuntimeStatus(r, tx, connections)
		h.applyRuntimeConnectionIDs(r.Context(), tx, connections)
		conn = connections[item.Slug]
		history = h.runtimeSyncHistory(r.Context(), tx, item)
	}
	conn = withConnectionHealth(item, conn)
	writeJSON(w, http.StatusOK, detailResponse{
		Item:             item,
		Connection:       conn,
		Setup:            SetupGuide(item),
		Recipes:          RecipesForItem(item),
		LifecycleActions: LifecycleActions(item),
		Health:           healthReportWithHistory(item, conn, history),
		Contract:         ContractFor(item),
	})
}

func (h *handler) contract(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))
	item, ok := h.catalogItemBySlugForRequest(r.Context(), slug)
	if !ok {
		writeError(w, http.StatusNotFound, "integration_not_found", "integration not found")
		return
	}
	writeJSON(w, http.StatusOK, ContractFor(item))
}

func (h *handler) health(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))
	item, ok := h.catalogItemBySlugForRequest(r.Context(), slug)
	if !ok {
		writeError(w, http.StatusNotFound, "integration_not_found", "integration not found")
		return
	}
	if hasSource(item, "support_integration") {
		writeJSON(w, http.StatusOK, supportProviderHeldHealth(item))
		return
	}
	conn := connectionFromItem(item)
	var history []SyncHistoryEntry
	if h.pool != nil {
		tenant, ok := middleware.TenantFromContext(r.Context())
		if !ok || tenant.ID == "" {
			writeError(w, http.StatusUnauthorized, "tenant_required", "tenant context is required")
			return
		}
		tx, err := db.WithTenant(r.Context(), h.pool, tenant.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "tenant_tx_failed", "could not open tenant-scoped transaction")
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		connections := map[string]Connection{item.Slug: conn}
		h.applyRuntimeStatus(r, tx, connections)
		conn = connections[item.Slug]
		history = h.runtimeSyncHistory(r.Context(), tx, item)
	}
	conn = withConnectionHealth(item, conn)
	writeJSON(w, http.StatusOK, healthReportWithHistory(item, conn, history))
}

func supportProviderHeldHealth(item CatalogItem) HealthReport {
	return HealthReport{
		State:             "held",
		Severity:          "info",
		Message:           "Support-provider runtime is release-held; no provider connection, callback, pull, sync, backfill, or lifecycle health has been evaluated.",
		MonitoringSurface: "unavailable",
		Checks:            []HealthCheck{},
		RetryPolicy: RetryPolicy{
			Mode:        "unavailable",
			MaxAttempts: 0,
			Backoff:     "none",
			DeadLetter:  "none",
			Idempotency: "not_applicable",
		},
		SyncHistory: []SyncHistoryEntry{},
		AuditTrail:  []AuditTrailEntry{},
		DataDelete:  []DataDeleteAction{},
	}
}

func recipeRequiredFields(recipe Recipe) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, step := range recipe.Steps {
		for _, field := range step.RequiredFields {
			if _, ok := seen[field]; ok {
				continue
			}
			seen[field] = struct{}{}
			out = append(out, field)
		}
	}
	for _, mapping := range recipe.Blueprint.FieldMappings {
		if !mapping.Required {
			continue
		}
		if _, ok := seen[mapping.Source]; ok {
			continue
		}
		seen[mapping.Source] = struct{}{}
		out = append(out, mapping.Source)
	}
	return out
}

func recipeDelegatedEndpoint(recipe Recipe) string {
	switch recipe.SetupPath {
	case "/commerce":
		return "POST /api/v1/commerce/integrations"
	case "/audience-syncs":
		return "POST /api/v1/audience-destinations"
	case "/data-platform":
		return "POST /api/v1/warehouse/connections"
	case "/migrations":
		return "POST /api/v1/migrations"
	case "/integrations":
		if item, ok := CatalogItemBySlug(recipe.SourceSlug); ok {
			return delegatedEndpoint(item, "connect/start")
		}
		return "POST /api/v1/integrations/{slug}/connect/start"
	case "/api-playground":
		return "POST /api/v1/api-keys or POST /api/v1/developer-marketplace/apps"
	default:
		return "POST /api/v1/inbound-webhooks/endpoints or POST /api/v1/outbound-webhooks"
	}
}

func (h *handler) connections(w http.ResponseWriter, r *http.Request) {
	items := h.catalogItemsForHTTPRequest(r.Context())
	connections := make(map[string]Connection, len(items))
	for _, item := range items {
		connections[item.Slug] = connectionFromItem(item)
	}

	if h.pool != nil {
		tenant, ok := middleware.TenantFromContext(r.Context())
		if !ok || tenant.ID == "" {
			writeError(w, http.StatusUnauthorized, "tenant_required", "tenant context is required")
			return
		}
		tx, err := db.WithTenant(r.Context(), h.pool, tenant.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "tenant_tx_failed", "could not open tenant-scoped transaction")
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()

		h.applyRuntimeStatus(r, tx, connections)
		h.applyRuntimeConnectionIDs(r.Context(), tx, connections)
	}
	enrichConnectionHealth(connections)

	out := make([]Connection, 0, len(connections))
	for _, conn := range connections {
		out = append(out, conn)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Connected != out[j].Connected {
			return out[i].Connected
		}
		if out[i].RuntimeStatus != out[j].RuntimeStatus {
			return statusRank(out[i].RuntimeStatus) < statusRank(out[j].RuntimeStatus)
		}
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return out[i].Name < out[j].Name
	})
	// Summary is deliberately taken BEFORE the filter (see the struct doc).
	summary := countConnections(out)
	out = filterConnections(out, r)
	writeJSON(w, http.StatusOK, connectionsResponse{
		Items:    out,
		Summary:  summary,
		Returned: len(out),
	})
}

// filterConnections narrows the connection inventory server-side.
//
// WHY THIS EXISTS. The catalog is ~600 entries and this endpoint returned all
// of them on every call, with no query parameters at all — the one aggregation
// route in this package that had none, while `filterRecipes` three functions
// below has read q/source/target/provider/badge/capability/available since it
// was written. Every client then threw the bulk away locally: the mobile
// health screen keeps only rows with a tenant footprint, which on a typical
// workspace is single digits out of ~600. On a phone that is a payload paid
// for in cellular bytes and JSON parse time on the UI thread, to render six
// rows.
//
// The parameters, all optional and all AND-ed together:
//
//	footprint=1        only rows this tenant actually touches — connected, or
//	                   carrying a connection count, or reporting an error.
//	                   This is the mobile health screen's whole query.
//	connected=true     strict connected/not-connected split.
//	q=<substring>      case-insensitive over name, slug and category.
//	category=<name>    exact, case-insensitive.
//	health=a,b         one or more health_state values.
//	status=a,b         one or more runtime status values.
//
// NO PARAMETERS MEANS NO FILTERING, byte-for-byte as before, so existing
// desktop/web callers are unaffected. This is a read-shaping parameter set: it
// can only ever remove rows the caller already had the right to see, and it
// runs after the tenant-scoped transaction that decided that. It cannot widen
// anything.
func filterConnections(items []Connection, r *http.Request) []Connection {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	connected := strings.TrimSpace(r.URL.Query().Get("connected"))
	footprint := strings.TrimSpace(r.URL.Query().Get("footprint"))
	health := csvSet(r.URL.Query().Get("health"))
	status := csvSet(r.URL.Query().Get("status"))
	if q == "" && category == "" && connected == "" && footprint == "" &&
		len(health) == 0 && len(status) == 0 {
		return items
	}
	wantConnected, hasConnected := parseBoolParam(connected)
	wantFootprint, _ := parseBoolParam(footprint)
	out := make([]Connection, 0, len(items))
	for _, item := range items {
		if hasConnected && item.Connected != wantConnected {
			continue
		}
		if wantFootprint && !hasTenantFootprint(item) {
			continue
		}
		if category != "" && !strings.EqualFold(item.Category, category) {
			continue
		}
		if len(health) > 0 && !health[strings.ToLower(item.HealthState)] {
			continue
		}
		if len(status) > 0 && !status[strings.ToLower(string(item.RuntimeStatus))] {
			continue
		}
		if q != "" && !connectionMatchesQuery(item, q) {
			continue
		}
		out = append(out, item)
	}
	return out
}

// hasTenantFootprint is the "does this workspace actually use it" test, kept
// identical to the one every client had reimplemented locally: connected, or a
// non-zero connection count, or a live error. The error clause is the one that
// matters — a connection that has broken badly enough to lose its `connected`
// flag is exactly the row an operator opened the screen to find.
func hasTenantFootprint(c Connection) bool {
	return c.Connected || c.Count > 0 || strings.TrimSpace(c.LastError) != ""
}

func connectionMatchesQuery(c Connection, needle string) bool {
	return strings.Contains(strings.ToLower(c.Name), needle) ||
		strings.Contains(strings.ToLower(c.Slug), needle) ||
		strings.Contains(strings.ToLower(c.Category), needle)
}

// csvSet splits a comma-separated parameter into a lowercase lookup set.
// Empty and whitespace-only members are dropped, so "a,,b " is {a,b} and ","
// is empty (= "no filter") rather than a set that matches nothing.
func csvSet(raw string) map[string]bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part == "" {
			continue
		}
		out[part] = true
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseBoolParam accepts the spellings a URL actually carries. The second
// return distinguishes "absent or unparseable" from "present and false" —
// without it, `connected=` would read as `connected=false` and hide every
// connected row, which is the opposite of what an empty parameter means.
func parseBoolParam(raw string) (value bool, present bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}

func filterRecipes(items []Recipe, r *http.Request) []Recipe {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	target := strings.TrimSpace(r.URL.Query().Get("target"))
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	badge := strings.TrimSpace(r.URL.Query().Get("badge"))
	capability := strings.TrimSpace(r.URL.Query().Get("capability"))
	available := strings.TrimSpace(r.URL.Query().Get("available"))
	if q == "" && source == "" && target == "" && provider == "" && badge == "" && capability == "" && available == "" {
		return items
	}
	out := make([]Recipe, 0, len(items))
	for _, item := range items {
		if source != "" && item.SourceSlug != source {
			continue
		}
		if target != "" && item.TargetSlug != target {
			continue
		}
		if provider != "" && !strings.EqualFold(item.Provider, provider) {
			continue
		}
		if badge != "" && string(item.Badge) != badge {
			continue
		}
		if capability != "" && !recipeHasCapability(item, Capability(capability)) {
			continue
		}
		if available != "" && (available == "true") != item.Available {
			continue
		}
		if q != "" && !recipeMatches(item, q) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func recipeMatches(item Recipe, q string) bool {
	fields := []string{
		item.ID,
		item.Name,
		item.Provider,
		item.SourceSlug,
		item.TargetSlug,
		item.Summary,
		string(item.Badge),
		item.Blueprint.Trigger,
		item.Blueprint.Destination,
		item.Blueprint.PostwaveSurface,
	}
	fields = append(fields, item.Blueprint.RequiredScopes...)
	fields = append(fields, item.Blueprint.RequiredSecrets...)
	fields = append(fields, item.Blueprint.Events...)
	fields = append(fields, item.Blueprint.DataHandling...)
	for _, mapping := range item.Blueprint.FieldMappings {
		fields = append(fields, mapping.Source, mapping.Target, mapping.Description)
	}
	for _, cap := range item.Capabilities {
		fields = append(fields, string(cap))
	}
	for _, step := range item.Steps {
		fields = append(fields, step.Title, step.Description, step.Action, step.Path)
		fields = append(fields, step.RequiredFields...)
	}
	return strings.Contains(strings.ToLower(strings.Join(fields, " ")), q)
}

func recipeHasCapability(item Recipe, capability Capability) bool {
	for _, cap := range item.Capabilities {
		if cap == capability {
			return true
		}
	}
	return false
}

func filterCatalog(items []CatalogItem, r *http.Request) []CatalogItem {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	badge := strings.TrimSpace(r.URL.Query().Get("badge"))
	capability := strings.TrimSpace(r.URL.Query().Get("capability"))
	if q == "" && category == "" && badge == "" && capability == "" {
		return items
	}
	out := make([]CatalogItem, 0, len(items))
	for _, item := range items {
		if category != "" && item.Category != category {
			continue
		}
		if badge != "" && string(item.Badge) != badge {
			continue
		}
		if capability != "" && !hasCapability(item, Capability(capability)) {
			continue
		}
		if q != "" && !catalogItemMatches(item, q) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func catalogItemMatches(item CatalogItem, q string) bool {
	fields := []string{
		item.Slug,
		item.Name,
		item.Category,
		string(item.Badge),
		string(item.RuntimeStatus),
		item.Summary,
	}
	fields = append(fields, item.Sources...)
	for _, cap := range item.Capabilities {
		fields = append(fields, string(cap))
	}
	return strings.Contains(strings.ToLower(strings.Join(fields, " ")), q)
}

func hasCapability(item CatalogItem, capability Capability) bool {
	for _, cap := range item.Capabilities {
		if cap == capability {
			return true
		}
	}
	return false
}

func connectionFromItem(item CatalogItem) Connection {
	source := ""
	if len(item.Sources) > 0 {
		source = item.Sources[0]
	}
	status := "not_configured"
	if item.RuntimeStatus == RuntimePlanned {
		status = "planned"
	}
	return withConnectionHealth(item, Connection{
		Slug:          item.Slug,
		Name:          item.Name,
		Category:      item.Category,
		Badge:         item.Badge,
		RuntimeStatus: item.RuntimeStatus,
		Status:        status,
		ManagePath:    item.SetupPath,
		Source:        source,
	})
}

func enrichConnectionHealth(connections map[string]Connection) {
	for _, item := range CatalogItems() {
		conn, ok := connections[item.Slug]
		if !ok {
			continue
		}
		connections[item.Slug] = withConnectionHealth(item, conn)
	}
}

func withConnectionHealth(item CatalogItem, conn Connection) Connection {
	state, message := healthSummary(item, conn)
	conn.HealthState = state
	conn.HealthMessage = message
	return conn
}

func healthSummary(item CatalogItem, conn Connection) (string, string) {
	switch {
	case item.RuntimeStatus == RuntimePlanned || item.Badge == BadgePlanned:
		return "planned", fmt.Sprintf("%s is visible for roadmap and parity tracking.", item.Name)
	case conn.LastError != "":
		return "action_required", conn.LastError
	case isKlaviyoNativeSurface(item) && conn.Count > 0:
		return "needs_attention", "Klaviyo native provider-row lifecycle is wired with credential-ref-only setup, managed public-app OAuth install/refresh/revoke, row-preserving pause/disconnect, provider_cleanup evidence plus local acknowledgement, marketing sync run history, marketing webhook delivery history, versioned klaviyo_native cursors, native JSON:API profile/source-event pulls, signed Klaviyo system-webhook receipt, managed Webhooks API subscription reconciliation/cleanup for allowlisted credentials, scheduled provider-row polling, and integration-writeback for existing-profile properties, list adds, and custom events; OAuth live certification, Webhooks API live allowlist certification, writeback live certification, provider-side cleanup certification, and live account certification remain open."
	case isMarketingNativeSurface(item) && conn.Count > 0:
		meta, _ := managedProviderMetadataForItem(item)
		return "needs_attention", fmt.Sprintf("%s native provider-row lifecycle is wired with credential-ref-only setup, row-preserving pause/disconnect, marketing sync run history, and %s_handoff delegated cursor evidence; provider API import remains delegated to the migration adapter while native webhooks, writeback, cleanup automation, source-event polling where unsupported, and live account certification remain open.", item.Name, meta.Provider)
	case isKlaviyoMigrationSurface(item) && conn.Count > 0:
		return "needs_attention", "Klaviyo API-key migration-to-live source is wired: /accounts validation, Klaviyo-API-Key auth, revision-pinned JSON:API pulls for profiles/lists/segments/flows/campaigns/templates, source-archive rebuild tasks, and incremental changed-profile polling are available; public-app OAuth, native-provider Webhooks API live certification, native-row writeback live certification, and live account certification belong to the separate native row before full availability."
	case isWixStoresSurface(item) && conn.Count > 0:
		return "needs_attention", "Wix Stores native runtime is locally complete: app-instance OAuth, signed JWT webhook ingest, Contacts/Catalog/Orders backfill, lifecycle recovery, retry cursors, delete evidence, and adjacent Wix provider-event evidence are wired; live Wix dev-site certification remains before full availability."
	case isWixLeadSurface(item) && conn.Count > 0:
		return "needs_attention", "Wix Forms and Contacts native runtime is locally complete: app-instance OAuth, signed JWT webhook ingest, REST backfill, lifecycle recovery, contact-delete evidence, retry cursors, and durable webhook idempotency are wired; live Wix dev-site certification remains before full availability."
	case isFilloutLeadSurface(item) && conn.Count > 0:
		return "needs_attention", "Fillout Bearer API-key credential refs, form metadata, submissions REST backfill, offset/limit filters, auto-registered URL-token webhooks, scheduled retry cursors, and managed webhook delete are wired; live Fillout US/EU/self-hosted certification remains before full availability."
	case isJotformLeadSurface(item) && conn.Count > 0:
		return "needs_attention", "Jotform APIKEY credential refs, Standard/EU/HIPAA/custom host routing, form/question/submission REST backfill, offset/limit pagination, managed form webhook reuse/create/delete, token-verified webhook ingest, and scheduled retry cursors are wired; live Jotform account certification remains before full availability."
	case isWebflowLeadSurface(item) && conn.Count > 0:
		return "needs_attention", "Webflow Bearer access-token/API-token credential refs, Data API v2 site/form submissions backfill, elementId filtering, offset/limit pagination, managed site webhook validation/repair/reuse/create/delete, x-webflow-signature verification, timestamp replay checks, durable form-aware webhook delivery idempotency, and scheduled retry cursors are wired; live Webflow site certification remains before full availability."
	case isGoogleLeadFormsSurface(item) && conn.Count > 0:
		return "needs_attention", "Google Lead Form Extensions OAuth/developer-token credential refs, GoogleAdsService.Search lead_form_submission_data backfill, asset/campaign filters, submission_date_time/id watermark checkpoints, connect-time history import, scheduled retry cursors, canonical lead mapping, and provider_cleanup disconnect evidence are wired; live Google Ads account/API certification, ownership/export-window evidence, duplicate/manual CRM export audit, and data-delete proof remain before full availability."
	case isWooCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "WooCommerce REST API credential refs, Customers/Products/Orders/Refunds backfill, variable-product variation enrichment, managed webhook reconciliation, X-WC-Webhook-Signature verification, delete/coupon/refund evidence, optional Subscriptions evidence, manual and scheduled retry cursors, and scheduled continuation are wired; live WooCommerce store certification remains before full availability."
	case isBigCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "BigCommerce API-account credential refs, Customers/Catalog Products/Orders REST backfill, product variant and order products/coupons enrichment, managed /v3/hooks reconciliation, custom-secret webhook verification, delete/archive routing, refund/transaction evidence, retry cursors, and scheduled continuation are wired; live BigCommerce store certification remains before full availability."
	case isAdobeCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Adobe Commerce bearer-token auth, PaaS/on-prem and SaaS REST routing, customers, products, orders, credit memos, merchant-configured webhook ingest, refund evidence, retry cursors, and scheduled continuation are wired; live Adobe Commerce/Magento certification and managed webhook provisioning remain before full availability."
	case isSquarespaceCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Squarespace Commerce API/OAuth credential refs, Contacts/Products/Orders REST backfill, product detail enrichment, signed webhook ingest, delete evidence, retry cursors, and scheduled continuation are wired; live merchant-site certification and managed webhook subscription creation remain before full availability."
	case isStripeCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Stripe restricted-key auth, customers, Checkout Sessions, PaymentIntents, Charges with payment-method evidence, disputes, invoices with paginated line-item enrichment, credit notes, subscriptions, refunds, signed webhooks, delete evidence, retry cursors, scheduled continuation, and provider_cleanup readiness evidence are wired; live Stripe account certification remains before full availability."
	case isSquareCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Square OAuth/app-token auth, customers, catalog products/deletions, catalog-version product refresh, orders, payments, refunds, signed webhooks, customer delete evidence, retry cursors, and scheduled continuation are wired; live Square merchant certification remains before full availability."
	case isPayPalCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "PayPal OAuth client-credential auth, Transaction Search backfill, verified webhook ingest with sparse Orders/Captures/Refunds/Subscriptions/Invoices resource hydration, customer/order/refund mapping, subscription and invoice provider-event evidence, retry cursors, and scheduled continuation are wired; live PayPal merchant certification remains before full availability."
	case isRazorpayCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Razorpay Basic Auth credential refs, customers, orders, payments, refunds, signed webhooks, refund evidence, retry cursors, and scheduled continuation are wired; live Razorpay account certification remains before full availability."
	case isHubSpotCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "HubSpot private-app/OAuth Bearer credential refs, OAuth token refresh/revocation, CRM contact REST backfill, configured Lists API membership fanout with provider-list segment evidence, opt-in native Moosewave list membership adds plus complete-scan stale repair for owned memberships, opt-in deal association event fanout, app-level signed contact webhooks, after-cursor checkpoints, scheduled retry cursors, contact/deal/company property mapping, and sync/webhook history are wired; live HubSpot certification remains before full availability, while historical owner reconciliation and broader deal/account modeling are optional migration or future product scope."
	case isSalesforceCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Salesforce native runtime is locally complete: managed OAuth install/storage/refresh, reactive INVALID_SESSION_ID refresh, OAuth Bearer credential refs, SOQL Contact and Lead backfill, CampaignMember event fanout with provider-segment evidence, opt-in native Moosewave list membership adds, explicit CampaignMember removal-signal native list cleanup, complete-scan stale repair for owned mapped Campaign memberships, Task activity fanout, query locator checkpoints, scheduled retry cursors, managed refresh-token revocation on disconnect, contact/lead mapping, and sync history are wired; live Salesforce org certification remains before full availability. CDC/Platform Events are a future streaming enhancement outside this SOQL runtime slice."
	case isPipedriveCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Pipedrive OAuth install/storage/refresh, /users/me install identity capture, refresh-token revocation on disconnect, Pipedrive OAuth uninstall callbacks, API-token/OAuth credential refs, /api/v2/persons, /api/v2/deals, /api/v2/organizations, and /api/v2/activities backfill, limit/cursor checkpoints, person mapping, deal event mapping, identity-safe organization enrichment, activity event mapping, managed person/deal/organization/activity webhooks with route identity checks and integration-scoped body-hash idempotency, scheduled retry cursors, row-preserving disconnect cleanup, and sync/webhook history are wired; live Pipedrive certification remains before full availability."
	case isCloseCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Close API-key credential refs, /api/v1/contact/ offset backfill, route-token signed webhook ingest using close-sig-hash and close-sig-timestamp, contact callback mapping, opportunity/task/activity event mapping with contact hydration, durable CRM webhook idempotency, scheduled retry cursors, operator-managed provider_cleanup evidence, and sync/webhook history are wired; live Close workspace certification remains before full availability."
	case isZohoCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Zoho CRM OAuth credential refs, managed OAuth refresh, /crm/v8 Contacts and Leads backfill, page/page-token checkpoints, contact/lead mapping, scheduled retry cursors, manual retry-cursor preservation, disconnect refresh-token revocation/local credential cleanup evidence, and sync history are wired; Notification API channels, Accounts/Deals/activities fanout, connected-app/notification cleanup certification, and live Zoho certification remain before full availability."
	case isDynamics365CRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Microsoft Dynamics 365 OAuth credential refs, managed OAuth refresh, Dataverse /api/data/v9.2 Contacts and Leads backfill, OData nextLink checkpoints, contact/lead mapping, scheduled retry cursors, manual retry-cursor preservation, local managed credential cleanup evidence, and sync history are wired; change tracking/webhooks, Accounts/Opportunities/activities/list fanout, Microsoft Entra/app cleanup certification, and live Dataverse certification remain before full availability."
	case isKeapCRMSurface(item) && conn.Count > 0:
		return "needs_attention", "Keap OAuth/PAT/SAK Bearer credential refs, managed OAuth refresh when OAuth credentials are used, REST v2 Contacts backfill, optional tagged-contact pulls, page_token checkpoints, contact mapping, scheduled retry cursors, manual retry-cursor preservation, local managed credential cleanup evidence, and sync history are wired; full tag/campaign/order/appointment/webhook fanout, provider credential cleanup certification, and live Keap certification remain before full availability."
	case isRechargeSubscriptionSurface(item) && conn.Count > 0:
		return "needs_attention", "Recharge API-token credential refs, /subscriptions REST backfill, cursor checkpoints, scheduled retry cursors, canonical subscription mapping, tokenized subscription/charge webhook ingest with optional Recharge signature verification and durable delivery claims, subscription run history, persisted operator-managed provider_cleanup readiness evidence, and local cleanup acknowledgment are wired; live merchant certification remains before full availability."
	case isYotpoReviewSurface(item) && conn.Count > 0:
		return "needs_attention", "Yotpo app-key/secret credential refs, token exchange, /v1/apps/{app_key}/reviews REST backfill, count/page checkpoints, scheduled yotpo_retry continuation, lookup-only product/order UUID enrichment with order-line product fallback, resolved review customer_id linkage, customer metadata/profile/event evidence, tokenized review_create/review_updated ingest, WebhookMessageId idempotency, canonical review/reviewer/event mapping, review run history, unresolved product-refresh handoff metadata, persisted operator-managed provider_cleanup readiness evidence, and local cleanup acknowledgment are wired; signed verification, provider-managed webhook registration/cleanup automation, broader product refresh behavior, and live brand certification remain before full availability."
	case isSmileLoyaltySurface(item) && conn.Count > 0:
		return "needs_attention", "Smile.io API-token credential refs, /v1/customers REST backfill, /v1/points_transactions and /v1/reward_fulfillments historical plus incremental event polling, account-id-routed signed Smile app webhook ingest, integration-scoped loyalty_webhook_events delivery idempotency with body-hash conflict checks, page/cursor checkpoints, updated_at_min watermarks, scheduled smile_retry continuation with not-due filtering and SYNC_FAILED preservation, canonical loyalty member mapping, points balance/VIP tier profile state, loyalty event mapping including reward pending state, disconnect-safe local write guards, run history, persisted operator-managed provider_cleanup readiness evidence, and local operator acknowledgment are wired; managed cleanup automation and live store certification remain before full availability."
	case isZendeskSupportSurface(item) && conn.Count > 0:
		return "needs_attention", "Zendesk OAuth/API-token credential refs, Tickets API REST backfill, opt-in Incremental Export pulls, requester-user side-loading, cursor checkpoints, scheduled zendesk_retry continuation, signed Zendesk webhook ingest, sparse ticket-id callback refresh, durable callback idempotency, canonical support mapping, support run history, and best-effort stored-webhook deletion with persisted provider_cleanup evidence are wired; live workspace certification remains before full availability."
	case isIntercomSupportSurface(item) && conn.Count > 0:
		return "needs_attention", "Intercom OAuth-token credential refs, Conversations REST backfill, contact lookup fallback for conversations without safe requester email, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, signed app webhook ingest, sparse conversation refresh, durable callback idempotency, starting_after cursor checkpoints, scheduled intercom_retry continuation, canonical support/profile/message/event mapping, support run history, and persisted operator-managed provider_cleanup readiness evidence are wired; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live workspace certification remain before RuntimeAvailable promotion."
	case isHelpScoutSupportSurface(item) && conn.Count > 0:
		return "needs_attention", "Help Scout OAuth client-credential refs, mailbox-scoped Conversations REST backfill, paginated thread message pulls, customer fallback evidence, page checkpoints, scheduled help_scout_retry continuation, signed app webhook ingest, durable callback idempotency, sparse conversation refresh, canonical support/profile/message/event mapping, support run history, and persisted operator-managed provider_cleanup readiness evidence are wired; managed provider cleanup automation and live mailbox certification remain before full availability."
	case isFreshdeskSupportSurface(item) && conn.Count > 0:
		return "needs_attention", "Freshdesk API-key credential refs, account-domain normalized Tickets REST backfill, include=requester embedding, local product_id filtering, authenticated automation-webhook ingest, sparse ticket refresh, durable callback idempotency, page checkpoints, Retry-After-aware provider errors, scheduled freshdesk_retry continuation, canonical support/profile/event mapping, support run history, and persisted operator-managed provider_cleanup readiness evidence are wired; managed provider cleanup automation and live helpdesk certification remain before full availability."
	case isGorgiasSupportSurface(item) && conn.Count > 0:
		return "needs_attention", "Gorgias API-key credential refs, Tickets API REST backfill, embedded customer mapping, bounded payload-present Shopify/Recharge/order evidence preservation, lookup-only commerce order/customer/product UUID resolution with refresh-required miss handoff metadata, cursor checkpoints, scheduled gorgias_retry continuation, authenticated HTTP integration callbacks, sparse ticket-id callback refresh, durable callback idempotency, canonical support/profile/event sinks, support run history, and best-effort stored HTTP integration deletion with persisted provider_cleanup evidence are wired; official hmac_secret header certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain before full availability."
	case isSnowflakeWarehouseSurface(item) && conn.Count > 0:
		return "needs_attention", "Snowflake account, database, schema, warehouse, stage, and credential-reference validation, audit-safe manifest export/import runs, dry_run side-effect guards, stored handoff evidence, per-object JSONL load-plan artifacts, destination schema DDL/validation previews, snowflake_provider_job handoff evidence with ordered statement plans, linked SnowflakeSQLExecutor artifact verification plus export-copy/import-query execution metrics, opt-in SELECT 1 provider-health probe evidence, local cleanup acknowledgment, provider_driver_attachment=manifest_worker health, target URI evidence, retry_count prior-failure evidence, and warehouse run history are wired; live SQL/COPY account certification, certified live SELECT 1 provider health evidence, remote row materialization, reverse-ETL remote fetch, provider Retry-After behavior, and Snowflake-side cleanup proof remain before full availability."
	case isCommerceFoundation(item) && conn.Count > 0:
		return "needs_attention", fmt.Sprintf("%s has a managed commerce foundation saved; canonical customer, product, or order imports are required until provider pullers and callbacks are verified.", item.Name)
	case isShopifyCommerceSurface(item) && conn.Count > 0:
		return "needs_attention", "Shopify OAuth, registered signed webhook ingest including bulk-operation finish, privacy delete/data-request handling, encrypted install secrets, bounded and scheduled Admin GraphQL backfill, async Bulk Operation launch/poll/import, cart recovery, discount-code capture, retry/error state recording, and disconnect webhook cleanup are configured; live provider verification remains before full availability."
	case isManagedIngestFoundation(item) && conn.Count > 0:
		meta, _ := managedProviderMetadataForItem(item)
		return "needs_attention", fmt.Sprintf("%s has a managed canonical-ingest foundation saved; canonical %s imports are required until provider pullers and callbacks are verified.", item.Name, joinedOrDefault(meta.SyncObjects, "rows"))
	case isTypeformLeadSurface(item) && conn.Count > 0:
		return "needs_attention", "Typeform credential refs, Retrieve Form routing, Responses API backfill, managed webhook tag upsert/delete, Typeform-Signature verification, partial-response option, and scheduled retry cursors are wired; live Typeform US/EU certification remains before full availability."
	case conn.Connected:
		return "healthy", fmt.Sprintf("%s is configured and monitored through %s.", item.Name, surfaceLabel(item))
	case conn.Count > 0:
		return "needs_attention", fmt.Sprintf("%s has saved configuration but is not active.", item.Name)
	case item.RuntimeStatus == RuntimeDelegated:
		return "ready_to_configure", fmt.Sprintf("%s is configured through %s.", item.Name, surfaceLabel(item))
	default:
		return "not_configured", fmt.Sprintf("%s is not configured yet.", item.Name)
	}
}

func healthReport(item CatalogItem, conn Connection) HealthReport {
	conn = withConnectionHealth(item, conn)
	severity := "info"
	switch conn.HealthState {
	case "healthy":
		severity = "ok"
	case "action_required":
		severity = "error"
	case "needs_attention":
		severity = "warning"
	}
	return HealthReport{
		State:             conn.HealthState,
		Severity:          severity,
		Message:           conn.HealthMessage,
		MonitoringSurface: surfaceLabel(item),
		DocsURL:           item.DocsURL,
		Checks:            healthChecks(item, conn),
		RetryPolicy:       retryPolicyFor(item),
		SyncHistory:       syncHistoryFor(item, conn),
		AuditTrail:        auditTrailFor(item, conn),
		DataDelete:        dataDeleteFor(item),
	}
}

func healthReportWithHistory(item CatalogItem, conn Connection, history []SyncHistoryEntry) HealthReport {
	report := healthReport(item, conn)
	if len(history) > 0 {
		report.SyncHistory = history
	}
	return report
}

func healthChecks(item CatalogItem, conn Connection) []HealthCheck {
	ownershipState := "info"
	ownershipMessage := "This tile is delegated to a bridge, partner, marketplace, webhook, API, SDK, or migration surface."
	if item.Badge == BadgeNative {
		ownershipState = "ok"
		ownershipMessage = "Moosewave owns the setup, lifecycle, monitoring, and disconnect path for this connector surface."
		if isCommerceFoundation(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the canonical commerce ingest surface for this provider; provider pullers, callback routes, token lifecycle, and webhook subscription management are not verified yet."
		}
		if isWixStoresSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Wix Stores app-instance OAuth, credential-reference auth, Contacts/Catalog/Orders REST backfill, signed JWT app webhooks, lifecycle recovery, delete evidence, provider-event evidence, scheduled retries, and disconnect routing; the local runtime is complete, while live Wix dashboard event-name and payload certification remains."
		}
		if isWooCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns WooCommerce consumer-key/secret credential refs, fixed /wp-json/wc/v3 routing, Customers/Products/Orders/Refunds REST backfill, product variation pagination, managed webhook reconciliation through /webhooks, X-WC-Webhook-Signature HMAC verification, source/delivery idempotency, delete/coupon/refund/subscription provider-event evidence, manual and scheduled retries, sync-state decoding, and returned/persisted disconnect cleanup evidence for Moosewave-owned webhooks; live store certification remains."
		}
		if isBigCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns BigCommerce X-Auth-Token credential refs, fixed https://api.bigcommerce.com/stores/{store_hash} Admin REST routing, V3 customers/products, V2 orders, product variants, order products/coupons, managed /v3/hooks reconciliation, X-Postwave-Webhook-Secret custom-header verification, ID-only webhook fetch fanout, deletion/archive routing, refund/transaction evidence, scheduled retries, sync-state decoding, and disconnect hook cleanup; live store certification remains."
		}
		if isAdobeCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Adobe Commerce bearer-token credential-reference auth, PaaS/on-prem /rest/{store-view}/V1 routing, SaaS Store-header routing, REST backfill for customers/products/orders/credit memos, merchant-configured shared-secret/Bearer webhook verification, refund provider-event evidence, scheduled retries, sync-state decoding, and disconnect routing; live Magento/Adobe validation and managed webhook definition provisioning remain."
		}
		if isSquarespaceCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Squarespace API-key/OAuth credential-reference auth, Contacts/Products/Orders REST backfill, product detail enrichment, raw-body HMAC webhook verification, order fetch fallback, contact delete evidence, scheduled retries, sync-state decoding, and disconnect routing; live merchant-site validation and OAuth-only webhook subscription creation remain."
		}
		if isStripeCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Stripe restricted-key credential-reference auth, REST backfill for customers, Checkout Sessions, PaymentIntents, Charges with payment-method evidence, disputes, invoices, credit notes, subscriptions, and refunds, invoice line-item pagination, raw-body Stripe-Signature verification, customer delete evidence, provider-event evidence, scheduled retries, sync-state decoding, disconnect routing, and provider_cleanup readiness evidence for operator-managed Stripe-side cleanup; live account validation and secret rotation proof remain."
		}
		if isSquareCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Square OAuth/app-token credential-reference auth, REST backfill for customers, catalog products and deleted ITEM tombstones, orders, payments, and refunds, active-location discovery, raw-body HMAC webhook verification using the exact notification URL, catalog.version.updated product refresh, customer/product delete evidence, manual and scheduled retries, sync-state decoding, and disconnect routing; live merchant validation and dashboard cleanup proof remain."
		}
		if isPayPalCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns PayPal client-credential credential-reference auth, OAuth token exchange, Transaction Search backfill for customer/order/refund evidence, PayPal Verify Webhook Signature API validation with transmission headers and webhook ID, allowlisted sparse resource hydration for Orders, Captures, Refunds, Subscriptions, and Invoices, checkout/capture/sale order upserts, refund provider-event evidence, subscription/invoice/catalog-product provider-event evidence, scheduled retries, sync-state decoding, and disconnect routing; live merchant validation and dashboard cleanup proof remain."
		}
		if isRazorpayCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Razorpay Basic Auth credential-reference auth, REST backfill for customers, orders, payments, and refunds, raw-body X-Razorpay-Signature HMAC verification, x-razorpay-event-id idempotency, payment/order-backed canonical orders, refund provider-event evidence, scheduled retries, sync-state decoding, and disconnect routing; live account validation and dashboard cleanup proof remain."
		}
		if isHubSpotCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns HubSpot private-app/OAuth Bearer credential-reference auth, OAuth start/callback token storage, refresh, managed refresh-token revocation, CRM contact REST backfill through the current date-versioned CRM objects API, configured /crm/v3/lists/{listId}/memberships traversal with contact batch reads, provider-list segment evidence, and complete-scan stale repair for owned memberships, opt-in native Moosewave list membership adds through list_membership_map, opt-in /crm/objects/{version}/deals pulls with contact/company associations and batch reads, after-cursor pagination, contact/deal/company property mapping, app-level v3-signed contact webhooks with portal routing/idempotency, scheduled retry cursors, run history, and disconnect routing; live HubSpot certification remains before full availability, while historical legacy owner reconciliation and broader deal/account modeling are optional migration or future product scope."
		}
		if isSalesforceCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Salesforce connected-app OAuth start/callback, encrypted managed credential storage, OAuth Bearer credential-reference auth, proactive token refresh plus one-shot reactive INVALID_SESSION_ID refresh, SOQL Contact, Lead, CampaignMember, and Task backfill through /services/data/v67.0/query by default, Sforce-Query-Options batch sizing, nextRecordsUrl cursor checkpoints, scheduled salesforce_retry cursors, contact/lead mapping, CampaignMember CRM event fanout, provider-segment evidence, opt-in native Moosewave list membership adds, explicit removal-signal soft-removes, complete-scan stale repair for owned mapped Campaign memberships through campaign_membership_map, Task CRM activity fanout by Contact/Lead Who email, run history, refresh-token revocation on Moosewave disconnect, local managed credential deletion, and disconnect routing; live Salesforce certification remains."
		}
		if isPipedriveCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Pipedrive OAuth start/callback, /users/me install identity capture, encrypted refresh-token storage, automatic token refresh, refresh-token revocation on Moosewave disconnect, Basic-authenticated Pipedrive OAuth uninstall callbacks, API-token or OAuth Bearer credential-reference auth, backfill through /api/v2/persons, /api/v2/deals, /api/v2/organizations, and /api/v2/activities, limit/cursor checkpoints, person-to-contact mapping, deal event mapping, identity-safe organization enrichment, activity event mapping, managed person/deal/organization/activity webhook registration, Basic Auth verification, payload route identity checks, integration-scoped body-checked webhook idempotency, scheduled retry cursors, run history, row-preserving disconnect cleanup for stored Moosewave-owned webhooks, and local managed OAuth credential deletion before disconnect finalization; live Pipedrive certification remains."
		}
		if isCloseCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Close API-key credential-reference auth, /api/v1/contact/ offset backfill, contact-to-profile mapping, route-token public webhook lookup, close-sig-hash/close-sig-timestamp HMAC-SHA256 verification using the vault-backed subscription signature_key, integration-scoped body-checked CRM webhook idempotency, contact callback mapping, opportunity/task/activity event mapping with /api/v1/contact/{id} hydration when needed, scheduled retry cursors, run history, disconnect routing, and persisted operator-managed provider_cleanup evidence; live Close workspace certification remains."
		}
		if isZohoCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Zoho OAuth credential-reference auth, managed refresh, CRM V8 Contacts and Leads backfill through /crm/v8/{module}, per_page/page/page_token checkpoints, contact/lead mapping, scheduled retry cursors, manual retry-cursor preservation, run history, refresh-token revocation on Moosewave disconnect, local managed credential deletion, and disconnect routing; Notification API channels, Accounts/Deals/activities fanout, connected-app/notification cleanup certification, and live Zoho certification remain."
		}
		if isDynamics365CRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Microsoft Dynamics 365 OAuth credential-reference auth, managed refresh, Dataverse Contacts and Leads backfill through /api/data/v9.2/{entityset}, odata.maxpagesize paging, @odata.nextLink checkpoints, contact/lead mapping, scheduled retry cursors, manual retry-cursor preservation, run history, local managed credential deletion on Moosewave disconnect, provider revocation boundary evidence, and disconnect routing; change tracking/webhooks, Accounts/Opportunities/activities/list fanout, Microsoft Entra/app cleanup certification, and live Dataverse certification remain."
		}
		if isKeapCRMSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Keap OAuth/PAT/SAK Bearer credential-reference auth, managed OAuth refresh when OAuth credentials are used, REST v2 Contacts backfill through /rest/v2/contacts, optional /rest/v2/tags/{tag_id}/contacts pulls, page_token checkpoints, contact mapping, scheduled retry cursors, manual retry-cursor preservation, run history, local managed credential deletion on Moosewave disconnect, provider revocation boundary evidence, and disconnect routing; full tag/campaign/order/appointment/webhook fanout, provider credential cleanup certification, and live Keap certification remain."
		}
		if isZendeskSupportSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Zendesk OAuth/API-token credential-reference auth, /api/v2/tickets.json REST backfill, opt-in /api/v2/incremental/tickets/cursor pulls, /api/v2/tickets/{id}.json sparse-webhook refresh, include=users requester side-loading, cursor pagination, scheduled zendesk_retry continuation, signed X-Zendesk-Webhook-Signature ingest for ticket/comment callbacks, support_webhook_events delivery idempotency, canonical support ticket/profile/event mapping, run history, disconnect routing, best-effort DELETE /api/v2/webhooks/{id} for the stored zendesk_webhook_id, and provider_cleanup evidence for local shutdown plus remaining operator-managed trigger/credential/manual-target cleanup; live Zendesk workspace certification remains."
		}
		if isIntercomSupportSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Intercom OAuth-token credential-reference auth, /conversations REST backfill, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, /conversations/{id} sparse-webhook refresh, cached /contacts/{id} requester fallback, author/contact/assignee evidence, per_page/starting_after cursor pagination, scheduled intercom_retry continuation, signed X-Hub-Signature app webhook ingest, support_webhook_events delivery idempotency, canonical support ticket/profile/message/event mapping, run history, disconnect routing, and provider_cleanup readiness evidence for operator-managed Intercom-side cleanup; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live Intercom workspace certification remain before RuntimeAvailable promotion."
		}
		if isHelpScoutSupportSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Help Scout OAuth client-credential reference auth, /v2/oauth2/token exchange, /v2/conversations REST backfill with embed=threads, paginated /v2/conversations/{id}/threads fallback, /v2/conversations/{id} sparse-webhook refresh, mailbox/status routing, page checkpoints, scheduled help_scout_retry continuation, signed X-HelpScout-Signature app webhook ingest, support_webhook_events delivery idempotency, canonical support ticket/profile/message/event mapping, run history, disconnect routing, and provider_cleanup readiness evidence for operator-managed Help Scout-side cleanup; managed cleanup automation and live Help Scout mailbox certification remain."
		}
		if isFreshdeskSupportSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Freshdesk API-key credential-reference auth, account_domain normalization for acme.freshdesk.com-style desks, /api/v2/tickets REST backfill with include=requester embedding, /api/v2/tickets/{id} sparse-webhook refresh, optional local product_id filtering against returned ticket payloads, per_page/page checkpoints, scheduled freshdesk_retry continuation, authenticated automation-webhook ingest through a vault-backed shared secret header, support_webhook_events delivery idempotency, Retry-After-aware provider errors, canonical support ticket/profile/event mapping, run history, disconnect routing, and provider_cleanup readiness evidence for operator-managed Freshdesk-side cleanup; managed cleanup automation and live Freshdesk helpdesk certification remain."
		}
		if isGorgiasSupportSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Gorgias email/API-key credential-reference auth, /api/tickets REST backfill, /api/tickets/{id} sparse-webhook refresh, limit/cursor pagination, embedded customer email mapping, bounded payload-present Shopify/Recharge/order evidence extraction for ticket and message properties, lookup-only commerce order/customer/product UUID resolution against existing commerce rows when commerce_integration_id is configured, scheduled gorgias_retry continuation, authenticated HTTP integration callback ingest for ticket/message payloads, support_webhook_events delivery idempotency, canonical support ticket/profile/event sinks, run history, disconnect routing, and best-effort DELETE /api/integrations/{id} cleanup for stored Gorgias HTTP integration IDs; official hmac_secret header certification, rule/duplicate integration cleanup proof, API-key cleanup, and live Gorgias helpdesk certification remain."
		}
		if isYotpoReviewSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Yotpo app-key/secret credential-reference auth, token exchange through /oauth/token, /v1/apps/{app_key}/reviews REST backfill, count/page pagination, yotpo: cursor checkpoints, scheduled yotpo_retry continuation, lookup-only product/order UUID enrichment with existing order-line product fallback, resolved review customer_id linkage with customer metadata/profile/event evidence, tokenized review_create/review_updated public ingest, WebhookMessageId delivery idempotency, canonical review/reviewer/event sinks, run history, disconnect routing, unresolved product-refresh handoff metadata, and provider_cleanup readiness plus local acknowledgment evidence for operator-managed Yotpo-side cleanup; signed verification, provider-managed webhook registration/cleanup automation, broader product refresh behavior, and live Yotpo brand certification remain."
		}
		if isSmileLoyaltySurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Smile.io API-token credential-reference auth, /v1/customers REST backfill, /v1/points_transactions and /v1/reward_fulfillments historical plus incremental event polling, account_id routing and Smile-Signature app webhook verification for ping and customer/updated, integration-scoped loyalty_webhook_events delivery idempotency with body-hash conflict checks, page/cursor pagination, smile: checkpoints, updated_at_min watermarks, scheduled smile_retry continuation with not-due filtering and SYNC_FAILED preservation, canonical loyalty member profile upserts, points balance/VIP tier mapping, points/reward/customer update event mapping including reward pending state, run history, disconnect routing with local-write rechecks, and provider_cleanup readiness plus acknowledgment evidence for operator-managed Smile-side cleanup; managed webhook cleanup automation and live Smile.io store certification remain."
		}
		if isShopifyCommerceSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Shopify OAuth, webhook subscription reconciliation and disconnect cleanup, mandatory privacy deletion/data-request handling, encrypted install-secret storage, raw-body webhook verification, dedupe, canonical ingest, bounded scheduled Admin GraphQL backfill, async Bulk Operation launch/poll/import, bulk_operations/finish JSONL import, shopify_bulk: retry and line-offset cursors, cart recovery, and discount-code capture with retry/error state recording; live provider verification remains before full availability."
		}
		if isManagedIngestFoundation(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the canonical ingest/import surface for this provider; provider pullers, callback routes, token lifecycle, and webhook subscription management are not verified yet."
		}
		if isGoogleLeadFormsSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Google Ads OAuth/developer-token credential-reference auth, GoogleAdsService.Search pulls through /customers/{customer_id}/googleAds:search, GAQL asset/campaign filtering, LIMIT 1000 batches, submission_date_time/id watermark cursors, connect-time history import, scheduled retry cursors, standard/custom field mapping, run history, disconnected-row guards, and returned/persisted operator-managed provider_cleanup readiness evidence; live Google Ads account/API certification, ownership/export-window evidence, duplicate/manual CRM export audit, and data-delete proof remain."
		}
		if item.Slug == "meta" && hasSource(item, "audience_destination") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the Meta Custom Audiences control plane, credential-reference storage, runtime secret hydration, consent firewall, EMAIL_SHA256 member hashing, chunked Graph v25.0 /users delivery adapter, Retry-After-aware transient chunk retries, safe Meta response counter evidence, batch/run history, and returned/persisted operator-managed provider_cleanup readiness evidence on disconnect; live Meta app review, ad-account quota validation, and provider-side cleanup certification remain."
		}
		if item.Slug == "google-ads" && hasSource(item, "audience_destination") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the Google Ads Customer Match control plane for the Data Manager slice: credential-reference storage, runtime secret hydration, targeted-ads consent firewall, SHA-256 email hashing, default chunked audienceMembers:ingest delivery, explicit audienceMembers:remove cleanup delivery, Retry-After-aware transient chunk retry, persisted single or multi-requestId evidence, on-demand requestStatus:retrieve diagnostics, background provider-result polling with bounded backoff, and returned/persisted operator-managed provider_cleanup readiness evidence on disconnect. Legacy OfflineUserDataJob remains an explicitly gated fallback outside this local-complete slice; live Google Ads/Data Manager certification and provider-side account/list/token cleanup remain."
		}
		if item.Slug == "tiktok" && hasSource(item, "audience_destination") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the TikTok Audiences control plane, credential-reference storage, runtime secret hydration, targeted-ads consent firewall, SHA-256 email hashing, multipart DMP Customer File upload, custom-audience create/update calls, Retry-After-aware transient retry, on-demand/background custom-audience status readback, and returned/persisted operator-managed provider_cleanup readiness evidence on disconnect; live TikTok advertiser certification, quota validation, REMOVE/REPLACE provider-side certification, and provider-side cleanup remain."
		}
		if item.Slug == "linkedin" && hasSource(item, "audience_destination") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the LinkedIn Matched Audiences control plane, credential-reference storage, runtime secret hydration, targeted-ads consent firewall, SHA-256 email hashing with whitespace removal, sequential 5,000-user DMP segment add/remove batch delivery, per-element batch failure handling, Retry-After-aware transient retry, segment readback evidence, on-demand/background DMP segment status polling, batch/run history, and returned/persisted operator-managed provider_cleanup readiness evidence on disconnect; live LinkedIn Audiences-program certification, account-role/quota validation, replacement semantics, and provider-side cleanup remain."
		}
		if item.Slug == "snap" && hasSource(item, "audience_destination") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the Snap Audiences control plane, credential-reference storage, runtime secret hydration, targeted-ads consent firewall, SHA-256 email hashing, nested EMAIL_SHA256 segment-user add/remove payloads, sequential 100,000-user batch delivery, explicit REMOVE/REPLACE request construction, Retry-After-aware transient retry, on-demand/background segment status readback, request-id/batch/run history, and returned/persisted operator-managed provider_cleanup readiness evidence on disconnect; live Snap account certification, remove/replace provider-side certification, quota validation, and provider-side cleanup remain."
		}
		if isTypeformLeadSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Typeform personal-token or externally managed OAuth access-token credential-reference auth, Retrieve Form routing with response-link awareness, Responses API pull/backfill, after-cursor pagination, page-size caps, managed /forms/{form_id}/webhooks/{tag} upsert/delete, Typeform-Signature raw-body HMAC verification, durable webhook delivery idempotency, optional partial-response event subscription, canonical profile/event mapping, scheduled retries, sync-state decoding, and returned/persisted provider_cleanup evidence for managed webhook disconnect cleanup; live Typeform US/EU certification remains."
		}
		if isWixLeadSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Wix Forms and Contacts app-instance OAuth, credential-reference auth, REST backfill, signed JWT app webhooks, lifecycle recovery, contact-delete evidence, scheduled retries, and disconnect routing; the local runtime is complete, while live Wix dashboard event-name, namespace, and payload certification remains."
		}
		if isFilloutLeadSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Fillout Bearer credential-reference auth, US/EU/custom API base URL routing, form metadata, submissions REST backfill, offset/limit pagination, submitted question/calculation/url-parameter/scheduling/payment mapping, auto-registered /webhook/create URL-token webhooks, webhook token verification from query/header/Bearer auth, durable idempotency, scheduled retries, sync-state decoding, and returned/persisted provider_cleanup evidence for managed /webhook/delete cleanup; live US/EU/self-hosted provider certification remains."
		}
		if isJotformLeadSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Jotform API-key credential-reference auth with APIKEY headers, Standard/EU/HIPAA/custom API host routing, form and question metadata pulls, form-scoped submissions REST backfill, offset/limit pagination, managed /form/{formID}/webhooks list/reuse/create/delete, shared-token verification from query/header/Bearer auth, JSON/form-url-encoded/multipart webhook decoding, durable idempotency, scheduled retries, sync-state decoding, and returned/persisted provider_cleanup evidence for managed webhook cleanup; live Jotform account certification remains."
		}
		if isWebflowLeadSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Webflow Bearer credential-reference auth, Data API v2 /v2/sites/{site_id}/form_submissions and /v2/sites/{site_id}/forms/{form_id}/submissions backfill, elementId filtering, limit/offset pagination, form-response mapping, stored /v2/webhooks/{webhook_id} validation, managed /v2/sites/{site_id}/webhooks repair/reuse/create, endpoint-match cleanup fallback, x-webflow-timestamp and x-webflow-signature HMAC verification, timestamp replay checks, form-aware webhook routing, durable delivery idempotency, scheduled retries, sync-state decoding, and returned/persisted provider_cleanup evidence for managed webhook disconnect cleanup; live Webflow site certification remains."
		}
		if isFacebookLeadAdsSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns Facebook Lead Ads Meta Graph credential-reference auth, /{form_id}/leads explicit and scheduled pulls, managed Page leadgen subscription reconciliation and disconnect cleanup, signed leadgen webhook ingest, lead-ID follow-up fetch, durable delivery claims, canonical submission mapping, sync-state decoding, and returned/persisted provider_cleanup evidence for the managed Page subscription cleanup; page/form ownership certification and live Meta app-review evidence remain partial."
		}
		if hasSource(item, "warehouse") && item.RuntimeStatus == RuntimeDelegated {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the warehouse lifecycle and run history; current object-storage execution uses the configured Moosewave storage adapter, while direct tenant-bucket delivery remains provider-driver work."
		}
		if hasSource(item, "warehouse") && item.RuntimeStatus == RuntimePartial {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the warehouse lifecycle, manifests, health, row-preserving disconnect path, and persisted provider_cleanup readiness evidence; provider API execution and provider-side cleanup remain manifest-driver/operator work before this can be called fully native."
		}
		if isSnowflakeWarehouseSurface(item) {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns the Snowflake warehouse connection control plane, account/database/schema/warehouse validation, qualified stage validation, audit-safe credential references, stored manifest export handoff artifacts, per-object JSONL load-plan artifacts, destination schema DDL/validation previews, typed provider-job request evidence with ordered statement plans, linked local executor artifact verification and SQL export/health execution, opt-in SELECT 1 provider-health probe plumbing, dry_run no-side-effect planning, import mapping mutation guards, import run history, row-preserving disconnect with config.provider_cleanup readiness evidence, local provider-cleanup/acknowledge attestation, disconnected health state, and provider_driver_attachment health; live Snowflake SQL/COPY account certification evidence, Snowflake-side cleanup automation, remote row materialization, certified live SELECT 1 health evidence, reverse-ETL remote fetch, and full live account certification remain."
		}
		if hasSource(item, "sending") {
			ownershipState = "warning"
			ownershipMessage = "Moosewave owns parts of the sending, provisioning, and deliverability surface; direct provider send APIs, provider-side setup, and official webhook verification are not fully verified for this tile yet."
		}
		if hasSource(item, "sms") {
			ownershipState = "warning"
			ownershipMessage = "The SMS provider runtime is release-held. Moosewave does not claim live send, A2P, billing, callback, end-to-end MMS, or hosted multi-tenant credential readiness until durable reconciliation and a tenant-bound provider-vault lifecycle are deployed."
		}
	}
	if isKlaviyoMigrationSurface(item) {
		ownershipState = "warning"
		ownershipMessage = "Moosewave owns the Klaviyo migration adapter, private API-key session validation, revision-pinned JSON:API profile/list/segment/flow/campaign/template import, source-archive rebuild-task capture, and changed-profile source-event monitoring; public-app OAuth, native-provider Webhooks API live certification, native-row writeback live certification, provider-side key revocation, and live Klaviyo account certification belong to the separate native row."
	}
	if isKlaviyoNativeSurface(item) {
		ownershipState = "warning"
		ownershipMessage = "Moosewave owns the Klaviyo native provider row, credential-reference-only setup, managed public-app OAuth install/refresh/revoke, row-preserving pause/disconnect, provider-cleanup guidance plus local acknowledgement, marketing sync run history, marketing webhook delivery history, native JSON:API profile/list/segment/source-event pulls, signed system-webhook verification, managed Klaviyo Webhooks API subscription reconciliation/cleanup for allowlisted credentials, versioned klaviyo_native cursors, scheduled provider-row polling, and integration-writeback for existing-profile properties, list adds, and custom events. OAuth live certification, Webhooks API live allowlist certification, writeback live certification, provider-side cleanup certification, and live Klaviyo account certification remain before promotion."
	}
	if isMarketingNativeSurface(item) && !isKlaviyoNativeSurface(item) {
		meta, _ := managedProviderMetadataForItem(item)
		ownershipState = "warning"
		ownershipMessage = "Moosewave owns the " + meta.Name + " native provider row, credential-reference-only setup, row-preserving pause/disconnect, provider-cleanup guidance, marketing sync run history, and delegated handoff/retry cursor evidence. Provider API import still delegates to the migration adapter; native webhook subscription/verification, source-event polling where unsupported, writeback, cleanup automation, and live account certification remain before promotion."
	}
	if item.Badge == BadgePlanned || item.RuntimeStatus == RuntimePlanned {
		ownershipState = "planned"
		ownershipMessage = "This tile is visible for parity accounting; native auth and sync are not yet shipped."
	}

	authState := "pending"
	authMessage := "No saved connection was detected."
	if conn.Count > 0 {
		authState = "ok"
		authMessage = fmt.Sprintf("%d saved configuration row(s) detected.", conn.Count)
	}
	if conn.LastError != "" {
		authState = "error"
		authMessage = conn.LastError
	}

	syncState := "pending"
	syncMessage := "No sync, delivery, or ingest run has been observed yet."
	if conn.LastSyncAt != nil {
		syncState = "ok"
		syncMessage = "Latest observed activity is recorded on the owning surface."
	}
	if conn.LastError != "" {
		syncState = "error"
		syncMessage = "Latest observed run needs operator review."
	}
	if item.RuntimeStatus == RuntimePlanned {
		syncState = "planned"
		syncMessage = "Run history will appear after this connector is implemented."
	}
	if isCommerceFoundation(item) {
		syncState = "warning"
		syncMessage = "Sync/backfill requires canonical customers, products, or orders; empty requests are rejected until provider-managed pullers are implemented."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest canonical commerce import activity is recorded on the owning surface."
		}
	}
	if isWixStoresSurface(item) {
		syncState = "warning"
		syncMessage = "Wix Stores /sync and /backfill can pull Contacts, Catalog V1/V3 products, and eCommerce orders with retry cursors; signed app webhooks can upsert/fetch contacts, products, orders, deletes, and adjacent provider events. No live Wix certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Wix Stores REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isWooCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "WooCommerce /sync and /backfill can pull Customers, Products with product variations, Orders with coupon/refund attribution, read-only Refunds, and optional Subscriptions extension snapshots using per_page/page plus X-WP-TotalPages cursors; manual and scheduled provider pulls share Retry-After-aware woocommerce_retry cursors. Signed webhooks can upsert/delete core commerce rows and record coupon/refund/subscription provider events. No live WooCommerce certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest WooCommerce REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isBigCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "BigCommerce /sync and /backfill can pull V3 Customers, Catalog Products/images/variants, and V2 Orders enriched with order products/coupons using page/limit and X-Rate-Limit-Time-Reset-Ms aware cursors; managed hooks fetch canonical rows for customer/product/order/inventory/status changes and record refund/transaction provider events. No live BigCommerce certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest BigCommerce REST pull or verified managed webhook ingest is recorded on the commerce surface."
		}
	}
	if isAdobeCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "Adobe Commerce /sync and /backfill can pull Customers, Products, Orders, and Credit Memos with searchCriteria currentPage/pageSize pagination, ascending entity sorting, PaaS /rest/V1 or SaaS Store-header routing, and Retry-After aware cursors; merchant-configured webhooks can upsert customer/product/order snapshots and record refund evidence. No live Adobe Commerce certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Adobe Commerce REST pull or verified merchant-configured webhook ingest is recorded on the commerce surface."
		}
	}
	if isSquarespaceCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "Squarespace /sync and /backfill can pull Contacts, product-list pages plus product-detail enrichment, and Orders with Retry-After aware cursors; signed webhooks can upsert/fetch orders, upsert/delete contacts, and handle extension uninstall. No live Squarespace certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Squarespace REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isStripeCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "Stripe /sync and /backfill can pull Customers, Checkout Sessions, PaymentIntents, Charges with payment-method evidence, disputes, invoices with full line-item pagination, credit notes, subscriptions, and refunds with Retry-After aware cursors; signed webhooks can upsert orders/customers, record charge/dispute/invoice/credit-note/refund/subscription provider events, and delete customers. No live Stripe certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Stripe REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isSquareCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "Square /sync and /backfill can pull Customers, Catalog ITEM products, variations, and deleted ITEM tombstones, Orders, Payments, and Refunds with Retry-After aware cursors; signed webhooks can refresh one bounded catalog product page, upsert payment-backed orders, upsert/delete customers, and record refund provider events. No live Square certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Square REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isPayPalCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "PayPal /sync and /backfill can pull Transaction Search windows with OAuth Bearer tokens, RFC3339 start/end bounds, page/page_size pagination, 31-day windowing, and Retry-After aware cursors; verified webhooks can hydrate sparse allowlisted PayPal resources, upsert checkout/capture/sale orders, and record refund/subscription/invoice provider events. No live PayPal certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest PayPal Transaction Search pull or verified webhook ingest is recorded on the commerce surface."
		}
	}
	if isRazorpayCommerceSurface(item) {
		syncState = "warning"
		syncMessage = "Razorpay /sync and /backfill can pull Customers, Orders, Payments, and Refunds with count/skip pagination, UNIX timestamp filters, and Retry-After aware cursors; signed webhooks can upsert payment/order-backed orders and record refund provider events. No live Razorpay certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Razorpay REST pull or signed webhook ingest is recorded on the commerce surface."
		}
	}
	if isHubSpotCRMSurface(item) {
		syncState = "warning"
		syncMessage = "HubSpot /sync and /backfill can pull CRM contacts with Bearer auth, /crm/objects/2026-03/contacts by default, page-size caps, configured contact properties, after-cursor checkpoints, optional configured list-membership fanout through /crm/v3/lists/{listId}/memberships plus contact batch reads with provider-list segment evidence, optional list_membership_map materialization into native Moosewave lists, complete-scan stale repair for owned memberships, optional sync_deals fanout through /crm/objects/2026-03/deals with contact/company associations plus batch reads, and scheduled retry continuation. Signed app webhooks can refresh changed contacts by portalId/objectId. Live HubSpot certification remains; historical owner reconciliation and richer deal/account modeling are optional migration or future product scope."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest HubSpot CRM contact/list-membership/deal-event REST pull or canonical CRM import is recorded on the CRM integrations surface."
		}
	}
	if isSalesforceCRMSurface(item) {
		syncState = "warning"
		syncMessage = "Salesforce /sync and /backfill can pull Contacts, Leads, CampaignMembers, and Tasks with OAuth Bearer auth, managed token refresh, one-shot reactive INVALID_SESSION_ID refresh, /services/data/v67.0/query by default, Sforce-Query-Options batch sizing, nextRecordsUrl checkpoints, CampaignMember CRM event mapping, optional campaign_membership_map materialization into native Moosewave list adds, explicit removal-signal soft-removes, complete-scan stale repair for owned mapped Campaign memberships, Task CRM activity mapping through TYPEOF Who Contact/Lead emails, and scheduled salesforce_retry continuation. Live Salesforce certification remains before full availability; CDC/Platform Events are a future streaming enhancement outside this SOQL runtime slice."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Salesforce SOQL contact/lead/CampaignMember/Task pull or canonical CRM import is recorded on the CRM integrations surface."
		}
	}
	if isPipedriveCRMSurface(item) {
		syncState = "warning"
		syncMessage = "Pipedrive /sync and /backfill can pull persons, deals, organizations, and activities with API-token query auth or OAuth Bearer auth, Pipedrive API v2 limit/cursor pagination, person-to-contact mapping, deal event mapping, identity-safe organization enrichment, activity event mapping, optional managed provider webhook ingest with route identity checks, and scheduled pipedrive_retry continuation with not-due filtering and SYNC_FAILED preservation. Live Pipedrive certification remains."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Pipedrive persons/deals/organizations/activities REST pull, managed webhook ingest, or canonical CRM import is recorded on the CRM integrations surface."
		}
	}
	if isCloseCRMSurface(item) {
		syncState = "warning"
		syncMessage = "Close /sync and /backfill can pull contacts through /api/v1/contact/ with Basic auth, _skip/_limit pagination, close: cursors, and scheduled close_retry continuation. Route-token public webhooks verify close-sig-hash/close-sig-timestamp HMAC signatures, upsert contact callbacks, and track opportunity/task/activity callbacks with /api/v1/contact/{id} hydration when needed. Live Close certification, managed webhook subscription cleanup, credential/signature-key rotation, reconnect, and data-delete proof remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Close contacts REST pull, signed webhook ingest, or canonical CRM import is recorded on the CRM integrations surface."
		}
	}
	if isZohoCRMSurface(item) {
		syncState = "warning"
		syncMessage = "Zoho CRM /sync and /backfill can pull Contacts and Leads with Authorization: Zoho-oauthtoken, /crm/v8/Contacts and /crm/v8/Leads, per_page/page/page_token pagination, contact/lead mapping, scheduled zoho_retry continuation, and manual retry-cursor skip/resume/failure preservation. Accounts, Deals, activities, Notification API channels, cleanup certification, and live Zoho certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Zoho CRM V8 contact/lead pull or canonical contact import is recorded on the CRM integrations surface."
		}
	}
	if isDynamics365CRMSurface(item) {
		syncState = "warning"
		syncMessage = "Microsoft Dynamics 365 /sync and /backfill can pull Dataverse Contacts and Leads with OAuth Bearer auth, /api/data/v9.2/contacts and /api/data/v9.2/leads, odata.maxpagesize paging, @odata.nextLink checkpoints, contact/lead mapping, scheduled dynamics365_retry continuation, and manual retry-cursor skip/resume/failure preservation. Accounts, Opportunities, activities, marketing lists, change tracking/webhooks, cleanup certification, and live Dataverse certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Dynamics 365 Dataverse contact/lead pull or canonical contact import is recorded on the CRM integrations surface."
		}
	}
	if isKeapCRMSurface(item) {
		syncState = "warning"
		syncMessage = "Keap /sync and /backfill can pull Contacts with Bearer auth, /rest/v2/contacts, optional /rest/v2/tags/{tag_id}/contacts, page_size caps, page_token pagination, filter/order_by support, contact mapping, scheduled keap_retry continuation, and manual retry-cursor skip/resume/failure preservation. Full tag membership, campaigns, orders, appointments, webhooks, cleanup certification, and live Keap certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Keap REST v2 contact pull or canonical contact import is recorded on the CRM integrations surface."
		}
	}
	if isShopifyCommerceSurface(item) && conn.LastSyncAt == nil {
		syncState = "warning"
		syncMessage = "Live Shopify webhooks plus one-page, /backfill?mode=bulk, mode=bulk_async Admin GraphQL Bulk Operations, bulk_operations/finish imports, and scheduled Admin GraphQL continuation can ingest customers, products, orders, cart recovery links, and discount-code metadata; live provider verification remains before full availability."
	}
	if isManagedIngestFoundation(item) {
		syncState = "warning"
		meta, _ := managedProviderMetadataForItem(item)
		syncMessage = fmt.Sprintf("Sync/backfill requires canonical %s; empty requests are rejected until provider-managed pullers are implemented.", joinedOrDefault(meta.SyncObjects, "rows"))
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest canonical ingest/import activity is recorded on the owning surface."
		}
	}
	if isGoogleLeadFormsSurface(item) {
		syncState = "warning"
		syncMessage = "Google Lead Form Extensions /sync and /backfill can pull lead_form_submission_data with OAuth Bearer auth, developer-token headers, optional login-customer-id, GoogleAdsService.Search, GAQL asset/campaign filters, LIMIT 1000 batches, submission_date_time/id watermark cursors, connect-time history import, scheduled google_lead_forms_retry continuation, and canonical lead mapping. Live Google Ads account/API certification, ownership/export-window evidence, duplicate/manual CRM export audit, and data-delete proof remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Google Lead Form Extensions Google Ads Search pull or canonical lead import is recorded on the lead integrations surface; live Google Ads certification still determines full availability."
		}
	}
	if isRechargeSubscriptionSurface(item) {
		syncState = "warning"
		syncMessage = "Recharge /sync and /backfill can pull Subscriptions with X-Recharge-Access-Token auth, limit/cursor pagination, scheduled recharge_retry continuation, and canonical subscription mapping; tokenized public ingest can verify X-Recharge-Hmac-Sha256 when configured, claim deliveries durably, and map subscription/charge webhooks. Disconnect returns and persists operator-managed provider_cleanup readiness evidence, and local cleanup acknowledgment records operator attestation. Live Recharge certification remains."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Recharge subscription REST pull, canonical import, or tokenized webhook ingest is recorded on the subscription integrations surface."
		}
	}
	if isYotpoReviewSurface(item) {
		syncState = "warning"
		syncMessage = "Yotpo /sync and /backfill can exchange app_key/secret for a token, pull /v1/apps/{app_key}/reviews with count/page pagination capped at 100, persist yotpo: checkpoints, run scheduled yotpo_retry continuation, perform lookup-only product/order evidence resolution to existing commerce UUIDs, resolve product_id from matched existing order line items after order lookup, map customer evidence to the canonical review customer_id column plus metadata/profile/event properties when commerce_integration_id is configured, map product reviews into canonical review/profile/event sinks, and accept tokenized review_create/review_updated public ingest with integration-scoped WebhookMessageId dedupe and body-hash conflict checks. Review payload product evidence does not create or refresh commerce product rows; unresolved misses carry product_refresh_required handoff metadata, provider-pulled local write failures preserve SYNC_FAILED retry cursors, disconnect-safe guards re-check rows before local writes, disconnect persists provider_cleanup readiness evidence, and the acknowledgment endpoint records local operator attestation, while signed verification, provider-managed webhook registration/cleanup automation, broader product refresh behavior, and live brand certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Yotpo Reviews REST pull, tokenized review webhook ingest, or canonical review import is recorded on the review integrations surface."
		}
	}
	if isSmileLoyaltySurface(item) {
		syncState = "warning"
		syncMessage = "Smile.io /sync and /backfill can pull /v1/customers with Bearer auth, then /v1/points_transactions and /v1/reward_fulfillments for historical and incremental loyalty events using cursor pagination plus updated_at_min after smile:complete, persist smile: checkpoints, run scheduled smile_retry continuation, preserve SYNC_FAILED retry cursors for fully failed local writes, refresh member state during event phases, and map points balance, VIP tier, points changes, and reward fulfillment state including pending into canonical loyalty sinks. Signed app webhooks require configured account_id routing, verify Smile-Signature, claim deliveries in loyalty_webhook_events with integration-scoped body-hash checks, ignore ping, and map customer/updated into member refresh plus loyalty.customer_updated events; live store certification remains."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Smile.io Customers/points/rewards REST pull, incremental event poll, or canonical loyalty import is recorded on the loyalty integrations surface."
		}
	}
	if isZendeskSupportSurface(item) {
		syncState = "warning"
		syncMessage = "Zendesk /sync and /backfill can pull Tickets with OAuth Bearer or email/token Basic auth, /api/v2/tickets.json by default or opt-in /api/v2/incremental/tickets/cursor, include=users requester email side-loading, cursor pagination, scheduled zendesk_retry continuation, and canonical support mapping; the public Zendesk webhook endpoint verifies X-Zendesk-Webhook-Signature plus timestamp, claims callback deliveries, maps ticket/comment callbacks, and refreshes sparse ticket-id callbacks through /api/v2/tickets/{id}.json. Disconnect best-effort deletes the stored Zendesk webhook id and persists provider_cleanup evidence; live Zendesk certification remains."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Zendesk ticket REST pull, signed webhook ingest, or canonical support import is recorded on the support integrations surface."
		}
	}
	if isIntercomSupportSurface(item) {
		syncState = "warning"
		syncMessage = "Intercom /sync and /backfill can pull Conversations with OAuth Bearer auth, /conversations, per_page caps, starting_after cursor pagination, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, cached contact lookup fallback, author/contact/assignee evidence, scheduled intercom_retry continuation, and canonical support/profile/message/event mapping; the public Intercom webhook endpoint verifies X-Hub-Signature, claims callback deliveries, maps full conversation callbacks including embedded messages, and refreshes sparse conversation-id callbacks through /conversations/{id}. Disconnect persists provider_cleanup readiness evidence; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live Intercom certification remain before RuntimeAvailable promotion."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Intercom conversation REST pull, signed webhook ingest, or canonical support import is recorded on the support integrations surface."
		}
	}
	if isHelpScoutSupportSurface(item) {
		syncState = "warning"
		syncMessage = "Help Scout /sync and /backfill can exchange OAuth client credentials, pull mailbox-scoped Conversations from /v2/conversations with status filters, embed=threads, and page checkpoints, fall back to /v2/conversations/{id}/threads for customer fallback and support messages, continue due installs with scheduled help_scout_retry cursors, accept signed X-HelpScout-Signature app webhooks with durable delivery claims, refresh sparse conversation callbacks through /v2/conversations/{id}, and map canonical support/profile/message/event rows. Disconnect persists provider_cleanup readiness evidence; managed cleanup automation and live Help Scout certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Help Scout conversation/thread REST pull or canonical support import is recorded on the support integrations surface."
		}
	}
	if isFreshdeskSupportSurface(item) {
		syncState = "warning"
		syncMessage = "Freshdesk /sync and /backfill can pull Tickets with API-key Basic auth, /api/v2/tickets?include=requester, per_page/page checkpoints, optional local product_id filtering, scheduled freshdesk_retry continuation, Retry-After-aware provider errors, and canonical support/profile/event mapping from ticket or embedded requester emails; the public Freshdesk webhook endpoint authenticates automation callbacks with a shared secret header, claims callback deliveries, maps full ticket callbacks, and refreshes sparse ticket-id callbacks through /api/v2/tickets/{id}?include=requester. Disconnect persists provider_cleanup readiness evidence; managed cleanup automation and live Freshdesk certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Freshdesk ticket REST pull, authenticated webhook ingest, or canonical support import is recorded on the support integrations surface."
		}
	}
	if isGorgiasSupportSurface(item) {
		syncState = "warning"
		syncMessage = "Gorgias /sync and /backfill can pull Tickets with email/API-key Basic auth, /api/tickets, limit/cursor pagination, embedded customer email mapping, payload-present Shopify/Recharge/order evidence preservation, lookup-only commerce order/customer/product UUID resolution with refresh-required miss handoff metadata, scheduled gorgias_retry continuation, and canonical support/profile/event sinks; the public Gorgias HTTP integration callback endpoint authenticates shared-secret or compatible HMAC headers, claims callback deliveries, maps ticket/message payloads, and refreshes sparse ticket-id callbacks through /api/tickets/{id}. Disconnect best-effort deletes stored gorgias_http_integration_id values through DELETE /api/integrations/{id} and persists provider_cleanup evidence; official hmac_secret header certification, rule/duplicate integration cleanup proof, API-key cleanup, and live Gorgias certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Gorgias ticket REST pull, authenticated HTTP callback, or canonical support import is recorded on the support integrations surface."
		}
	}
	if isSnowflakeWarehouseSurface(item) {
		syncState = "warning"
		syncMessage = "Snowflake warehouse runs validate account/database/schema/warehouse/stage settings and record auditable manifests with provider_target_uri, stored handoff bundle metadata, per-object JSONL load-plan artifacts, destination schema DDL/validation previews, ordered snowflake_provider_job statement plans, snowflake_load_plan_state, snowflake_provider_job_state, snowflake_provider_execution_state/local executor metrics, opt-in SELECT 1 provider-health probe evidence on the connection health route, retry_count prior-failure evidence, and provider_driver_attachment=manifest_worker. dry_run export/import runs preserve a run record while skipping artifact writes, executor calls, product-event materialization, row-error inserts, and cursor advancement. Export runs keep delivery_state=prepared_manifest while the linked SnowflakeSQLExecutor verifies artifacts and executes ready COPY/query/health statements; import runs with no staged rows record loader_state=import_plan_ready when import_table prerequisites are present, otherwise waiting_for_provider_driver. Live Snowflake account certification, returned-row materialization, provider-aware backoff proof, and Snowflake-side cleanup proof remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Snowflake warehouse manifest run is recorded with stored handoff, load/import-plan, retry, dry-run, provider-job, and SQL executor evidence where prerequisites are configured; provider_driver_attachment remains manifest_worker while live Snowflake account certification, remote import materialization, provider-aware retry proof, and Snowflake-side cleanup proof stay open."
		}
	}
	if isTypeformLeadSurface(item) {
		syncState = "warning"
		syncMessage = "Typeform /sync and /backfill can pull Retrieve Form metadata and Responses API pages with page_size, response_type, and after-cursor traversal; managed signed form_response and optional form_response_partial webhooks can ingest raw-body verified callbacks. No live Typeform certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Typeform response pull or signed webhook ingest is recorded on the lead integration surface."
		}
	}
	if isWixLeadSurface(item) {
		syncState = "warning"
		syncMessage = "Wix /sync and /backfill can pull Forms submissions and Contacts; signed app webhooks can fetch ID-only submissions/contacts before ingest, and contact-delete deliveries are verified and deduped as provider evidence. No live Wix certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Wix Forms/Contacts REST pull or signed webhook ingest is recorded on the lead integration surface."
		}
	}
	if isFilloutLeadSurface(item) {
		syncState = "warning"
		syncMessage = "Fillout /sync and /backfill can pull form metadata and submissions via /forms/{formId}/submissions with limit/offset, filters, totalResponses/pageCount-aware cursors, and generic retry cursors; URL-token webhooks can ingest direct/enveloped submission payloads. No live Fillout certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Fillout submissions REST pull or URL-token webhook ingest is recorded on the lead integration surface."
		}
	}
	if isJotformLeadSurface(item) {
		syncState = "warning"
		syncMessage = "Jotform /sync and /backfill can pull forms, questions, and submissions via /form/{formID}, /form/{formID}/questions, and /form/{formID}/submissions with offset/limit cursors; shared-token webhooks can ingest JSON, form-url-encoded, and multipart submissions. No live Jotform certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Jotform submissions REST pull or shared-token webhook ingest is recorded on the lead integration surface."
		}
	}
	if isWebflowLeadSurface(item) {
		syncState = "warning"
		syncMessage = "Webflow /sync and /backfill can pull site-level or form-scoped submissions via /v2/sites/{site_id}/form_submissions and /v2/sites/{site_id}/forms/{form_id}/submissions with elementId filtering, limit/offset cursors, pagination totals, and Retry-After-aware retry cursors; signed form_submission webhooks resolve by site plus form/form-element scope, use durable delivery idempotency, and ingest JSON payloads. No live Webflow certification run has been recorded yet."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Webflow Data API pull or signed form_submission webhook ingest is recorded on the lead integration surface."
		}
	}
	if hasSource(item, "sending") {
		syncState = "warning"
		syncMessage = "Campaign delivery currently routes through the Moosewave send loop/Listmonk messenger, and provider webhooks provide deliverability feedback; direct provider send API sync/backfill is pending."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest send-loop or deliverability-provider activity is recorded on the owning surface."
		}
	}
	if isKlaviyoMigrationSurface(item) {
		syncState = "warning"
		syncMessage = "Klaviyo migrations can backfill Profiles with subscriptions/predictive analytics, Lists, Segments, Flows with actions, Campaigns, Templates, and source-archive rebuild tasks through JSON:API cursor pagination; source-event monitoring polls changed profiles with filter=greater-than(updated,...) and sort=updated. Native Klaviyo public-app OAuth, webhooks, writeback, and live certification belong to the separate native row."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Klaviyo API import or source-event monitor run is recorded on the migration surface."
		}
	}
	if isKlaviyoNativeSurface(item) {
		syncState = "warning"
		syncMessage = "Klaviyo native sync/backfill now runs provider-row JSON:API pulls for Profiles, Lists, Segments, and changed-profile source events, records completed or failed marketing_sync_runs, and persists versioned klaviyo_native cursors. Source-event polling uses filter=greater-than(updated,...), sort=updated, emits klaviyo:profile:{id}:{updated} source-event IDs, and preserves bounded profile payload evidence. Public-app OAuth install uses PKCE, encrypted managed credentials, token refresh, and disconnect-time revoke/delete handling. Signed Klaviyo system-webhook deliveries resolve through opaque route tokens, verify HMAC headers, dedupe in marketing_webhook_events, and record webhook-mode marketing_sync_runs without advancing polling cursors. Allowlisted Klaviyo Webhooks API credentials can reconcile/create/update the provider system-webhook subscription and delete it on disconnect. Klaviyo integration-writeback can update existing profiles by email, add matched profiles to lists, create custom events by profile ID, preserve no-create semantics, and honor Retry-After. Disconnect persists provider_cleanup evidence and the acknowledgement endpoint records local operator attestation; OAuth live certification, Webhooks API live allowlist certification, writeback live certification, provider-side cleanup certification, and live account certification remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Klaviyo native provider-row pull is recorded in marketing_sync_runs with klaviyo_native cursor evidence."
		}
	}
	if isMarketingNativeSurface(item) && !isKlaviyoNativeSurface(item) {
		meta, _ := managedProviderMetadataForItem(item)
		syncState = "warning"
		syncMessage = meta.Name + " native sync/backfill records partial marketing_sync_runs and " + meta.Provider + "_handoff provider-row cursor evidence while provider API import for " + joinedOrDefault(meta.SyncObjects, "marketing objects") + " remains delegated to the migration adapter. Native webhook ingest, writeback, cleanup automation, and live account certification remain."
		if containsString(meta.SyncObjects, "contact_source_events") {
			syncMessage += " Changed-contact source-event monitoring is delegated to the migration source-event adapter until the native scheduler/data plane is promoted."
		} else {
			syncMessage += " Incremental source-event polling is not claimed until the adapter implements it."
		}
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest " + meta.Name + " native partial run is recorded in marketing_sync_runs with " + meta.Provider + "_handoff cursor evidence."
		}
	}
	if item.Slug == "meta" && hasSource(item, "audience_destination") {
		syncState = "warning"
		syncMessage = "Meta audience syncs can resolve a stored credential reference, apply the targeted-ads consent firewall, hash deliverable email members as EMAIL_SHA256, and POST them to the Graph v25.0 Custom Audience users endpoint in 10,000-member chunks with Retry-After-aware transient retry, batch-count, safe num_received/invalid-entry counter evidence, and partial-failure evidence. Live app-review and provider-certification evidence are still required before promotion."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Meta Custom Audience delivery run is recorded on the audience destination surface with safe provider response counter evidence when Meta returned it."
		}
	}
	if item.Slug == "google-ads" && hasSource(item, "audience_destination") {
		syncState = "warning"
		syncMessage = "Google Ads Customer Match syncs can resolve a stored credential reference, apply the targeted-ads consent firewall, hash deliverable emails as SHA-256 HEX, send chunked Data Manager API audienceMembers:ingest payloads by default or explicit audienceMembers:remove cleanup payloads when customer_match_operation=remove, require Customer Match terms for Data Manager readiness, retry transient Data Manager 429/5xx/network chunk failures with Retry-After-aware backoff, persist raw single requestIds or compact multi-requestId evidence, retrieve request status on demand for each stored request, and roll background provider status into job/run history. Existing allowlisted OfflineUserDataJob uploads remain behind their explicit worker gate and outside the Data Manager local-complete slice."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Google Ads Customer Match audience delivery run is recorded on the audience destination surface with stored Data Manager provider evidence and background provider-status polling when requestId evidence is available; live certification status still determines promotion."
		}
	}
	if item.Slug == "tiktok" && hasSource(item, "audience_destination") {
		syncState = "warning"
		syncMessage = "TikTok Audiences syncs can resolve a stored credential reference, apply the targeted-ads consent firewall, hash deliverable emails as SHA-256, upload a Customer File through TikTok's multipart DMP endpoint, call custom-audience update or create, retry transient provider errors with Retry-After-aware backoff, and retrieve custom-audience status through TikTok's DMP readback endpoint. Live advertiser certification, REMOVE/REPLACE provider-side certification, quota validation, and provider-side cleanup remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest TikTok Audience delivery run is recorded on the audience destination surface with provider request/audience evidence and background status polling when request evidence is available; live certification still determines full availability."
		}
	}
	if item.Slug == "linkedin" && hasSource(item, "audience_destination") {
		syncState = "warning"
		syncMessage = "LinkedIn Matched Audiences syncs can resolve a stored credential reference, apply the targeted-ads consent firewall, hash deliverable emails as SHA-256 with whitespace removal, add or remove DMP segment users in sequential 5,000-user BATCH_CREATE requests, handle per-element batch failures, retry transient provider errors with Retry-After-aware backoff, and retrieve DMP segment status through LinkedIn segment readback. Live Audiences-program certification, account-role/quota validation, replacement semantics, and provider-side cleanup remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest LinkedIn Matched Audience delivery run is recorded on the audience destination surface with segment readback evidence and background status polling when segment evidence is available; live LinkedIn certification still determines full availability."
		}
	}
	if item.Slug == "snap" && hasSource(item, "audience_destination") {
		syncState = "warning"
		syncMessage = "Snap Audience syncs can resolve a stored credential reference, apply the targeted-ads consent firewall, hash deliverable emails as SHA-256, add or remove nested EMAIL_SHA256 rows through the segment users endpoint in sequential 100,000-user batches, construct REPLACE through segment clear plus add requests, retry transient provider errors with Retry-After-aware backoff, and retrieve segment status through Snap's segment readback endpoint. Live Snap account certification, remove/replace provider-side certification, quota validation, and provider-side cleanup remain."
		if conn.LastSyncAt != nil {
			syncState = "ok"
			syncMessage = "Latest Snap Audience delivery run is recorded on the audience destination surface with provider request/segment evidence and background status polling when request evidence is available; live Snap certification still determines full availability."
		}
	}

	disconnectState := "ok"
	disconnectMessage := "Disconnect and delete requests are delegated to the owning surface and exposed from this facade."
	if isCommerceFoundation(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave commerce row and cache; provider-side apps, webhooks, OAuth installs, or API keys may still need provider-console cleanup."
	}
	if isWixStoresSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Wix Stores row, stops sync, and preserves audit evidence; Wix app/dashboard webhook subscriptions and app uninstall remain provider-console actions because Wix self-managed webhooks are dashboard configured."
	}
	if isWooCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave WooCommerce row disconnected, stops sync, preserves audit evidence, returns/persists provider_cleanup evidence, and deletes only Moosewave-managed webhooks matching the stored endpoint/topics with force=true. WooCommerce REST API key revocation and legacy/manual webhooks may still require WordPress admin cleanup until live certification."
	}
	if isBigCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave BigCommerce row disconnected, stops sync, preserves audit evidence, returns/persists provider_cleanup evidence, and deletes only Moosewave-owned hooks matching the stored endpoint/scopes. BigCommerce API account token revocation and provider-side webhook audit may still require control panel cleanup until live certification."
	}
	if isAdobeCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Adobe Commerce row, stops sync, and preserves audit evidence. Adobe/Magento access-token revocation, shared-secret rotation, and merchant-configured webhook definition cleanup remain Admin/module actions until managed provisioning is certified."
	}
	if isSquarespaceCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Squarespace Commerce row, stops sync, and preserves audit evidence. OAuth-only Squarespace webhook subscriptions and API/OAuth credential revocation may still require provider-console cleanup until managed subscription creation/deletion is certified."
	}
	if isStripeCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Stripe row disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. Stripe restricted-key revocation, webhook endpoint deletion, duplicate endpoint audit, and signing-secret rotation remain provider-dashboard actions until managed app/webhook provisioning is certified."
	}
	if isSquareCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Square row disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. Square OAuth revocation/app-token cleanup, webhook subscription deletion, duplicate notification URL audit, and signature-key rotation remain Square Developer Console actions until managed app provisioning is certified."
	}
	if isPayPalCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave PayPal row disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. PayPal REST app credentials, webhook ID cleanup, and dashboard webhook subscription deletion remain provider-dashboard actions until managed app provisioning is certified."
	}
	if isRazorpayCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Razorpay row, stops sync, and preserves audit evidence. Razorpay keys, webhook endpoint cleanup, and webhook signing-secret rotation remain dashboard actions until managed app provisioning is certified."
	}
	if isShopifyCommerceSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect deletes Moosewave-owned Shopify webhook subscriptions and the local encrypted install token before removing the integration row. Shopify's current OAuth docs do not expose an explicit token-revocation endpoint; merchant app uninstall/app-uninstalled is the provider-side invalidation path."
	}
	if isPipedriveCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Pipedrive row disconnected, stops sync, preserves audit evidence, cleans up stored Moosewave-owned webhook registrations when available, revokes managed OAuth refresh tokens through /oauth/revoke, and deletes local managed OAuth credential envelopes before finalizing the disconnected row. API-token revocation and duplicate/manual webhook cleanup may still require Pipedrive admin action until live certification lands."
	}
	if isCloseCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Close row disconnected, stops manual/scheduled contact pulls, makes route-token webhook lookups fail closed for disconnected rows, preserves sync/webhook audit evidence, and persists operator-managed provider_cleanup evidence. Close API-key revocation, subscription deletion, duplicate/manual webhook cleanup, and signature-key rotation remain Close admin actions until live certification lands."
	}
	if isHubSpotCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave HubSpot row disconnected, stops sync/webhook mutation, preserves audit evidence, revokes managed OAuth refresh tokens when present, deletes local managed OAuth credential envelopes, and persists provider_cleanup readiness evidence. Private app token revocation, duplicate/manual webhook cleanup, app uninstall review, and provider-console list/deal settings may still require HubSpot-side action until live certification lands."
	}
	if isSalesforceCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Salesforce row, stops sync, preserves audit evidence, revokes managed OAuth refresh tokens when present, and deletes local managed OAuth credential envelopes. Connected App policy changes, duplicate/manual credential cleanup, and provider-side data-delete evidence remain Salesforce admin/live-certification checks."
	}
	if isKlaviyoMigrationSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Stopping or deleting the Klaviyo migration/source-event monitor stops Moosewave polling and preserves import audit evidence. Klaviyo private API-key revocation, native-row public-app OAuth cleanup, webhook cleanup, and source-side writeback cleanup remain Klaviyo account actions until live certification lands."
	}
	if isKlaviyoNativeSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Klaviyo marketing integration row disconnected, rejects further native sync/backfill, preserves run/webhook/audit evidence, persists provider_cleanup guidance, cleans Moosewave-managed Klaviyo webhooks when evidence exists, and revokes/deletes managed OAuth credentials when present. POST /api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after private-key, duplicate-webhook, and writeback cleanup review. Klaviyo private API-key revocation, duplicate/manual webhook audits, provider-side writeback cleanup, and live OAuth cleanup evidence remain Klaviyo account actions until provider-side cleanup certification lands."
	}
	if isMarketingNativeSurface(item) && !isKlaviyoNativeSurface(item) {
		meta, _ := managedProviderMetadataForItem(item)
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the " + meta.Name + " marketing integration row disconnected, rejects further native sync/backfill, preserves run/audit evidence, and persists provider-cleanup guidance. Provider credential revocation, OAuth app cleanup where applicable, webhook cleanup, and provider-side writeback cleanup remain account actions until live cleanup automation is certified."
	}
	if item.Slug == "meta" && hasSource(item, "audience_destination") {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Meta audience destination row disconnected, stops scheduled delivery, preserves run/audit evidence, and returns/persists provider_cleanup readiness evidence. Meta access-token revocation, app uninstall, ad-account permission cleanup, and provider-side audience deletion remain Meta Business/admin actions until live certification lands."
	}
	if item.Slug == "google-ads" && hasSource(item, "audience_destination") {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Google Ads audience destination row disconnected, stops scheduled delivery, preserves run/audit evidence, and returns/persists provider_cleanup readiness evidence. Google OAuth token revocation, developer-token access changes, Customer Match list deletion or membership cleanup, and Data Manager/Google Ads account permission cleanup remain Google account actions until live certification lands."
	}
	if item.Slug == "tiktok" && hasSource(item, "audience_destination") {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave TikTok audience destination row disconnected, stops scheduled delivery, preserves run/audit evidence, and returns/persists provider_cleanup readiness evidence. TikTok token revocation, app cleanup, duplicate export audit, and provider-side audience deletion remain TikTok Ads Manager actions until live certification lands."
	}
	if isZohoCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Zoho CRM row, stops sync, returns/persists provider_cleanup evidence, revokes managed Zoho OAuth refresh tokens when present, deletes local managed OAuth credential envelopes, and preserves audit evidence. Zoho connected-app cleanup, Notification API channel deletion, and provider-side workflow/deal settings remain Zoho admin/live-certification actions."
	}
	if isDynamics365CRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Microsoft Dynamics 365 row, stops sync, returns/persists provider_cleanup evidence, deletes local managed OAuth credential envelopes, records that provider revocation is operator-managed because this connector has no provider revocation endpoint, and preserves audit evidence. Microsoft Entra app cleanup, Dataverse change-tracking/webhook cleanup, and provider-side workflow/solution settings remain Microsoft admin/live-certification actions."
	}
	if isKeapCRMSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Keap row, stops sync, returns/persists provider_cleanup evidence, deletes local managed OAuth/PAT/SAK credential envelopes, records that provider credential revocation is operator-managed because this connector has no provider revocation endpoint, and preserves audit evidence. Keap app/token cleanup, duplicate/manual webhook cleanup, and provider-side campaign/order settings remain Keap admin/live-certification actions."
	}
	if isManagedIngestFoundation(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks or removes the Moosewave integration row; provider-side apps, API keys, OAuth installs, webhooks, or tokens may still need provider-console cleanup."
	}
	if isGoogleLeadFormsSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Google Lead Form Extensions row disconnected, stops sync, preserves audit evidence, and returns plus persists operator-managed provider_cleanup readiness evidence. Google Ads OAuth token revocation, developer-token rotation, lead form asset permission cleanup, duplicate/manual CRM export cleanup, and data-delete evidence remain Google Ads-side actions until live certification."
	}
	if isRechargeSubscriptionSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Recharge row disconnected, stops scheduled subscription pulls, stops tokenized webhook-ingest resolution for that row, preserves subscription sync and webhook audit history, returns plus persists provider_cleanup readiness evidence in subscription integration settings, and POST /api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge records local operator attestation. Recharge API-token revocation, provider-console webhook cleanup, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live merchant certification land."
	}
	if isYotpoReviewSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Yotpo review row disconnected, stops scheduled review pulls, stops tokenized review webhook-ingest resolution for that row, preserves review sync and webhook audit history, and returns plus persists provider_cleanup readiness evidence in review integration settings. The review provider-cleanup acknowledgment endpoint records local operator attestation after the checklist is completed. Yotpo app secret rotation, API credential revocation, provider-console webhook target cleanup, duplicate/manual webhook audit, and tokenized ingest URL removal from Yotpo remain operator-managed provider-console actions until managed cleanup automation and live brand certification land."
	}
	if isSmileLoyaltySurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Smile.io loyalty row disconnected, removes it from connected-state/action-ID resolution, rejects manual sync/backfill/admin ingest/pause, stops tokenized and account_id-routed app webhook resolution for that row, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence in integration settings. Scheduled and connect-time pulls re-check before provider calls and before local writes; already in-flight Smile REST calls may finish, but they cannot write sinks or revive the disconnected row. The Smile-only disconnected-row acknowledgment endpoint records local operator attestation after the checklist is completed. Smile.io API-token revocation, app-webhook target cleanup, client-secret rotation, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live store certification land."
	}
	if isZendeskSupportSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Zendesk support row disconnected, best-effort deletes the stored zendesk_webhook_id through DELETE /api/v2/webhooks/{id}, treats provider 404 as already absent, records provider cleanup failures without blocking local disconnect, stops scheduled pulls, rejects manual sync/backfill and admin ingest with integration_disconnected, stops signed callback resolution for that row, preserves support run history, and returns plus persists provider_cleanup evidence in support integration settings. Zendesk OAuth/API-token revocation, trigger cleanup, and duplicate/manual webhook audit remain operator-managed provider-console actions until live workspace certification lands."
	}
	if isIntercomSupportSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Intercom support row disconnected, stops scheduled conversation sync, rejects manual sync/backfill and admin ingest with integration_disconnected, stops signed app webhook resolution for that row, preserves support run history, and returns plus persists provider_cleanup readiness evidence in support integration settings. Intercom OAuth-token revocation, app uninstall cleanup, webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live workspace certification land."
	}
	if isHelpScoutSupportSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Help Scout support row disconnected, stops scheduled conversation sync, rejects manual sync/backfill and admin ingest with integration_disconnected, stops signed app webhook resolution for that row, preserves support run history, and returns plus persists provider_cleanup readiness evidence in support integration settings. Help Scout OAuth app credential rotation, webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live mailbox certification land."
	}
	if isFreshdeskSupportSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Freshdesk support row disconnected, stops scheduled ticket sync, rejects manual sync/backfill and admin ingest with integration_disconnected, stops authenticated automation-webhook resolution for that row, preserves support run history, and returns plus persists provider_cleanup readiness evidence in support integration settings. Freshdesk API-key rotation, automation webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live helpdesk certification land."
	}
	if isGorgiasSupportSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Gorgias support row disconnected, best-effort deletes the stored gorgias_http_integration_id through DELETE /api/integrations/{id}, treats provider 404 as already absent, records provider cleanup failures without blocking local disconnect, stops scheduled pulls, rejects manual sync/backfill and admin ingest with integration_disconnected, stops authenticated callback resolution for that row, preserves support run history, and returns plus persists provider_cleanup evidence in support integration settings. Gorgias API-key revocation, rule references, app cleanup, and duplicate/manual integration audit remain operator-managed provider-console actions until live cleanup certification lands."
	}
	if isSnowflakeWarehouseSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Snowflake warehouse connection disconnected, hides it from ordinary connection lists, stops scheduled/manual warehouse runs, blocks import-mapping and reverse-ETL mutations, preserves connection/run/mapping audit evidence, keeps health disconnected even when older runs failed, stores config.provider_cleanup readiness evidence, and exposes provider-cleanup/acknowledge for local operator attestation. Snowflake users, roles, grants, stages, tasks, streams, warehouses, and key/OAuth/PAT material remain Snowflake-account actions until certified cleanup automation or explicit live cleanup proof lands."
	}
	if isTypeformLeadSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Typeform row disconnected after deleting or verifying absence of the stored managed /forms/{form_id}/webhooks/{tag} registration when Moosewave-owned webhook evidence is stored, then returns and persists provider_cleanup evidence. Typeform personal-token or externally managed OAuth access-token revocation and duplicate/manual webhook cleanup may still require dashboard action until live certification."
	}
	if isWixLeadSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect removes the Moosewave Wix lead row, stops sync, and preserves audit evidence; Wix app/dashboard webhook subscriptions and app uninstall remain provider-console actions because Wix self-managed webhooks are dashboard configured."
	}
	if isFilloutLeadSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Fillout row disconnected after deleting the managed /webhook/delete registration when a Moosewave-owned webhook ID is stored, then returns and persists provider_cleanup evidence. API-key revocation and duplicate/manual webhook cleanup may still require Fillout dashboard action until live certification."
	}
	if isJotformLeadSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Jotform row disconnected after deleting or verifying absence of the stored managed /form/{formID}/webhooks/{webhookID} registration when a Moosewave-owned webhook ID is stored, then returns and persists provider_cleanup evidence. API-key revocation and duplicate/manual webhook cleanup may still require Jotform dashboard action until live certification."
	}
	if isWebflowLeadSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Webflow row disconnected after deleting the stored managed /v2/webhooks/{webhook_id} registration, or after listing site webhooks to delete the exact Moosewave endpoint/filter match when the stored ID is missing or stale, then returns and persists provider_cleanup evidence. OAuth/app token revocation, duplicate/manual webhook cleanup, and site-token secret rotation may still require Webflow dashboard action until live certification."
	}
	if isFacebookLeadAdsSurface(item) {
		disconnectState = "warning"
		disconnectMessage = "Disconnect marks the Moosewave Facebook Lead Ads row disconnected after deleting the stored Moosewave-owned Page leadgen app subscription when available, then returns and persists provider_cleanup evidence. Meta OAuth token revocation, Page/app permission cleanup, duplicate/manual CRM integration audit, and live app-review evidence remain Meta-side actions until certification."
	}
	if hasSource(item, "sms") {
		disconnectState = "warning"
		disconnectMessage = "Moosewave sender profiles can be paused and local send/callback routing stops through sender readiness, but provider-side app/profile, number, campaign, webhook, and carrier-registration cleanup remains operator-managed until live cleanup certification exists."
	}
	if hasSource(item, "sending") {
		disconnectState = "warning"
		disconnectMessage = "Moosewave can delete provider config or sending-state rows, but provider-side API keys, sender identities, domains, SNS topics, webhooks, and SMTP credentials may still require console cleanup."
	}
	if item.RuntimeStatus == RuntimePlanned {
		disconnectState = "planned"
		disconnectMessage = "Disconnect is not available until the connector is implemented."
	}

	return []HealthCheck{
		{Key: "ownership", Label: "Ownership", State: ownershipState, Message: ownershipMessage},
		{Key: "auth", Label: "Auth and configuration", State: authState, Message: authMessage},
		{Key: "sync", Label: "Sync or delivery", State: syncState, Message: syncMessage},
		{Key: "disconnect", Label: "Disconnect and data delete", State: disconnectState, Message: disconnectMessage},
	}
}

func surfaceLabel(item CatalogItem) string {
	if item.SetupPath == "" {
		return "docs"
	}
	switch item.SetupPath {
	case "/integrations":
		return "Integrations"
	case "/commerce":
		return "Commerce"
	case "/audience-syncs":
		return "Audience syncs"
	case "/data-platform":
		return "Data platform"
	case "/webhooks":
		return "Webhooks"
	case "/migrations":
		return "Migrations"
	case "/api-playground":
		return "Developer tools"
	case "/mcp":
		return "MCP"
	case "/settings":
		return "Settings"
	default:
		return item.SetupPath
	}
}

func countCatalog(items []CatalogItem) map[string]int {
	counts := map[string]int{"total": len(items)}
	for _, item := range items {
		counts["badge:"+string(item.Badge)]++
		counts["category:"+item.Category]++
		counts["runtime:"+string(item.RuntimeStatus)]++
		if item.Native {
			counts["native"]++
		}
		if isNativeManaged(item) {
			counts["native_managed"]++
		}
		if isNativeVerified(item) {
			counts["native_verified"]++
		}
		if item.RuntimeStatus == RuntimePlanned {
			counts["planned"]++
		}
	}
	return counts
}

func countConnections(items []Connection) map[string]int {
	counts := map[string]int{"total": len(items)}
	for _, item := range items {
		if item.Connected {
			counts["connected"]++
		}
		counts["status:"+item.Status]++
		counts["health:"+item.HealthState]++
		counts["badge:"+string(item.Badge)]++
	}
	return counts
}

func countRecipes(items []Recipe) map[string]int {
	counts := map[string]int{"total": len(items)}
	for _, item := range items {
		if item.Available {
			counts["available"]++
		} else {
			counts["planned"]++
		}
		counts["badge:"+string(item.Badge)]++
		counts["provider:"+item.Provider]++
	}
	return counts
}

func statusRank(status RuntimeStatus) int {
	switch status {
	case RuntimeAvailable:
		return 0
	case RuntimeDelegated:
		return 1
	case RuntimePartial:
		return 2
	case RuntimePlanned:
		return 3
	default:
		return 9
	}
}

func phaseLabel(phase string) string {
	if phase == "" {
		return "integration"
	}
	return "month " + phase
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, code int, codeText, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{
			"code":    codeText,
			"message": message,
		},
	})
}
