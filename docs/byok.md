# BYOK (Bring-Your-Own-Key) wiring

Moosewave's data-at-rest BYOK lets a tenant supply an AWS KMS-resident KEK
(Key Encryption Key) for the production fields explicitly listed below.
It does not yet cover every per-tenant secret. The platform handles the data plane (DEK generation,
AES-GCM seal/open, envelope framing); the customer's KMS only ever
sees `kms:Encrypt` / `kms:Decrypt` calls on the wrapped DEK.

## Architecture

```
  apps/api/internal/byok
  ├── awsadapter.go    AWS-SDK-v2 → pwkms.AWSClient adapter + BuildRegistry
  ├── cipher.go        TenantCipher: v=0x03 envelope (per-tenant)
  ├── composite.go     Composite: routes by tenant (BYOK vs platform)
  ├── reencrypt.go     Reencryptor: column-driven background rotation
  ├── handlers.go      /api/v1/byok/* admin endpoints
  └── repo.go          tenant_keys CRUD

  packages/kms
  ├── kms.go           Provider interface + Registry
  ├── aws.go           AWSProvider
  ├── gcp.go           GCPProvider
  ├── vault.go         VaultProvider
  └── tink.go          TinkProvider
```

The cipher layer (`apps/api/internal/byok/cipher.go`) writes a
`v=0x03` envelope that embeds the `tenant_keys.id` UUID, so Decrypt
routes to the right (provider, KeyRef) without an out-of-band
lookup. The wire format:

```
[ 0x03 ][ key_id_len:1 ][ key_id ASCII ][ wrapped_len:2 BE ][ wrapped ][ nonce:12 ][ ciphertext ]
```

A blob written under KEK A stays decryptable forever as long as the
`tenant_keys` row for A is preserved (status `inactive` is fine —
that only blocks new writes). The Reencryptor's job is to migrate
existing blobs forward so the old KEK can eventually be retired in
the provider.

## Provider wiring (operators)

`byok.BuildRegistry(awsClient)` constructs the registry main.go
passes into the BYOK Deps. AWS is wired automatically when the
platform's `*kms.Client` is available (i.e. `AWS_REGION` +
`POSTWAVE_KMS_KEY_ID` are set).

| Provider | Production status | Requires                            |
| -------- | ----------------- | ----------------------------------- |
| AWS      | Available         | `AWS_REGION`, `POSTWAVE_KMS_KEY_ID` |
| GCP      | Not available     | Provider primitive exists but has no production credential/configuration wiring. |
| Vault    | Not available     | Provider primitive exists but has no production credential/configuration wiring. |
| Tink     | Not available     | Provider primitive exists but has no production keyset/configuration wiring. |

`GET /api/v1/byok/providers` returns only providers wired in the current
deployment. Creation rejects every unavailable provider. The desktop picker
uses that response and does not optimistically advertise dormant primitives.

## Cross-account AWS KMS

