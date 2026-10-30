# Campaigns 2026 — Gap analysis & roadmap

A multi-agent workflow (`wmsf6qig0`) audited Moosewave's Campaigns tab,
researched five competitor / trend angles, and produced a prioritized
gap list with implementation specs. Outputs:

- [`gap-analysis.json`](./gap-analysis.json) — full structured output:
  22 gaps, the shortlist of 8 to ship, and an implementation spec per
  shortlist item (with file paths, API contracts, acceptance criteria).

## Executive summary

> Moosewave Campaigns has solid table-stakes plus differentiators
> competitors lack: collaborative cursors, per-campaign feedback
> threads, sandbox lifecycle, fingerprint-gated approvals,
> dynamic-content regions, voice-drift banner, Inbox Reality
> predictor, STO.
>
> Three strongest 2026 themes:
>
> 1. **Reply-as-channel** — Litmus Live 2026 frames replies as
>    the cleanest engagement signal. Moosewave can extend feedback
>    surfaces into inbound classification.
> 2. **Per-recipient send-time + bandit allocation** layered on
>    the existing SendTimeOptBanner.
> 3. **Bot-stripped Human metrics + per-campaign timeseries** —
>    today's report is point-in-time and Apple MPP makes raw opens
>    noise.
>
> Moosewave's voice profile, presend verdict, and audit log are
> unique assets to weaponize vs Klaviyo Composer and Brevo Aura.

## Shortlist (priority order, from the workflow)

| Rank | ID  | Title                                                       | Impact   | Effort | Status     |
| ---- | --- | ----------------------------------------------------------- | -------- | ------ | ---------- |
| 1    | G7  | Recipient-count + cost preview in send-confirm              | critical | S      | **shipped** (this commit) |
| 2    | G3  | Reply-loop tooling: inbound triage + feature-reply block    | high     | L      | speced     |
| 3    | G2  | Human-engagement metric (MPP/bot-stripped opens + clicks)   | high     | M      | speced     |
| 4    | G10 | Brand Voice profile + drift scoring on AI compose           | high     | M      | speced     |
| 5    | G17 | AI post-send summary with baseline comparison               | high     | M      | speced (depends on G3 + G10) |
| 6    | G5  | Per-recipient send-time within a window (PSTO)              | high     | L      | speced     |
| 7    | G16 | Frequency cap + recipient-local quiet hours engine          | high     | M      | speced     |
| 8    | G11 | Subject Lab with confidence-scored variants                 | high     | M      | speced (pairs with G4 bandit) |

## What shipped in this commit (G7)

**New surface**: `AudiencePreviewPanel` at the top of the send-confirm
modal. Before clicking Send, the operator now sees:

- exact recipient count (formatted with thousands separators)
- suppression delta ("− 312 excluded by suppression")
- deliverable count in bold ("= 12,168 will receive this email")
- today's warmup-cap headroom + post-send remaining
- a red over-cap callout that hard-disables Send when the audience
  exceeds today's cap

**Wire**:

```
GET /api/v1/campaigns/{id}/send-preview
  → scope: ScopeReadCampaigns
  → response: {
      campaign_id, audience_kind, segment_label?, recipients,
      suppressed_excluded, deliverable, tier_cap_today,
      tier_cap_remaining, tier_cap_remaining_after, over_cap,
      counted_at
    }
  → fields with value -1 mean "unavailable" (suppression timeout,
    no tenant cap)
```

**Files touched** (~480 lines):

- `apps/api/internal/campaigns/send_preview.go` *(new, 200 lines)*
- `apps/api/main.go` — mounted new route alongside `MountChecklist`
- `apps/desktop/src/lib/api-client.ts` — `getCampaignSendPreview` +
  `CampaignSendPreview` type
- `apps/desktop/src/components/AudiencePreviewPanel.tsx` *(new, 215 lines)*
- `apps/desktop/src/components/CampaignDetailSlideover.tsx` — wired
  panel into send-confirm modal + `sendBlockedByCap` state
- `apps/desktop/src/components/InboxRealityBanner.tsx` — added
  optional `continueDisabled` / `continueDisabledReason` props

**Verified**: `pnpm tsc --noEmit` clean, `go build ./...` clean,
`go test ./internal/campaigns/...` green.

## Remaining work

Every spec in `gap-analysis.json` is buildable from its `frontend_changes`
+ `backend_changes` + `db_changes` + `api_contract` arrays without
re-running the workflow. Each spec also lists `open_questions` that
need product input before shipping.

The 14 gaps that didn't make the shortlist are still in
`gap-analysis.json` under `all_gaps` — useful for backlog grooming
even though they weren't prioritized for this round.
