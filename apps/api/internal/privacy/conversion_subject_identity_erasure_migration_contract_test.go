// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConversionSubjectIdentityErasureMigrationContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"2029_conversion_subject_identity_erasure.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2029: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"migration-execution: phased",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_subject_identity_erasure_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS conversion_attribution_touches_subject_erasure_idx",
		"conversion_subject_identity_erasure_receipts",
		"identity_subject_erased",
		"identity_value = 'subject:cryptoshredded'",
		"postwave_conversion_identity_eraser",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION NOBYPASSRLS",
		"FORCE ROW LEVEL SECURITY",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog, public, pg_temp",
		"pg_advisory_xact_lock",
		"hashtextextended(p_tenant_id::text, 2029)",
		"GRANT UPDATE (id) ON public.subscribers",
		"GRANT SELECT (tenant_id, key_id, digest, subscriber_id)",
		"ON public.conversion_email_hmac_bindings",
		"subscriber_email = NULL",
		"email_sha256 = NULL",
		"email_hmac_sha256 = NULL",
		"email_hmac_key_id = NULL",
		"click_id = NULL",
		"external_id = NULL",
		"DELETE FROM public.conversion_click_identities",
		"conversion_subject_identity_erasure_receipt_immutable",
		"REVOKE ALL ON public.conversion_subject_identity_erasure_receipts",
		"GRANT SELECT ON public.conversion_subject_identity_erasure_receipts TO postwave_app",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("migration 2029 omits %q", required)
		}
	}
	if strings.Count(source, "BEGIN;") != 1 || strings.Count(source, "COMMIT;") != 1 {
		t.Fatalf("migration 2029 must have one atomic catalog/data phase: BEGIN=%d COMMIT=%d",
			strings.Count(source, "BEGIN;"), strings.Count(source, "COMMIT;"))
	}
	begin := strings.Index(source, "BEGIN;")
	for _, indexName := range []string{
		"conversions_subject_identity_erasure_idx",
		"conversion_attribution_touches_subject_erasure_idx",
	} {
		if at := strings.Index(source, "CREATE INDEX CONCURRENTLY IF NOT EXISTS "+indexName); at < 0 || at > begin {
			t.Errorf("concurrent index %s is not outside the transaction", indexName)
		}
	}

	receiptStart := strings.Index(source,
		"CREATE TABLE public.conversion_subject_identity_erasure_receipts")
	if receiptStart < 0 {
		t.Fatal("cannot isolate conversion subject erasure receipt DDL")
	}
	receiptEnd := strings.Index(source[receiptStart:], "\n);")
	if receiptEnd < 0 {
		t.Fatal("cannot find end of conversion subject erasure receipt DDL")
	}
	receiptDDL := source[receiptStart : receiptStart+receiptEnd]
	for _, forbidden := range []string{
		"subject_email", "subscriber_id", "email_hmac", "email_sha256",
		"identity_value", "click_id", "external_id", "secret",
	} {
		if strings.Contains(receiptDDL, forbidden) {
			t.Errorf("content-free receipt persists %q:\n%s", forbidden, receiptDDL)
		}
	}
	for _, forbidden := range []string{
		"GRANT INSERT ON public.conversion_subject_identity_erasure_receipts TO postwave_app",
		"GRANT UPDATE ON public.conversion_subject_identity_erasure_receipts TO postwave_app",
		"GRANT DELETE ON public.conversion_subject_identity_erasure_receipts TO postwave_app",
		"DELETE FROM public.conversions",
		"DELETE FROM public.conversion_attribution_touches",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("migration 2029 contains unsafe contract %q", forbidden)
		}
	}
}

