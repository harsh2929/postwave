package warehouse

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
)

type SnowflakeLoadPlan struct {
	Account               string                  `json:"account,omitempty"`
	Warehouse             string                  `json:"warehouse,omitempty"`
	Database              string                  `json:"database,omitempty"`
	Schema                string                  `json:"schema,omitempty"`
	Role                  string                  `json:"role,omitempty"`
	Stage                 string                  `json:"stage,omitempty"`
	CredentialsRefPresent bool                    `json:"credentials_ref_present"`
	ExecutionState        string                  `json:"execution_state"`
	Tables                []SnowflakeTablePlan    `json:"tables,omitempty"`
	Warnings              []string                `json:"warnings,omitempty"`
	ProviderJob           *SnowflakeProviderJob   `json:"provider_job,omitempty"`
	Artifacts             []SnowflakeLoadArtifact `json:"artifacts,omitempty"`
}

type SnowflakeTablePlan struct {
	Object                   string `json:"object"`
	Table                    string `json:"table"`
	ArtifactURI              string `json:"artifact_uri,omitempty"`
	Rows                     int64  `json:"rows"`
	DestinationSchemaVersion string `json:"destination_schema_version,omitempty"`
	CreateTableSQL           string `json:"create_table_sql,omitempty"`
	ValidateTableSQL         string `json:"validate_table_sql,omitempty"`
	CopySQL                  string `json:"copy_sql,omitempty"`
	QuerySQL                 string `json:"query_sql,omitempty"`
	Executable               bool   `json:"executable"`
}

type SnowflakeProviderJob struct {
	Driver                string                          `json:"driver"`
	RunID                 string                          `json:"run_id,omitempty"`
	RequestKind           string                          `json:"request_kind"`
	LiveState             string                          `json:"live_state"`
	ExecutionState        string                          `json:"execution_state"`
	Account               string                          `json:"account,omitempty"`
	Warehouse             string                          `json:"warehouse,omitempty"`
	Database              string                          `json:"database,omitempty"`
	Schema                string                          `json:"schema,omitempty"`
	Role                  string                          `json:"role,omitempty"`
	Stage                 string                          `json:"stage,omitempty"`
	TargetURI             string                          `json:"target_uri,omitempty"`
	CredentialsRefPresent bool                            `json:"credentials_ref_present"`
	Tables                []SnowflakeProviderJobTable     `json:"tables,omitempty"`
	Statements            []SnowflakeProviderJobStatement `json:"statements,omitempty"`
	Artifacts             []SnowflakeLoadArtifact         `json:"artifacts,omitempty"`
	Warnings              []string                        `json:"warnings,omitempty"`
}

type SnowflakeProviderJobTable struct {
	Object                   string `json:"object"`
	Table                    string `json:"table"`
	ArtifactURI              string `json:"artifact_uri,omitempty"`
	ArtifactObjectKey        string `json:"artifact_object_key,omitempty"`
	Rows                     int64  `json:"rows"`
	DestinationSchemaVersion string `json:"destination_schema_version,omitempty"`
	CreateTableSQL           string `json:"create_table_sql,omitempty"`
	ValidateTableSQL         string `json:"validate_table_sql,omitempty"`
	CopySQL                  string `json:"copy_sql,omitempty"`
	QuerySQL                 string `json:"query_sql,omitempty"`
	Executable               bool   `json:"executable"`
}

type SnowflakeProviderJobStatement struct {
	Order      int    `json:"order"`
	Phase      string `json:"phase"`
	Object     string `json:"object,omitempty"`
	Table      string `json:"table,omitempty"`
	SQL        string `json:"sql"`
	Executable bool   `json:"executable"`
}

type SnowflakeLoadArtifact struct {
	Object    string `json:"object"`
	ZipEntry  string `json:"zip_entry,omitempty"`
	Rest      string `json:"rest,omitempty"`
	ObjectKey string `json:"object_key,omitempty"`
	Rows      int64  `json:"rows"`
}

