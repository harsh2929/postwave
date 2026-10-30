// Package eqscore is the pre-send "Email Quality" grader. It accepts a
// candidate message (subject, html, text, from, headers) and returns a
// 0-100 score plus a structured list of reasons the score isn't 100.
//
// EQ Score is composed of three sub-scores, each independently scored
// 0-100 and then weighted into the overall:
//
//   - Content (40%)    spammy phrases, image:text ratio, link count,
//     body length, subject hygiene, all-caps, ALL-EMOJI.
//     Catches the most common low-effort spam shapes
//     without needing any account history.
//   - Auth (35%)       SPF/DKIM/DMARC alignment ON THE SENDING DOMAIN
//     at evaluation time, plus a check that the From
//     address matches the verified domain. We don't
//     run a real DNS lookup here — production wires
//     this to the per-tenant verified-domains cache
//     so eqscore stays sync-fast (<2ms p99).
//   - Reputation (25%) bounce + complaint rate over the last 7 days
//     for this tenant, taken from the existing
//     campaign_recipients / email_events tables.
//     Optional: when the tenant has no send history
//     the reputation sub-score is dropped and the
//     remaining two are reweighted to 100%.
//
// Each sub-score returns a list of "reasons" — short, actionable
// strings ("Subject is all uppercase", "9 of 10 links use raw IPs").
// The reasons are what powers the dashboard's "fix this" surface; the
// score is what powers the gate ("block-on-send if below threshold
// on the tenant's policy").
//
// EQ Score is deliberately sync + pure on the input. The only IO is
// the reputation lookup, and that's behind an interface (Reputation)
// so unit tests can supply a fixture without hitting the DB. This
// makes eqscore safe to call from the dispatcher's send-prep path,
// from the dashboard preview, and from the agent's pre-flight tool.
package eqscore
