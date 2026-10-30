// Package corpus owns labeled email examples used to calibrate the
// content/spam scorer. Two flavours of corpus live here:
//
//  1. Synthetic: hand-curated SPAM / HAM examples shipped with the source
//     so contributors can re-train the scorer with no DB access. See
//     synthetic_data.go for the actual slices and SyntheticSamples()
//     below for the typed accessor.
//  2. Real: tuples extracted from email_events JOIN seedlist_outcomes via
//     the Exporter type (exporter.go). Used by the spam-corpus-export
//     CLI for ops + serious model fitting.
//
// Neither flavour requires new Go dependencies — the corpus itself is
// just plain Go literals and a thin DB query.
package corpus

import "time"

// SyntheticSample is one labeled example pre-rendered as subject+HTML
// body with category tags so the trainer can sanity-check coverage.
type SyntheticSample struct {
	// Subject is the raw email subject line.
	Subject string
	// BodyHTML is the email body. Light HTML is fine; the feature
	// extractor calls stripHTML for text-level features.
	BodyHTML string
	// Tags label the spam/ham category — "pharma", "urgency",
	// "transactional", etc. Used by tests to check category coverage,
	// not consumed by the trainer.
	Tags []string
}

// Sample is the unified shape that both real-DB extraction and
// synthetic data flow through into the trainer. The text field is
// the same "subject + \"\\n\\n\" + body" concatenation the trainer
// re-feeds to content.Extract.
type Sample struct {
	// Text is "subject\n\nbody". For real samples this is the raw
	// email; for synthetic samples it's the synthetic literals
	// re-flattened. Trainers split on the first "\n\n" to recover
	// subject + body separately.
	Text string
	// Subject is the original subject line. Only set when the source
	// preserved subject as a separate column.
	Subject string
	// BodyHTML is the original HTML body. Only set when the source
	// preserved body as a separate column.
	BodyHTML string
	// IsSpam is the binary label. Strict labels only — the gray zone
	// (40%-60% spam-folder placement) is filtered out at the source.
	IsSpam bool
	// Source identifies the data origin for provenance. One of:
	//   "seedlist"  — landed in N% spam folder of seedlist mailboxes
	//   "user-marked-spam" — explicit user "this is spam" complaint
	//   "synthetic" — from SyntheticSpam / SyntheticHam in this package
	//   "reply-unsubscribe" — recipient replied with unsubscribe intent
	Source string
	// SampleAt is when the sample was produced/collected.
	SampleAt time.Time
}

// SyntheticSamples returns the embedded synthetic corpus pre-flattened
// into Sample form so trainer code can iterate one slice without
// caring about category distinctions. Order is deterministic: all
// SyntheticSpam first, then SyntheticHam, preserving the source slice
// order. Callers that need shuffling MUST do so themselves with their
// own seeded RNG (the trainer in calibrate.go does exactly this).
func SyntheticSamples(at time.Time) []Sample {
	out := make([]Sample, 0, len(SyntheticSpam)+len(SyntheticHam))
	for _, s := range SyntheticSpam {
		out = append(out, Sample{
			Text:     s.Subject + "\n\n" + s.BodyHTML,
			Subject:  s.Subject,
			BodyHTML: s.BodyHTML,
			IsSpam:   true,
			Source:   "synthetic",
			SampleAt: at,
		})
	}
	for s := range SyntheticHam {
		ham := SyntheticHam[s]
		out = append(out, Sample{
			Text:     ham.Subject + "\n\n" + ham.BodyHTML,
			Subject:  ham.Subject,
			BodyHTML: ham.BodyHTML,
			IsSpam:   false,
			Source:   "synthetic",
			SampleAt: at,
		})
	}
	return out
}

// CountByTag returns a tag → count map across the synthetic corpus.
// Useful for asserting category coverage in tests.
func CountByTag(samples []SyntheticSample) map[string]int {
	m := map[string]int{}
	for _, s := range samples {
		for _, t := range s.Tags {
			m[t]++
		}
	}
	return m
}
