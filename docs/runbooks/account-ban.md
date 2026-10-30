# Runbook — Seedlist Account Banned

When one of our 30 seedlist mailbox accounts is locked, suspended, or
shadow-banned by the provider (Gmail, Outlook.com, Yahoo, iCloud, ProtonMail,
GMX, Mail.ru, M365). Without intervention this corrupts Inbox Reality
reports — bans look like permanent placement misses for that provider.

---

## Symptoms

- `seedlist_health_miss` Prometheus metric > 0 for one or more `inbox_id`s.
- The synthetic hourly health-check email never arrives in the target inbox.
- Inbox Reality reports show `placement=missing` from a single seedlist
  account while *other* accounts on the same provider still report normally.
- Sustained `imap_login_failed` errors in the deliverability service log,
  sometimes with provider-specific status codes (`AUTHENTICATIONFAILED`,
  `[ALERT] Web login required`, `Account suspended`).

## Detection

The synthetic-health pipeline runs every 60 minutes (`SeedlistHealth` job
in `services/deliverability/internal/seedlist/poller.go`) and writes
`status=flagged|banned|ok` to `seedlist_inboxes`. Two signals fire alerts:

1. **Hard fail** — three consecutive misses → PagerDuty SEV3.
2. **Soft fail** — > 20% miss rate on a single provider over 24h → SEV2.

A confirmed ban is also surfaced in webmail with one of:
- "Unusual activity detected, sign-in challenge"
- "Your account has been suspended"
- "We've changed your password as a precaution"
- For ProtonMail: "Account locked due to abuse policy"

## Severity matrix

| Condition | Severity | On-call action |
|---|---|---|
| Single account, single provider | SEV3 | Mark inactive, replace within 7 days |
| ≥2 accounts at same provider in 48h | SEV2 | Page deliverability lead, suspect provider-policy shift |
| ≥4 accounts across multiple providers in 24h | SEV1 | Likely IP-pool issue; cross-check with `ip-delisting.md` |

---

## Immediate response (P0)

P0 (SEV1/SEV2):
1. **Mark inactive in registry** (stops polling, stops corrupting reports):
   ```sql
   UPDATE seedlist_inboxes
   SET status = 'banned', banned_at = NOW()
   WHERE id = $1;
   ```
2. **Reroute Inbox Reality aggregation** to ignore that provider's
   percentage when ≥25% of its seedlist is dark, by setting the
   tenant-overridable `seedlist.min_active_per_provider` config to 1
   (default 3).
3. **Inform customers** if any campaign report in the last 24h would
   have included the banned mailbox: post to the `#cust-deliverability`
   internal Slack with the affected campaign IDs.

P1: schedule a replacement provisioning job (next section).

P2: file an ADR if this is the third ban from the same provider in 30
days — that's a signal of a behavioral pattern to investigate.

## Investigation

1. **Why was it flagged?**
   - Inspect the mailbox via webmail. Provider-specific messages tell you
     whether it's a credential rotation, IP heuristic, or anti-abuse hit.
   - Check `seedlist_audit` for recent sign-in events. Any from unexpected
     IP geos = likely provider flagging us as suspicious.
2. **Is it our IP pool?** Cross-check with `ip-delisting.md` — if Postmark/SES
   shared IPs are listed, the seedlist account may be a side effect.
3. **Was this account paid?** Free Gmail/Yahoo flag faster than paid
   Workspace/M365. If we lost a free account, schedule its replacement
   on a paid plan.

## Permanent fix

1. **Provision a replacement** following
   `docs/runbooks/seedlist-provisioning.md`.
   The replacement must use a fresh mailbox, preferably fresh ASN/geo
   diversity, manual signup over a normal residential/provider network, and a
   warming period before it is included in customer-facing reports.
2. **Rotate credentials** of the banned account just to be safe — if it
   later un-bans, we don't want stale creds re-polling.
3. **Geographic distribution**: if 2+ bans came from the same provider in
   the same data center, schedule reprovisioning across at least 3
   geographic regions.
4. **Pricing tier upgrade**: free accounts ban faster. Move to Workspace
   ($6/mo/user) for chronic offenders. Tracked under deliverability
   opex budget.

---

## Post-mortem template

```
## Incident: Seedlist account ban — <inbox_id>
**Detected:** <UTC timestamp>
**Resolved:** <UTC timestamp>
**Severity:** SEV<N>
**Affected:** <count> Inbox Reality reports, <tenant_ids>

### Timeline
- <ts> — health probe miss #1
- <ts> — alert fired
- <ts> — on-call paged
- <ts> — marked inactive
- <ts> — replacement provisioned
- <ts> — back to N-1 of 30

### Root cause
<single sentence: provider behavior, IP-reputation collateral, credential rotation, etc.>

### Actions
- [ ] Replacement live in seedlist.yaml
- [ ] Provider-specific rotation cadence updated if needed
- [ ] ADR opened if pattern is forming

### What went well / What to improve
```

## Communication template (SEV1/SEV2)

Internal Slack — `#incidents`:

> [SEV<N>] Seedlist account banned — <provider> / <inbox_id>
>
> Symptom: <one line>
> Affected reports: <campaign_ids>
> Mitigation: marked banned at <ts>; provider's percentage now omitted
> from aggregation when <25% active.
> ETA replacement: <date>
> Owner: <on-call>

External (only if customers reported skewed numbers):

> We briefly omitted <provider> from your Inbox Reality reports between
> <start> and <end> while replacing a monitored test mailbox.
> Future reports include <provider> as normal. No action needed on your end.
