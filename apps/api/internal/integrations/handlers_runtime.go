// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	marketingintegrations "github.com/postwave/postwave/apps/api/internal/marketing_integrations"
)

// Runtime connection enrichment: per-surface status queries, connection ids
// and recent run history read from the owning integration tables.

func (h *handler) applyRuntimeStatus(r *http.Request, tx pgx.Tx, connections map[string]Connection) {
	ctx := r.Context()
	for _, provider := range []string{"shopify", "woocommerce", "bigcommerce", "adobe-commerce", "wix-stores", "squarespace-commerce", "stripe", "square", "paypal", "razorpay"} {
		h.applyStatus(ctx, tx, connections, provider, "commerce", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active', 'ready', 'ok')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"hubspot", "salesforce", "pipedrive", "zoho-crm", "microsoft-dynamics-365", "keap", "close", "copper", "freshsales", "highlevel"} {
		h.applyStatus(ctx, tx, connections, provider, "crm", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM crm_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"typeform", "jotform", "google-forms", "microsoft-forms", "surveymonkey", "facebook-lead-ads", "linkedin-lead-gen", "google-lead-form-extensions", "tiktok-lead-generation", "snap-lead-ads", "reddit-lead-gen", "pinterest-lead-ads", "unbounce", "leadpages", "instapage", "carrd", "paperform", "formstack", "fillout", "optinmonster", "privy", "convertflow", "sleeknote", "wisepops", "poptin", "hello-bar", "unstack", "landingi", "kickofflabs", "shortstack", "formsite", "cognito-forms", "ninja-forms", "formidable-forms", "interact", "outgrow", "riddle", "qualtrics-forms", "feathery", "formaloo", "123formbuilder", "tally", "gravity-forms", "wpforms", "wordpress", "webflow", "wix"} {
		h.applyStatus(ctx, tx, connections, provider, "lead_capture", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM lead_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"yotpo", "judge-me", "okendo", "loox", "stamped", "trustpilot", "reviews-io", "bazaarvoice", "powerreviews"} {
		h.applyStatus(ctx, tx, connections, provider, "review_integration", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM review_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"smile", "loyaltylion", "rivo", "referralcandy", "growave", "marsello", "antavo", "friendbuy", "talkable"} {
		h.applyStatus(ctx, tx, connections, provider, "loyalty_integration", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM loyalty_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"recharge", "skio", "aftership", "shipstation", "shippo", "easyship", "shipbob", "easypost", "narvar", "route", "malomo", "wonderment", "bold-subscriptions", "ordergroove", "loop-subscriptions", "appstle", "seal-subscriptions", "chargebee"} {
		h.applyStatus(ctx, tx, connections, provider, "subscription_integration", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM subscription_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range []string{"ga4", "google-tag-manager", "segment", "rudderstack", "mixpanel", "amplitude", "posthog", "heap", "hotjar", "fullstory", "plausible", "fathom-analytics", "matomo", "adobe-analytics", "looker-studio", "looker", "tableau", "power-bi", "mode", "metabase", "sisense", "kissmetrics", "woopra", "chartmogul", "baremetrics", "profitwell", "triple-whale", "northbeam", "daasity", "glew", "peel-insights"} {
		h.applyStatus(ctx, tx, connections, provider, "analytics_integration", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM analytics_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, provider := range marketingintegrations.ProviderKeys() {
		h.applyStatus(ctx, tx, connections, provider, "marketing_integration", `
SELECT count(*),
       COALESCE(bool_or(status IN ('connected', 'active')), false),
       COALESCE(max(status), ''),
       max(last_sync_at),
       COALESCE(max(NULLIF(error_message, '')), '')
  FROM marketing_integrations
 WHERE provider = $1
   AND status <> 'disconnected'`, provider)
	}
	for _, pair := range []struct {
		slug     string
		provider string
	}{
		{"meta", "meta"},
		{"google-ads", "google_ads"},
		{"tiktok", "tiktok"},
		{"linkedin", "linkedin"},
		{"snap", "snap"},
	} {
		h.applyStatus(ctx, tx, connections, pair.slug, "audience_destination", `
SELECT count(*),
       COALESCE(bool_or(status IN ('active', 'syncing')), false),
       COALESCE(max(status), ''),
       max(last_synced_at),
       ''
  FROM audience_destinations
 WHERE provider = $1
   AND status <> 'disconnected'`, pair.provider)
	}
	for _, provider := range []string{"s3", "bigquery", "snowflake", "redshift", "databricks", "postgres", "r2"} {
		h.applyStatus(ctx, tx, connections, provider, "warehouse", `
	SELECT count(*),
	       COALESCE(bool_or(status IN ('active', 'ready', 'syncing')), false),
	       COALESCE(max(status), ''),
	       max(updated_at),
	       COALESCE(max(NULLIF(error, '')), '')
	  FROM warehouse_connections
	 WHERE provider = $1
	   AND status <> 'disconnected'`, provider)
	}
	h.applyStatus(ctx, tx, connections, "postmark", "sending", `
	SELECT count(*),
	       count(*) > 0,
	       CASE WHEN count(*) > 0 THEN 'provisioned' ELSE '' END,
	       max(updated_at),
	       ''
	  FROM sending_state
	 WHERE postmark_server_id IS NOT NULL
	    OR postmark_stream_id IS NOT NULL`)
	for _, provider := range []string{"ses", "sendgrid", "mailgun"} {
		h.applyStatus(ctx, tx, connections, provider, "sending", `
	SELECT count(*),
	       COALESCE(bool_or(active), false),
	       CASE WHEN COALESCE(bool_or(active), false) THEN 'active' ELSE 'paused' END,
	       max(updated_at),
	       ''
	  FROM tenant_deliverability_providers
	 WHERE provider = $1`, provider)
	}
	h.applyStatus(ctx, tx, connections, "outbound-webhooks", "outbound_webhooks", `
	SELECT count(*),
	       COALESCE(bool_or(active), false),
       CASE WHEN COALESCE(bool_or(active), false) THEN 'active' ELSE 'paused' END,
       max(updated_at),
       ''
  FROM outbound_webhooks`)
	h.applyStatus(ctx, tx, connections, "inbound-webhooks", "inbound_webhooks", `
SELECT count(*),
       COALESCE(bool_or(enabled), false),
       CASE WHEN COALESCE(bool_or(enabled), false) THEN 'active' ELSE 'paused' END,
       max(created_at),
       ''
  FROM inbound_webhook_endpoints`)
	h.applyStatus(ctx, tx, connections, "developer-marketplace", "developer_marketplace", `
SELECT count(*),
       COALESCE(bool_or(status IN ('approved', 'published', 'active')), false),
       COALESCE(max(status), ''),
       max(updated_at),
       ''
  FROM developer_apps`)
	h.applyPartnerAppStatus(ctx, tx, connections)
	h.applyStatus(ctx, tx, connections, "slack", "slack", `
SELECT count(*), count(*) > 0, 'connected', max(updated_at), ''
  FROM slack_workspace_connections`)
	h.applyStatus(ctx, tx, connections, "discord", "discord", `
SELECT count(*),
       COALESCE(bool_or(enabled), false),
       CASE WHEN COALESCE(bool_or(enabled), false) THEN 'active' ELSE 'paused' END,
       max(updated_at),
       COALESCE(max(NULLIF(last_delivery_error, '')), '')
  FROM discord_integrations`)
	h.applyStatus(ctx, tx, connections, "microsoft-teams", "teams", `
SELECT count(*),
       COALESCE(bool_or(enabled), false),
       CASE WHEN COALESCE(bool_or(enabled), false) THEN 'active' ELSE 'paused' END,
       max(updated_at),
       COALESCE(max(NULLIF(last_delivery_error, '')), '')
  FROM teams_integrations`)
}

func (h *handler) applyStatus(ctx context.Context, tx pgx.Tx, connections map[string]Connection, slug, source, query string, args ...any) {
	st, err := queryStatus(ctx, tx, query, args...)
	if err != nil {
		if h.logger != nil {
			h.logger.Debug("integrations status query failed", "slug", slug, "err", err)
		}
		return
	}
	conn, ok := connections[slug]
	if !ok {
		return
	}
	conn.Source = source
	conn.Count = st.Count
	conn.Connected = st.Connected || st.Count > 0
	conn.Status = st.Status
	conn.LastSyncAt = st.LastSyncAt
	conn.LastError = st.LastError
	if conn.Count == 0 {
		conn.Status = "not_configured"
		conn.Connected = false
	}
	connections[slug] = conn
}

func (h *handler) applyPartnerAppStatus(ctx context.Context, tx pgx.Tx, connections map[string]Connection) {
	rows, err := tx.Query(ctx, `
SELECT l.slug::text,
       count(i.id)::int,
       COALESCE(bool_or(i.status = 'installed'), false),
       COALESCE(max(i.status), ''),
       max(i.updated_at)
  FROM app_listings l
  JOIN developer_apps a ON a.id = l.app_id
  LEFT JOIN app_installations i
    ON i.app_id = a.id
   AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 WHERE l.status = 'published'
   AND l.review_state = 'approved'
   AND a.distribution IN ('marketplace', 'partner_catalog')
   AND a.status IN ('approved', 'active')
 GROUP BY l.slug`)
	if err != nil {
		if h.logger != nil {
			h.logger.Debug("integrations partner app status query failed", "err", err)
		}
		return
	}
	defer rows.Close()
	for rows.Next() {
		var slug string
		var count int
		var connected bool
		var status string
		var last sql.NullTime
		if err := rows.Scan(&slug, &count, &connected, &status, &last); err != nil {
			if h.logger != nil {
				h.logger.Debug("integrations partner app status scan failed", "err", err)
			}
			return
		}
		conn, ok := connections[slug]
		if !ok || conn.Badge != BadgePartner || !hasSource(CatalogItem{Sources: []string{conn.Source}}, "developer_marketplace") {
			continue
		}
		conn.Count = count
		conn.Connected = connected
		conn.Status = strings.TrimSpace(status)
		if conn.Status == "" {
			conn.Status = "not_configured"
		}
		if last.Valid {
			conn.LastSyncAt = &last.Time
		}
		connections[slug] = conn
	}
	if err := rows.Err(); err != nil && h.logger != nil {
		h.logger.Debug("integrations partner app status rows failed", "err", err)
	}
}

func queryStatus(ctx context.Context, tx pgx.Tx, query string, args ...any) (sourceStatus, error) {
	var count int
	var connected bool
	var status string
	var last sql.NullTime
	var lastErr string
	if err := tx.QueryRow(ctx, query, args...).Scan(&count, &connected, &status, &last, &lastErr); err != nil {
		return sourceStatus{}, err
	}
	out := sourceStatus{
		Count:     count,
		Connected: connected,
		Status:    strings.TrimSpace(status),
		LastError: strings.TrimSpace(lastErr),
	}
	if out.Status == "" {
		out.Status = "configured"
	}
	if last.Valid {
		out.LastSyncAt = &last.Time
	}
	return out, nil
}

const connectionIDLimit = 25

func (h *handler) applyRuntimeConnectionIDs(ctx context.Context, tx pgx.Tx, connections map[string]Connection) {
	for slug, conn := range connections {
		if conn.Count == 0 {
			continue
		}
		item, ok := CatalogItemBySlug(slug)
		if !ok {
			continue
		}
		if hasSource(item, "support_integration") {
			continue
		}
		ids, err := h.connectionIDs(ctx, tx, item)
		if err != nil {
			if h.logger != nil {
				h.logger.Debug("integrations connection id query failed", "slug", slug, "err", err)
			}
			continue
		}
		conn = withConnectionIDs(conn, ids)
		connections[slug] = conn
	}
}

func (h *handler) connectionIDs(ctx context.Context, tx pgx.Tx, item CatalogItem) ([]string, error) {
	query, args, ok := connectionIDQuery(item)
	if !ok {
		return nil, nil
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		id = strings.TrimSpace(id)
		if id != "" {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func connectionIDQuery(item CatalogItem) (string, []any, bool) {
	provider := connectionIDProvider(item)
	switch {
	case hasSource(item, "commerce"):
		return activeProviderConnectionIDQuery("commerce_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "crm"):
		return activeProviderConnectionIDQuery("crm_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "lead_capture"):
		return activeProviderConnectionIDQuery("lead_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "review_integration"):
		return activeProviderConnectionIDQuery("review_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "loyalty_integration"):
		return activeProviderConnectionIDQuery("loyalty_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "subscription_integration"):
		return activeProviderConnectionIDQuery("subscription_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "support_integration"):
		return "", nil, false
	case hasSource(item, "analytics_integration"):
		return activeProviderConnectionIDQuery("analytics_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "marketing_integration"):
		return activeProviderConnectionIDQuery("marketing_integrations"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "audience_destination"):
		return audienceDestinationConnectionIDQuery(), []any{provider, connectionIDLimit}, true
	case hasSource(item, "warehouse"):
		return activeProviderConnectionIDQuery("warehouse_connections"), []any{provider, connectionIDLimit}, true
	case hasSource(item, "outbound_webhooks"):
		return `SELECT id::text FROM outbound_webhooks ORDER BY updated_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	case hasSource(item, "inbound_webhooks"):
		return `SELECT id::text FROM inbound_webhook_endpoints ORDER BY created_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	case hasSource(item, "developer_marketplace"):
		return `SELECT id::text FROM developer_apps ORDER BY updated_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	case hasSource(item, "slack"):
		return `SELECT id::text FROM slack_workspace_connections ORDER BY updated_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	case hasSource(item, "discord"):
		return `SELECT id::text FROM discord_integrations ORDER BY updated_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	case hasSource(item, "teams"):
		return `SELECT id::text FROM teams_integrations ORDER BY updated_at DESC LIMIT $1`, []any{connectionIDLimit}, true
	default:
		return "", nil, false
	}
}

func providerConnectionIDQuery(table string) string {
	return fmt.Sprintf(`SELECT id::text FROM %s WHERE provider = $1 ORDER BY updated_at DESC LIMIT $2`, table)
}

func activeProviderConnectionIDQuery(table string) string {
	return fmt.Sprintf(`SELECT id::text FROM %s WHERE provider = $1 AND status <> 'disconnected' ORDER BY updated_at DESC LIMIT $2`, table)
}

func audienceDestinationConnectionIDQuery() string {
	return `SELECT id::text
  FROM audience_destinations
 WHERE provider = $1
   AND status <> 'disconnected'
 ORDER BY updated_at DESC
 LIMIT $2`
}

func connectionIDProvider(item CatalogItem) string {
	switch item.Slug {
	case "azure-blob":
		return "azure_blob"
	case "google-ads":
		return "google_ads"
	default:
		return item.Slug
	}
}

func withConnectionIDs(conn Connection, ids []string) Connection {
	if len(ids) == 0 {
		return conn
	}
	conn.ConnectionIDs = append([]string(nil), ids...)
	conn.PrimaryConnectionID = ids[0]
	return conn
}

func actionResponseWithConnection(resp actionResponse, conn Connection) actionResponse {
	if len(conn.ConnectionIDs) == 0 {
		return actionResponseWithDelegationRequirements(resp)
	}
	resp.ConnectionIDs = append([]string(nil), conn.ConnectionIDs...)
	resp.PrimaryConnectionID = conn.PrimaryConnectionID
	if resp.PrimaryConnectionID == "" {
		resp.PrimaryConnectionID = resp.ConnectionIDs[0]
	}
	resp.DelegatedTo = strings.ReplaceAll(resp.DelegatedTo, "{id}", resp.PrimaryConnectionID)
	resp.RequiredFields = removeStrings(resp.RequiredFields, "id")
	return actionResponseWithDelegationRequirements(resp)
}

func actionResponseWithDelegationRequirements(resp actionResponse) actionResponse {
	fields := append([]string(nil), resp.RequiredFields...)
	if strings.Contains(resp.DelegatedTo, "{id}") {
		fields = append(fields, "id")
	}
	if strings.Contains(resp.DelegatedTo, "{installation_id}") {
		fields = append(fields, "installation_id")
	}
	resp.RequiredFields = uniqueStrings(fields)
	return resp
}

func removeStrings(values []string, remove ...string) []string {
	blocked := make(map[string]struct{}, len(remove))
	for _, value := range remove {
		blocked[value] = struct{}{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := blocked[value]; ok {
			continue
		}
		out = append(out, value)
	}
	return out
}

const runtimeHistoryLimit = 5

func (h *handler) runtimeSyncHistory(ctx context.Context, tx pgx.Tx, item CatalogItem) []SyncHistoryEntry {
	if hasSource(item, "support_integration") {
		return nil
	}
	integrationTable, runTable, provider, ok := nativeRunHistoryTables(item)
	if ok {
		return h.nativeRunHistory(ctx, tx, item, integrationTable, runTable, provider)
	}
	if hasSource(item, "warehouse") {
		return h.warehouseRunHistory(ctx, tx, item)
	}
	return nil
}

func nativeRunHistoryTables(item CatalogItem) (string, string, string, bool) {
	provider := item.Slug
	switch {
	case hasSource(item, "crm"):
		return "crm_integrations", "crm_sync_runs", provider, true
	case hasSource(item, "lead_capture"):
		return "lead_integrations", "lead_sync_runs", provider, true
	case hasSource(item, "review_integration"):
		return "review_integrations", "review_sync_runs", provider, true
	case hasSource(item, "loyalty_integration"):
		return "loyalty_integrations", "loyalty_sync_runs", provider, true
	case hasSource(item, "subscription_integration"):
		return "subscription_integrations", "subscription_sync_runs", provider, true
	case hasSource(item, "support_integration"):
		return "", "", "", false
	case hasSource(item, "analytics_integration"):
		return "analytics_integrations", "analytics_sync_runs", provider, true
	case hasSource(item, "marketing_integration"):
		return "marketing_integrations", "marketing_sync_runs", provider, true
	default:
		return "", "", "", false
	}
}

func (h *handler) nativeRunHistory(ctx context.Context, tx pgx.Tx, item CatalogItem, integrationTable, runTable, provider string) []SyncHistoryEntry {
	query := fmt.Sprintf(`
SELECT COALESCE(r.completed_at, r.started_at, r.created_at),
       r.run_mode,
       r.status,
       1,
       r.rows_failed::bigint,
       COALESCE(NULLIF(r.error_message, ''), '')
  FROM %s r
  JOIN %s i ON i.id = r.integration_id
 WHERE i.provider = $1
 ORDER BY r.created_at DESC
 LIMIT $2`, runTable, integrationTable)
	history, err := scanRunHistory(ctx, tx, query, item, provider, runtimeHistoryLimit)
	if err != nil {
		if h.logger != nil {
			h.logger.Debug("integrations run history query failed", "slug", item.Slug, "err", err)
		}
		return nil
	}
	return history
}

func (h *handler) warehouseRunHistory(ctx context.Context, tx pgx.Tx, item CatalogItem) []SyncHistoryEntry {
	query := `
SELECT COALESCE(r.completed_at, r.started_at, r.created_at),
       r.run_mode,
       r.status,
       r.retry_count + 1,
       r.rows_failed::bigint,
       COALESCE(NULLIF(r.error, ''), '')
  FROM warehouse_sync_runs r
  JOIN warehouse_connections c ON c.id = r.connection_id
 WHERE c.provider = $1
 ORDER BY r.created_at DESC
 LIMIT $2`
	history, err := scanRunHistory(ctx, tx, query, item, item.Slug, runtimeHistoryLimit)
	if err != nil {
		if h.logger != nil {
			h.logger.Debug("integrations warehouse run history query failed", "slug", item.Slug, "err", err)
		}
		return nil
	}
	return history
}

func scanRunHistory(ctx context.Context, tx pgx.Tx, query string, item CatalogItem, provider string, limit int) ([]SyncHistoryEntry, error) {
	rows, err := tx.Query(ctx, query, provider, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncHistoryEntry{}
	for rows.Next() {
		var at time.Time
		var runMode string
		var status string
		var attempts int
		var rowsFailed int64
		var runErr string
		if err := rows.Scan(&at, &runMode, &status, &attempts, &rowsFailed, &runErr); err != nil {
			return nil, err
		}
		entryAt := at
		entry := SyncHistoryEntry{
			At:       &entryAt,
			Action:   historyActionFor(item),
			Status:   strings.TrimSpace(status),
			Attempts: attempts,
			Message:  runHistoryMessage(item, runMode, rowsFailed),
			Error:    strings.TrimSpace(runErr),
		}
		if entry.Status == "" {
			entry.Status = "completed"
		}
		if entry.Attempts <= 0 {
			entry.Attempts = 1
		}
		out = append(out, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func runHistoryMessage(item CatalogItem, runMode string, rowsFailed int64) string {
	mode := strings.TrimSpace(runMode)
	if mode == "" {
		mode = "sync"
	}
	message := fmt.Sprintf("Latest %s run recorded by %s.", strings.ReplaceAll(mode, "_", " "), surfaceLabel(item))
	if rowsFailed > 0 {
		message += fmt.Sprintf(" %d row(s) failed.", rowsFailed)
	}
	return message
}
