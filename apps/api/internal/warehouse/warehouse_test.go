package warehouse

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/uploads"
)

type fakeSnowflakeExecutor struct {
	requests []SnowflakeJobExecutionRequest
	result   SnowflakeJobExecutionResult
	err      error
}

func (f *fakeSnowflakeExecutor) ExecuteSnowflakeJob(_ context.Context, req SnowflakeJobExecutionRequest) (SnowflakeJobExecutionResult, error) {
	f.requests = append(f.requests, req)
	if f.err != nil {
		return SnowflakeJobExecutionResult{}, f.err
	}
	return f.result, nil
}

func TestValidateConnectionDefaultsAndWarnings(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:      "Daily S3",
		Provider:  "s3",
		Direction: "export",
	})
	if !got.Valid {
		t.Fatalf("expected valid connection, got %#v", got)
	}
	if len(got.Warnings) == 0 || !strings.Contains(strings.Join(got.Warnings, ","), "storage adapter") {
		t.Fatalf("expected storage-adapter warning, got %#v", got.Warnings)
	}
}

func TestValidateConnectionStripsCallerSuppliedProviderCleanup(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Snowflake Prod",
		Provider:        ProviderSnowflake,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":          "xy12345",
			"warehouse":        "COMPUTE_WH",
			"database":         "POSTWAVE",
			"schema":           "PUBLIC",
			"provider_cleanup": map[string]any{"status": "spoofed"},
		},
	})
	if !got.Valid {
		t.Fatalf("expected valid connection, got %#v", got)
	}

	in := Connection{
		Name:            "Snowflake Prod",
		Provider:        ProviderSnowflake,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":          "xy12345",
			"warehouse":        "COMPUTE_WH",
			"database":         "POSTWAVE",
			"schema":           "PUBLIC",
			"provider_cleanup": map[string]any{"status": "spoofed"},
		},
	}
	normalizeConnection(&in)
	if _, exists := in.Config["provider_cleanup"]; exists {
		t.Fatalf("caller-supplied provider_cleanup should be stripped: %+v", in.Config)
	}
}

func TestValidateConnectionManagedSQLProviderRequiresSettings(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "BigQuery Import",
		Provider:        "bigquery",
		Direction:       "import",
		Status:          "active",
		Cadence:         "daily",
		BackfillDays:    30,
		ObjectSelection: []string{"events"},
	})
	if got.Valid {
		t.Fatalf("expected missing settings to be invalid")
	}
	if len(got.Errors) == 0 || !strings.Contains(strings.Join(got.Errors, ","), "project_id") {
		t.Fatalf("expected missing BigQuery settings, got %#v", got)
	}
}

func TestValidateConnectionManagedSQLProviderAcceptsCredentialRefs(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Snowflake Prod",
		Provider:        "snowflake",
		Direction:       "bidirectional",
		Status:          "active",
		Cadence:         "daily",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles", "events"},
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	})
	if !got.Valid {
		t.Fatalf("expected valid Snowflake connection, got %#v", got)
	}
	if len(got.Warnings) == 0 {
		t.Fatalf("expected partial-driver warning, got %#v", got.Warnings)
	}
}

func TestValidateConnectionSnowflakeImportTablePath(t *testing.T) {
	valid := ValidateConnection(Connection{
		Name:            "Snowflake Traits",
		Provider:        ProviderSnowflake,
		Direction:       "import",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":      "xy12345.us-east-1",
			"warehouse":    "COMPUTE_WH",
			"database":     "POSTWAVE",
			"schema":       "PUBLIC",
			"import_table": "POSTWAVE.PUBLIC.PROFILE_TRAITS",
		},
	})
	if !valid.Valid {
		t.Fatalf("expected valid Snowflake import table path, got %#v", valid)
	}

	unsafe := ValidateConnection(Connection{
		Name:            "Snowflake Unsafe",
		Provider:        ProviderSnowflake,
		Direction:       "import",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":      "xy12345",
			"warehouse":    "COMPUTE_WH",
			"database":     "POSTWAVE",
			"schema":       "PUBLIC",
			"import_table": "POSTWAVE.PUBLIC.PROFILE_TRAITS;DROP TABLE USERS",
		},
	})
	if unsafe.Valid || !strings.Contains(strings.Join(unsafe.Errors, ","), "import_table") {
		t.Fatalf("expected unsafe Snowflake import_table rejection, got %#v", unsafe)
	}
}

func TestValidateConnectionSnowflakeQualifiedStagePath(t *testing.T) {
	valid := ValidateConnection(Connection{
		Name:            "Snowflake Qualified Stage",
		Provider:        ProviderSnowflake,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":   "xy12345.us-east-1",
			"warehouse": "compute_wh",
			"database":  "postwave",
			"schema":    "public",
			"stage":     "postwave.public.export_stage",
		},
	})
	if !valid.Valid {
		t.Fatalf("expected qualified Snowflake stage path to be valid, got %#v", valid)
	}

	unsafe := ValidateConnection(Connection{
		Name:            "Snowflake Unsafe Stage",
		Provider:        ProviderSnowflake,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://snowflake-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE.PUBLIC.EXPORT_STAGE;DROP",
		},
	})
	if unsafe.Valid || !strings.Contains(strings.Join(unsafe.Errors, ","), "stage") {
		t.Fatalf("expected unsafe Snowflake stage rejection, got %#v", unsafe)
	}
}

func TestSnowflakeProviderTargetURIDisclosesManifestDestination(t *testing.T) {
	got := providerTargetURI(Connection{
		Provider: ProviderSnowflake,
		Config: map[string]any{
			"account":      "xy12345",
			"warehouse":    "COMPUTE_WH",
			"database":     "POSTWAVE",
			"schema":       "PUBLIC",
			"role":         "POSTWAVE_ROLE",
			"stage":        "POSTWAVE_STAGE",
			"import_table": "PROFILE_TRAITS",
		},
	})
	for _, want := range []string{
		"snowflake://xy12345/POSTWAVE/PUBLIC?",
		"warehouse=COMPUTE_WH",
		"role=POSTWAVE_ROLE",
		"stage=POSTWAVE_STAGE",
		"import_table=PROFILE_TRAITS",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("target URI %q missing %q", got, want)
		}
	}
}

func TestValidateConnectionDatabricksAcceptsCredentialRef(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Databricks Lakehouse",
		Provider:        "databricks",
		Direction:       "bidirectional",
		Status:          "active",
		Cadence:         "daily",
		BackfillDays:    30,
		CredentialsRef:  "vault://databricks-prod",
		ObjectSelection: []string{"profiles", "events"},
		Config: map[string]any{
			"workspace_url": "https://adb-123.azuredatabricks.net",
			"warehouse_id":  "abc",
			"catalog":       "postwave",
			"schema":        "marketing",
		},
	})
	if !got.Valid {
		t.Fatalf("expected valid Databricks connection, got %#v", got)
	}
	if len(got.Warnings) == 0 {
		t.Fatalf("expected partial-driver warning, got %#v", got.Warnings)
	}
}

func TestValidateConnectionRejectsRawCredentialConfig(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Unsafe",
		Provider:        "postgres",
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"host":     "db.example.com",
			"database": "postwave",
			"schema":   "public",
			"password": "not-here",
		},
	})
	if got.Valid {
		t.Fatalf("expected raw credential config to be rejected")
	}
}

