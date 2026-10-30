// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSignedIngestHardeningMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1951_conversion_signed_ingest_hardening.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversion_ingest_secrets_live_key_id_uniq",
		"migration-execution: phased",
		"CREATE TRIGGER conversion_ingest_secrets_live_key_guard",
		"pg_advisory_xact_lock(",
		"DROP POLICY IF EXISTS conversion_ingest_secrets_resolver_select",
		"CREATE ROLE postwave_conversion_secret_resolver",
		"NOREPLICATION NOBYPASSRLS",
		"GRANT SELECT (\n    tenant_id, key_id, secret, secret_envelope, revoked_at, legacy_v1_until",
		"CREATE POLICY conversion_ingest_secrets_fixed_resolver_select",
		"CREATE FUNCTION public.resolve_conversion_ingest_secret(",
		"SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp",
		"OWNER TO postwave_conversion_secret_resolver",
		"REVOKE CREATE ON SCHEMA public",
		"FROM PUBLIC, postwave_public",
		"GRANT EXECUTE ON FUNCTION public.resolve_conversion_ingest_secret(text)\n    TO postwave_app",
		"ADD COLUMN IF NOT EXISTS legacy_v1_until timestamptz",
		"SET DEFAULT '-infinity'::timestamptz",
		"ALTER COLUMN legacy_v1_until SET NOT NULL",
		"interval '30 days'",
		"FORCE ROW LEVEL SECURITY",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("hardening migration missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"USING (current_setting('app.conversion_signature_resolver'",
		"NOREPLICATION BYPASSRLS;",
		"GRANT SELECT ON public.conversion_ingest_secrets TO postwave_conversion_secret_resolver",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("hardening migration contains unsafe fragment %q", forbidden)
		}
	}
}

func TestSignedIngestTenantHMACIdentityMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/2010_conversion_tenant_hmac_identity.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS email_hmac_sha256 text",
		"ADD COLUMN IF NOT EXISTS email_hmac_key_id text",
		"ADD COLUMN IF NOT EXISTS identity_key_id text",
		"identity_kind = 'email_hmac_sha256'",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_email_hmac_identity_idx",
		"DROP INDEX CONCURRENTLY IF EXISTS public.subscribers_email_sha256_idx",
		"Historical unsalted digest only",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("tenant-HMAC migration missing %q", required)
		}
	}
}
