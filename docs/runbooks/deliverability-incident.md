# Runbook — Deliverability Incident

Pillar 2 owners: on-call deliverability engineer.
Severity convention: SEV1 = customer-visible mass spam-folder placement; SEV2 = single-customer regression; SEV3 = single seedlist account flagged.

## At-a-glance triage

1. Check `/health` on the service.
2. Pull recent `seedlist_health_miss` and `dnsbl_listed` metrics.
3. Tail Diagnostician error log for `llm:` failures.
4. Confirm whether the issue is **fleet-wide** (shared infra) or **single-customer** (their auth/copy/reputation).

If fleet-wide → SEV1. If one customer → SEV2 with that tenant's domain in the title.

---

## Scenario: Seedlist account flagged or banned

Symptom: `seedlist_health_miss` spikes; one or more inbox `status` flips to `flagged` or `banned`. Inbox Reality reports show placement=`missing` for those inboxes.

### Diagnose

- Check `seedlist.yaml` for the affected `id`. Confirm provider and address.
- Try logging into the mailbox manually via webmail. Look for "unusual activity" / "account locked" challenges.
- Check whether the IMAP-app-password is still valid (Gmail, Yahoo, GMX rotate them silently).

### Mitigate

- Set the inbox's `status` to `banned` in the registry to stop polling.
- If under 25% of provider's seedlist remains active, route Inbox Reality reports to omit that provider's percentages until restored.
- Provision a replacement using [seedlist-provisioning.md](seedlist-provisioning.md).

### Post-incident

- Rotate the affected provider's other accounts on a 1/week cadence to detect silent locks.
- File ADR if banning pattern is provider-policy-driven.

---

## Scenario: Shared sending IP gets blacklisted

Symptom: `dnsbl_listed` metric > 0 for a Postmark/SES shared IP; spam placement spikes across many tenants on Microsoft + Yahoo.

### Diagnose

- `GET /v1/reputation` for any affected tenant — confirm `blacklist_hits` includes the listing.
- Check Spamhaus / SORBS lookup pages for context (listing reason, evidence URL).
- Identify the spammy tenant via Postmark / SES outbound logs (high complaint rate, sudden volume spike).

### Mitigate

- Pause the offending tenant's sending immediately.
- Submit removal requests to the listing operator (Spamhaus and Barracuda are usually fast; UCEPROTECT charges).
- Move other tenants to a clean shared IP pool while removal is pending.

### Post-incident

- Tighten new-customer screening: lower volume cap during first 7 days.
- Require per-customer DKIM signing domain so the bad actor doesn't poison the shared d= identity.

---

## Scenario: Diagnostician latency or 5xx spike

Symptom: `/v1/diagnose/...` returns 502; Gemini API rate-limit or outage.

### Diagnose

- Google AI Studio / Google Cloud status page.
- Service logs: `llm: rate_limit_exceeded` or context-canceled errors.

### Mitigate

- Drop operational concurrency to one active diagnostician worker or route
  diagnose traffic through a single service instance until the provider
  recovers.
- Serve last-known-good Diagnosis from cache where the fingerprint matches.
- Fail open: return Layer 1-4 raw signals to the UI with a "diagnosis temporarily unavailable" banner.

### Post-incident

- Verify cache hit rate didn't collapse. If it did, the fingerprint logic is too sensitive — review `fingerprint()` in `diagnostician.go`.

---

## Scenario: SPF / DKIM / DMARC regression for a customer

Symptom: A customer's `/v1/auth-checks` started returning `fail` after their last DNS change.

### Diagnose

- Compare current TXT record against a known-good snapshot.
- Walk the SPF include-tree manually; identify newly-added include exceeding the 10-lookup limit.
- For DMARC: confirm the change wasn't a deliberate `p=` tighten that broke alignment with a forwarder.

### Mitigate

- Surface the exact bad record + suggested fix via the Diagnostician (it should already do this — verify).
- Offer a one-click "revert to last-good" if we have history.

### Post-incident

- If multiple customers regressed at the same time, suspect their DNS provider rolled out a TXT-truncation behavior.

---

## Scenario: Diagnostician produced a hallucinated stat

Symptom: User reports "the report cited a number that isn't in our data."

### Diagnose

- Pull the request payload (Signals) and the cached Diagnosis.
- Diff numeric values in the diagnosis text against the input.

### Mitigate

- Bust the cache for that fingerprint.
- Add the case as a regression test under `internal/diagnostician/eval/cases/`.

### Post-incident

- If recurring, tighten the system prompt's "Never invent statistics" section with an explicit example of the violation.
- Trigger an eval run; gate Phase 2 prompt changes on accuracy not regressing.

---

## Communication template (SEV1)

Subject: `[SEV1] Deliverability — <one-line summary>`

Body:
- Detected at:
- Affected tenants:
- Symptom:
- Hypothesis:
- Mitigation in progress:
- Next update at:

Post to `#incidents` Slack channel; PagerDuty already paged the on-call.

---

## TODO

- Wire metric names into Grafana dashboard `pillar-2.json`.
- Document provider-fallback rotation once the LLM client supports multiple
  diagnostician providers.