func TestValidateConnectionRejectsAdditionalRawWarehouseSecretNames(t *testing.T) {
	for _, key := range []string{"sas_token", "account_key", "storage_account_key", "shared_key", "access_key_id", "auth.privateKey", "credentials.awsSecretAccessKey"} {
		config := map[string]any{
			"account_url": "https://example.blob.core.windows.net",
			"container":   "exports",
		}
		switch key {
		case "auth.privateKey":
			config["auth"] = map[string]any{"privateKey": "not-here"}
		case "credentials.awsSecretAccessKey":
			config["credentials"] = map[string]any{"awsSecretAccessKey": "not-here"}
		default:
			config[key] = "not-here"
		}
		got := ValidateConnection(Connection{
			Name:            "Unsafe " + key,
			Provider:        ProviderAzureBlob,
			Direction:       "export",
			Status:          "draft",
			Cadence:         "manual",
			BackfillDays:    30,
			ObjectSelection: []string{"profiles"},
			Config:          config,
		})
		if got.Valid {
			t.Fatalf("expected %s to be rejected as raw credential config", key)
		}
	}
}

func TestValidateConnectionR2IsExecutableObjectStorage(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Daily R2",
		Provider:        "R2",
		Direction:       "bidirectional",
		Status:          "active",
		Cadence:         "daily",
		BackfillDays:    30,
		CredentialsRef:  "vault://r2-prod",
		ObjectSelection: []string{"profiles", "events"},
		Config: map[string]any{
			"bucket":     "postwave-prod",
			"account_id": "1234567890abcdef1234567890abcdef",
		},
	})
	if !got.Valid {
		t.Fatalf("expected valid R2 connection, got %#v", got)
	}
	if len(got.Warnings) == 0 || !strings.Contains(strings.Join(got.Warnings, ","), "storage adapter") {
		t.Fatalf("expected storage-adapter warning, got %#v", got.Warnings)
	}
}

func TestValidateConnectionRejectsRawLookingCredentialRefAndEndpointOverride(t *testing.T) {
	rawRef := ValidateConnection(Connection{
		Name:            "Unsafe ref",
		Provider:        ProviderS3,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "Bearer raw-provider-token",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"bucket": "postwave-prod",
			"region": "us-east-1",
		},
	})
	if rawRef.Valid || !strings.Contains(strings.Join(rawRef.Errors, ","), "credentials_ref") {
		t.Fatalf("expected raw-looking credentials_ref rejection, got %#v", rawRef)
	}

	endpoint := ValidateConnection(Connection{
		Name:            "Unsafe endpoint",
		Provider:        ProviderR2,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://r2-prod",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"bucket":       "postwave-prod",
			"account_id":   "1234567890abcdef1234567890abcdef",
			"endpoint_url": "http://127.0.0.1:9000",
		},
	})
	if endpoint.Valid || !strings.Contains(strings.Join(endpoint.Errors, ","), "endpoint_url") {
		t.Fatalf("expected endpoint override rejection, got %#v", endpoint)
	}
}

func TestValidateConnectionRejectsActivePlannedAzure(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Azure",
		Provider:        ProviderAzureBlob,
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    30,
		CredentialsRef:  "vault://azure",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account_url": "https://acct.blob.core.windows.net",
			"container":   "exports",
		},
	})
	if got.Valid || !strings.Contains(strings.Join(got.Errors, ","), "planned") {
		t.Fatalf("expected active planned Azure to be rejected, got %#v", got)
	}
}

func TestWarehouseProviderSpecsCoverAllowedProviders(t *testing.T) {
	specs := map[string]ProviderSpec{}
	for _, spec := range ProviderSpecs() {
		specs[spec.Provider] = spec
	}
	for _, provider := range allWarehouseProviders() {
		spec, ok := specs[provider]
		if !ok {
			t.Fatalf("missing provider spec for %q", provider)
		}
		if spec.Name == "" || spec.RuntimeStatus == "" || spec.DocsURL == "" {
			t.Fatalf("incomplete provider spec for %q: %#v", provider, spec)
		}
	}
	if specs[ProviderAzureBlob].Managed {
		t.Fatalf("azure blob should remain planned until its storage driver is attached")
	}
	if !specs[ProviderStreamingExport].Managed || specs[ProviderStreamingExport].RuntimeStatus != "available" {
		t.Fatalf("streaming export should expose the first-party worker, got %#v", specs[ProviderStreamingExport])
	}
}

func TestWarehouseProviderSpecsUsePreciseAuthModesAndDriverStates(t *testing.T) {
	cases := map[string]string{
		ProviderS3:        "aws_iam_ref",
		ProviderR2:        "r2_s3_access_key_ref",
		ProviderBigQuery:  "service_account_ref",
		ProviderSnowflake: "snowflake_auth_ref",
		ProviderRedshift:  "aws_iam_or_secret_ref",
		ProviderPostgres:  "postgres_credential_ref",
		ProviderAzureBlob: "azure_storage_credential_ref",
	}
	for provider, want := range cases {
		spec, ok := ProviderSpecByKey(provider)
		if !ok {
			t.Fatalf("missing provider %s", provider)
		}
		if spec.AuthMode != want {
			t.Fatalf("%s auth_mode = %q, want %q", provider, spec.AuthMode, want)
		}
	}

	partial := healthForConnection(Connection{Provider: ProviderSnowflake, Status: "active"}, nil)
	if partial.ProviderDriverAttachment != "manifest_worker" {
		t.Fatalf("partial driver attachment = %q", partial.ProviderDriverAttachment)
	}
	delegated := healthForConnection(Connection{Provider: ProviderR2, Status: "active"}, nil)
	if delegated.ProviderDriverAttachment != "workspace_storage" || delegated.ProviderRuntimeStatus != "delegated" {
		t.Fatalf("delegated health = %+v", delegated)
	}
	planned := healthForConnection(Connection{Provider: ProviderAzureBlob, Status: "draft"}, nil)
	if planned.ProviderDriverAttachment != "planned" || planned.ProviderRuntimeStatus != "planned" {
		t.Fatalf("planned health = %+v", planned)
	}
	disconnected := healthForConnection(Connection{Provider: ProviderSnowflake, Status: "disconnected"}, nil)
	if disconnected.Health != "disconnected" || disconnected.ProviderDriverAttachment != "manifest_worker" {
		t.Fatalf("disconnected health = %+v", disconnected)
	}
}

func TestHealthForDisconnectedConnectionKeepsDisconnectedOverFailedRun(t *testing.T) {
	failedAt := time.Date(2026, 6, 30, 9, 0, 0, 0, time.UTC)
	got := healthForConnection(Connection{
		Provider: ProviderSnowflake,
		Status:   "disconnected",
	}, []SyncRun{{
		Status:    "failed",
		Error:     "previous provider failure",
		CreatedAt: failedAt,
	}})
	if got.Health != "disconnected" || got.Error != "" || got.LastRunStatus != "failed" || got.LastRunAt == nil || !got.LastRunAt.Equal(failedAt) {
		t.Fatalf("disconnected health should retain status while showing run history: %+v", got)
	}
}

func TestHealthForDisconnectedConnectionSuppressesStaleConnectionError(t *testing.T) {
	got := healthForConnection(Connection{
		Provider: ProviderSnowflake,
		Status:   "disconnected",
		Error:    "old provider failure",
	}, nil)
	if got.Health != "disconnected" || got.Error != "" {
		t.Fatalf("disconnected health should not surface stale error state: %+v", got)
	}
}

