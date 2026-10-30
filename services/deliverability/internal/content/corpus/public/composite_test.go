package public

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

// TestBuildCompositeCorpus_EmptyCache covers the operator path where
// `spam-corpus-download` was never run — every loader returns nil and
// the composite degrades to "empty" without erroring.
func TestBuildCompositeCorpus_EmptyCache(t *testing.T) {
	dir := t.TempDir()
	samples, summary, err := BuildCompositeCorpus(context.Background(), CompositeOptions{
		CacheDir:    dir,
		IncludeTREC: true,
	})
	if err != nil {
		t.Fatalf("BuildCompositeCorpus on empty cache: %v", err)
	}
	if len(samples) != 0 {
		t.Errorf("empty cache should yield 0 samples, got %d", len(samples))
	}
	wantMissing := map[string]bool{"spamassassin": true, "enron": true, "trec07": true}
	if len(summary.Missing) != len(wantMissing) {
		t.Errorf("expected %d missing datasets, got %v", len(wantMissing), summary.Missing)
	}
	for _, name := range summary.Missing {
		if !wantMissing[name] {
			t.Errorf("unexpected missing dataset %q", name)
		}
	}
}

// TestBuildCompositeCorpus_LoadsSpamAssassinFixture seeds a tiny
// SpamAssassin-style cache (extracted/, no archive), confirms the
// loader walks it, and verifies the composite plumbs the rows.
func TestBuildCompositeCorpus_LoadsSpamAssassinFixture(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "spamassassin", "extracted")
	spamDir := filepath.Join(root, "spam")
	hamDir := filepath.Join(root, "easy_ham")
	mustMkdir(t, spamDir)
	mustMkdir(t, hamDir)
	mustWrite(t, filepath.Join(spamDir, "0001.txt"), spamFixture())
	mustWrite(t, filepath.Join(spamDir, "0002.txt"), spamFixture2())
	mustWrite(t, filepath.Join(hamDir, "0001.txt"), hamFixture())

	samples, summary, err := BuildCompositeCorpus(context.Background(), CompositeOptions{
		CacheDir:    dir,
		IncludeTREC: false,
	})
	if err != nil {
		t.Fatalf("BuildCompositeCorpus: %v", err)
	}
	if got, want := len(samples), 3; got != want {
		t.Fatalf("samples: got %d want %d", got, want)
	}

	var spam, ham int
	for _, s := range samples {
		if s.IsSpam {
			spam++
		} else {
			ham++
		}
		if s.Source == "" {
			t.Errorf("sample missing Source: %+v", s)
		}
		if !strings.HasPrefix(s.Source, "spamassassin/") {
			t.Errorf("sample Source should start with 'spamassassin/', got %q", s.Source)
		}
	}
	if spam != 2 || ham != 1 {
		t.Errorf("labels: spam=%d ham=%d want 2/1", spam, ham)
	}
	if summary.Counts["spamassassin"] != 3 {
		t.Errorf("spamassassin count: got %d want 3", summary.Counts["spamassassin"])
	}
	// Enron is missing — should be in summary.Missing.
	foundEnron := false
	for _, m := range summary.Missing {
		if m == "enron" {
			foundEnron = true
		}
	}
	if !foundEnron {
		t.Errorf("expected enron in Missing, got %v", summary.Missing)
	}
}

// TestBuildCompositeCorpus_LoadsEnronFixture seeds an Enron-style
// cache (one user, one spam, one ham) and confirms parseEnronMessage
// recovers Subject+body.
func TestBuildCompositeCorpus_LoadsEnronFixture(t *testing.T) {
	dir := t.TempDir()
	user := filepath.Join(dir, "enron", "extracted", "enron1")
	spamDir := filepath.Join(user, "spam")
	hamDir := filepath.Join(user, "ham")
	mustMkdir(t, spamDir)
	mustMkdir(t, hamDir)
	mustWrite(t, filepath.Join(spamDir, "0001.txt"), []byte("Subject: viagra now cheap\n\nBuy from us today!"))
	mustWrite(t, filepath.Join(hamDir, "0001.txt"), []byte("Subject: lunch tomorrow\n\nWant to grab a sandwich at noon?"))

	samples, _, err := BuildCompositeCorpus(context.Background(), CompositeOptions{
		CacheDir:    dir,
		IncludeTREC: false,
	})
	if err != nil {
		t.Fatalf("BuildCompositeCorpus: %v", err)
	}
	if len(samples) != 2 {
		t.Fatalf("expected 2 samples, got %d", len(samples))
	}
	for _, s := range samples {
		if s.Subject == "" {
			t.Errorf("Enron sample missing Subject: %+v", s)
		}
		if !strings.HasPrefix(s.Source, "enron/") {
			t.Errorf("Enron sample Source: got %q", s.Source)
		}
	}
}

