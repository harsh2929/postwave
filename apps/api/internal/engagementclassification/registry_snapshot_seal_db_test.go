// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRegistrySealDatabaseAuthority_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	var appRawInsert, appPublish, publicPublish bool
	if err := admin.QueryRow(ctx, `
SELECT has_table_privilege(
           'postwave_app',
           'public.engagement_machine_registry_entries',
           'INSERT'
       ),
       has_function_privilege(
           'postwave_app',
           'public.publish_engagement_machine_registry(text,jsonb)',
           'EXECUTE'
       ),
       has_function_privilege(
           'postwave_public',
           'public.publish_engagement_machine_registry(text,jsonb)',
           'EXECUTE'
       )`).Scan(&appRawInsert, &appPublish, &publicPublish); err != nil {
		t.Fatalf("inspect registry publication grants: %v", err)
	}
	if appRawInsert || !appPublish || publicPublish {
		t.Fatalf("unsafe registry grants raw_insert=%v app_publish=%v public_publish=%v", appRawInsert, appPublish, publicPublish)
	}
	var publicSchemaCreate, appSchemaCreate bool
	if err := admin.QueryRow(ctx, `
SELECT has_schema_privilege('public', 'public', 'CREATE'),
       has_schema_privilege('postwave_app', 'public', 'CREATE')`).Scan(
		&publicSchemaCreate, &appSchemaCreate,
	); err != nil {
		t.Fatalf("inspect registry schema authority: %v", err)
	}
	if publicSchemaCreate || appSchemaCreate {
		t.Fatalf("untrusted schema create authority public=%v app=%v", publicSchemaCreate, appSchemaCreate)
	}

	var publisherUnsafe bool
	var publisherMemberships int
	if err := admin.QueryRow(ctx, `
SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR
       rolreplication OR rolbypassrls,
       (
           SELECT count(*)
             FROM pg_auth_members AS membership
            WHERE membership.member = publisher.oid OR membership.roleid = publisher.oid
       )
  FROM pg_roles AS publisher
 WHERE rolname='postwave_registry_publisher'`).Scan(
		&publisherUnsafe, &publisherMemberships,
	); err != nil {
		t.Fatalf("inspect purpose-built publisher role: %v", err)
	}
	if publisherUnsafe || publisherMemberships != 0 {
		t.Fatalf("registry publisher unsafe=%v memberships=%d", publisherUnsafe, publisherMemberships)
	}

	_, err := app.Exec(ctx, registryRawInsertSQL,
		CurrentRegistryV2, "R_APP_RAW_INSERT_BLOCKED", strings.Repeat("a", 64))
	if state := classifierSQLState(err); state != "42501" {
		t.Fatalf("raw application registry insert error=%v state=%q, want 42501", err, state)
	}
	_, err = admin.Exec(ctx, registryRawInsertSQL,
		CurrentRegistryV2, "R_ADMIN_SEALED_INSERT_BLOCKED", strings.Repeat("b", 64))
	if state := classifierSQLState(err); state != "PWR01" {
		t.Fatalf("sealed-version admin insert error=%v state=%q, want PWR01", err, state)
	}

	for name, statement := range map[string]string{
		"update": `UPDATE engagement_machine_registry_versions
                    SET sealed_at=sealed_at
                  WHERE registry_version=$1`,
		"delete": `DELETE FROM engagement_machine_registry_versions
                  WHERE registry_version=$1`,
	} {
		if _, err := admin.Exec(ctx, statement, CurrentRegistryV2); classifierSQLState(err) != "55000" {
			t.Fatalf("manifest %s error=%v state=%q, want 55000", name, err, classifierSQLState(err))
		}
	}

	legacyMethodology := fmt.Sprintf("postwave.engagement-methodology.test.%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, `
INSERT INTO engagement_classifier_methodology_versions (
    classifier_version, methodology_version, registry_version,
    configuration_hash, rollout_mode, configuration, release_note
) VALUES (
    'postwave.engagement-classifier.v2', $1, $2, $3,
    'shadow', '{}'::jsonb, 'Legacy registry must not authorize new lineage.'
)`, legacyMethodology, HistoricalRegistryV1, strings.Repeat("c", 64))
	if state := classifierSQLState(err); state != "55000" {
		t.Fatalf("legacy-registry methodology insert error=%v state=%q, want 55000", err, state)
	}

	var sealedLineageTriggers int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname = ANY(ARRAY[
       'engagement_classifier_methodology_sealed_registry',
       'engagement_classifier_calibration_sealed_registry',
       'event_classifications_sealed_registry',
       'engagement_reach_cutover_sealed_registry'
   ])`).Scan(&sealedLineageTriggers); err != nil {
		t.Fatalf("inspect sealed-lineage triggers: %v", err)
	}
	if sealedLineageTriggers != 4 {
		t.Fatalf("sealed-lineage trigger count=%d, want 4", sealedLineageTriggers)
	}

	unsealedVersion := fmt.Sprintf("postwave.machine-source-registry.unsealed.%d", time.Now().UnixNano())
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, registryRawInsertSQL,
		unsealedVersion, "R_UNSEALED_COMMIT_BLOCKED", strings.Repeat("d", 64)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("stage unsealed registry row: %v", err)
	}
	if err := tx.Commit(ctx); classifierSQLState(err) != "23503" {
		t.Fatalf("unsealed registry commit error=%v state=%q, want 23503", err, classifierSQLState(err))
	}
	var residue int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM engagement_machine_registry_entries
 WHERE registry_version=$1`, unsealedVersion).Scan(&residue); err != nil {
		t.Fatal(err)
	}
	if residue != 0 {
		t.Fatalf("failed unsealed transaction left %d rows", residue)
	}
}

func TestRegistryPublisherRejectsMalformedSnapshotsAtomically_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	valid := `{"confidence":0.9,"entry_id":"R_VALID_PUBLICATION","last_verified":"2026-08-31","machine_subtype":"unknown_bot","matcher_type":"ua_substring","matcher_value":"valid-agent","source_note":"bounded publication fixture"}`
	cases := []string{
		`[{"confidence":0.9,"entry_id":"X_BAD","last_verified":"2026-08-31","machine_subtype":"unknown_bot","matcher_type":"ua_substring","matcher_value":"valid-agent","source_note":"bounded publication fixture"}]`,
		`[{"confidence":0.9,"entry_id":"R_PADDED_MATCHER","last_verified":"2026-08-31","machine_subtype":"unknown_bot","matcher_type":"ua_substring","matcher_value":" padded-agent ","source_note":"bounded publication fixture"}]`,
		`[{"confidence":0.12345,"entry_id":"R_EXCESS_PRECISION","last_verified":"2026-08-31","machine_subtype":"unknown_bot","matcher_type":"ua_substring","matcher_value":"valid-agent","source_note":"bounded publication fixture"}]`,
		"[" + valid + "," + valid + "]",
		`[{"confidence":0.9,"entry_id":"R_INVALID_DATE","last_verified":"2026-02-30","machine_subtype":"unknown_bot","matcher_type":"ua_substring","matcher_value":"valid-agent","source_note":"bounded publication fixture"}]`,
	}
	for index, payload := range cases {
		version := fmt.Sprintf("postwave.machine-source-registry.invalid.%d.%d", time.Now().UnixNano(), index)
		var count int
		var fingerprint string
		err := app.QueryRow(ctx, `