func TestSnowflakeConnectionHealthCheckPlansSelectOneWithoutExecutor(t *testing.T) {
	got := snowflakeConnectionHealthCheck(context.Background(), Connection{
		Provider:       ProviderSnowflake,
		Status:         "active",
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}, nil, false)
	if got.State != "driver_not_attached" || got.Executable || len(got.Statements) != 1 || got.Statements[0].SQL != "SELECT 1" || got.Statements[0].Executable {
		t.Fatalf("health check = %+v", got)
	}
}

func TestSnowflakeConnectionHealthCheckRejectsMissingSettings(t *testing.T) {
	got := snowflakeConnectionHealthCheck(context.Background(), Connection{
		Provider: ProviderSnowflake,
		Status:   "active",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
		},
	}, &fakeSnowflakeExecutor{}, true)
	if got.State != "not_ready" || got.Executable || len(got.MissingRequiredSettings) == 0 || len(got.Statements) != 1 || got.Statements[0].Executable {
		t.Fatalf("health check = %+v", got)
	}
}

func TestSnowflakeConnectionHealthCheckSkipsInactiveRows(t *testing.T) {
	executor := &fakeSnowflakeExecutor{}
	got := snowflakeConnectionHealthCheck(context.Background(), Connection{
		Provider:       ProviderSnowflake,
		Status:         "disconnected",
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}, executor, true)
	if got.State != "not_active" || got.Executable || len(executor.requests) != 0 || len(got.Statements) != 1 || got.Statements[0].Executable {
		t.Fatalf("health check = %+v requests=%d", got, len(executor.requests))
	}
}

func TestSnowflakeConnectionHealthCheckExecutesSelectOneWhenRequested(t *testing.T) {
	executor := &fakeSnowflakeExecutor{result: SnowflakeJobExecutionResult{
		LiveState:          "executed",
		ExecutionMode:      "snowflake_sql_api",
		ExecutionState:     "provider_checked",
		StatementsExecuted: 1,
	}}
	conn := Connection{
		Provider:       ProviderSnowflake,
		Status:         "active",
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"role":      "POSTWAVE_ROLE",
		},
	}
	planned := snowflakeConnectionHealthCheck(context.Background(), conn, executor, false)
	if planned.State != "ready" || !planned.Executable || len(executor.requests) != 0 {
		t.Fatalf("planned health check = %+v requests=%d", planned, len(executor.requests))
	}
	got := snowflakeConnectionHealthCheck(context.Background(), conn, executor, true)
	if got.State != "provider_checked" || got.LiveState != "executed" || got.ExecutionMode != "snowflake_sql_api" || got.StatementsExecuted != 1 {
		t.Fatalf("executed health check = %+v", got)
	}
	if len(executor.requests) != 1 {
		t.Fatalf("executor calls = %d", len(executor.requests))
	}
	req := executor.requests[0]
	if req.Job.RequestKind != "health_check" || req.Job.Driver != "snowflake_sql_query" || len(req.Tables) != 0 || len(req.Artifacts) != 0 || len(req.Statements) != 1 || req.Statements[0].SQL != "SELECT 1" || !req.Statements[0].Executable {
		t.Fatalf("health request = %+v", req)
	}
}

func TestRequireMutableWarehouseConnectionRejectsDisconnectedOnly(t *testing.T) {
	if err := requireMutableWarehouseConnection(&Connection{Status: "draft"}); err != nil {
		t.Fatalf("draft connection should allow mapping edits: %v", err)
	}
	if err := requireMutableWarehouseConnection(&Connection{Status: "active"}); err != nil {
		t.Fatalf("active connection should allow mapping edits: %v", err)
	}
	if err := requireMutableWarehouseConnection(nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nil connection error = %v", err)
	}
	if err := requireMutableWarehouseConnection(&Connection{Status: "disconnected"}); !errors.Is(err, ErrDisconnected) {
		t.Fatalf("disconnected connection error = %v", err)
	}
}

func TestValidateConnectionActiveManagedProviderRequiresSettings(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Active S3",
		Provider:        ProviderS3,
		Direction:       "export",
		Status:          "active",
		Cadence:         "daily",
		BackfillDays:    30,
		ObjectSelection: []string{"profiles"},
	})
	if got.Valid {
		t.Fatalf("expected active S3 without bucket/region/credentials to be invalid")
	}
	joined := strings.Join(got.Errors, ",")
	for _, want := range []string{"bucket", "region", "credentials_ref"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected missing %s in errors, got %#v", want, got)
		}
	}
}

func TestWarehouseDisconnectCleanupEvidenceDescribesOperatorManagedSnowflakeCleanup(t *testing.T) {
	recordedAt := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	evidence := warehouseDisconnectCleanupEvidence(Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345.us-east-1",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}, recordedAt)
	if evidence["status"] != "operator_action_required" ||
		evidence["postwave_status"] != "disconnected" ||
		evidence["provider_cleanup_posture"] != "operator_managed_provider_console" ||
		evidence["managed_provider_cleanup"] != false ||
		evidence["provider_scope_type"] != "snowflake_account" ||
		evidence["provider_scope_id"] != "xy12345.us-east-1" ||
		evidence["credential_ref_present"] != true {
		t.Fatalf("cleanup evidence = %+v", evidence)
	}
	actions, ok := evidence["provider_console_actions"].([]string)
	if !ok || !strings.Contains(strings.Join(actions, " "), "roles") || !strings.Contains(strings.Join(actions, " "), "stages") {
		t.Fatalf("provider actions = %+v", evidence["provider_console_actions"])
	}
	postwaveEffects, ok := evidence["postwave_effects"].([]string)
	if !ok || !strings.Contains(strings.Join(postwaveEffects, " "), "scheduled warehouse runs exclude disconnected rows") {
		t.Fatalf("postwave effects = %+v", evidence["postwave_effects"])
	}
}

func TestNormalizeWarehouseProviderCleanupAcknowledgementInput(t *testing.T) {
	got, err := normalizeWarehouseProviderCleanupAcknowledgementInput(ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{
			" snowflake_roles_or_grants_removed ",
			"snowflake_roles_or_grants_removed",
			"snowflake_stage_or_external_integration_removed",
		},
		Notes:           strings.Repeat("n", 2100),
		AcknowledgedBy:  strings.Repeat("a", 300),
		ExpectedVersion: 7,
	})
	if err != nil {
		t.Fatalf("normalize acknowledgement: %v", err)
	}
	if len(got.CompletedActions) != 2 ||
		got.CompletedActions[0] != "snowflake_roles_or_grants_removed" ||
		got.CompletedActions[1] != "snowflake_stage_or_external_integration_removed" {
		t.Fatalf("completed actions = %#v", got.CompletedActions)
	}
	if len(got.Notes) != 2000 || len(got.AcknowledgedBy) != 200 {
		t.Fatalf("notes/actor were not bounded: notes=%d actor=%d", len(got.Notes), len(got.AcknowledgedBy))
	}

	if _, err := normalizeWarehouseProviderCleanupAcknowledgementInput(ProviderCleanupAcknowledgementInput{}); err == nil {
		t.Fatal("expected empty acknowledgement to fail")
	}
	if _, err := normalizeWarehouseProviderCleanupAcknowledgementInput(ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{"drop_everything"},
		ExpectedVersion:  7,
	}); err == nil || !strings.Contains(err.Error(), "unsupported Snowflake cleanup action key") {
		t.Fatalf("expected unsupported action error, got %v", err)
	}
}

