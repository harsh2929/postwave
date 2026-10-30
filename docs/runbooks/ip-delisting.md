# Runbook — Sending IP Blacklisted (DNSBL Listing)

When a sending IP we use (Postmark Streams shared IP, AWS SES IP, or a
dedicated Pro-tier IP) shows up on a major DNS-based blocklist
(Spamhaus SBL/CSS, SORBS, Barracuda, UCEPROTECT, Spamcop, etc.).

---

## Symptoms

- `dnsbl_listed` Prometheus metric > 0 for one of our outbound IPs.
- Spam-folder placement spikes for one or more tenants — Inbox Reality
  shows Outlook/Yahoo placement crashing while Gmail still trends fine
  (Microsoft + Yahoo lean heavily on Spamhaus).
- Tenant complaints on `/v1/auth-checks` showing `blacklist_hits` > 0.
- Postmark / SES dashboards show bounces with reason
  `552 5.7.1 banned-by-listing` or `554 5.7.1 RBL`.

## Detection

We poll the major DNSBLs continuously
(`services/deliverability/internal/reputation/blacklist`) per outbound IP
on a 5-minute cadence. Listings trigger:

- SEV1 when ≥1 Spamhaus, SORBS, or Barracuda listing on a shared IP.
- SEV2 when listed on UCEPROTECT/PSBL only (these are noisy/lower-trust).
- SEV3 when listed on a non-aggregating regional list.

Independent of polling, alarms fire on Postmark complaint rate >0.3%
(industry threshold for "ESP intervention warranted") sustained 30 min.

## Severity matrix

| Listing | List trust | Severity | Notes |
|---|---|---|---|
| Spamhaus SBL/CSS | Tier-1 | SEV1 | Microsoft + Comcast block immediately |
| Spamhaus DBL | Tier-1 | SEV1 | Domain blocklist; check `domain` not IP |
| Barracuda BRBL | Tier-1 | SEV1 | Heavy Outlook impact |
| SpamCop SCBL | Tier-2 | SEV2 | Time-decay; auto-removes if abuse stops |
| SORBS DUHL/SPAM | Tier-2 | SEV2 | |
| UCEPROTECT L2/L3 | Tier-3 | SEV3 | Wide IP-range nets; usually safe to ignore short-term |

---

## Immediate response

P0 — SEV1 (Tier-1 listing on a production IP):

1. **Identify the offending tenant.** Pull Postmark / SES outbound logs
   for the IP over the last 24h, grouped by tenant. Look for:
   - Sudden volume spike (>5x previous-30-day baseline)
   - Complaint rate >0.3% on a single tenant
   - Lots of bounces to obvious spam-traps (`*@spamtraps.example`)
2. **Pause that tenant's sending.**
   ```sql
   UPDATE tenants SET sending_paused = true,
     paused_reason = 'investigation: dnsbl listing'
   WHERE id = $1;
   ```
   Their queue spools to disk; we resume once cleared.
3. **Move other tenants off the affected shared IP.** Postmark's
   "Message Streams" let us rebalance to an alternate IP pool without
   re-warming. SES uses a Configuration Set + IP pool change.
4. **Open the delisting case** with the listing operator:
   - Spamhaus: https://check.spamhaus.org/ → "Submit removal request"
     (state our domain, IP, complaint volume rectified, affected tenant
     paused; usually clears within 24h).
   - Barracuda: support form, response within 12h.
   - SORBS: removal form; aggressive listings can take 48–72h.
   - UCEPROTECT: paid expedited removal — only do this if Tier-1 also lists.

P1: contact affected customers with the spam-folder placement spike
note (template below).

P2: write up findings under `docs/decisions.md` if a tenant's pattern
was in a known-bad category we should screen at signup.

## Investigation

1. **Pull listing evidence.** Spamhaus shows the trapped messages with
   timestamps. Match against our outbound logs to identify the campaign
   that triggered.
2. **Identify the smoking gun in that campaign.**
   - High image-only ratio?
   - Hidden text / spam-trap address harvested somewhere?
   - List-purchase pattern (random email-locality additions)?
3. **Check authentication alignment.** A surprising number of listings
   trigger because SPF/DKIM passed but DMARC alignment failed and the
   forwarder was a known blocklist honey-trap.

## Resolution

1. After listing operator clears, watch `dnsbl_listed` until it returns
   to 0 across all checks for >30 minutes.
2. **Gradually restore tenants** to the IP — start with cleanest reputation
   cohorts, monitor `complaint_rate` and `bounce_rate` for 24h.
3. **Decision on the offending tenant:**
   - First offense + cooperative customer → reinstate with reduced cap
     (50% of previous) for 7 days, mandatory list-cleaning campaign first.
   - Repeat offender → terminate per ToS §X (abuse / sending to purchased
     lists). Refund prorated.
4. **Tighten signals**:
   - Lower volume cap during first 7 days for new tenants by 30%.
   - Require per-customer DKIM signing domain so the next bad actor
     can't poison the shared `d=postmarkapp.com` identity.
   - Feed the offending campaign into the Pre-Send Predictor eval set.

---

## Post-mortem template

```
## Incident: <listname> listing on <ip>
**Detected:** <ts>      **Resolved:** <ts>      **Severity:** SEV<N>
**Affected:** <tenant_count> tenants, <campaign_count> campaigns

### Timeline
- <ts> dnsbl_listed alert fires
- <ts> on-call investigates, identifies offending tenant
- <ts> tenant paused
- <ts> delisting requested
- <ts> delisted; restoring tenants

### Root cause

### Detection lessons
- Did our predictor flag this campaign? If not, why?

### Actions
- [ ] Predictor weight tune (PR #...)
- [ ] Onboarding screening update
- [ ] Customer communication sent
```

## Communication templates

Internal:

> [SEV1] DNSBL listing — <listname> on <ip>
> Affected tenants paused; alternate IP pool active.
> Delisting case opened at <ts>. ETA <12-24h>.

Customer (affected innocent tenants):

> Subject: Brief deliverability dip on <date>
>
> Between <start> and <end> UTC, your campaigns may have seen elevated
> spam-folder placement at Microsoft and Yahoo. We identified the cause
> within X minutes and rerouted your sending to a clean IP pool. The
> issue is resolved. No action is required from you. We're tightening
> our monitoring to detect this class of issue earlier.
