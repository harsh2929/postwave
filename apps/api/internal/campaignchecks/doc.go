// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignchecks implements the bounded, deterministic portion of
// Campaign Assurance. It checks one immutable campaign revision against one
// canonical compiler result without network access, browser execution, OCR
// execution, or model calls. It may consume a closed, evidence-bound OCR
// receipt produced by the separately isolated image broker; malformed or
// incomplete receipts cannot become a provided capability.
//
// Analyze is that deterministic surface and calls no model. F06 needs one half
// that does — whether a summariser represents a message consistently can only
// be answered by summarising it — so that half is AssessSummaryStability, a
// separate entry point taking an injected Summarizer. It is separate rather
// than folded in so that a caller merging both results can still tell which
// findings are reproducible from the input alone; an absent summariser degrades
// to an explicit not_assessed state and never to a pass.
//
// The package deliberately owns no persistence types. Finding mirrors the
// semantic fields in campaignassurance.FindingInput, while retaining typed
// evidence and remediation values that an orchestration layer can marshal at
// the persistence boundary.
package campaignchecks