func TestValidateConnectionRejectsUnsupportedObject(t *testing.T) {
	got := ValidateConnection(Connection{
		Name:            "Bad",
		Provider:        "s3",
		Direction:       "export",
		Status:          "active",
		Cadence:         "manual",
		BackfillDays:    90,
		ObjectSelection: []string{"profiles", "unknown"},
	})
	if got.Valid {
		t.Fatalf("expected invalid connection")
	}
}

func TestValidateRunInputRejectsDisconnectedConnection(t *testing.T) {
	conn := Connection{
		ID:              "conn-snowflake",
		Provider:        ProviderSnowflake,
		Status:          "disconnected",
		CredentialsRef:  "vault://snowflake-prod",
		Direction:       "export",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	err := validateRunInput(conn, RunInput{Direction: "export", RunMode: "manual", ObjectSelection: []string{"profiles"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "must be active") {
		t.Fatalf("expected active-status validation error, got %v", err)
	}
}

func TestValidateRunInputAllowsR2ObjectStorage(t *testing.T) {
	store := uploads.NewMemoryStore()
	conn := Connection{
		ID:              "conn-r2",
		Provider:        "r2",
		Status:          "active",
		CredentialsRef:  "vault://r2-prod",
		Direction:       "bidirectional",
		ObjectSelection: []string{"profiles", "events"},
		Config: map[string]any{
			"bucket":     "postwave-prod",
			"account_id": "1234567890abcdef1234567890abcdef",
		},
	}
	exportIn := RunInput{Direction: "export", RunMode: "manual", ObjectSelection: []string{"profiles"}}
	if err := validateRunInput(conn, exportIn, store); err != nil {
		t.Fatalf("r2 export validation failed: %v", err)
	}
	importIn := RunInput{Direction: "import", RunMode: "manual", ObjectSelection: []string{"events"}}
	if err := validateRunInput(conn, importIn, store); err != nil {
		t.Fatalf("r2 import validation failed: %v", err)
	}
}

func TestValidateRunInputAllowsManagedSQLManifestRuns(t *testing.T) {
	conn := Connection{
		ID:              "conn-snowflake",
		Provider:        "snowflake",
		Status:          "active",
		CredentialsRef:  "vault://snowflake-prod",
		Direction:       "bidirectional",
		ObjectSelection: []string{"profiles", "events"},
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	exportIn := RunInput{Direction: "export", RunMode: "manual", ObjectSelection: []string{"profiles"}}
	if err := validateRunInput(conn, exportIn, nil); err != nil {
		t.Fatalf("managed SQL export validation failed: %v", err)
	}
	importIn := RunInput{Direction: "import", RunMode: "manual", ObjectSelection: []string{"events"}}
	if err := validateRunInput(conn, importIn, nil); err != nil {
		t.Fatalf("managed SQL import manifest validation failed: %v", err)
	}
}

func TestStoreWarehouseRunArtifactStoresBundleAndPresigns(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	artifact, err := storeWarehouseRunArtifact(ctx, store, "tenant-A", "run-123", []byte("zip-body"))
	if err != nil {
		t.Fatalf("store artifact: %v", err)
	}
	if artifact.Rest != "warehouse/runs/run-123.zip" {
		t.Fatalf("rest path = %q", artifact.Rest)
	}
	if artifact.ObjectKey != "tenants/tenant-A/warehouse/runs/run-123.zip" {
		t.Fatalf("object key = %q", artifact.ObjectKey)
	}
	if !strings.Contains(artifact.DownloadURL, artifact.ObjectKey) {
		t.Fatalf("download URL %q does not include object key %q", artifact.DownloadURL, artifact.ObjectKey)
	}
	body, contentType, err := store.Get(ctx, "tenant-A", artifact.Rest)
	if err != nil {
		t.Fatalf("get artifact: %v", err)
	}
	defer func() { _ = body.Close() }()
	if contentType != "application/zip" {
		t.Fatalf("content type = %q", contentType)
	}
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if string(got) != "zip-body" {
		t.Fatalf("stored body = %q", got)
	}
}

func TestBuildSnowflakeLoadPlanQuotesIdentifiersAndCopySQL(t *testing.T) {
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"role":      "POSTWAVE_ROLE",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	rowsByObject := snowflakeRowsByObject(map[string]any{"rows_by_object": map[string]any{
		"profiles": int64(2),
		"events":   float64(3),
	}})
	entries := snowflakeExportEntries([]string{"profiles", "events"}, rowsByObject)
	plan := BuildSnowflakeLoadPlan(conn, "run-1", entries, []SnowflakeLoadArtifact{
		{Object: "profiles", Rest: "warehouse/runs/run-1/profiles.jsonl", ObjectKey: "tenants/tenant-A/warehouse/runs/run-1/profiles.jsonl", Rows: 2},
		{Object: "events", Rest: "warehouse/runs/run-1/events.jsonl", ObjectKey: "tenants/tenant-A/warehouse/runs/run-1/events.jsonl", Rows: 3},
	})
	if plan.ExecutionState != "load_plan_ready" {
		t.Fatalf("execution state = %q warnings=%+v", plan.ExecutionState, plan.Warnings)
	}
	if plan.ProviderJob == nil {
		t.Fatalf("missing provider job")
	}
	if plan.ProviderJob.Driver != "snowflake_sql_copy" || plan.ProviderJob.RequestKind != "export_copy" || plan.ProviderJob.LiveState != "not_executed" {
		t.Fatalf("provider job = %+v", plan.ProviderJob)
	}
	if plan.ProviderJob.ExecutionState != "load_plan_ready" || !plan.ProviderJob.CredentialsRefPresent {
		t.Fatalf("provider job readiness = %+v", plan.ProviderJob)
	}
	if plan.ProviderJob.TargetURI != "snowflake://xy12345/POSTWAVE/PUBLIC?role=POSTWAVE_ROLE&stage=POSTWAVE_STAGE&warehouse=COMPUTE_WH" {
		t.Fatalf("provider job target URI = %q", plan.ProviderJob.TargetURI)
	}
	if !plan.CredentialsRefPresent {
		t.Fatalf("expected credentials_ref evidence")
	}
	byObject := map[string]SnowflakeTablePlan{}
	for _, table := range plan.Tables {
		byObject[table.Object] = table
	}
	profiles := byObject["profiles"]
	if profiles.Table != `"POSTWAVE"."PUBLIC"."POSTWAVE_PROFILES"` {
		t.Fatalf("profiles table = %q", profiles.Table)
	}
	if profiles.DestinationSchemaVersion != "postwave_warehouse_profiles_v1" {
		t.Fatalf("profiles schema version = %q", profiles.DestinationSchemaVersion)
	}
	for _, want := range []string{
		`CREATE TABLE IF NOT EXISTS "POSTWAVE"."PUBLIC"."POSTWAVE_PROFILES"`,
		`"ID" STRING`,
		`"TAGS" VARIANT`,
		`"CUSTOM_FIELDS" VARIANT`,
		`"UPDATED_AT" TIMESTAMP_NTZ`,
	} {
		if !strings.Contains(profiles.CreateTableSQL, want) {
			t.Fatalf("create table SQL %q missing %q", profiles.CreateTableSQL, want)
		}
	}
	if !strings.Contains(profiles.ValidateTableSQL, `"POSTWAVE".INFORMATION_SCHEMA.COLUMNS`) ||
		!strings.Contains(profiles.ValidateTableSQL, `table_schema = 'PUBLIC'`) ||
		!strings.Contains(profiles.ValidateTableSQL, `table_name = 'POSTWAVE_PROFILES'`) {
		t.Fatalf("validate table SQL = %q", profiles.ValidateTableSQL)
	}
	for _, want := range []string{
		`COPY INTO "POSTWAVE"."PUBLIC"."POSTWAVE_PROFILES"`,
		`FROM @"POSTWAVE"."PUBLIC"."POSTWAVE_STAGE"/warehouse/runs/run-1/profiles.jsonl`,
		`MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE`,
	} {
		if !strings.Contains(profiles.CopySQL, want) {
			t.Fatalf("copy SQL %q missing %q", profiles.CopySQL, want)
		}
	}
	if byObject["events"].Rows != 3 {
		t.Fatalf("events rows = %d", byObject["events"].Rows)
	}
	jobByObject := map[string]SnowflakeProviderJobTable{}
	for _, table := range plan.ProviderJob.Tables {
		jobByObject[table.Object] = table
	}
	if !jobByObject["profiles"].Executable || jobByObject["profiles"].CopySQL == "" {
		t.Fatalf("provider job profiles table = %+v", jobByObject["profiles"])
	}
	if jobByObject["profiles"].DestinationSchemaVersion != profiles.DestinationSchemaVersion ||
		jobByObject["profiles"].CreateTableSQL != profiles.CreateTableSQL ||
		jobByObject["profiles"].ValidateTableSQL != profiles.ValidateTableSQL {
		t.Fatalf("provider job should carry destination schema plan: %+v", jobByObject["profiles"])
	}
	if jobByObject["profiles"].ArtifactURI != "warehouse/runs/run-1/profiles.jsonl" {
		t.Fatalf("provider job artifact URI = %q", jobByObject["profiles"].ArtifactURI)
	}
	if jobByObject["profiles"].ArtifactObjectKey != "tenants/tenant-A/warehouse/runs/run-1/profiles.jsonl" {
		t.Fatalf("provider job artifact object key = %q", jobByObject["profiles"].ArtifactObjectKey)
	}
}

func TestBuildSnowflakeLoadPlanNormalizesLowercaseUnquotedIdentifiers(t *testing.T) {
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "compute_wh",
			"database":  "postwave",
			"schema":    "public",
			"stage":     "postwave.public.export_stage",
		},
	}
	plan := BuildSnowflakeLoadPlan(conn, "run-1", snowflakeExportEntries([]string{"profiles"}, map[string]int64{
		"profiles": 1,
	}), []SnowflakeLoadArtifact{
		{Object: "profiles", Rest: "warehouse/runs/run-1/profiles.jsonl", Rows: 1},
	})
	if len(plan.Tables) != 1 {
		t.Fatalf("tables = %+v", plan.Tables)
	}
	if plan.Tables[0].Table != `"POSTWAVE"."PUBLIC"."POSTWAVE_PROFILES"` {
		t.Fatalf("table = %q", plan.Tables[0].Table)
	}
	if !strings.Contains(plan.Tables[0].CopySQL, `FROM @"POSTWAVE"."PUBLIC"."EXPORT_STAGE"/warehouse/runs/run-1/profiles.jsonl`) {
		t.Fatalf("copy SQL did not normalize qualified stage: %q", plan.Tables[0].CopySQL)
	}
	if !strings.Contains(plan.Tables[0].CreateTableSQL, `CREATE TABLE IF NOT EXISTS "POSTWAVE"."PUBLIC"."POSTWAVE_PROFILES"`) {
		t.Fatalf("create table SQL did not normalize lowercase identifiers: %q", plan.Tables[0].CreateTableSQL)
	}
	if plan.ProviderJob == nil || len(plan.ProviderJob.Statements) != 3 {
		t.Fatalf("provider job statements = %+v", plan.ProviderJob)
	}
	for i, statement := range plan.ProviderJob.Statements {
		if statement.Order != i+1 || !statement.Executable {
			t.Fatalf("statement[%d] = %+v", i, statement)
		}
	}
	if plan.ProviderJob.Statements[0].Phase != "create_table" ||
		plan.ProviderJob.Statements[1].Phase != "validate_table" ||
		plan.ProviderJob.Statements[2].Phase != "copy_into" ||
		!strings.Contains(plan.ProviderJob.Statements[2].SQL, `FROM @"POSTWAVE"."PUBLIC"."EXPORT_STAGE"/warehouse/runs/run-1/profiles.jsonl`) {
		t.Fatalf("ordered statement plan = %+v", plan.ProviderJob.Statements)
	}
}

func TestBuildSnowflakeLoadPlanWarnsWhenStageOrArtifactsMissing(t *testing.T) {
	conn := Connection{
		Provider: ProviderSnowflake,
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	plan := BuildSnowflakeLoadPlan(conn, "run-1", []snowflakeExportEntry{
		{Object: "profiles", Entry: "profiles.jsonl", Rows: 1},
	}, nil)
	if plan.ExecutionState != "waiting_for_provider_driver" {
		t.Fatalf("execution state = %q", plan.ExecutionState)
	}
	joined := strings.Join(plan.Warnings, " ")
	for _, want := range []string{"stage", "artifacts", "credentials_ref"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("warnings %q missing %q", joined, want)
		}
	}
	if len(plan.Tables) != 1 || plan.Tables[0].CopySQL != "" {
		t.Fatalf("unexpected table plans: %+v", plan.Tables)
	}
	if plan.ProviderJob == nil || plan.ProviderJob.ExecutionState != "waiting_for_provider_driver" || plan.ProviderJob.CredentialsRefPresent {
		t.Fatalf("provider job readiness = %+v", plan.ProviderJob)
	}
}

func TestBuildSnowflakeLoadPlanDoesNotReadyPartialArtifacts(t *testing.T) {
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	entries := snowflakeExportEntries([]string{"profiles", "events"}, map[string]int64{
		"profiles": 2,
		"events":   3,
	})
	plan := BuildSnowflakeLoadPlan(conn, "run-1", entries, []SnowflakeLoadArtifact{
		{Object: "profiles", Rest: "warehouse/runs/run-1/profiles.jsonl", Rows: 2},
	})
	if plan.ExecutionState == "load_plan_ready" {
		t.Fatalf("partial artifact set should not be load ready: %+v", plan)
	}
	byObject := map[string]SnowflakeTablePlan{}
	for _, table := range plan.Tables {
		byObject[table.Object] = table
	}
	if byObject["profiles"].CopySQL == "" {
		t.Fatalf("available object should still get COPY SQL: %+v", byObject["profiles"])
	}
	if byObject["events"].CopySQL != "" {
		t.Fatalf("missing artifact should not get COPY SQL: %+v", byObject["events"])
	}
	jobByObject := map[string]SnowflakeProviderJobTable{}
	for _, table := range plan.ProviderJob.Tables {
		jobByObject[table.Object] = table
	}
	if !jobByObject["profiles"].Executable || jobByObject["events"].Executable {
		t.Fatalf("provider job executable flags = %+v", jobByObject)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " "), `"events"`) {
		t.Fatalf("warnings should identify missing object artifact: %+v", plan.Warnings)
	}
}

func TestBuildSnowflakeLoadPlanDoesNotCopyUnavailableReviews(t *testing.T) {
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	entries := snowflakeExportEntries([]string{"reviews"}, map[string]int64{"reviews": 0})
	plan := BuildSnowflakeLoadPlan(conn, "run-1", entries, []SnowflakeLoadArtifact{
		{Object: "reviews", Rest: "warehouse/runs/run-1/reviews.jsonl", Rows: 0},
	})
	if plan.ExecutionState == "load_plan_ready" {
		t.Fatalf("placeholder reviews artifact should not be load ready: %+v", plan)
	}
	if len(plan.Tables) != 1 || plan.Tables[0].CopySQL != "" {
		t.Fatalf("reviews should not get executable COPY SQL: %+v", plan.Tables)
	}
	if plan.ProviderJob == nil || len(plan.ProviderJob.Tables) != 1 || plan.ProviderJob.Tables[0].Executable {
		t.Fatalf("reviews provider job should remain non-executable: %+v", plan.ProviderJob)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " "), `"reviews"`) {
		t.Fatalf("warnings should identify reviews as non-executable: %+v", plan.Warnings)
	}
}

