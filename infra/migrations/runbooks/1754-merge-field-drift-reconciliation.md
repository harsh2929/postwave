# Migration 1754 merge-field drift reconciliation

Use this runbook only when `1754_merge_field_write_compatibility` stops with
`declared values disagree between canonical and sidecar stores`. The stop is
intentional: both stores historically accepted writes, so the migration must
not guess which value reflects the operator's latest intent.

## Safety invariants

- Take and verify a restorable snapshot before changing any value.
- Keep the phase-0 compatibility triggers installed. They committed before the
  fleet scan failed and prevent new rolling-deploy drift.
- Do not edit the migration, delete `schema_migration_steps`, or mark 1754
  applied manually. Resume state is checksum- and phase-digest-bound.
- Treat values as customer PII. Inventory only in the restricted operations
  environment, encrypt review exports, and never paste raw values into logs or
  tickets.
- Resolve every tuple with an accountable reviewer. There is no safe global
  canonical-wins or sidecar-wins default.

## 1. Confirm resumable state

```sql
SELECT version, step, checksum, phase_digest, transactional, applied_at
  FROM schema_migration_steps
 WHERE version = '1754_merge_field_write_compatibility'
 ORDER BY step;

SELECT version, checksum, applied_at
  FROM schema_migrations
 WHERE version = '1754_merge_field_write_compatibility';
```

After the expected preflight rejection there is one committed transactional
phase row and no completed-version row. Any other shape is an incident: stop
and restore/escalate instead of modifying the ledgers.

## 2. Inventory exact drift

Phase 0 installed `validate_declared_merge_field_value`, so this compares the
same normalized values the migration attests:

```sql
WITH canonical_values AS MATERIALIZED (
    SELECT schema.tenant_id,
           subscriber.id AS subscriber_id,
           schema.key,
           validate_declared_merge_field_value(
               schema.key, schema.type, schema.required,
               subscriber.merge_fields -> schema.key
           ) AS value
      FROM merge_field_schema schema
      JOIN subscribers subscriber
        ON subscriber.tenant_id = schema.tenant_id
       AND subscriber.merge_fields ? schema.key
),
sidecar_values AS MATERIALIZED (
    SELECT value.tenant_id,
           value.subscriber_id,
           value.key,
           validate_declared_merge_field_value(
               value.key, schema.type, schema.required, to_jsonb(value.value)
           ) AS value
      FROM merge_field_values value
      JOIN merge_field_schema schema
        ON schema.tenant_id = value.tenant_id
       AND schema.key = value.key
)
SELECT COALESCE(canonical.tenant_id, sidecar.tenant_id) AS tenant_id,
       COALESCE(canonical.subscriber_id, sidecar.subscriber_id) AS subscriber_id,
       COALESCE(canonical.key, sidecar.key) AS key,
       canonical.value AS canonical_value,
       sidecar.value AS sidecar_value,
       CASE
           WHEN canonical.subscriber_id IS NULL THEN 'canonical_missing'
           WHEN sidecar.subscriber_id IS NULL THEN 'sidecar_missing'
           ELSE 'values_differ'
       END AS drift_kind
  FROM canonical_values canonical
  FULL JOIN sidecar_values sidecar
    ON sidecar.tenant_id = canonical.tenant_id
   AND sidecar.subscriber_id = canonical.subscriber_id
   AND sidecar.key = canonical.key
 WHERE canonical.subscriber_id IS NULL
    OR sidecar.subscriber_id IS NULL
    OR canonical.value IS DISTINCT FROM sidecar.value
 ORDER BY 1, 2, 3;
```

Record the count and a cryptographic digest of the encrypted review artifact.
A reviewer selects one outcome per tuple: keep canonical, keep sidecar, or
clear an optional field. Required fields cannot be cleared; `PW001` is a
safety signal, not an error to bypass.

## 3. Apply reviewed decisions tenant by tenant