// TestBuildCompositeCorpus_DeterministicDownsample verifies that two
// runs with the same seed produce the same sample set. We seed enough
// fake samples to exercise the reservoir.
func TestBuildCompositeCorpus_DeterministicDownsample(t *testing.T) {
	dir := t.TempDir()
	spamDir := filepath.Join(dir, "spamassassin", "extracted", "spam")
	mustMkdir(t, spamDir)
	for i := 0; i < 50; i++ {
		body := []byte("Subject: msg " + itoa(i) + "\n\nBody text " + itoa(i))
		mustWrite(t, filepath.Join(spamDir, itoa(i)+".txt"), body)
	}

	run := func(seed int64) []string {
		samples, _, err := BuildCompositeCorpus(context.Background(), CompositeOptions{
			CacheDir:   dir,
			MaxSamples: 10,
			Seed:       seed,
		})
		if err != nil {
			t.Fatalf("BuildCompositeCorpus: %v", err)
		}
		subs := make([]string, len(samples))
		for i, s := range samples {
			subs[i] = s.Subject
		}
		return subs
	}

	a := run(7)
	b := run(7)
	if !equalStrings(a, b) {
		t.Errorf("seed 7 runs disagree:\n a=%v\n b=%v", a, b)
	}
	c := run(11)
	if equalStrings(a, c) {
		t.Errorf("seed 7 and seed 11 should produce different samples, both = %v", a)
	}
	if len(a) != 10 {
		t.Errorf("downsample to 10 expected, got %d", len(a))
	}
}

// TestParseRFC822_HeaderUnfolding ensures continuation-line subjects
// are reassembled correctly. SpamAssassin samples occasionally use
// soft line wraps for long subjects (RFC 822 §3.1.1).
func TestParseRFC822_HeaderUnfolding(t *testing.T) {
	raw := []byte("From: x@y.com\r\nSubject: hello\r\n  world\r\n\r\nthe body")
	subj, body := parseRFC822(raw)
	if subj != "hello world" {
		t.Errorf("subject unfolding: got %q want %q", subj, "hello world")
	}
	if strings.TrimSpace(body) != "the body" {
		t.Errorf("body: got %q want %q", body, "the body")
	}
}

// TestParseEnronMessage_NoSubjectPrefix covers Enron files whose
// first line is the subject without a "Subject:" prefix — the AUEB
// preprocessor sometimes strips the label.
func TestParseEnronMessage_NoSubjectPrefix(t *testing.T) {
	subj, body := parseEnronMessage([]byte("re : lunch tomorrow ?\n\nyes let's go to the deli"))
	if subj != "re : lunch tomorrow ?" {
		t.Errorf("subject: got %q", subj)
	}
	if strings.TrimSpace(body) != "yes let's go to the deli" {
		t.Errorf("body: got %q", body)
	}
}

// TestDatasetOf classifies Source strings into top-level dataset names.
func TestDatasetOf(t *testing.T) {
	cases := map[string]string{
		"spamassassin/spam_2": "spamassassin",
		"enron/enron3/ham":    "enron",
		"trec07/spam":         "trec07",
		"synthetic":           "synthetic",
		"":                    "",
	}
	for src, want := range cases {
		if got := datasetOf(src); got != want {
			t.Errorf("datasetOf(%q) = %q want %q", src, got, want)
		}
	}
}

// TestSampleTypeIsCorpusSample is a small static-checks test: the
// public package promises rows are corpus.Sample so consumers can
// pass them straight into the calibrate trainer without conversion.
func TestSampleTypeIsCorpusSample(t *testing.T) {
	dir := t.TempDir()
	spamDir := filepath.Join(dir, "spamassassin", "extracted", "spam")
	mustMkdir(t, spamDir)
	mustWrite(t, filepath.Join(spamDir, "0001.txt"), spamFixture())
	samples, _, err := BuildCompositeCorpus(context.Background(), CompositeOptions{CacheDir: dir})
	if err != nil {
		t.Fatalf("BuildCompositeCorpus: %v", err)
	}
	var _ []corpus.Sample = samples
}

// ---- fixtures ----

func spamFixture() []byte {
	return []byte("From: spammer@example.com\r\n" +
		"Subject: GET RICH QUICK!!! Act now\r\n" +
		"To: victim@example.org\r\n" +
		"\r\n" +
		"<html><body>CLICK HERE NOW to claim your $1,000,000 prize!! " +
		"Limited time offer expires today!</body></html>")
}

func spamFixture2() []byte {
	return []byte("Subject: Cheap V1agra Online Pharmacy\r\n" +
		"\r\n" +
		"Discount pharmacy meds shipped fast, no prescription needed.")
}

func hamFixture() []byte {
	return []byte("From: alice@example.com\r\n" +
		"Subject: Re: project sync notes\r\n" +
		"To: bob@example.com\r\n" +
		"\r\n" +
		"Thanks for the sync today. I'll send the deck Friday. " +
		"Let me know if anything is unclear.")
}

// ---- helpers (avoiding strconv import drift between test files) ----

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", p, err)
	}
}

func mustWrite(t *testing.T, p string, content []byte) {
	t.Helper()
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// itoa is a strconv-free integer-to-string for fixture IDs. Avoids
// adding strconv import just for test scaffolding.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