func TestExecuteSnowflakeProviderJobVerifiesArtifactsAndCallsExecutor(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	mustPut(t, ctx, store, "tenant-A", "warehouse/runs/run-1/profiles.jsonl", []byte(`{"email":"a@example.com"}`+"\n"))
	mustPut(t, ctx, store, "tenant-A", "warehouse/runs/run-1/events.jsonl", []byte(`{"event_type":"opened"}`+"\n"))
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	entries := snowflakeExportEntries([]string{"profiles", "events"}, map[string]int64{
		"profiles": 2,
		"events":   3,
	})
	plan := BuildSnowflakeLoadPlan(conn, "run-1", entries, []SnowflakeLoadArtifact{
		{Object: "profiles", Rest: "warehouse/runs/run-1/profiles.jsonl", ObjectKey: "tenants/tenant-A/warehouse/runs/run-1/profiles.jsonl", Rows: 2},
		{Object: "events", Rest: "warehouse/runs/run-1/events.jsonl", ObjectKey: "tenants/tenant-A/warehouse/runs/run-1/events.jsonl", Rows: 3},
	})
	executor := &fakeSnowflakeExecutor{result: SnowflakeJobExecutionResult{
		ExecutionMode:      "fake_driver",
		StatementsExecuted: 2,
		TablesLoaded:       2,
		RowsLoaded:         5,
		Metrics:            map[string]any{"driver": "unit", "execution_state": "driver_state"},
	}}
	metrics, err := executeSnowflakeProviderJob(ctx, store, executor, "tenant-A", conn, plan.ProviderJob)
	if err != nil {
		t.Fatalf("execute job: %v", err)
	}
	if len(executor.requests) != 1 {
		t.Fatalf("executor calls = %d", len(executor.requests))
	}
	req := executor.requests[0]
	if req.Job.LiveState != "not_executed" || len(req.Tables) != 2 || len(req.Artifacts) != 2 || len(req.Statements) != 6 {
		t.Fatalf("request = %+v", req)
	}
	if req.Statements[0].Phase != "create_table" ||
		req.Statements[1].Phase != "validate_table" ||
		req.Statements[2].Phase != "copy_into" ||
		req.Statements[3].Phase != "create_table" ||
		req.Statements[3].Object == req.Statements[0].Object ||
		req.Statements[5].Phase != "copy_into" {
		t.Fatalf("request statements = %+v", req.Statements)
	}
	if req.Artifacts[0].ContentType != "application/x-ndjson" || req.Artifacts[0].Bytes == 0 {
		t.Fatalf("verified artifacts = %+v", req.Artifacts)
	}
	if metrics["snowflake_provider_execution_state"] != "local_executed" ||
		metrics["snowflake_provider_job_state"] != "not_executed" ||
		metrics["snowflake_provider_execution_mode"] != "fake_driver" ||
		metrics["snowflake_provider_execution_live_state"] != "not_executed" ||
		metrics["snowflake_provider_artifacts_verified"] != 2 ||
		metrics["snowflake_provider_statements_executed"] != 2 ||
		metrics["snowflake_provider_tables_loaded"] != 2 ||
		metrics["snowflake_provider_rows_loaded"] != int64(5) ||
		metrics["snowflake_provider_driver"] != "unit" ||
		metrics["snowflake_provider_driver_execution_state"] != "driver_state" {
		t.Fatalf("execution metrics = %+v", metrics)
	}
}

