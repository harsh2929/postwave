# NON-PRODUCTION — retired MVP experiment

The former account-specific MVP stack was removed from the distributable tree
because it embedded personal and operational identifiers and depended on a
long-lived IAM user. It is not an alternate deployment path and must not be
reconstructed from repository history.

Required incident actions outside this repository:

1. Revoke and delete every access key that belonged to the retired MVP IAM
   user; do not rely on removing the text from Git.
2. Review CloudTrail and SES activity from the key's creation through
   revocation and retain the incident ticket/evidence outside the repository.
3. Remove obsolete buckets, topics, identities, tunnels and callbacks only
   after retention and legal-hold requirements are confirmed.
4. Rewrite published Git history and invalidate forks/caches before any public
   source handoff. Coordinate this operation with every collaborator because
   it changes commit IDs.

The sole Moosewave Cloud contract is
[`../aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../aws/PRODUCTION_DEPLOY_RUNBOOK.md).
Local development uses [`../docker-compose.yml`](../docker-compose.yml) with
synthetic credentials only.
