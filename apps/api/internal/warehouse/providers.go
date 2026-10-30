package warehouse

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var (
	s3BucketPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	awsRegionPattern    = regexp.MustCompile(`^[a-z]{2}-[a-z]+-\d$|^us-gov-[a-z]+-\d$|^cn-[a-z]+-\d$`)
	r2AccountIDPattern  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	identifierPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$]{0,254}$`)
	snowflakeAcctRegexp = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)
)

const (
	ProviderS3              = "s3"
	ProviderR2              = "r2"
	ProviderBigQuery        = "bigquery"
	ProviderSnowflake       = "snowflake"
	ProviderRedshift        = "redshift"
	ProviderDatabricks      = "databricks"
	ProviderPostgres        = "postgres"
	ProviderAzureBlob       = "azure_blob"
	ProviderStreamingExport = "streaming_export"
)

type ProviderField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Required bool   `json:"required,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
	Help     string `json:"help,omitempty"`
}

type ProviderSpec struct {
	Provider         string          `json:"provider"`
	Name             string          `json:"name"`
	AuthMode         string          `json:"auth_mode"`
	Managed          bool            `json:"managed"`
	RuntimeStatus    string          `json:"runtime_status"`
	Capabilities     []string        `json:"capabilities"`
	RequiredSettings []ProviderField `json:"required_settings"`
	OptionalSettings []ProviderField `json:"optional_settings,omitempty"`
	SyncObjects      []string        `json:"sync_objects"`
	DocsURL          string          `json:"docs_url"`
}