func TestExecuteSnowflakeProviderJobSkipsNonReadyPlan(t *testing.T) {
	ctx := context.Background()
	conn := Connection{
		Provider: ProviderSnowflake,
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	plan := BuildSnowflakeLoadPlan(conn, "run-1", []snowflakeExportEntry{
		{Object: "profiles", Entry: "profiles.jsonl", Rows: 1},
	}, nil)
	executor := &fakeSnowflakeExecutor{}
	metrics, err := executeSnowflakeProviderJob(ctx, uploads.NewMemoryStore(), executor, "tenant-A", conn, plan.ProviderJob)
	if err != nil {
		t.Fatalf("execute job: %v", err)
	}
	if len(executor.requests) != 0 {
		t.Fatalf("executor should not run for non-ready plan: %+v", executor.requests)
	}
	if metrics["snowflake_provider_execution_state"] != "not_ready" ||
		metrics["snowflake_provider_execution_reason"] != "waiting_for_provider_driver" {
		t.Fatalf("metrics = %+v", metrics)
	}
}

func TestExecuteSnowflakeProviderJobSkipsUnavailableReviewsPlan(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	mustPut(t, ctx, store, "tenant-A", "warehouse/runs/run-1/reviews.jsonl", []byte(`{"unavailable":true}`+"\n"))
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	plan := BuildSnowflakeLoadPlan(conn, "run-1", snowflakeExportEntries([]string{"reviews"}, map[string]int64{"reviews": 1}), []SnowflakeLoadArtifact{
		{Object: "reviews", Rest: "warehouse/runs/run-1/reviews.jsonl", Rows: 1},
	})
	executor := &fakeSnowflakeExecutor{}
	metrics, err := executeSnowflakeProviderJob(ctx, store, executor, "tenant-A", conn, plan.ProviderJob)
	if err != nil {
		t.Fatalf("execute job: %v", err)
	}
	if len(executor.requests) != 0 {
		t.Fatalf("executor should not run for placeholder reviews plan: %+v", executor.requests)
	}
	if metrics["snowflake_provider_execution_state"] != "not_ready" {
		t.Fatalf("metrics = %+v", metrics)
	}
}

func TestStoreSnowflakeJSONLArtifactsExtractsBundleEntries(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{
		"profiles.jsonl":                 `{"email":"a@example.com"}` + "\n",
		"events/subscriber_events.jsonl": `{"event_type":"opened"}` + "\n",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	artifacts, err := storeSnowflakeJSONLArtifacts(ctx, store, "tenant-A", "run-1", buf.Bytes(), []snowflakeExportEntry{
		{Object: "profiles", Entry: "profiles.jsonl", Rows: 1},
		{Object: "events", Entry: "events/subscriber_events.jsonl", Rows: 1},
	})
	if err != nil {
		t.Fatalf("store snowflake artifacts: %v", err)
	}
	if len(artifacts) != 2 {
		t.Fatalf("artifacts = %+v", artifacts)
	}
	if artifacts[0].Rest != "warehouse/runs/run-1/profiles.jsonl" || artifacts[1].Rest != "warehouse/runs/run-1/events.jsonl" {
		t.Fatalf("artifact paths = %+v", artifacts)
	}
	body, contentType, err := store.Get(ctx, "tenant-A", artifacts[0].Rest)
	if err != nil {
		t.Fatalf("get snowflake artifact: %v", err)
	}
	defer func() { _ = body.Close() }()
	if contentType != "application/x-ndjson" {
		t.Fatalf("content type = %q", contentType)
	}
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read snowflake artifact: %v", err)
	}
	if string(got) != `{"email":"a@example.com"}`+"\n" {
		t.Fatalf("stored snowflake body = %q", got)
	}
}

func TestBuildSnowflakeImportPlanUsesConfiguredImportTable(t *testing.T) {
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":      "xy12345",
			"warehouse":    "COMPUTE_WH",
			"database":     "POSTWAVE",
			"schema":       "PUBLIC",
			"import_table": "POSTWAVE.PUBLIC.PROFILE_TRAITS",
		},
	}
	plan := BuildSnowflakeImportPlan(conn, "run-1")
	if plan.ExecutionState != "import_plan_ready" {
		t.Fatalf("execution state = %q", plan.ExecutionState)
	}
	if len(plan.Tables) != 1 || plan.Tables[0].Table != `"POSTWAVE"."PUBLIC"."PROFILE_TRAITS"` {
		t.Fatalf("import tables = %+v", plan.Tables)
	}
	if plan.ProviderJob == nil || plan.ProviderJob.Driver != "snowflake_sql_query" || plan.ProviderJob.RequestKind != "import_query" {
		t.Fatalf("provider job = %+v", plan.ProviderJob)
	}
	if len(plan.ProviderJob.Tables) != 1 || plan.ProviderJob.Tables[0].QuerySQL != `SELECT * FROM "POSTWAVE"."PUBLIC"."PROFILE_TRAITS"` || !plan.ProviderJob.Tables[0].Executable {
		t.Fatalf("provider job tables = %+v", plan.ProviderJob.Tables)
	}
	if len(plan.ProviderJob.Statements) != 1 ||
		plan.ProviderJob.Statements[0].Order != 1 ||
		plan.ProviderJob.Statements[0].Phase != "query" ||
		plan.ProviderJob.Statements[0].SQL != `SELECT * FROM "POSTWAVE"."PUBLIC"."PROFILE_TRAITS"` ||
		!plan.ProviderJob.Statements[0].Executable {
		t.Fatalf("provider job statements = %+v", plan.ProviderJob.Statements)
	}
}