type SnowflakeJobExecutor interface {
	ExecuteSnowflakeJob(ctx context.Context, req SnowflakeJobExecutionRequest) (SnowflakeJobExecutionResult, error)
}

type SnowflakeJobExecutionRequest struct {
	Connection Connection                      `json:"connection"`
	Job        SnowflakeProviderJob            `json:"job"`
	Tables     []SnowflakeProviderJobTable     `json:"tables"`
	Statements []SnowflakeProviderJobStatement `json:"statements,omitempty"`
	Artifacts  []SnowflakeVerifiedArtifact     `json:"artifacts"`
}

type SnowflakeVerifiedArtifact struct {
	Object      string `json:"object"`
	Rest        string `json:"rest"`
	ObjectKey   string `json:"object_key,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	Bytes       int64  `json:"bytes"`
	Rows        int64  `json:"rows"`
}

type SnowflakeJobExecutionResult struct {
	LiveState          string         `json:"live_state,omitempty"`
	ExecutionMode      string         `json:"execution_mode,omitempty"`
	ExecutionState     string         `json:"execution_state,omitempty"`
	StatementsExecuted int            `json:"statements_executed,omitempty"`
	TablesLoaded       int            `json:"tables_loaded,omitempty"`
	RowsLoaded         int64          `json:"rows_loaded,omitempty"`
	Warnings           []string       `json:"warnings,omitempty"`
	Metrics            map[string]any `json:"metrics,omitempty"`
}

type snowflakeExportEntry struct {
	Object string
	Entry  string
	Rows   int64
}

type snowflakeColumn struct {
	Name string
	Type string
}

func BuildSnowflakeLoadPlan(conn Connection, runID string, entries []snowflakeExportEntry, artifacts []SnowflakeLoadArtifact) SnowflakeLoadPlan {
	plan := SnowflakeLoadPlan{
		Account:               configString(conn.Config, "account"),
		Warehouse:             configString(conn.Config, "warehouse"),
		Database:              configString(conn.Config, "database"),
		Schema:                configString(conn.Config, "schema"),
		Role:                  configString(conn.Config, "role"),
		Stage:                 configString(conn.Config, "stage"),
		CredentialsRefPresent: strings.TrimSpace(firstNonEmpty(conn.CredentialsRef, configString(conn.Config, "credentials_ref"), configString(conn.Config, "credential_ref"))) != "",
		ExecutionState:        "waiting_for_provider_driver",
		Artifacts:             artifacts,
	}
	if plan.Stage == "" {
		plan.Warnings = append(plan.Warnings, "Snowflake stage is not configured; COPY execution requires a named stage or external-stage handoff.")
	}
	if len(artifacts) == 0 {
		plan.Warnings = append(plan.Warnings, "Snowflake JSONL artifacts are not stored; configure warehouse object storage before attaching the COPY driver.")
	}
	if !plan.CredentialsRefPresent {
		plan.Warnings = append(plan.Warnings, "Snowflake credentials_ref is missing; live driver execution cannot resolve provider credentials.")
	}
	artifactByObject := map[string]SnowflakeLoadArtifact{}
	for _, artifact := range artifacts {
		artifactByObject[artifact.Object] = artifact
	}
	ready := plan.Stage != "" && plan.CredentialsRefPresent && len(entries) > 0
	readyTables := 0
	if len(entries) == 0 {
		plan.Warnings = append(plan.Warnings, "No Snowflake-exportable warehouse objects were selected for this run.")
	}
	for _, entry := range entries {
		table := snowflakeObjectTableName(conn, entry.Object)
		artifact := artifactByObject[entry.Object]
		artifactURI := ""
		if artifact.Rest != "" {
			artifactURI = artifact.Rest
		} else if entry.Entry != "" {
			artifactURI = "zip://" + entry.Entry
		}
		tablePlan := SnowflakeTablePlan{
			Object:      entry.Object,
			Table:       table,
			ArtifactURI: artifactURI,
			Rows:        entry.Rows,
		}
		if !snowflakeExecutableObject(entry.Object) {
			ready = false
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("Snowflake object %q is not yet exportable as an executable COPY plan.", entry.Object))
			plan.Tables = append(plan.Tables, tablePlan)
			continue
		}
		tablePlan.DestinationSchemaVersion = snowflakeDestinationSchemaVersion(entry.Object)
		tablePlan.CreateTableSQL = snowflakeCreateTableSQL(table, snowflakeDestinationColumns(entry.Object))
		tablePlan.ValidateTableSQL = snowflakeValidateTableSQL(conn, entry.Object)
		if artifact.Rest == "" {
			ready = false
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("Snowflake JSONL artifact is missing for object %q; COPY plan cannot load every selected object.", entry.Object))
		} else if plan.Stage != "" {
			tablePlan.CopySQL = snowflakeCopySQL(table, snowflakeQualifiedTableName(conn, plan.Stage), artifact.Rest)
			tablePlan.Executable = plan.CredentialsRefPresent
			readyTables++
		}
		plan.Tables = append(plan.Tables, tablePlan)
	}
	if ready && readyTables == len(entries) {
		plan.ExecutionState = "load_plan_ready"
	}
	plan.ProviderJob = snowflakeProviderJob(conn, runID, "snowflake_sql_copy", "export_copy", plan)
	return plan
}

func BuildSnowflakeImportPlan(conn Connection, runID string) SnowflakeLoadPlan {
	table := configString(conn.Config, "import_table")
	plan := SnowflakeLoadPlan{
		Account:               configString(conn.Config, "account"),
		Warehouse:             configString(conn.Config, "warehouse"),
		Database:              configString(conn.Config, "database"),
		Schema:                configString(conn.Config, "schema"),
		Role:                  configString(conn.Config, "role"),
		Stage:                 configString(conn.Config, "stage"),
		CredentialsRefPresent: strings.TrimSpace(firstNonEmpty(conn.CredentialsRef, configString(conn.Config, "credentials_ref"), configString(conn.Config, "credential_ref"))) != "",
		ExecutionState:        "waiting_for_provider_driver",
	}
	if table == "" {
		plan.Warnings = append(plan.Warnings, "Snowflake import_table is not configured; remote import polling requires a table or view.")
		plan.ProviderJob = snowflakeProviderJob(conn, runID, "snowflake_sql_query", "import_query", plan)
		return plan
	}
	if !plan.CredentialsRefPresent {
		plan.Warnings = append(plan.Warnings, "Snowflake credentials_ref is missing; live driver import queries cannot resolve provider credentials.")
	}
	qualifiedTable := snowflakeQualifiedTableName(conn, table)
	plan.Tables = []SnowflakeTablePlan{{
		Object:     "import_table",
		Table:      qualifiedTable,
		QuerySQL:   fmt.Sprintf("SELECT * FROM %s", qualifiedTable),
		Executable: plan.CredentialsRefPresent,
	}}
	if plan.CredentialsRefPresent {
		plan.ExecutionState = "import_plan_ready"
	}
	plan.ProviderJob = snowflakeProviderJob(conn, runID, "snowflake_sql_query", "import_query", plan)
	return plan
}

func snowflakeProviderJob(conn Connection, runID, driver, requestKind string, plan SnowflakeLoadPlan) *SnowflakeProviderJob {
	job := &SnowflakeProviderJob{
		Driver:                driver,
		RunID:                 strings.TrimSpace(runID),
		RequestKind:           requestKind,
		LiveState:             "not_executed",
		ExecutionState:        plan.ExecutionState,
		Account:               plan.Account,
		Warehouse:             plan.Warehouse,
		Database:              plan.Database,
		Schema:                plan.Schema,
		Role:                  plan.Role,
		Stage:                 plan.Stage,
		TargetURI:             providerTargetURI(conn),
		CredentialsRefPresent: plan.CredentialsRefPresent,
		Artifacts:             append([]SnowflakeLoadArtifact(nil), plan.Artifacts...),
		Warnings:              append([]string(nil), plan.Warnings...),
	}
	artifactByObject := map[string]SnowflakeLoadArtifact{}
	for _, artifact := range plan.Artifacts {
		artifactByObject[artifact.Object] = artifact
	}
	for _, table := range plan.Tables {
		artifact := artifactByObject[table.Object]
		job.Tables = append(job.Tables, SnowflakeProviderJobTable{
			Object:                   table.Object,
			Table:                    table.Table,
			ArtifactURI:              table.ArtifactURI,
			ArtifactObjectKey:        artifact.ObjectKey,
			Rows:                     table.Rows,
			DestinationSchemaVersion: table.DestinationSchemaVersion,
			CreateTableSQL:           table.CreateTableSQL,
			ValidateTableSQL:         table.ValidateTableSQL,
			CopySQL:                  table.CopySQL,
			QuerySQL:                 table.QuerySQL,
			Executable:               table.Executable,
		})
	}
	job.Statements = snowflakeProviderJobStatements(job.Tables, requestKind)
	return job
}

func snowflakeProviderJobStatements(tables []SnowflakeProviderJobTable, requestKind string) []SnowflakeProviderJobStatement {
	out := []SnowflakeProviderJobStatement{}
	appendStatement := func(table SnowflakeProviderJobTable, phase, sql string) {
		sql = strings.TrimSpace(sql)
		if sql == "" {
			return
		}
		out = append(out, SnowflakeProviderJobStatement{
			Order:      len(out) + 1,
			Phase:      phase,
			Object:     table.Object,
			Table:      table.Table,
			SQL:        sql,
			Executable: table.Executable,
		})
	}
	switch requestKind {
	case "export_copy":
		for _, table := range tables {
			appendStatement(table, "create_table", table.CreateTableSQL)
			appendStatement(table, "validate_table", table.ValidateTableSQL)
			appendStatement(table, "copy_into", table.CopySQL)
		}
	case "import_query":
		for _, table := range tables {
			appendStatement(table, "query", table.QuerySQL)
		}
	default:
		for _, table := range tables {
			appendStatement(table, "statement", firstNonEmpty(table.CopySQL, table.QuerySQL, table.CreateTableSQL, table.ValidateTableSQL))
		}
	}
	return out
}

func executableSnowflakeJobStatements(statements []SnowflakeProviderJobStatement) []SnowflakeProviderJobStatement {
	out := make([]SnowflakeProviderJobStatement, 0, len(statements))
	for _, statement := range statements {
		if statement.Executable && strings.TrimSpace(statement.SQL) != "" {
			out = append(out, statement)
		}
	}
	return out
}

func snowflakeConnectionHealthCheck(ctx context.Context, conn Connection, executor SnowflakeJobExecutor, execute bool) *ProviderHealthCheck {
	job := snowflakeHealthCheckJob(conn)
	out := &ProviderHealthCheck{
		Provider:   ProviderSnowflake,
		State:      "ready",
		LiveState:  job.LiveState,
		Message:    "Snowflake SELECT 1 provider-health check is ready; pass provider_check=true to execute it through the attached executor.",
		Executable: true,
		Statements: append([]SnowflakeProviderJobStatement(nil), job.Statements...),
	}
	if conn.Status != "active" && conn.Status != "error" {
		out.State = "not_active"
		out.Message = "Snowflake SELECT 1 provider-health check is not executable unless the connection is active or in error state."
		out.Executable = false
		markSnowflakeHealthStatementsExecutable(out.Statements, false)
		return out
	}
	if missing := missingRequiredSettings(conn); len(missing) > 0 {
		out.State = "not_ready"
		out.Message = "Snowflake SELECT 1 provider-health check requires complete account, warehouse, database, schema, and credential-reference settings."
		out.Executable = false
		out.MissingRequiredSettings = missing
		markSnowflakeHealthStatementsExecutable(out.Statements, false)
		return out
	}
	if executor == nil {
		out.State = "driver_not_attached"
		out.Message = "Snowflake SELECT 1 provider-health check is planned, but no Snowflake executor is attached."
		out.Executable = false
		markSnowflakeHealthStatementsExecutable(out.Statements, false)
		return out
	}
	if !execute {
		return out
	}
	result, err := executor.ExecuteSnowflakeJob(ctx, SnowflakeJobExecutionRequest{
		Connection: conn,
		Job:        job,
		Statements: executableSnowflakeJobStatements(job.Statements),
	})
	if err != nil {
		out.State = "failed"
		out.Message = "Snowflake SELECT 1 provider-health check failed through the attached executor."
		out.Error = truncateWarehouseCleanupString(err.Error(), 500)
		return out
	}
	out.State = strings.TrimSpace(result.ExecutionState)
	if out.State == "" {
		out.State = "checked"
	}
	out.LiveState = strings.TrimSpace(result.LiveState)
	if out.LiveState == "" {
		out.LiveState = job.LiveState
	}
	out.ExecutionMode = strings.TrimSpace(result.ExecutionMode)
	if out.ExecutionMode == "" {
		out.ExecutionMode = "local_driver"
	}
	out.StatementsExecuted = result.StatementsExecuted
	if len(result.Warnings) > 0 {
		out.Warnings = append([]string(nil), result.Warnings...)
	}
	out.Message = "Snowflake SELECT 1 provider-health check executed through the attached executor."
	return out
}

func snowflakeHealthCheckJob(conn Connection) SnowflakeProviderJob {
	statement := SnowflakeProviderJobStatement{
		Order:      1,
		Phase:      "health_check",
		SQL:        "SELECT 1",
		Executable: true,
	}
	return SnowflakeProviderJob{
		Driver:                "snowflake_sql_query",
		RequestKind:           "health_check",
		LiveState:             "not_executed",
		ExecutionState:        "health_check_ready",
		Account:               configString(conn.Config, "account"),
		Warehouse:             configString(conn.Config, "warehouse"),
		Database:              configString(conn.Config, "database"),
		Schema:                configString(conn.Config, "schema"),
		Role:                  configString(conn.Config, "role"),
		TargetURI:             providerTargetURI(conn),
		CredentialsRefPresent: firstNonEmpty(conn.CredentialsRef, configString(conn.Config, "credentials_ref"), configString(conn.Config, "credential_ref")) != "",
		Statements:            []SnowflakeProviderJobStatement{statement},
	}
}

func markSnowflakeHealthStatementsExecutable(statements []SnowflakeProviderJobStatement, executable bool) {
	for i := range statements {
		statements[i].Executable = executable
	}
}

func executeSnowflakeProviderJob(ctx context.Context, storage Storage, executor SnowflakeJobExecutor, tenantID string, conn Connection, job *SnowflakeProviderJob) (map[string]any, error) {
	if executor == nil || job == nil {
		return nil, nil
	}
	metrics := map[string]any{
		"snowflake_provider_execution_live_state": job.LiveState,
	}
	var tables []SnowflakeProviderJobTable
	var artifacts []SnowflakeVerifiedArtifact
	switch job.RequestKind {
	case "export_copy":
		if job.ExecutionState != "load_plan_ready" {
			metrics["snowflake_provider_execution_state"] = "not_ready"
			metrics["snowflake_provider_execution_reason"] = job.ExecutionState
			return metrics, nil
		}
		if storage == nil {
			metrics["snowflake_provider_execution_state"] = "not_ready"
			metrics["snowflake_provider_execution_reason"] = "storage_not_configured"
			return metrics, nil
		}
		tables = executableSnowflakeCopyJobTables(job.Tables)
		if len(tables) == 0 {
			metrics["snowflake_provider_execution_state"] = "not_ready"
			metrics["snowflake_provider_execution_reason"] = "no_executable_tables"
			return metrics, nil
		}
		for _, table := range tables {
			if strings.TrimSpace(table.ArtifactURI) == "" {
				metrics["snowflake_provider_execution_state"] = "not_ready"
				metrics["snowflake_provider_execution_reason"] = "missing_artifact_uri"
				return metrics, nil
			}
			body, contentType, err := storage.Get(ctx, tenantID, table.ArtifactURI)
			if err != nil {
				return nil, err
			}
			bytesRead, copyErr := io.Copy(io.Discard, body)
			closeErr := body.Close()
			if copyErr != nil {
				return nil, copyErr
			}
			if closeErr != nil {
				return nil, closeErr
			}
			artifacts = append(artifacts, SnowflakeVerifiedArtifact{
				Object:      table.Object,
				Rest:        table.ArtifactURI,
				ObjectKey:   table.ArtifactObjectKey,
				ContentType: contentType,
				Bytes:       bytesRead,
				Rows:        table.Rows,
			})
		}
	case "import_query":
		if job.ExecutionState != "import_plan_ready" {
			metrics["snowflake_provider_execution_state"] = "not_ready"
			metrics["snowflake_provider_execution_reason"] = job.ExecutionState
			return metrics, nil
		}
		tables = executableSnowflakeQueryJobTables(job.Tables)
		if len(tables) == 0 {
			metrics["snowflake_provider_execution_state"] = "not_ready"
			metrics["snowflake_provider_execution_reason"] = "no_executable_tables"
			return metrics, nil
		}
	default:
		metrics["snowflake_provider_execution_state"] = "skipped"
		metrics["snowflake_provider_execution_reason"] = "unsupported_request_kind"
		return metrics, nil
	}
	result, err := executor.ExecuteSnowflakeJob(ctx, SnowflakeJobExecutionRequest{
		Connection: conn,
		Job:        *job,
		Tables:     tables,
		Statements: executableSnowflakeJobStatements(job.Statements),
		Artifacts:  artifacts,
	})
	if err != nil {
		return nil, err
	}
	state := strings.TrimSpace(result.ExecutionState)
	if state == "" {
		state = "local_executed"
	}
	mode := strings.TrimSpace(result.ExecutionMode)
	if mode == "" {
		mode = "local_driver"
	}
	liveState := strings.TrimSpace(result.LiveState)
	if liveState == "" {
		liveState = job.LiveState
	}
	if liveState == "" {
		liveState = "not_executed"
	}
	metrics["snowflake_provider_job_state"] = liveState
	metrics["snowflake_provider_execution_live_state"] = liveState
	metrics["snowflake_provider_execution_state"] = state
	metrics["snowflake_provider_execution_mode"] = mode
	metrics["snowflake_provider_artifacts_verified"] = len(artifacts)
	metrics["snowflake_provider_tables_loaded"] = result.TablesLoaded
	metrics["snowflake_provider_statements_executed"] = result.StatementsExecuted
	metrics["snowflake_provider_rows_loaded"] = result.RowsLoaded
	if len(result.Warnings) > 0 {
		metrics["snowflake_provider_execution_warnings"] = append([]string(nil), result.Warnings...)
	}
	for key, value := range result.Metrics {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		metricKey := "snowflake_provider_" + key
		if _, exists := metrics[metricKey]; exists {
			metricKey = "snowflake_provider_driver_" + key
		}
		metrics[metricKey] = value
	}
	return metrics, nil
}

func executableSnowflakeCopyJobTables(tables []SnowflakeProviderJobTable) []SnowflakeProviderJobTable {
	out := make([]SnowflakeProviderJobTable, 0, len(tables))
	for _, table := range tables {
		if table.Executable && strings.TrimSpace(table.CopySQL) != "" {
			out = append(out, table)
		}
	}
	return out
}

func executableSnowflakeQueryJobTables(tables []SnowflakeProviderJobTable) []SnowflakeProviderJobTable {
	out := make([]SnowflakeProviderJobTable, 0, len(tables))
	for _, table := range tables {
		if table.Executable && strings.TrimSpace(table.QuerySQL) != "" {
			out = append(out, table)
		}
	}
	return out
}

func snowflakeExportEntries(objects []string, rowsByObject map[string]int64) []snowflakeExportEntry {
	entries := make([]snowflakeExportEntry, 0, len(objects))
	for _, object := range normalizeObjects(objects) {
		entry := snowflakeJSONLEntryForObject(object)
		if entry == "" {
			continue
		}
		entries = append(entries, snowflakeExportEntry{Object: object, Entry: entry, Rows: rowsByObject[object]})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Object < entries[j].Object })
	return entries
}

func snowflakeRowsByObject(metrics map[string]any) map[string]int64 {
	out := map[string]int64{}
	switch rows := metrics["rows_by_object"].(type) {
	case map[string]int64:
		for object, count := range rows {
			out[object] = count
		}
	case map[string]int:
		for object, count := range rows {
			out[object] = int64(count)
		}
	case map[string]any:
		for object, count := range rows {
			switch v := count.(type) {
			case int:
				out[object] = int64(v)
			case int64:
				out[object] = v
			case int32:
				out[object] = int64(v)
			case float64:
				out[object] = int64(v)
			case float32:
				out[object] = int64(v)
			}
		}
	}
	return out
}

func snowflakeJSONLEntryForObject(object string) string {
	switch object {
	case "profiles":
		return "profiles.jsonl"
	case "events":
		return "events/subscriber_events.jsonl"
	case "metrics":
		return "metrics/subscriber_event_daily.jsonl"
	case "campaigns":
		return "campaigns.jsonl"
	case "flows":
		return "flows/automations.jsonl"
	case "forms":
		return "forms.jsonl"
	case "catalog":
		return "catalog/products.jsonl"
	case "custom_objects":
		return "custom_objects/records.jsonl"
	case "reviews":
		return "reviews/unavailable.jsonl"
	default:
		return ""
	}
}

func snowflakeExecutableObject(object string) bool {
	return object != "reviews"
}

func storeSnowflakeJSONLArtifacts(ctx context.Context, storage Storage, tenantID, runID string, bundle []byte, entries []snowflakeExportEntry) ([]SnowflakeLoadArtifact, error) {
	if storage == nil || len(entries) == 0 {
		return nil, nil
	}
	zr, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		return nil, err
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	out := make([]SnowflakeLoadArtifact, 0, len(entries))
	for _, entry := range entries {
		f := files[entry.Entry]
		if f == nil {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(rc)
		closeErr := rc.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		rest := path.Join("warehouse", "runs", runID, snowflakeArtifactFileName(entry.Object))
		key, err := storage.Put(ctx, tenantID, rest, "application/x-ndjson", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		out = append(out, SnowflakeLoadArtifact{
			Object:    entry.Object,
			ZipEntry:  entry.Entry,
			Rest:      rest,
			ObjectKey: key,
			Rows:      entry.Rows,
		})
	}
	return out, nil
}

func snowflakeArtifactFileName(object string) string {
	object = strings.ToLower(strings.TrimSpace(object))
	object = strings.ReplaceAll(object, "/", "_")
	object = strings.ReplaceAll(object, ".", "_")
	if object == "" {
		object = "object"
	}
	return object + ".jsonl"
}

func snowflakeObjectTableName(conn Connection, object string) string {
	name := "POSTWAVE_" + strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(object), "-", "_"))
	return snowflakeQualifiedTableName(conn, name)
}

func snowflakeDestinationSchemaVersion(object string) string {
	if len(snowflakeDestinationColumns(object)) == 0 {
		return ""
	}
	return "postwave_warehouse_" + strings.ToLower(strings.TrimSpace(object)) + "_v1"
}

func snowflakeDestinationColumns(object string) []snowflakeColumn {
	switch object {
	case "profiles":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"email", "STRING"},
			{"status", "STRING"},
			{"name", "STRING"},
			{"tags", "VARIANT"},
			{"custom_fields", "VARIANT"},
			{"created_at", "TIMESTAMP_NTZ"},
			{"updated_at", "TIMESTAMP_NTZ"},
		}
	case "events":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"subscriber_email", "STRING"},
			{"event_type", "STRING"},
			{"campaign_id", "STRING"},
			{"link_url", "STRING"},
			{"user_agent", "STRING"},
			{"ip", "STRING"},
			{"at", "TIMESTAMP_NTZ"},
		}
	case "metrics":
		return []snowflakeColumn{
			{"event_type", "STRING"},
			{"day", "DATE"},
			{"count", "NUMBER"},
		}
	case "campaigns":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"name", "STRING"},
			{"subject", "STRING"},
			{"status", "STRING"},
			{"scheduled_at", "TIMESTAMP_NTZ"},
			{"created_at", "TIMESTAMP_NTZ"},
		}
	case "flows":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"name", "STRING"},
			{"status", "STRING"},
			{"created_at", "TIMESTAMP_NTZ"},
		}
	case "forms":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"name", "STRING"},
			{"slug", "STRING"},
			{"status", "STRING"},
			{"opt_in_mode", "STRING"},
			{"structure", "VARIANT"},
			{"settings", "VARIANT"},
			{"created_at", "TIMESTAMP_NTZ"},
			{"updated_at", "TIMESTAMP_NTZ"},
		}
	case "catalog":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"integration_id", "STRING"},
			{"source_id", "STRING"},
			{"title", "STRING"},
			{"url", "STRING"},
			{"image_url", "STRING"},
			{"price_cents", "NUMBER"},
			{"currency", "STRING"},
			{"raw", "VARIANT"},
			{"created_at", "TIMESTAMP_NTZ"},
			{"updated_at", "TIMESTAMP_NTZ"},
		}
	case "custom_objects":
		return []snowflakeColumn{
			{"id", "STRING"},
			{"object_type", "STRING"},
			{"external_id", "STRING"},
			{"properties", "VARIANT"},
			{"created_at", "TIMESTAMP_NTZ"},
			{"updated_at", "TIMESTAMP_NTZ"},
		}
	default:
		return nil
	}
}

func snowflakeCreateTableSQL(table string, columns []snowflakeColumn) string {
	if strings.TrimSpace(table) == "" || len(columns) == 0 {
		return ""
	}
	parts := make([]string, 0, len(columns))
	for _, column := range columns {
		name := snowflakeQuoteIdentifier(column.Name)
		typ := strings.ToUpper(strings.TrimSpace(column.Type))
		if typ == "" {
			typ = "VARIANT"
		}
		parts = append(parts, name+" "+typ)
	}
	return fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (%s)", table, strings.Join(parts, ", "))
}

func snowflakeValidateTableSQL(conn Connection, object string) string {
	tableName := "POSTWAVE_" + strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(object), "-", "_"))
	database := configString(conn.Config, "database")
	schema := configString(conn.Config, "schema")
	if tableName == "" || database == "" || schema == "" {
		return ""
	}
	return fmt.Sprintf("SELECT column_name, data_type FROM %s.INFORMATION_SCHEMA.COLUMNS WHERE table_schema = '%s' AND table_name = '%s' ORDER BY ordinal_position",
		snowflakeQuoteIdentifier(database),
		snowflakeSQLStringLiteral(strings.ToUpper(schema)),
		snowflakeSQLStringLiteral(tableName))
}

func snowflakeQualifiedTableName(conn Connection, table string) string {
	parts := strings.Split(strings.TrimSpace(table), ".")
	if len(parts) == 1 {
		parts = []string{configString(conn.Config, "database"), configString(conn.Config, "schema"), parts[0]}
	} else if len(parts) == 2 {
		parts = []string{configString(conn.Config, "database"), parts[0], parts[1]}
	}
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			quoted = append(quoted, snowflakeQuoteIdentifier(part))
		}
	}
	return strings.Join(quoted, ".")
}

func snowflakeCopySQL(table, stageReference, artifactRest string) string {
	return fmt.Sprintf("COPY INTO %s FROM @%s/%s FILE_FORMAT = (TYPE = JSON STRIP_OUTER_ARRAY = FALSE) MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE",
		table,
		stageReference,
		strings.TrimLeft(artifactRest, "/"))
}

func snowflakeQuoteIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if identifierPattern.MatchString(value) {
		value = strings.ToUpper(value)
	}
	value = strings.ReplaceAll(value, `"`, `""`)
	return `"` + value + `"`
}

func snowflakeSQLStringLiteral(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), `'`, `''`)
}