var warehouseProviderSpecs = []ProviderSpec{
	{
		Provider:      ProviderS3,
		Name:          "Amazon S3",
		AuthMode:      "aws_iam_ref",
		Managed:       true,
		RuntimeStatus: "delegated",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "bucket", Label: "Bucket", Required: true, Help: "S3 bucket metadata for the tenant bucket driver; current runs use the configured Moosewave storage adapter"},
			{Key: "region", Label: "Region", Required: true, Help: "AWS region metadata for the tenant bucket driver"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing AWS IAM credentials or role-assumption material"},
		},
		OptionalSettings: []ProviderField{
			{Key: "prefix", Label: "Export prefix", Help: "Optional export prefix metadata"},
			{Key: "import_prefix", Label: "Import prefix", Help: "Optional JSONL polling prefix under Moosewave storage"},
			{Key: "import_limit", Label: "Import object limit", Help: "Maximum JSONL objects to poll per import run"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "forms", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/s3",
	},
	{
		Provider:      ProviderR2,
		Name:          "Cloudflare R2",
		AuthMode:      "r2_s3_access_key_ref",
		Managed:       true,
		RuntimeStatus: "delegated",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "bucket", Label: "Bucket", Required: true, Help: "R2 bucket metadata for the tenant bucket driver; current runs use the configured Moosewave storage adapter"},
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Cloudflare account ID metadata for future S3-compatible endpoint routing"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing R2 S3-compatible access credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "prefix", Label: "Export prefix", Help: "Optional export object prefix"},
			{Key: "import_prefix", Label: "Import prefix", Help: "Optional import JSONL polling prefix"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "forms", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/r2",
	},
	{
		Provider:      ProviderBigQuery,
		Name:          "Google BigQuery",
		AuthMode:      "service_account_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "project_id", Label: "Project ID", Required: true, Help: "Google Cloud project ID"},
			{Key: "dataset", Label: "Dataset", Required: true, Help: "Target BigQuery dataset for Moosewave tables"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing service account credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "location", Label: "Location", Help: "Dataset location, such as US or EU"},
			{Key: "table_prefix", Label: "Table prefix", Help: "Optional table prefix for exported objects"},
			{Key: "import_table", Label: "Import table", Help: "Optional table or view used for import polling"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/bigquery",
	},
	{
		Provider:      ProviderSnowflake,
		Name:          "Snowflake",
		AuthMode:      "snowflake_auth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "account", Label: "Account", Required: true, Help: "Snowflake account locator or organization-account name"},
			{Key: "warehouse", Label: "Warehouse", Required: true, Help: "Snowflake compute warehouse"},
			{Key: "database", Label: "Database", Required: true, Help: "Target database"},
			{Key: "schema", Label: "Schema", Required: true, Help: "Target schema"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Snowflake key-pair, OAuth, PAT, or workload-identity credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "role", Label: "Role", Help: "Optional Snowflake role"},
			{Key: "stage", Label: "Stage", Help: "Optional named stage used for export handoff"},
			{Key: "import_table", Label: "Import table", Help: "Optional table or view used for import polling"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/snowflake",
	},
	{
		Provider:      ProviderRedshift,
		Name:          "Amazon Redshift",
		AuthMode:      "aws_iam_or_secret_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "cluster_or_workgroup", Label: "Cluster or workgroup", Required: true, Help: "Redshift cluster identifier or Serverless workgroup"},
			{Key: "database", Label: "Database", Required: true, Help: "Target database"},
			{Key: "schema", Label: "Schema", Required: true, Help: "Target schema"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing IAM, Secrets Manager, or temporary credential configuration"},
		},
		OptionalSettings: []ProviderField{
			{Key: "region", Label: "Region", Help: "AWS region"},
			{Key: "iam_role_ref", Label: "IAM role reference", Help: "Vault/reference name for COPY/UNLOAD role configuration"},
			{Key: "import_table", Label: "Import table", Help: "Optional table or view used for import polling"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/redshift",
	},
	{
		Provider:      ProviderPostgres,
		Name:          "Postgres",
		AuthMode:      "postgres_credential_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "host", Label: "Host", Required: true, Help: "Postgres host or private connectivity endpoint"},
			{Key: "database", Label: "Database", Required: true, Help: "Target database"},
			{Key: "schema", Label: "Schema", Required: true, Help: "Target schema"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Postgres password, certificate, or managed identity credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "port", Label: "Port", Help: "Optional port, defaults to 5432"},
			{Key: "sslmode", Label: "SSL mode", Help: "Optional SSL mode, defaults to require"},
			{Key: "import_table", Label: "Import table", Help: "Optional table or view used for import polling"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/postgres",
	},
	{
		Provider:      ProviderDatabricks,
		Name:          "Databricks",
		AuthMode:      "personal_access_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "workspace_url", Label: "Workspace URL", Required: true, Help: "Databricks workspace URL, for example https://adb-123.azuredatabricks.net"},
			{Key: "warehouse_id", Label: "SQL warehouse ID", Required: true, Help: "Databricks SQL warehouse ID used by Statement Execution"},
			{Key: "catalog", Label: "Catalog", Required: true, Help: "Unity Catalog catalog for Moosewave tables"},
			{Key: "schema", Label: "Schema", Required: true, Help: "Target schema for Moosewave tables"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Databricks PAT or OAuth credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "http_path", Label: "SQL warehouse HTTP path", Help: "Optional HTTP path for JDBC/ODBC-style worker routing"},
			{Key: "table_prefix", Label: "Table prefix", Help: "Optional table prefix for exported objects"},
			{Key: "import_table", Label: "Import table", Help: "Optional table or view used for reverse ETL import polling"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/databricks",
	},
	{
		Provider:      ProviderAzureBlob,
		Name:          "Azure Blob Storage",
		AuthMode:      "azure_storage_credential_ref",
		Managed:       false,
		RuntimeStatus: "planned",
		Capabilities:  []string{"warehouse_export", "warehouse_import", "profiles", "events"},
		RequiredSettings: []ProviderField{
			{Key: "account_url", Label: "Account URL", Required: true, Help: "Azure Storage account endpoint"},
			{Key: "container", Label: "Container", Required: true, Help: "Blob container used for exports and import polling"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing SAS, service principal, or storage credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "prefix", Label: "Export prefix", Help: "Optional export blob prefix"},
			{Key: "import_prefix", Label: "Import prefix", Help: "Optional import polling prefix"},
			{Key: "tenant_id", Label: "Azure tenant ID", Help: "Optional tenant ID for service-principal based credentials"},
		},
		SyncObjects: []string{"profiles", "events", "metrics", "campaigns", "forms", "catalog", "custom_objects"},
		DocsURL:     "/docs/integrations/azure-blob",
	},
	{
		Provider:      ProviderStreamingExport,
		Name:          "Streaming Export",
		AuthMode:      "workspace_storage",
		Managed:       true,
		RuntimeStatus: "available",
		Capabilities:  []string{"warehouse_export", "events", "profiles"},
		OptionalSettings: []ProviderField{
			{Key: "format", Label: "Format", Help: "parquet or avro; defaults to parquet"},
			{Key: "compression", Label: "Compression", Help: "none, snappy, gzip, or zstd; defaults to snappy"},
			{Key: "batch_size", Label: "Batch size", Help: "Rows per hourly shipment, from 100 to 1000000"},
			{Key: "prefix", Label: "Prefix", Help: "Optional export object prefix"},
			{Key: "field_filters", Label: "Event type filters", Help: "Optional event_type allowlist for streamed subscriber events"},
		},
		SyncObjects: []string{"events", "profiles"},
		DocsURL:     "/docs/integrations/streaming-export",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := withRequiredProviderLists(append([]ProviderSpec(nil), warehouseProviderSpecs...))
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func ProviderSpecByKey(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range warehouseProviderSpecs {
		if spec.Provider == key {
			return spec, true
		}
	}
	return ProviderSpec{}, false
}

func allWarehouseProviders() []string {
	return []string{
		ProviderS3,
		ProviderR2,
		ProviderRedshift,
		ProviderDatabricks,
		ProviderBigQuery,
		ProviderAzureBlob,
		ProviderSnowflake,
		ProviderPostgres,
		ProviderStreamingExport,
	}
}

func providerRequiredSettings(provider string) []ProviderField {
	spec, ok := ProviderSpecByKey(provider)
	if !ok {
		return nil
	}
	return spec.RequiredSettings
}

func missingRequiredSettings(conn Connection) []string {
	missing := []string{}
	for _, field := range providerRequiredSettings(conn.Provider) {
		value := ""
		if field.Key == "credentials_ref" {
			value = firstNonEmpty(conn.CredentialsRef, configString(conn.Config, field.Key), configString(conn.Config, "credential_ref"))
		} else {
			value = configString(conn.Config, field.Key)
		}
		if field.Required && strings.TrimSpace(value) == "" {
			missing = append(missing, field.Key)
		}
	}
	return missing
}

func rawCredentialConfigKey(config map[string]any) string {
	return rawCredentialConfigKeyAt("", config)
}

func rawCredentialConfigKeyAt(prefix string, value any) string {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			if isRawCredentialKey(key) {
				return path
			}
			if child := rawCredentialConfigKeyAt(path, nested); child != "" {
				return child
			}
		}
	case []any:
		for i, nested := range typed {
			if child := rawCredentialConfigKeyAt(fmt.Sprintf("%s[%d]", prefix, i), nested); child != "" {
				return child
			}
		}
	}
	return ""
}

func isRawCredentialKey(key string) bool {
	normalized := normalizeConfigKey(key)
	switch normalized {
	case "accesskeyid", "accesstoken", "accountkey", "apikey", "apisecret", "awsaccesskeyid",
		"awssecretaccesskey", "clientsecret", "connectionstring", "password", "pat",
		"personalaccesstoken", "privatekey", "privatekeyjson", "refreshtoken", "sastoken",
		"secret", "secretaccesskey", "serviceaccountjson", "sharedkey", "storageaccountkey",
		"token":
		return true
	default:
		return false
	}
}

func normalizeConfigKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	var b strings.Builder
	for _, r := range key {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func looksLikeRawCredentialRef(value string) bool {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	if trimmed == "" {
		return false
	}
	if strings.ContainsAny(trimmed, " \t\r\n") {
		return true
	}
	for _, prefix := range []string{
		"bearer ",
		"basic ",
		"aws_access_key_id=",
		"aws_secret_access_key=",
		"sk_live_",
		"sk_test_",
		"rk_live_",
		"pk_live_",
		"shpat_",
		"xoxb-",
		"xoxp-",
		"ya29.",
		"ghp_",
		"gho_",
		"github_pat_",
		"glpat-",
		"pat-",
		"eyj",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if strings.Count(trimmed, ".") >= 2 && strings.HasPrefix(trimmed, "eyJ") {
		return true
	}
	if len(trimmed) >= 80 && !strings.Contains(trimmed, "://") && !strings.Contains(trimmed, ":") {
		return true
	}
	return false
}

func disallowedEndpointOverrideKey(conn Connection) string {
	if !allowed(conn.Provider, []string{ProviderS3, ProviderR2}) {
		return ""
	}
	for _, key := range []string{"endpoint_url", "endpoint", "base_url", "api_base", "s3_endpoint", "s3_endpoint_url"} {
		if configString(conn.Config, key) != "" {
			return key
		}
	}
	return ""
}

func providerAddressConfigError(conn Connection) string {
	switch conn.Provider {
	case ProviderS3:
		if bucket := configString(conn.Config, "bucket"); bucket != "" && !validS3BucketName(bucket) {
			return "bucket must be a valid S3 bucket name"
		}
		if region := configString(conn.Config, "region"); region != "" && !awsRegionPattern.MatchString(region) {
			return "region must be an AWS region code"
		}
	case ProviderR2:
		if bucket := configString(conn.Config, "bucket"); bucket != "" && !validS3BucketName(bucket) {
			return "bucket must be a valid R2 bucket name"
		}
		if accountID := strings.ToLower(configString(conn.Config, "account_id")); accountID != "" && !r2AccountIDPattern.MatchString(accountID) {
			return "account_id must be a 32-character Cloudflare account ID"
		}
	case ProviderBigQuery:
		if dataset := configString(conn.Config, "dataset"); dataset != "" && !identifierPattern.MatchString(dataset) {
			return "dataset must be a BigQuery dataset identifier"
		}
		if location := configString(conn.Config, "location"); location != "" && strings.ContainsAny(location, " /\\") {
			return "location must be a BigQuery location code"
		}
	case ProviderSnowflake:
		if account := configString(conn.Config, "account"); account != "" && !snowflakeAcctRegexp.MatchString(account) {
			return "account must be a Snowflake account identifier"
		}
		for _, key := range []string{"database", "schema", "warehouse", "role"} {
			if value := configString(conn.Config, key); value != "" && !identifierPattern.MatchString(value) {
				return key + " must be a SQL identifier"
			}
		}
		if stage := configString(conn.Config, "stage"); stage != "" && !validSQLIdentifierPath(stage, 3) {
			return "stage must be a Snowflake stage identifier"
		}
		if table := configString(conn.Config, "import_table"); table != "" && !validSQLIdentifierPath(table, 3) {
			return "import_table must be a Snowflake table or view identifier"
		}
	case ProviderRedshift:
		if region := configString(conn.Config, "region"); region != "" && !awsRegionPattern.MatchString(region) {
			return "region must be an AWS region code"
		}
		for _, key := range []string{"database", "schema"} {
			if value := configString(conn.Config, key); value != "" && !identifierPattern.MatchString(value) {
				return key + " must be a SQL identifier"
			}
		}
	case ProviderPostgres:
		if host := configString(conn.Config, "host"); host != "" && isLocalOrPrivateHost(strings.ToLower(host)) {
			return "host must not target localhost, private, link-local, or unspecified hosts"
		}
		if port := configString(conn.Config, "port"); port != "" && !validTCPPort(port) {
			return "port must be a TCP port between 1 and 65535"
		}
		if sslmode := configString(conn.Config, "sslmode"); sslmode != "" && !allowed(sslmode, []string{"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}) {
			return "sslmode must be a supported Postgres sslmode"
		}
		for _, key := range []string{"database", "schema"} {
			if value := configString(conn.Config, key); value != "" && !identifierPattern.MatchString(value) {
				return key + " must be a SQL identifier"
			}
		}
	case ProviderDatabricks:
		if raw := configString(conn.Config, "workspace_url"); raw != "" {
			if err := validateExternalHTTPSURL(raw, "workspace_url"); err != "" {
				return err
			}
		}
		for _, key := range []string{"warehouse_id", "catalog", "schema"} {
			if value := configString(conn.Config, key); value != "" && strings.ContainsAny(value, " \t\r\n") {
				return key + " must not contain whitespace"
			}
		}
	case ProviderAzureBlob:
		if raw := configString(conn.Config, "account_url"); raw != "" {
			if err := validateExternalHTTPSURL(raw, "account_url"); err != "" {
				return err
			}
		}
		if container := configString(conn.Config, "container"); container != "" && !validAzureContainerName(container) {
			return "container must be a valid Azure Blob container name"
		}
	}
	return ""
}

func validS3BucketName(bucket string) bool {
	bucket = strings.TrimSpace(bucket)
	if !s3BucketPattern.MatchString(bucket) {
		return false
	}
	return !strings.Contains(bucket, "..") &&
		!strings.Contains(bucket, ".-") &&
		!strings.Contains(bucket, "-.") &&
		net.ParseIP(bucket) == nil
}

func validAzureContainerName(container string) bool {
	if len(container) < 3 || len(container) > 63 {
		return false
	}
	if container[0] == '-' || container[len(container)-1] == '-' || strings.Contains(container, "--") {
		return false
	}
	for _, r := range container {
		if !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && r != '-' {
			return false
		}
	}
	return true
}

func validTCPPort(port string) bool {
	if port == "" || len(port) > 5 {
		return false
	}
	n := 0
	for _, r := range port {
		if r < '0' || r > '9' {
			return false
		}
		n = n*10 + int(r-'0')
	}
	return n >= 1 && n <= 65535
}

func validSQLIdentifierPath(value string, maxParts int) bool {
	value = strings.TrimSpace(value)
	if value == "" || maxParts <= 0 || strings.ContainsAny(value, " \t\r\n/\\;") {
		return false
	}
	parts := strings.Split(value, ".")
	if len(parts) > maxParts {
		return false
	}
	for _, part := range parts {
		if !identifierPattern.MatchString(part) {
			return false
		}
	}
	return true
}

func validateExternalHTTPSURL(raw, field string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return field + " must be an https URL"
	}
	if parsed.User != nil {
		return field + " must not embed credentials"
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if isLocalOrPrivateHost(host) {
		return field + " must not target localhost, private, link-local, or unspecified hosts"
	}
	return ""
}

func isLocalOrPrivateHost(host string) bool {
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func objectStorageProvider(provider string) bool {
	return allowed(provider, []string{ProviderS3, ProviderR2})
}

func managedSQLWarehouseProvider(provider string) bool {
	return allowed(provider, []string{ProviderBigQuery, ProviderSnowflake, ProviderRedshift, ProviderDatabricks, ProviderPostgres})
}

func providerTargetURI(conn Connection) string {
	switch conn.Provider {
	case ProviderBigQuery:
		project := configString(conn.Config, "project_id")
		dataset := configString(conn.Config, "dataset")
		prefix := configString(conn.Config, "table_prefix")
		if prefix == "" {
			prefix = "postwave"
		}
		return fmt.Sprintf("bigquery://%s/%s/%s_*", project, dataset, prefix)
	case ProviderSnowflake:
		account := configString(conn.Config, "account")
		database := configString(conn.Config, "database")
		schema := configString(conn.Config, "schema")
		q := url.Values{}
		for _, key := range []string{"warehouse", "role", "stage", "import_table"} {
			if value := configString(conn.Config, key); value != "" {
				q.Set(key, value)
			}
		}
		target := fmt.Sprintf("snowflake://%s/%s/%s", account, database, schema)
		if encoded := q.Encode(); encoded != "" {
			target += "?" + encoded
		}
		return target
	case ProviderRedshift:
		cluster := configString(conn.Config, "cluster_or_workgroup")
		database := configString(conn.Config, "database")
		schema := configString(conn.Config, "schema")
		return fmt.Sprintf("redshift://%s/%s/%s", cluster, database, schema)
	case ProviderDatabricks:
		workspace := strings.TrimPrefix(strings.TrimPrefix(configString(conn.Config, "workspace_url"), "https://"), "http://")
		catalog := configString(conn.Config, "catalog")
		schema := configString(conn.Config, "schema")
		return fmt.Sprintf("databricks://%s/%s/%s", workspace, catalog, schema)
	case ProviderPostgres:
		host := configString(conn.Config, "host")
		database := configString(conn.Config, "database")
		schema := configString(conn.Config, "schema")
		return fmt.Sprintf("postgres://%s/%s/%s", host, database, schema)
	default:
		return conn.Provider + "://warehouse"
	}
}

func configString(config map[string]any, key string) string {
	if config == nil {
		return ""
	}
	raw, ok := config[key]
	if !ok {
		return ""
	}
	switch value := raw.(type) {
	case string:
		return strings.TrimSpace(value)
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// withRequiredProviderLists gives every spec the lists the provider contract
// requires as arrays (WarehouseNativeProvider: capabilities, required_settings,
// sync_objects). A provider with nothing required (streaming_export) declares
// no RequiredSettings, and a nil slice marshals to JSON null, which the
// dashboard rejected as "Warehouse capabilities could not be verified".
func withRequiredProviderLists(specs []ProviderSpec) []ProviderSpec {
	for i := range specs {
		if specs[i].Capabilities == nil {
			specs[i].Capabilities = []string{}
		}
		if specs[i].RequiredSettings == nil {
			specs[i].RequiredSettings = []ProviderField{}
		}
		if specs[i].SyncObjects == nil {
			specs[i].SyncObjects = []string{}
		}
	}
	return specs
}