func TestExecuteSnowflakeProviderJobRunsImportQueryPlan(t *testing.T) {
	ctx := context.Background()
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake-prod",
		Config: map[string]any{
			"account":      "xy12345",
			"warehouse":    "COMPUTE_WH",
			"database":     "POSTWAVE",
			"schema":       "PUBLIC",
			"import_table": "POSTWAVE.PUBLIC.PROFILE_TRAITS",
		},
	}
	plan := BuildSnowflakeImportPlan(conn, "run-1")
	executor := &fakeSnowflakeExecutor{result: SnowflakeJobExecutionResult{
		LiveState:          "executed",
		ExecutionMode:      "snowflake_sql_api",
		ExecutionState:     "provider_executed",
		StatementsExecuted: 1,
		RowsLoaded:         7,
		Metrics:            map[string]any{"query_id": "01abc"},
	}}
	metrics, err := executeSnowflakeProviderJob(ctx, nil, executor, "tenant-A", conn, plan.ProviderJob)
	if err != nil {
		t.Fatalf("execute import job: %v", err)
	}
	if len(executor.requests) != 1 {
		t.Fatalf("executor calls = %d", len(executor.requests))
	}
	req := executor.requests[0]
	if req.Job.RequestKind != "import_query" || len(req.Tables) != 1 || len(req.Artifacts) != 0 || len(req.Statements) != 1 {
		t.Fatalf("request = %+v", req)
	}
	if req.Tables[0].QuerySQL != `SELECT * FROM "POSTWAVE"."PUBLIC"."PROFILE_TRAITS"` {
		t.Fatalf("query table = %+v", req.Tables[0])
	}
	if req.Statements[0].Phase != "query" || req.Statements[0].SQL != req.Tables[0].QuerySQL {
		t.Fatalf("query statements = %+v", req.Statements)
	}
	if metrics["snowflake_provider_job_state"] != "executed" ||
		metrics["snowflake_provider_execution_live_state"] != "executed" ||
		metrics["snowflake_provider_execution_state"] != "provider_executed" ||
		metrics["snowflake_provider_execution_mode"] != "snowflake_sql_api" ||
		metrics["snowflake_provider_statements_executed"] != 1 ||
		metrics["snowflake_provider_rows_loaded"] != int64(7) ||
		metrics["snowflake_provider_query_id"] != "01abc" {
		t.Fatalf("execution metrics = %+v", metrics)
	}
}

