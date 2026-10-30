// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmailHMACProjectionMigrationCarriesDurabilityAndIsolationContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"2017_conversion_email_hmac_projection.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2017: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"conversion_email_hmac_projection_states",
		"conversion_email_hmac_bindings",
		"conversion_email_hmac_projection_tasks",
		"PRIMARY KEY (tenant_id, key_id, digest)",
		"target_revision",
		"lease_token",
		"FOR UPDATE SKIP LOCKED",
		"pg_advisory_xact_lock_shared",
		"churn cannot starve a newly issued key",
		"- (SELECT count(*) FROM full_candidates)",
		"AFTER INSERT OR UPDATE OF revoked_at",
		"AFTER UPDATE OF email ON public.subscribers",
		"AFTER DELETE ON public.subscribers",
		"task->subscriber / subscriber->task deadlock",
		"conversion_email_hmac_bindings_digest_lookup_idx",
		"conversion_email_hmac_projection_subscriber_claim_due_idx",
		"conversion_email_hmac_projection_full_claim_due_idx",
		"conversion_email_hmac_projection_tasks_tenant_key_idx",
		"conversion_ingest_secrets_live_tenant_idx",
		"conversion_attribution_touches_email_hmac_key_idx",
		"conversions_email_hmac_identity_idx",
		"conversion_ingest_secret_require_envelope",
		"BEFORE INSERT OR UPDATE\n    ON public.conversion_ingest_secrets",
		"conversion_ingest_secret_identity_immutable",
		"conversion_ingest_secret_material_immutable",
		"conversion_ingest_secret_revocation_permanent",
		"conversion_ingest_secret_insert_live",
		"secret_kms_key_arn",
		"secret_destroyed_at",
		"revoked:cryptoshredded",
		"email_hmac_cryptoshredded",
		"identity_value = 'revoked:cryptoshredded'",
		"subscriber_id = NULL",
		"is_winner = false",
		"REVOKE UPDATE, DELETE, TRUNCATE ON public.conversion_ingest_secrets FROM postwave_app",
		"GRANT UPDATE (revoked_at) ON public.conversion_ingest_secrets TO postwave_app",
		"conversion_ingest_secrets_live_tenant_limit",
		"conversion_email_hmac_projection_catalog_consistent",
		"conversion_ingest_secrets_projection_catalog_projector",
		"conversion identity projector table grants are unsafe",
		"conversion_email_hmac_projection_health",
		"NEW.secret <> 'envelope:do-not-use'",
		"octet_length(NEW.secret_envelope) = 0",
		"get_byte(NEW.secret_envelope, 0) <> 2",
		"FORCE ROW LEVEL SECURITY",
		"SECURITY DEFINER",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION NOBYPASSRLS",
		"REVOKE ALL ON FUNCTION public.claim_conversion_email_hmac_projection_tasks",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("migration 2017 omits %q", required)
		}
	}
	if strings.Count(source, "BEGIN;") != 1 || strings.Count(source, "COMMIT;") != 1 ||
		!strings.Contains(source, "migration-execution: atomic") {
		t.Fatalf("migration 2017 must have one replay-safe atomic boundary: BEGIN=%d COMMIT=%d",
			strings.Count(source, "BEGIN;"), strings.Count(source, "COMMIT;"))
	}
	if strings.Contains(source, "DELETE FROM public.conversion_attribution_touches") {
		t.Fatal("migration 2017 must cryptoshred attribution touches in place; apply-time deletion is irreversible and blocked by migration safety policy")
	}
	if strings.Contains(source, "OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL") {
		t.Fatal("migration 2017 retains a revoked-to-live lifecycle branch")
	}
	bindingsStart := strings.Index(source, "CREATE TABLE public.conversion_email_hmac_bindings")
	if bindingsStart < 0 {
		t.Fatal("cannot isolate bindings DDL")
	}
	bindingsEnd := strings.Index(source[bindingsStart:], ");")
	if bindingsEnd < 0 {
		t.Fatal("cannot isolate bindings DDL")
	}
	bindingsDDL := source[bindingsStart : bindingsStart+bindingsEnd]
	if strings.Contains(bindingsDDL, " secret ") || strings.Contains(bindingsDDL, "email ") {
		t.Fatalf("binding projection persists plaintext material:\n%s", bindingsDDL)
	}
	if strings.Contains(bindingsDDL, "REFERENCES public.subscribers") {
		t.Fatal("binding subscriber FK reintroduces the task/subscriber lock inversion")
	}
	stateBackfillStart := strings.LastIndex(source,
		"INSERT INTO public.conversion_email_hmac_projection_states")
	taskBackfillStart := strings.LastIndex(source,
		"INSERT INTO public.conversion_email_hmac_projection_tasks")
	if stateBackfillStart < 0 || taskBackfillStart < 0 || taskBackfillStart <= stateBackfillStart {
		t.Fatal("cannot isolate historical projection-state backfill")
	}
	if strings.Contains(source[stateBackfillStart:taskBackfillStart], "WHERE revoked_at IS NULL") {
		t.Fatal("historical revoked keys would disappear from closed list metadata")
	}
	fullCandidates := strings.Index(source, "WITH full_candidates AS MATERIALIZED")
	subscriberCandidates := strings.Index(source, "), subscriber_candidates AS MATERIALIZED")
	if fullCandidates < 0 || subscriberCandidates <= fullCandidates {
		t.Fatal("claim function no longer reserves a due full-task slot before filling subscriber capacity")
	}
	triggerStart := strings.Index(source, "CREATE OR REPLACE FUNCTION public.conversion_email_hmac_enqueue_subscriber")
	if triggerStart < 0 {
		t.Fatal("cannot isolate subscriber projection trigger")
	}
	triggerEnd := strings.Index(source[triggerStart:], "DROP TRIGGER IF EXISTS conversion_email_hmac_subscriber_insert")
	if triggerEnd < 0 {
		t.Fatal("cannot isolate subscriber projection trigger")
	}
	triggerBody := source[triggerStart : triggerStart+triggerEnd]
	if strings.Contains(triggerBody, "SET cursor_subscriber_id = NULL") {
		t.Fatal("subscriber churn resets the full projection cursor and can starve key issuance")
	}
}

