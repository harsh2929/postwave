# Independent-operation evaluation notes

> [!IMPORTANT]
> This is a source-evaluation note, not a supported production SKU,
> installer, customer distribution, continuity commitment, or SLA. Moosewave
> Cloud uses the separately governed AWS release path. Packaging, maintenance,
> upgrade assistance, support, and service commitments exist only in an
> executed agreement tied to a reviewed release artifact.

The repository contains source that may be studied, modified, and operated
under the applicable licenses. That does not mean a tested self-host bundle is
available. There is currently no approved download, license key, customer image
registry, automatic update channel, supported topology, or production install
procedure.

## License and artifact boundaries

- `apps/`, `services/`, and `infra/` are AGPL-3.0-only.
- Each immediate `packages/*` root is MIT licensed. Its presence does not
  promise a mirror, registry release, maintenance, or support.
- Moosewave calls a separately running upstream Listmonk process over HTTP.
  There is no Moosewave Listmonk fork, source tree, or Git submodule.
- `proprietary/` contains separately controlled calibrated packs that may be
  present in a private/internal checkout and selected private Moosewave Cloud
  images only. They must not enter public, customer, self-host, or
  corresponding-source artifacts.
- `proprietary-stubs/` contains MIT-licensed, uncalibrated placeholders for
  exercising the runtime path contract.

The current `Dockerfile.go` intentionally copies the real Diagnostician pack
into the deliverability image and the real voice pack into the voice image.
Those targets therefore belong only to private Moosewave Cloud builds. A public
source export omits `proprietary/`; an independently operated build must use
reviewed operator-created assets or the stubs and must define its own build and
runtime packaging. The repository does not yet provide or certify that
external distribution workflow.

See [`../LICENSE-BOUNDARY.md`](../LICENSE-BOUNDARY.md) for the authoritative
policy. License questions and the first external distribution require counsel
review.

## Development topology only

The Compose files under `infra/` are local integration references. They use
development credentials and a version-tagged upstream Listmonk v6.1.0 image,
not an approved immutable release digest. From an existing private/internal
checkout, an engineer can inspect the topology with:

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.full.yml config
```

Do not put customer or recipient data into this topology based on this note.
Do not infer production readiness from successful compilation, container
startup, or a health endpoint.

An operator evaluating the source must independently provide and validate at
least:

- PostgreSQL, Redis/Valkey, object storage, KMS/secrets, TLS, DNS, and network
  isolation;
- an email service provider and the provider-specific sending, complaint,
  suppression, webhook, and abuse controls;
- LLM/rendering/identity/payment/observability dependencies used by the chosen
  feature set;
- tenant isolation, least-privilege credentials, outbound-egress restrictions,
  log redaction, rate limits, and incident response;
- database and object migrations run through the canonical migrator rather
  than application-startup assumptions; and
- monitoring that distinguishes process liveness from dependency readiness
  and end-to-end business health.

Configuration options and adapters in source are not evidence that a provider
has certified an integration or that a feature is commercially available.

## Release evidence required before supported packaging

Before Moosewave can publish customer installation or upgrade instructions, a
release packet must include:

1. an immutable source commit and signed application image digests;
2. an approved `listmonk/listmonk@sha256:<digest>` with upstream source and
   license provenance, SBOM, signature/provenance, and vulnerability review;
3. a reviewed source export containing the applicable AGPL, MIT, and
   third-party notices while excluding `proprietary/`;
4. an extraction manifest/SBOM proving no tuned pack, secret, credential,
   private URL, or build cache entered a public or customer artifact;
5. verified registry access controls for every private Moosewave Cloud image;
6. installation and smoke-test evidence on each declared supported topology;
7. backup, isolated restore, migration, upgrade, rollback/forward-recovery,
   and disaster-recovery rehearsals with measured RPO/RTO; and
8. counsel-approved corresponding-source handling and commercial terms.

Until that packet exists, source-level independent operation is
operator-built and unsupported. The operator owns dependency selection,
capacity, security, privacy and data residency, abuse prevention,
deliverability, backups, recovery, upgrades, vulnerability management, and
all applicable legal obligations.

## Current production path

Moosewave Cloud's declared target is AWS ECS Fargate in `us-west-2`, governed by
[`../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md)
and `config/production-platform.json`. Those documents define a release target;
they do not by themselves prove a live, certified environment.

For local engineering, start with [`DEVELOPING.md`](DEVELOPING.md). For backup
and recovery engineering, use [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md)
only together with current executable contract checks and recorded rehearsal
evidence.