func TestValidateRunInputRejectsDraftConnections(t *testing.T) {
	conn := Connection{
		ID:              "conn-snowflake",
		Provider:        "snowflake",
		Status:          "draft",
		CredentialsRef:  "vault://snowflake-prod",
		Direction:       "export",
		ObjectSelection: []string{"profiles"},
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	err := validateRunInput(conn, RunInput{Direction: "export", RunMode: "manual", ObjectSelection: []string{"profiles"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "must be active") {
		t.Fatalf("expected draft connection rejection, got %v", err)
	}
}

func TestNormalizeRunInputMapsSyncAliasToManual(t *testing.T) {
	conn := Connection{Direction: "export", ObjectSelection: []string{"profiles"}}
	in := RunInput{RunMode: "sync"}
	normalizeRunInput(&in, conn)
	if in.RunMode != "manual" {
		t.Fatalf("run_mode = %q, want manual", in.RunMode)
	}
}

func TestNormalizeRunInputUsesConnectionDefaults(t *testing.T) {
	conn := Connection{
		Direction:       "bidirectional",
		ObjectSelection: []string{"profiles", "events"},
	}
	var in RunInput
	normalizeRunInput(&in, conn)
	if in.Direction != "export" {
		t.Fatalf("direction = %q", in.Direction)
	}
	if in.RunMode != "manual" {
		t.Fatalf("run mode = %q", in.RunMode)
	}
	if len(in.ObjectSelection) != 2 {
		t.Fatalf("objects = %#v", in.ObjectSelection)
	}
}

func TestImportPrefixForUsesConfigOrConnectionID(t *testing.T) {
	defaultPrefix := importPrefixFor(Connection{ID: "abc"})
	if defaultPrefix != "warehouse/imports/abc/" {
		t.Fatalf("default prefix = %q", defaultPrefix)
	}
	custom := importPrefixFor(Connection{
		ID:     "abc",
		Config: map[string]any{"import_prefix": "/exports/feed/"},
	})
	if custom != "exports/feed/" {
		t.Fatalf("custom prefix = %q", custom)
	}
}

func TestSourceObjectFromKey(t *testing.T) {
	cases := map[string]string{
		"warehouse/imports/conn/orders/2026-06-01.jsonl": "orders",
		"warehouse/imports/conn/orders.jsonl":            "orders",
		"misc/uploads/random.jsonl":                      "random",
		"":                                               "",
	}
	for in, want := range cases {
		if got := sourceObjectFromKey(in); got != want {
			t.Errorf("sourceObjectFromKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseJSONLObjectAcceptsValidAndRecordsBadLines(t *testing.T) {
	body := strings.NewReader(`
{"subscriber_id":"sub-1","event_name":"viewed","properties":{"sku":"A"}}

{"subscriber_id":"sub-2","event_name":"ordered"}
not-json-at-all
{"subscriber_id":"sub-3","event_name":"checked_out"}
`)
	rows, errs := parseJSONLObject(body, "warehouse/imports/conn/orders/x.jsonl")
	if len(rows) != 3 {
		t.Fatalf("rows = %d (%+v)", len(rows), rows)
	}
	if len(errs) != 1 {
		t.Fatalf("errs = %d (%+v)", len(errs), errs)
	}
	if rows[0].SourceObject != "orders" {
		t.Fatalf("source_object inferred = %q", rows[0].SourceObject)
	}
	if errs[0].line != 5 {
		t.Fatalf("bad line index = %d", errs[0].line)
	}
}

func TestPollImportObjectsAdvancesCursorAndUnionsParseErrors(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	tenant := "tenant-A"
	mustPut(t, ctx, store, tenant, "warehouse/imports/conn-1/orders/2026-06-01.jsonl",
		[]byte(`{"subscriber_id":"s1","event_name":"ordered"}`+"\n"+`{"subscriber_id":"s2","event_name":"ordered"}`+"\n"))
	mustPut(t, ctx, store, tenant, "warehouse/imports/conn-1/orders/2026-06-02.jsonl",
		[]byte(`oops`+"\n"+`{"subscriber_id":"s3","event_name":"ordered"}`+"\n"))
	mustPut(t, ctx, store, tenant, "warehouse/imports/conn-1/orders/2026-06-03.jsonl",
		[]byte(`{"subscriber_id":"s4","event_name":"ordered"}`+"\n"))

	conn := Connection{ID: "conn-1", Provider: "s3"}
	result, err := pollImportObjects(ctx, store, tenant, conn, 10)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(result.rows) != 4 {
		t.Fatalf("rows = %d (%+v)", len(result.rows), result.rows)
	}
	if len(result.parseErrors) != 1 {
		t.Fatalf("parse errors = %d (%+v)", len(result.parseErrors), result.parseErrors)
	}
	want := "warehouse/imports/conn-1/orders/2026-06-03.jsonl"
	if result.advancedCursor != want {
		t.Fatalf("advancedCursor = %q want %q", result.advancedCursor, want)
	}
	if len(result.objectsRead) != 3 {
		t.Fatalf("objectsRead = %d", len(result.objectsRead))
	}

	conn.LastCursor = result.advancedCursor
	second, err := pollImportObjects(ctx, store, tenant, conn, 10)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(second.rows) != 0 || len(second.objectsRead) != 0 {
		t.Fatalf("second poll re-read objects: rows=%d objects=%d", len(second.rows), len(second.objectsRead))
	}
	if second.advancedCursor != conn.LastCursor {
		t.Fatalf("cursor regressed: %q -> %q", conn.LastCursor, second.advancedCursor)
	}
}

func TestPollImportObjectsSupportsR2ObjectStorageConnections(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	tenant := "tenant-A"
	mustPut(t, ctx, store, tenant, "warehouse/imports/conn-r2/orders/2026-06-01.jsonl",
		[]byte(`{"subscriber_id":"s1","event_name":"ordered"}`+"\n"))

	conn := Connection{ID: "conn-r2", Provider: ProviderR2}
	result, err := pollImportObjects(ctx, store, tenant, conn, 10)
	if err != nil {
		t.Fatalf("poll r2: %v", err)
	}
	if len(result.rows) != 1 || len(result.objectsRead) != 1 {
		t.Fatalf("unexpected r2 poll result: %+v", result)
	}
	if result.objectsRead[0] != "warehouse/imports/conn-r2/orders/2026-06-01.jsonl" {
		t.Fatalf("objectsRead = %+v", result.objectsRead)
	}
}

func TestPollImportObjectsRespectsLimit(t *testing.T) {
	ctx := context.Background()
	store := uploads.NewMemoryStore()
	tenant := "tenant-A"
	for i := 0; i < 5; i++ {
		key := "warehouse/imports/conn/" + string(rune('a'+i)) + ".jsonl"
		mustPut(t, ctx, store, tenant, key, []byte(`{"subscriber_id":"s","event_name":"e"}`+"\n"))
	}
	conn := Connection{ID: "conn", Provider: "s3"}
	out, err := pollImportObjects(ctx, store, tenant, conn, 2)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(out.objectsRead) != 2 {
		t.Fatalf("objectsRead = %d want 2", len(out.objectsRead))
	}
	if !strings.HasSuffix(out.advancedCursor, "b.jsonl") {
		t.Fatalf("advancedCursor = %q", out.advancedCursor)
	}
}

func TestPollImportObjectsErrorsWithoutStorage(t *testing.T) {
	if _, err := pollImportObjects(context.Background(), nil, "t", Connection{ID: "c", Provider: "s3"}, 10); err == nil {
		t.Fatal("expected storage error")
	}
}

func TestImportPollLimitClampsConfig(t *testing.T) {
	cases := map[string]struct {
		conn Connection
		want int
	}{
		"default":       {Connection{}, 25},
		"valid_int":     {Connection{Config: map[string]any{"import_limit": 7}}, 7},
		"valid_float":   {Connection{Config: map[string]any{"import_limit": 50.0}}, 50},
		"negative":      {Connection{Config: map[string]any{"import_limit": -3.0}}, 25},
		"out_of_bounds": {Connection{Config: map[string]any{"import_limit": 99999.0}}, 25},
		"wrong_type":    {Connection{Config: map[string]any{"import_limit": "many"}}, 25},
	}
	for name, tc := range cases {
		if got := importPollLimit(tc.conn); got != tc.want {
			t.Errorf("%s: got %d want %d", name, got, tc.want)
		}
	}
}

func mustPut(t *testing.T, ctx context.Context, store *uploads.MemoryStore, tenant, key string, body []byte) {
	t.Helper()
	if _, err := store.Put(ctx, tenant, key, "application/x-ndjson", bytes.NewReader(body)); err != nil {
		t.Fatalf("put %q: %v", key, err)
	}
}

func TestCadenceDue(t *testing.T) {
	now := time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)
	if !cadenceDue("daily", nil, now) {
		t.Fatalf("never-run connection should be due")
	}
	last := now.Add(-23 * time.Hour)
	if cadenceDue("daily", &last, now) {
		t.Fatalf("daily connection should not be due before 24h")
	}
	last = now.Add(-24 * time.Hour)
	if !cadenceDue("daily", &last, now) {
		t.Fatalf("daily connection should be due at 24h")
	}
	if cadenceDue("manual", nil, now) {
		t.Fatalf("manual cadence should not be due")
	}
}
