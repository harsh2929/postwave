package profile

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
)

// TestExtractThemes_MarketingCopy asserts that themes from typical
// growth-marketing prose surface words like "growth", "scale", or
// "convert" — not generic filler.
func TestExtractThemes_MarketingCopy(t *testing.T) {
	corpus := []string{
		"Our growth strategy focused on aggressive scale across paid channels. We tripled conversion rates by tightening the funnel and reinvesting in performance marketing.",
		"Convert more leads with a tighter funnel. Growth is about leverage — finding the channels that scale and doubling down. The conversion math compounds.",
		"Last quarter we drove 40% growth. The team scaled across three channels and the conversion lift held steady. Growth-stage discipline beats vanity metrics every time.",
	}
	themes := ExtractThemes(corpus, 10)
	if len(themes) == 0 {
		t.Fatal("no themes")
	}
	wantAny := []string{"growth", "scale", "convert", "conversion", "channels", "funnel", "leverage"}
	if !themesContainAny(themes, wantAny) {
		t.Errorf("expected at least one of %v in themes; got %s",
			wantAny, themesString(themes))
	}
	// Boilerplate must not appear.
	for _, th := range themes {
		if boilerplateBlocklist[th.Term] {
			t.Errorf("boilerplate %q surfaced as theme: %+v", th.Term, th)
		}
	}
}

// TestExtractThemes_TechnicalWriting asserts that technical prose
// surfaces terms like "architecture", "latency", or "throughput".
func TestExtractThemes_TechnicalWriting(t *testing.T) {
	corpus := []string{
		"The architecture splits ingestion from query, with a queue between them to absorb spikes. Latency stays under 50ms at p99.",
		"Latency budgets matter. We profile every request, instrument the hot path, and cap tail latency with a circuit breaker.",
		"The new architecture pushes throughput by 4x while keeping latency flat. The trade-off is a more complex deployment topology.",
	}
	themes := ExtractThemes(corpus, 10)
	if len(themes) == 0 {
		t.Fatal("no themes")
	}
	wantAny := []string{"architecture", "latency", "throughput", "ingestion", "circuit"}
	if !themesContainAny(themes, wantAny) {
		t.Errorf("expected at least one of %v in themes; got %s",
			wantAny, themesString(themes))
	}
}

// TestExtractThemes_PersonalStorytelling asserts that personal anecdotes
// surface noun-y content (mother, garden, summer, ...) over filler.
func TestExtractThemes_PersonalStorytelling(t *testing.T) {
	corpus := []string{
		"My grandmother taught me how to bake bread on Sunday mornings. The kitchen smelled of yeast and butter. I still remember her hands shaping the dough.",
		"Grandmother kept a garden out back, full of tomatoes and herbs. I'd sneak basil leaves on the way home from school. The garden was her sanctuary.",
		"Every summer we'd visit grandmother. She'd hand me a basket and we'd walk to the garden, picking herbs for dinner. Bread was always cooling on the counter.",
	}
	themes := ExtractThemes(corpus, 10)
	wantAny := []string{"grandmother", "garden", "bread", "herbs", "basil"}
	if !themesContainAny(themes, wantAny) {
		t.Errorf("expected at least one of %v in themes; got %s",
			wantAny, themesString(themes))
	}
}

// TestExtractThemes_ProductReview asserts that product-review prose
// surfaces product-y terms.
func TestExtractThemes_ProductReview(t *testing.T) {
	corpus := []string{
		"The headphones have impressive bass response, though the soundstage feels narrow on orchestral tracks. Battery life clocks in at 28 hours.",
		"At this price, the soundstage is the weakest point. Battery life is excellent, bass is punchy, the build quality feels premium.",
		"Bass-heavy listeners will love these headphones. The battery lasts a full day of mixed listening, and the build holds up to commute abuse.",
	}
	themes := ExtractThemes(corpus, 10)
	wantAny := []string{"bass", "battery", "soundstage", "headphones", "listening", "build"}
	if !themesContainAny(themes, wantAny) {
		t.Errorf("expected at least one of %v in themes; got %s",
			wantAny, themesString(themes))
	}
}

// TestExtractThemes_BoilerplateGetsBlocked asserts that a corpus full of
// thanks/regards/please does not surface those as themes.
func TestExtractThemes_BoilerplateGetsBlocked(t *testing.T) {
	corpus := []string{
		"Thanks for the email. Please review the attached. Regards.",
		"Thanks again. Please confirm receipt. Best regards.",
		"Hi team — thanks for the update. Please advise. Regards.",
	}
	themes := ExtractThemes(corpus, 10)
	for _, th := range themes {
		if boilerplateBlocklist[th.Term] {
			t.Errorf("boilerplate %q must not surface: %+v", th.Term, th)
		}
	}
}

func TestExtractThemes_Empty(t *testing.T) {
	if got := ExtractThemes(nil, 10); got != nil {
		t.Errorf("nil corpus: got %v, want nil", got)
	}
	if got := ExtractThemes([]string{"the the the"}, 10); len(got) != 0 {
		t.Errorf("stopwords-only corpus should yield no themes, got %v", got)
	}
}

func TestExtractThemes_RespectsK(t *testing.T) {
	corpus := []string{
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
	}
	themes := ExtractThemes(corpus, 5)
	if len(themes) > 5 {
		t.Errorf("k=5 but got %d themes", len(themes))
	}
}