func TestConversionSubjectIdentityErasureLifecycleFenceMigrationContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"2032_conversion_subject_erasure_key_lifecycle_fence.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2032: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"migration-execution: transactional",
		"RENAME TO conversion_subject_identity_privacy_erase_unfenced_2029",
		"SECURITY INVOKER",
		"FROM PUBLIC, postwave_public, postwave_app",
		"CREATE FUNCTION public.conversion_subject_identity_privacy_erase(",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog, public, pg_temp",
		"pg_advisory_xact_lock(",
		"hashtextextended(p_tenant_id::text, 2029)",
		"pg_advisory_xact_lock_shared(",
		"hashtextextended(p_tenant_id::text, 2017)",
		"conversion_subject_identity_privacy_erase_unfenced_2029(",
		"OWNER TO postwave_conversion_identity_eraser",
		"GRANT EXECUTE ON FUNCTION public.conversion_subject_identity_privacy_erase(",
		"conversion subject erasure lock order is unsafe",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("migration 2032 omits %q", required)
		}
	}
	if strings.Count(source, "BEGIN;") != 1 || strings.Count(source, "COMMIT;") != 1 {
		t.Fatalf("migration 2032 must be atomic: BEGIN=%d COMMIT=%d",
			strings.Count(source, "BEGIN;"), strings.Count(source, "COMMIT;"))
	}

	wrapperAt := strings.Index(source,
		"CREATE FUNCTION public.conversion_subject_identity_privacy_erase(")
	if wrapperAt < 0 {
		t.Fatal("migration 2032 canonical wrapper is missing")
	}
	wrapper := source[wrapperAt:]
	tenantCheckAt := strings.Index(wrapper, "conversion subject erasure tenant scope mismatch")
	erasureFenceAt := strings.Index(wrapper, "hashtextextended(p_tenant_id::text, 2029)")
	lifecycleFenceAt := strings.Index(wrapper, "hashtextextended(p_tenant_id::text, 2017)")
	implementationAt := strings.Index(wrapper,
		"conversion_subject_identity_privacy_erase_unfenced_2029(")
	if tenantCheckAt < 0 || erasureFenceAt <= tenantCheckAt ||
		lifecycleFenceAt <= erasureFenceAt || implementationAt <= lifecycleFenceAt {
		t.Fatalf("migration 2032 lock order is unsafe: tenant=%d erasure=%d lifecycle=%d implementation=%d",
			tenantCheckAt, erasureFenceAt, lifecycleFenceAt, implementationAt)
	}
	for _, forbidden := range []string{
		"GRANT EXECUTE ON FUNCTION public.conversion_subject_identity_privacy_erase_unfenced_2029",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("migration 2032 contains unsafe contract %q", forbidden)
		}
	}
}

func TestConversionSubjectIdentityErasureApplicationCutoverContract(t *testing.T) {
	erasureRaw, err := os.ReadFile("erasure.go")
	if err != nil {
		t.Fatalf("read erasure application path: %v", err)
	}
	erasureSource := string(erasureRaw)
	if !strings.Contains(erasureSource, "erasureHistoryCoverageComplete = false") {
		t.Fatal("wider privacy inventory gate was opened by the F03-only erasure fix")
	}
	fenceAt := strings.Index(erasureSource, "pg_advisory_xact_lock(")
	capabilityAt := strings.Index(erasureSource, "conversion_subject_identity_privacy_erase(")
	profileAt := strings.Index(erasureSource, "UPDATE subscribers AS subscriber")
	if fenceAt < 0 || capabilityAt <= fenceAt || profileAt <= capabilityAt {
		t.Fatalf("erasure cutover order is unsafe: fence=%d capability=%d profile=%d",
			fenceAt, capabilityAt, profileAt)
	}

	ingestRaw, err := os.ReadFile(filepath.Join("..", "conversions", "signed_ingest.go"))
	if err != nil {
		t.Fatalf("read signed conversion ingest: %v", err)
	}
	ingestSource := string(ingestRaw)
	txAt := strings.Index(ingestSource, "tx, err := db.WithTenant")
	subjectFenceAt := strings.Index(ingestSource, "hashtextextended($1, 2029)")
	keyLockAt := strings.Index(ingestSource, "SELECT true\n  FROM conversion_ingest_secrets")
	lifecycleFenceAt := strings.Index(ingestSource, "hashtextextended($1, 2017)")
	claimAt := strings.Index(ingestSource, "INSERT INTO conversion_ingest_idempotency")
	if txAt < 0 || subjectFenceAt <= txAt || keyLockAt <= subjectFenceAt ||
		lifecycleFenceAt <= keyLockAt || claimAt <= lifecycleFenceAt {
		t.Fatalf("signed ingest cutover order is unsafe: tx=%d subject=%d key_row=%d lifecycle=%d claim=%d",
			txAt, subjectFenceAt, keyLockAt, lifecycleFenceAt, claimAt)
	}
	keyBoundary := ingestSource[keyLockAt:lifecycleFenceAt]
	for _, required := range []string{
		"conversion_ingest_secrets",
		"tenant_id = $1::uuid AND key_id = $2 AND revoked_at IS NULL",
		"FOR SHARE",
		"errors.Is(err, pgx.ErrNoRows)",
		"return nil, ErrUnsignedRequest",
	} {
		if !strings.Contains(keyBoundary, required) {
			t.Errorf("signed ingest live-key cutover omits %q", required)
		}
	}
}
