package corpus

import (
	"testing"
	"time"
)

// TestSyntheticCorpus_Sizes pins the corpus sizes within a reasonable
// band so accidental deletions are caught. The exact target is "around
// 200" per class; we allow a generous margin because corpus iteration
// during calibration grows the slices as we patch coverage gaps.
func TestSyntheticCorpus_Sizes(t *testing.T) {
	if n := len(SyntheticSpam); n < 180 || n > 350 {
		t.Errorf("SyntheticSpam size = %d, want roughly 200 (180-350)", n)
	}
	if n := len(SyntheticHam); n < 180 || n > 350 {
		t.Errorf("SyntheticHam size = %d, want roughly 200 (180-350)", n)
	}
}

// TestSyntheticCorpus_CategoryCoverage ensures we have at least
// some examples in every documented category. If a category is
// renamed or dropped, this test breaks loudly so the trainer's
// implicit assumptions stay aligned with the corpus.
func TestSyntheticCorpus_CategoryCoverage(t *testing.T) {
	spamRequired := []string{
		"pharma", "urgency", "prize", "money", "all-caps",
		"phishing", "shortener", "unicode-obfusc",
		"misspelled-runs", "excessive-punct",
	}
	spamTags := CountByTag(SyntheticSpam)
	for _, tag := range spamRequired {
		if spamTags[tag] < 5 {
			t.Errorf("SyntheticSpam category %q = %d, want >=5", tag, spamTags[tag])
		}
	}

	hamRequired := []string{
		"transactional", "calendar", "newsletter", "github",
		"reply", "long-form", "announcement", "support",
		"team-internal", "personal",
	}
	hamTags := CountByTag(SyntheticHam)
	for _, tag := range hamRequired {
		if hamTags[tag] < 5 {
			t.Errorf("SyntheticHam category %q = %d, want >=5", tag, hamTags[tag])
		}
	}
}

// TestSyntheticCorpus_NoEmptyEntries catches accidentally-empty rows
// (e.g. trailing comma + missing line in synthetic_data.go). Every
// row MUST have a subject. Body MAY be empty for the deliberate
// minimal-body ham examples (one-line replies, ack messages) — those
// exist so the trainer sees neutral-body cases and pulls the
// intercept appropriately negative.
func TestSyntheticCorpus_NoEmptyEntries(t *testing.T) {
	for i, s := range SyntheticSpam {
		if s.Subject == "" {
			t.Errorf("SyntheticSpam[%d] has empty subject", i)
		}
		if s.BodyHTML == "" {
			t.Errorf("SyntheticSpam[%d] has empty body (spam should always have a body)", i)
		}
	}
	for i, s := range SyntheticHam {
		if s.Subject == "" {
			t.Errorf("SyntheticHam[%d] has empty subject", i)
		}
	}
}

// TestSyntheticSamples_LabelDistribution sanity-checks the unified
// Sample-emission API: the slice is the concatenation of spam-class
// then ham-class, label flags align with the source slices.
func TestSyntheticSamples_LabelDistribution(t *testing.T) {
	samples := SyntheticSamples(time.Time{})
	if len(samples) != len(SyntheticSpam)+len(SyntheticHam) {
		t.Fatalf("SyntheticSamples len=%d, want %d",
			len(samples), len(SyntheticSpam)+len(SyntheticHam))
	}
	spamCount, hamCount := 0, 0
	for _, s := range samples {
		if s.Source != "synthetic" {
			t.Errorf("sample source=%q, want 'synthetic'", s.Source)
		}
		if s.IsSpam {
			spamCount++
		} else {
			hamCount++
		}
	}
	if spamCount != len(SyntheticSpam) {
		t.Errorf("spam labels = %d, want %d", spamCount, len(SyntheticSpam))
	}
	if hamCount != len(SyntheticHam) {
		t.Errorf("ham labels = %d, want %d", hamCount, len(SyntheticHam))
	}
}