func TestExtractThemes_FiltersDigitsAndShortWords(t *testing.T) {
	corpus := []string{"a aa aaa 2024 v1 release release release verylongword"}
	themes := ExtractThemes(corpus, 10)
	for _, th := range themes {
		if len(th.Term) < 3 {
			t.Errorf("term too short: %q", th.Term)
		}
		if hasDigit(th.Term) {
			t.Errorf("term contains digit: %q", th.Term)
		}
	}
}

func themesContainAny(themes []Theme, words []string) bool {
	for _, th := range themes {
		for _, w := range words {
			if th.Term == w {
				return true
			}
		}
	}
	return false
}

// TestExtractThemesEmbedding_ClustersAndLabels asserts that with a wired
// (mock) embedding client, the embedding-clustering theme extractor
// produces at most k themes, each carrying a non-empty label, a non-zero
// cluster centroid, and a positive frequency.
func TestExtractThemesEmbedding_ClustersAndLabels(t *testing.T) {
	// Build a 50-sample corpus from four topical buckets. The mock
	// embedding client hashes words into vector bins, so samples in the
	// same bucket land near each other and clustering should recover
	// each bucket as its own cluster.
	marketing := []string{
		"Growth marketing scales conversion funnels across acquisition channels.",
		"Conversion rates compound when growth and channels align tightly.",
		"Scale the funnel: growth, conversion, channels, growth.",
		"Acquisition channels drive growth when conversion math compounds.",
	}
	technical := []string{
		"Architecture latency throughput ingestion architecture latency.",
		"Latency budgets cap throughput; architecture matters most.",
		"Throughput climbs when architecture splits ingestion from query.",
		"Latency dominates user perception; architecture compounds.",
	}
	personal := []string{
		"Grandmother garden bread herbs basil kitchen Sunday.",
		"Garden bread kitchen Sunday grandmother basil herbs.",
		"Kitchen Sunday grandmother bread basil garden herbs.",
		"Bread herbs garden kitchen grandmother Sunday basil.",
	}
	product := []string{
		"Headphones bass soundstage battery headphones bass battery.",
		"Battery soundstage headphones bass build battery soundstage.",
		"Bass battery headphones build soundstage headphones bass.",
		"Soundstage bass battery headphones bass headphones battery.",
	}
	corpus := make([]string, 0, 50)
	// 4 buckets * ~13 samples each = 52, trim to 50.
	for _, bucket := range [][]string{marketing, technical, personal, product} {
		for i := 0; i < 13; i++ {
			corpus = append(corpus, bucket[i%len(bucket)])
		}
	}
	corpus = corpus[:50]

	mock := &embeddings.MockEmbeddingClient{Dim: 128}
	got := ExtractThemesEmbedding(context.Background(), mock, corpus, ThemeClusterK)

	if len(got) == 0 {
		t.Fatal("no clusters produced")
	}
	if len(got) > ThemeClusterK {
		t.Errorf("more clusters than k=%d: %d", ThemeClusterK, len(got))
	}
	for i, th := range got {
		if th.Term == "" {
			t.Errorf("theme[%d] has empty Term: %+v", i, th)
		}
		if th.Frequency <= 0 {
			t.Errorf("theme[%d] has non-positive Frequency: %+v", i, th)
		}
		if len(th.EmbeddingCentroid) == 0 {
			t.Errorf("theme[%d] missing EmbeddingCentroid: %+v", i, th)
		}
	}
	// At least one batch embed call must have happened.
	if len(mock.Calls) == 0 {
		t.Error("expected EmbedBatch to be called")
	}
}

// TestExtractThemesEmbedding_NilClientFallsBack ensures that with no
// embedding client wired, the extractor degrades to TF-IDF.
func TestExtractThemesEmbedding_NilClientFallsBack(t *testing.T) {
	corpus := []string{
		"architecture latency throughput",
		"latency architecture matters",
		"throughput architecture latency",
	}
	got := ExtractThemesEmbedding(context.Background(), nil, corpus, 5)
	if len(got) == 0 {
		t.Fatal("expected TF-IDF fallback to produce themes")
	}
}

// TestExtractThemesEmbedding_TooFewSamplesFallsBack ensures that when
// the corpus has fewer items than k, the extractor falls back to
// TF-IDF instead of clustering 3 samples into 8 clusters.
func TestExtractThemesEmbedding_TooFewSamplesFallsBack(t *testing.T) {
	mock := &embeddings.MockEmbeddingClient{Dim: 64}
	corpus := []string{
		"architecture matters when latency budgets matter",
		"latency under 50ms requires careful architecture",
		"architecture and latency are the two axes",
	}
	got := ExtractThemesEmbedding(context.Background(), mock, corpus, ThemeClusterK)
	if len(got) == 0 {
		t.Fatal("expected fallback themes")
	}
	// In the fallback path no embedding call should happen.
	if len(mock.Calls) != 0 {
		t.Errorf("expected zero embed calls in fallback path, got %d", len(mock.Calls))
	}
}

func themesString(themes []Theme) string {
	var b strings.Builder
	for _, th := range themes {
		b.WriteString(th.Term)
		b.WriteString(" ")
	}
	return b.String()
}