SELECT published_entry_count, published_snapshot_fingerprint
  FROM public.publish_engagement_machine_registry($1, $2::jsonb)`,
			version, payload).Scan(&count, &fingerprint)
		if err == nil {
			t.Fatalf("malformed publication %d unexpectedly sealed count=%d fingerprint=%q", index, count, fingerprint)
		}
		var rows, manifests int
		if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM engagement_machine_registry_entries WHERE registry_version=$1),
       (SELECT count(*) FROM engagement_machine_registry_versions WHERE registry_version=$1)`,
			version).Scan(&rows, &manifests); err != nil {
			t.Fatal(err)
		}
		if rows != 0 || manifests != 0 {
			t.Fatalf("malformed publication %d left rows=%d manifests=%d", index, rows, manifests)
		}
	}
}

func TestRegistryPublisherOverridesCallerImmediateConstraintMode_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	version := fmt.Sprintf("postwave.machine-source-registry.immediate-test.%d", time.Now().UnixNano())
	payload := `[{
        "confidence": 0.9,
        "entry_id": "R_IMMEDIATE_MODE_PUBLICATION",
        "last_verified": "2026-08-31",
        "machine_subtype": "unknown_bot",
        "matcher_type": "ua_substring",
        "matcher_value": "immediate-mode-agent",
        "source_note": "Caller constraint mode determinism fixture."
    }]`

	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatalf("begin app publication transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET CONSTRAINTS ALL IMMEDIATE`); err != nil {
		t.Fatalf("force caller constraints immediate: %v", err)
	}
	var publishedCount int
	var publishedFingerprint string
	if err := tx.QueryRow(ctx, `
SELECT published_entry_count, published_snapshot_fingerprint
  FROM public.publish_engagement_machine_registry($1, $2::jsonb)`,
		version, payload).Scan(&publishedCount, &publishedFingerprint); err != nil {
		t.Fatalf("publish with caller constraints immediate: %v", err)
	}
	if publishedCount != 1 || len(publishedFingerprint) != 64 {
		t.Fatalf("publication receipt count=%d fingerprint=%q", publishedCount, publishedFingerprint)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit immediate-mode publication: %v", err)
	}

	repo := &Repo{Pool: (*db.Pool)(app)}
	loaded, err := repo.LoadRegistry(ctx, version)
	if err != nil {
		t.Fatalf("load immediate-mode sealed snapshot: %v", err)
	}
	if len(loaded) != 1 || loaded[0].EntryID != "R_IMMEDIATE_MODE_PUBLICATION" {
		t.Fatalf("loaded immediate-mode snapshot = %+v", loaded)
	}
	var manifestCount int
	var manifestFingerprint, provenance string
	if err := admin.QueryRow(ctx, `
SELECT entry_count, snapshot_fingerprint, provenance_state
  FROM engagement_machine_registry_versions
 WHERE registry_version=$1`, version).Scan(
		&manifestCount, &manifestFingerprint, &provenance,
	); err != nil {
		t.Fatalf("inspect immediate-mode manifest: %v", err)
	}
	if manifestCount != publishedCount || manifestFingerprint != publishedFingerprint || provenance != "sealed_snapshot" {
		t.Fatalf("manifest count=%d fingerprint=%q provenance=%q", manifestCount, manifestFingerprint, provenance)
	}
}

const registryRawInsertSQL = `
INSERT INTO engagement_machine_registry_entries (
    registry_version, entry_id, matcher_type, matcher_value,
    machine_subtype, confidence, source_note, last_verified,
    entry_fingerprint
) VALUES (
    $1, $2, 'ua_substring', 'blocked-agent', 'unknown_bot', 0.9000,
    'Registry seal authority regression fixture.', DATE '2026-08-31', $3
)`
