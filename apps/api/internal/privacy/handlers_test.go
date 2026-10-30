package privacy

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNormalizeRegion(t *testing.T) {
	cases := map[string]string{
		"eu":         "GDPR",
		"UK":         "GDPR",
		"ccpa":       "CCPA",
		"california": "CCPA",
		"br":         "LGPD",
		"":           "OTHER",
	}
	for in, want := range cases {
		if got := normalizeRegion(in); got != want {
			t.Fatalf("normalizeRegion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWorkflowSLAs(t *testing.T) {
	// Audit fix (GDPR HIGH #4): the GDPR export deadline was bumped
	// from 14d to 30d to align with the legal one-month window
	// (GDPR Art. 12(3)) and to match deletionSLA's value for the
	// same regulator. Both surfaces now quote the same deadline.
	if got := exportSLA("GDPR"); got != 30*24*time.Hour {
		t.Fatalf("GDPR export SLA = %s; want 30d (legal max under Art. 12(3))", got)
	}
	if got := deletionSLA("CCPA"); got != 45*24*time.Hour {
		t.Fatalf("CCPA deletion SLA = %s", got)
	}
}

func TestNewRequestID(t *testing.T) {
	id, err := newRequestID("data_export")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(id, "prv_data-export_") {
		t.Fatalf("unexpected id prefix: %s", id)
	}
	if len(id) != len("prv_data-export_")+24 {
		t.Fatalf("unexpected id length: %s", id)
	}
}

func TestExportFileNameIsSafe(t *testing.T) {
	ts := time.Date(2026, 5, 6, 1, 2, 3, 0, time.UTC)
	got := exportFileName(`prv_data-export_abc/../../secret`, ts)
	if got != "postwave-export-20260506T010203Z-prv_data-export_abc-------secret.zip" {
		t.Fatalf("filename = %q", got)
	}
}

func TestBuildExportZip(t *testing.T) {
	ts := time.Date(2026, 5, 6, 1, 2, 3, 0, time.UTC)
	bundle, err := buildExportZip("prv_data-export_test", "tenant_1", ts, []tableExport{
		{
			Name:  "subscribers",
			Rows:  1,
			Bytes: len(`[{"email":"a@example.com"}]`),
			Data:  json.RawMessage(`[{"email":"a@example.com"}]`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range zr.File {
		seen[f.Name] = true
	}
	for _, name := range []string{"manifest.json", "README.txt", "tables/subscribers.json"} {
		if !seen[name] {
			t.Fatalf("zip missing %s; files=%v", name, seen)
		}
	}
}

func TestSafeIdentifier(t *testing.T) {
	if !safeIdentifier("subscriber_events") {
		t.Fatalf("expected valid identifier")
	}
	if safeIdentifier("subscriber_events;drop table tenants") {
		t.Fatalf("expected invalid identifier")
	}
}

func TestExportDiscoveryPolicyIncludesKnownTenantData(t *testing.T) {
	required := []string{
		"assets",
		"campaign_recipients",
		"campaign_replies",
		"conversion_tracking_keys",
		"conversions",
		"custom_domains",
		"form_file_uploads",
		"inbound_events",
		"inbound_webhook_endpoints",
		"notification_preferences",
		"paid_members",
		"product_events",
		"retention_policies",
		"subscriber_suppressions",
		"tenant_ai_usage",
		"tenant_custom_fields",
		"voice_profile_labels",
		"voice_semantic_signatures",
		"workspace_settings",
	}
	for _, table := range required {
		if shouldExcludeExportTable(table) {
			t.Fatalf("%s must not be excluded from tenant exports", table)
		}
		if !safeIdentifier(table) {
			t.Fatalf("%s must be a safe export identifier", table)
		}
	}
}

func TestExportPolicyExcludesSecretAndTransientTables(t *testing.T) {
	for _, table := range []string{
		"auth_credentials",
		"auth_sessions",
		"auth_tokens",
		"auth_totp_secrets",
		"commerce_oauth_states",
		"idempotency_records",
		"migration_oauth_states",
		"migration_sessions",
		"outbox_events",
	} {
		if !shouldExcludeExportTable(table) {
			t.Fatalf("%s should be excluded from generic tenant export", table)
		}
	}
}

func TestExportJSONExprOmitsSensitiveColumns(t *testing.T) {
	for table, column := range map[string]string{
		"api_keys":                  "key_hash",
		"conversion_tracking_keys":  "key_hash",
		"conversion_ingest_secrets": "secret_envelope",
		"outbound_webhooks":         "secret_envelope",
	} {
		expr := exportJSONExpr(exportTable{
			Name:        table,
			Where:       tenantScopedWhere,
			OmitColumns: exportOmitColumns[table],
		})
		if !strings.Contains(expr, "- '"+column+"'") {
			t.Fatalf("%s not omitted from %s expression: %s", column, table, expr)
		}
	}
}

func TestGiftSubscriptionExportOmitsBearerMaterialOnly(t *testing.T) {
	expr := exportJSONExpr(exportTable{
		Name:        "gift_subscriptions",
		Where:       tenantScopedWhere,
		OmitColumns: exportOmitColumns["gift_subscriptions"],
	})

	for _, column := range []string{
		"stripe_payment_url",
		"redemption_token_sha256",
		"gifter_attribution_token",
	} {
		if !strings.Contains(expr, "- '"+column+"'") {
			t.Errorf("%s not omitted from gift subscription export expression: %s", column, expr)
		}
	}

	// These fields are personal data or operational reconciliation evidence,
	// not credentials. Keeping them is intentional data portability behavior.
	for _, column := range []string{
		"purchaser_email",
		"recipient_email",
		"message",
		"plan_id",
		"stripe_invoice_id",
		"cancel_reason",
	} {
		if strings.Contains(expr, "- '"+column+"'") {
			t.Errorf("%s must remain in gift subscription exports: %s", column, expr)
		}
	}
}

func TestGiftAttributionEventsRemainPortable(t *testing.T) {
	if columns := exportOmitColumns["gift_attribution_events"]; len(columns) != 0 {
		t.Fatalf("gift attribution events contain no bearer material; unexpected omissions: %v", columns)
	}
}