func TestEmailHMACProjectionHotPathIsIndexedAndSecretFree(t *testing.T) {
	raw, err := os.ReadFile("signed_ingest_identity.go")
	if err != nil {
		t.Fatalf("read resolver: %v", err)
	}
	source := string(raw)
	start := strings.Index(source, "func loadEmailHMACBindings(")
	if start < 0 {
		t.Fatal("cannot isolate email-HMAC resolver")
	}
	end := strings.Index(source[start:], "// lookupSubscriberByExternalID")
	if end < 0 {
		t.Fatal("cannot isolate email-HMAC resolver")
	}
	resolver := source[start : start+end]
	for _, required := range []string{
		"conversion_email_hmac_projection_states",
		"conversion_email_hmac_bindings",
		"projection.status = 'ready'",
		"LEFT JOIN conversion_email_hmac_bindings",
		"binding.key_id = $3",
		"binding.digest = requested.digest",
		"FOR SHARE OF projection, secret",
		"seenRequested != len(requested)",
		"ErrEmailIdentityProjectionNotReady",
	} {
		if !strings.Contains(resolver, required) {
			t.Errorf("indexed resolver omits %q", required)
		}
	}
	for _, forbidden := range []string{
		"hmac(",
		"encode(hmac",
		"FROM subscribers AS subscriber",
		"identityHMACSecret",
		"tx.QueryRow",
	} {
		if strings.Contains(resolver, forbidden) {
			t.Errorf("hot resolver retained unbounded/secret-bearing form %q", forbidden)
		}
	}

	workerRaw, err := os.ReadFile("email_hmac_projection.go")
	if err != nil {
		t.Fatalf("read projection repository: %v", err)
	}
	workerSource := string(workerRaw)
	if !strings.Contains(workerSource, "ORDER BY id\n LIMIT $3") ||
		!strings.Contains(workerSource, "pageSize > 1000") {
		t.Fatal("full reconciliation no longer proves a bounded subscriber page")
	}
	for _, required := range []string{
		"envelope[0] != pwcrypto.VersionEnvelope",
		"return nil, ErrProjectionSecretUnavailable",
		"cipher.Decrypt(ctx, envelope, nil)",
	} {
		if !strings.Contains(workerSource, required) {
			t.Errorf("exact-KMS projection secret boundary omits %q", required)
		}
	}
	for _, forbidden := range []string{"return legacy, nil", "secret.secret,"} {
		if strings.Contains(workerSource, forbidden) {
			t.Fatalf("email-HMAC projection still reads or accepts historical plaintext via %q", forbidden)
		}
	}

	projectionWorkerRaw, err := os.ReadFile("email_hmac_projection_worker.go")
	if err != nil {
		t.Fatalf("read projection worker: %v", err)
	}
	runtimeRaw, err := os.ReadFile(filepath.Join("..", "..", "cmd",
		"campaign-assurance-worker", "email_hmac_projection.go"))
	if err != nil {
		t.Fatalf("read projection runtime composition: %v", err)
	}
	runtimeSource := string(runtimeRaw)
	if !strings.Contains(runtimeSource, "pwcrypto.NewKMSEnvelope(") {
		t.Fatal("projection runtime no longer pins the KMS-only envelope constructor")
	}
	for name, source := range map[string]string{
		"repository":  workerSource,
		"worker":      string(projectionWorkerRaw),
		"composition": runtimeSource,
	} {
		for _, forbidden := range []string{
			"NewKMSEnvelopeWithFallback", "POSTWAVE_SENDING_KEK", "LegacyKEK", "legacyKEK",
		} {
			if strings.Contains(source, forbidden) {
				t.Errorf("%s projection path retains legacy KEK dependency %q", name, forbidden)
			}
		}
	}
}