Load reviewed decisions into a session-local table. `chosen_value = NULL`
means an explicitly reviewed clear; a non-empty value is the reviewed winner.

```sql
CREATE TEMP TABLE merge_field_reconciliation_decisions (
    tenant_id uuid NOT NULL,
    subscriber_id uuid NOT NULL,
    key text NOT NULL,
    chosen_value text,
    decision text NOT NULL CHECK (
        decision IN ('canonical_wins', 'sidecar_wins', 'clear')
    ),
    reviewed_by text NOT NULL,
    reviewed_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, subscriber_id, key),
    CHECK ((decision = 'clear') = (chosen_value IS NULL)),
    CHECK (chosen_value IS NULL OR btrim(chosen_value) <> '')
);
```

For each tenant, bind RLS and reconcile in one transaction. The installed
triggers validate type/required rules and mirror the chosen value atomically.

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant-uuid>', true);

INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
SELECT decision.tenant_id,
       decision.subscriber_id,
       decision.key,
       decision.chosen_value
  FROM merge_field_reconciliation_decisions decision
 WHERE decision.tenant_id = '<tenant-uuid>'::uuid
   AND decision.chosen_value IS NOT NULL
ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE
   SET value = EXCLUDED.value,
       updated_at = now();

UPDATE subscribers subscriber
   SET merge_fields = COALESCE(subscriber.merge_fields, '{}'::jsonb)
                      - decision.key
  FROM merge_field_reconciliation_decisions decision
 WHERE decision.tenant_id = '<tenant-uuid>'::uuid
   AND decision.decision = 'clear'
   AND subscriber.tenant_id = decision.tenant_id
   AND subscriber.id = decision.subscriber_id;

-- Covers a sidecar-only clear whose canonical key was already absent.
DELETE FROM merge_field_values value
 USING merge_field_reconciliation_decisions decision
 WHERE decision.tenant_id = '<tenant-uuid>'::uuid
   AND decision.decision = 'clear'
   AND value.tenant_id = decision.tenant_id
   AND value.subscriber_id = decision.subscriber_id
   AND value.key = decision.key;

COMMIT;
```

Do not batch unrelated tenants into one transaction. On validation,
serialization, timeout, or constraint failure, roll back that tenant,
investigate, and retry only reviewed decisions.

## 4. Prove zero drift and resume

Run the inventory again. It must return zero rows. Record its count,
timestamp, migration checksum, reviewer, and snapshot ID in release evidence.

The CLI default is five minutes; size an explicit production timeout from a
staging rehearsal of the fleet scan:

```bash
DATABASE_URL='<admin-url>' go run ./apps/api/cmd/migrate \
  --dir infra/migrations \
  --timeout 30m
```

`30m` is an example, not a universal value. Use the unchanged migration file.
The runner skips the attested cutover phase, reruns preflight and validation,
records 1754, and clears its phase rows.

## 5. Post-run verification

```sql
SELECT version, checksum, applied_at
  FROM schema_migrations
 WHERE version = '1754_merge_field_write_compatibility';

SELECT count(*) AS remaining_phase_rows
  FROM schema_migration_steps
 WHERE version = '1754_merge_field_write_compatibility';

SELECT conname, convalidated
  FROM pg_constraint
 WHERE conname IN (
     'subscribers_merge_fields_object_check',
     'merge_field_values_tenant_subscriber_fkey'
 )
 ORDER BY conname;

SELECT indexrelid::regclass AS index_name, indisvalid, indisready
  FROM pg_index
 WHERE indexrelid IN (
     'merge_field_values_tenant_key_usage_idx'::regclass,
     'subscribers_tenant_id_id_uidx'::regclass
 );
```

Expected: one completed 1754 row, zero phase rows, both constraints validated,
and both indexes valid/ready. Re-run drift inventory and a sample read through
the unprivileged app role before releasing traffic.

The executable exact-file rejection/resume rehearsal is
`apps/api/internal/migrationrunner/migration_1754_db_test.go`.