The BYOK AWS provider uses the SAME AWS credentials as the
platform's `*kms.Client`. Per-tenant routing happens by the `KeyRef`
the tenant supplies (their KMS key's ARN). AWS authorises each
`kms:Encrypt` / `kms:Decrypt` against that ARN's resource policy, so
a tenant's customer-managed key is only usable if their KMS key
policy grants access to Moosewave's IAM role. This is the standard
cross-account BYOK pattern.

## Key lifecycle

```
                     create (status=inactive)
                              ↓
       activate ←──── inactive ──── delete (status=deleted)
          ↓               ↑
       active ─── rotate ─┘
                              (a new key activates,
                               previous demotes to inactive)
```

- Exactly one `tenant_keys` row per tenant has `status='active'`
  (enforced by a partial unique index).
- The activation endpoint performs a live provider encrypt/decrypt health
  check, records it, and only then atomically demotes the previous key and
  promotes the target.
- The delete endpoint refuses to retire an active key or any inactive key
  still embedded in a registered ciphertext column.

## Re-encryption sweep

`byok.Reencryptor` is the background goroutine launched in
`main.go` as `byok-reencrypt-sweeper`. Default cadence is 5 min;
default batch size is 50 rows per (tenant, column) per tick (small
enough to stay well under AWS KMS's 1000 ops/sec/region default
quota).

The sweep is **column-driven**: it only touches `(table, blob_col)`
pairs explicitly registered via `Reencryptor.RegisterColumn`. Production
currently registers:

| Table | Column | Data |
| ----- | ------ | ---- |
| `ai_llm_provider_config` | `api_key_ciphertext` | The tenant's Anthropic credential for the in-app agent |

All other secrets continue to use the platform envelope cipher unless their
own subsystem documentation explicitly says otherwise.

To register a column:

```go
if err := byokReencryptor.RegisterColumn(byok.EncryptedColumn{
    Table:   "subscriber_pii",
    IDCol:   "id",
    BlobCol: "encrypted_payload",
    // TenantCol defaults to "tenant_id" — set if your table names
    // it differently.
}); err != nil {
    log.Fatalf("register byok column: %v", err)
}
```

Identifiers are validated against a strict allow-list
(`[a-z_][a-z0-9_]{0,62}`) before reaching the SQL formatter — there
is no path for an attacker-controlled string to land in
`fmt.Sprintf`.

## Operator runbook: rotating a tenant's KEK

1. **Mint the new KEK in AWS.** Use `aws kms create-key` and create an alias.
2. **Create the inactive row.** Dashboard: BYOK → "Add key" with
   provider + KeyRef. Server inserts with `status='inactive'`.
3. **Optionally health-check early.** POST `/api/v1/byok/keys/{id}/health`
   to diagnose permissions before activation.
4. **Activate.** POST `/api/v1/byok/keys/{id}/activate`. The endpoint repeats
   the live health check; failure leaves the current key unchanged. On success,
   the previous active key demotes to inactive in the same transaction.
5. **Wait for the sweeper.** The Reencryptor will start migrating
   blobs from the inactive KEK to the new active KEK on its next
   tick. Watch `byok-reencrypt-sweeper` log lines — when row counts
   drop to zero across all registered columns, the inactive KEK is
   no longer referenced by any blob.
6. **Soft-delete the old row.** DELETE `/api/v1/byok/keys/{id}`. The API
   counts references across every registered column and returns `409
   key_still_referenced` until the count reaches zero.
7. **Schedule provider-side deletion.** AWS: `aws kms
   schedule-key-deletion --pending-window-in-days 30`. Pending
   window lets you recover if you discover a stray blob.

## Failure modes

| Symptom                                         | Cause                                                    | Fix                                                          |
|-------------------------------------------------|----------------------------------------------------------|--------------------------------------------------------------|
| `provider_unavailable` on key creation          | The requested backend is not wired in this deployment | Use a provider returned by `/api/v1/byok/providers`; production currently supports AWS. |
| `aws kms decrypt: AccessDenied`                 | Tenant's KMS key policy doesn't grant Moosewave's IAM    | Tenant adds Moosewave's role ARN to their key policy.         |
| `byok: tenant has no active key` on Encrypt     | Composite routed to TenantCipher but no active row       | Either create+activate a key or fall back to platform cipher.|
| Reencrypt sweep logs `decrypt: NotFoundException` | Old KEK was deleted from provider before sweep finished | Recover from provider's pending-deletion window.             |

## Reference

- `apps/api/internal/byok/awsadapter.go` — adapter + BuildRegistry
- `apps/api/internal/byok/reencrypt.go` — sweep loop + column registry
- `apps/api/internal/byok/cipher.go` — v=0x03 envelope wire format
- `packages/kms/kms.go` — Provider interface + Registry
- `infra/migrations/0109_tenant_keys.sql` — schema
