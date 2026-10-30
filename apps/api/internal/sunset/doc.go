// Package sunset implements per-tenant sunset policies for inactive
// subscribers — the "fire your CRM" feature.
//
// A sunset policy says: "subscribers who haven't engaged in N days
// should be {suppressed | tagged | sent a win-back campaign}." The
// engine runs on a cron tick (or via the on-demand endpoint), finds
// candidates by joining subscribers ← engagement events, and executes
// the action exactly once per (policy, subscriber) pair via the
// sunset_executions UNIQUE.
//
// Action semantics:
//
//   - "suppress" inserts into email_suppressions immediately with
//     source='sunset'. The dispatcher honors the suppression on the
//     next send; the customer can review + restore via the dashboard.
//
//   - "tag"      writes a sunset_candidate tag to subscriber_tags.
//     The customer's team reviews and decides what to do.
//     The detector itself does no email-side action; the
//     tag is just a label.
//
//   - "winback"  enqueues the candidate into winback_candidate_queue.
//     A separate worker (or the customer's automation
//     builder) consumes that queue and triggers a real
//     re-engagement campaign. reengagement.go has the
//     pure-function template generator that turns a
//     queued candidate list into a ready-to-send template.
//
// Why a separate package rather than extending subscribers/:
//
//   - subscribers/ is already large (timeline + engagement + bulk +
//     csv_export + merge). The sunset logic is its own bounded
//     domain (policy CRUD, candidate discovery, action execution,
//     reengagement generation).
//
//   - The reengagement template generator is reusable independently
//     of the policy engine — the MCP tool "sunset.preview_winback"
//     calls it directly without ever running a policy.
package sunset
