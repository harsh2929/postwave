# Diagnostician Eval Harness

This directory holds the labeled cases that drive the V1 acceptance gate for
the AI Diagnostician. Each `cases/NN_*.json` file is a single,
hand-constructed scenario that the Diagnostician must reason about
correctly. The harness (`eval.go`) loads every JSON file, runs each
through the Diagnostician's `Diagnose()` pipeline, and grades the output
against a declarative expectation block.

## Strategy

The PRD calls for 200 cases eventually; we ship **40** for V1. 40 is
small enough to label by hand with care, large enough to surface
regressions when the prompt or model changes, and large enough to give
each major scenario class at least 1-3 representatives.

The 40 cases are distributed across the failure modes the
Diagnostician will see in production:

| Bucket                                   | Cases | Files       |
|------------------------------------------|-------|-------------|
| Auth issues (SPF/DKIM/DMARC/keylen)      | 5 + 1 | 02, 04-08   |
| Reputation (BL hits, score drops, mix)   | 4     | 09-12       |
| Content (image-heavy, spam words, HTML)  | 6 + 1 | 03, 13-18   |
| Mixed / stacked failures                 | 3     | 19-21       |
| Provider-specific behaviour              | 3     | 22-24       |
| Recovery scenarios                       | 2     | 25-26       |
| Volume cohorts                           | 3     | 27-29       |
| Edge cases (empty / pixel / txn / BIMI)  | 4     | 30-33       |
| B2B-specific (O365 quarantine etc.)      | 2     | 34-35       |
| ProtonMail encryption headers            | 1     | 36          |
| Yahoo FBL                                | 1     | 37          |
| Post-blocklist sustained recovery        | 1     | 38          |
| Permission-pass cleanup                  | 1     | 39          |
| Calibration: predicted bad / placed good | 1     | 40          |
| Clean campaign (baseline)                | 1     | 01          |

## Schema

Cases support two expectation blocks. Use `expected` for new cases:

```json
{
  "name": "spf_overflow_with_recent_changes",
  "description": "Single sentence describing the scenario.",
  "signals": {
    "campaign_id": "...",
    "domain": "...", "ip": "...",
    "auth":       { "domain": "...", "spf": {...}, "dkim": {...}, "dmarc": {...}, "bimi": {...}, "ptr": {...} },
    "reputation": { "domain": "...", "ip": "...", "google_score": "...", "microsoft_score": "...", "sender_score": <0-100>, "blacklist_hits": [...] },
    "content":    { "spam_score": <0-1>, "image_text_ratio": <float>, "link_reputation": "...", "html_issues": [...] },
    "seedlist":   { "campaign_id": "...", "providers": [...], "overall_pct": {...} }
  },
  "expected": {
    "diagnosis_must_mention": ["substring1", "substring2"],
    "fix_actions_required":   ["dns_record"],
    "max_fixes": 4,
    "min_fixes": 1,
    "predicted_impact_present": true
  }
}
```

The legacy `expect` block (`headline_phrase`, `fix_actions`, `max_fixes`)
on cases 01-03 still works — the loader merges both shapes into one
`Expectation`.

## Running the harness

```bash
go test ./services/deliverability/internal/diagnostician/eval/...
```

or programmatically:

```go
results, _ := eval.Run(ctx, "internal/diagnostician/eval/cases", diag)
fmt.Println(eval.Report(results))
fmt.Printf("accuracy: %.2f\n", eval.Accuracy(results))
```

## Acceptance gate

V1 ships when ≥85% of cases pass with `claude-sonnet-4-6`. Failed cases
are surfaced individually so prompt iteration is targeted, not
guess-and-check. A failure in a single bucket (e.g. all Yahoo FBL cases
fail) is a stronger regression signal than the aggregate, so always
read `eval.Report()` before shipping prompt changes.

## Baseline mode (`--baseline` flag)

For tighter regression detection, the harness can compare each
Diagnostician output against a curated reference output stored in
`eval/baselines/<case>.json`. The reference file holds the full
`Diagnosis` JSON our prompt is expected to produce. The baseline grader
adds three checks on top of the loose `expected` block:

- **Action overlap.** Every `fix.action` listed in the baseline must
  appear at least once in the model's fix list.
- **Predicted-impact tolerance.** For every key the baseline provides in
  `predicted_impact`, the model's value must be within ±0.20.
- **Diagnosis term coverage.** The richer `must_mention` substrings come
  from the baseline file's diagnosis when richer terms aren't already
  declared.

Missing baseline files are a soft pass (the loose checks still apply),
which lets us roll baselines out incrementally.

```go
results, _ := eval.RunWithOptions(ctx, "internal/diagnostician/eval/cases", diag, eval.Options{
    BaselineDir: "internal/diagnostician/eval/baselines",
})
```

## Adding cases

1. Pick the next free number.
2. Write a realistic Signals block — image-text ratios, sender scores,
   placement counts must be plausible.
3. Specify only the substrings you genuinely expect; over-tight grading
   makes prompt iteration brittle.
4. Verify locally against the real Diagnostician at least once before
   committing.
