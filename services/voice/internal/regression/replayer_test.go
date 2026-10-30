package regression

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/profile"
)

// fakeGenerator returns a canned output per (surface,brief) or an error.
type fakeGenerator struct {
	out map[string]string
	err error
}

func (f *fakeGenerator) Generate(_ context.Context, surfaceKind, brief string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	if f.out == nil {
		return brief, nil // echo the brief back by default
	}
	return f.out[surfaceKind+"|"+brief], nil
}

// scoreEvaluator returns a fixed score keyed by the generated text, so
// aggregation tests are deterministic without depending on the heuristic.
type scoreEvaluator struct {
	byText map[string]float64
	err    error
}

type receiptEvaluator struct {
	score     float64
	breakdown fidelity.FidelityBreakdown
}

func (e receiptEvaluator) Score(_ context.Context, _ string, _ profile.VoiceProfile) (float64, fidelity.FidelityBreakdown, error) {
	return e.score, e.breakdown, nil
}

func (s *scoreEvaluator) Score(_ context.Context, generated string, _ profile.VoiceProfile) (float64, fidelity.FidelityBreakdown, error) {
	if s.err != nil {
		return 0, fidelity.FidelityBreakdown{}, s.err
	}
	sc := s.byText[generated]
	return sc, fidelity.FidelityBreakdown{Combined: sc}, nil
}

func ctx() context.Context { return context.Background() }

func scoreValue(t *testing.T, score *float64) float64 {
	t.Helper()
	if score == nil {
		t.Fatal("expected a scored result")
	}
	return *score
}

func TestSeverityFromScore_Boundaries(t *testing.T) {
	cases := []struct {
		score float64
		want  string
	}{
		{60, "ok"}, // exactly warn => ok
		{61, "ok"},
		{59.999, "warn"},
		{40, "warn"}, // exactly crit => warn
		{39.999, "critical"},
		{0, "critical"},
		{100, "ok"},
	}
	for _, c := range cases {
		if got := severityFromScore(c.score, DefaultWarnThreshold, DefaultCriticalThreshold); got != c.want {
			t.Errorf("severityFromScore(%v) = %q, want %q", c.score, got, c.want)
		}
	}
}

func TestSeverityFromScore_HonorsPermissiveWarnThresholdBeforeAdvisoryBand(t *testing.T) {
	if got := severityFromScore(0, 0, DefaultCriticalThreshold); got != "ok" {
		t.Fatalf("zero score at zero warning threshold = %q, want ok", got)
	}
	if got := severityFromScore(35, 30, DefaultCriticalThreshold); got != "ok" {
		t.Fatalf("score above permissive warning threshold = %q, want ok", got)
	}
	if got := severityFromScore(29, 30, DefaultCriticalThreshold); got != "critical" {
		t.Fatalf("score below both thresholds = %q, want critical", got)
	}
}

func TestReplayExample_GeneratorError(t *testing.T) {
	r := NewReplayer(&fakeGenerator{err: errors.New("llm down")}, &scoreEvaluator{})
	res := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{ID: "g1", SurfaceKind: "campaign_draft", Brief: "b"})
	if res.Severity != "error" {
		t.Fatalf("severity = %q, want error", res.Severity)
	}
	if res.ErrorCode != "generation_unavailable" {
		t.Errorf("error code = %q, want generation_unavailable", res.ErrorCode)
	}
	if res.FidelityScore != nil {
		t.Errorf("score = %v, want absent (no fabricated score on error)", res.FidelityScore)
	}
}

func TestReplayExample_EvaluatorError(t *testing.T) {
	r := NewReplayer(&fakeGenerator{}, &scoreEvaluator{err: errors.New("embed down")})
	res := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{ID: "g1", SurfaceKind: "subject_line", Brief: "hi"})
	if res.Severity != "error" {
		t.Fatalf("severity = %q, want error", res.Severity)
	}
	if res.ErrorCode != "scoring_unavailable" || res.FidelityScore != nil {
		t.Fatalf("unexpected evaluator failure receipt: %+v", res)
	}
}

func TestReplayExample_RejectsInvalidEvaluatorReceipt(t *testing.T) {
	tests := []struct {
		name      string
		score     float64
		breakdown fidelity.FidelityBreakdown
	}{
		{name: "score nan", score: math.NaN(), breakdown: fidelity.FidelityBreakdown{}},
		{name: "score infinite", score: math.Inf(1), breakdown: fidelity.FidelityBreakdown{}},
		{name: "score out of range", score: 101, breakdown: fidelity.FidelityBreakdown{Combined: 101}},
		{name: "component nan", score: 80, breakdown: fidelity.FidelityBreakdown{EmbeddingSimilarity: math.NaN(), Combined: 80}},
		{name: "component infinite", score: 80, breakdown: fidelity.FidelityBreakdown{StylisticDistance: math.Inf(1), Combined: 80}},
		{name: "component out of range", score: 80, breakdown: fidelity.FidelityBreakdown{VocabularyOverlap: 1.01, Combined: 80}},
		{name: "combined mismatch", score: 80, breakdown: fidelity.FidelityBreakdown{Combined: 79}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := NewReplayer(&fakeGenerator{}, receiptEvaluator{score: test.score, breakdown: test.breakdown})
			result := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{
				ID: "g1", SurfaceKind: "campaign_draft", Brief: "bounded brief",
			})
			if result.Severity != "error" || result.ErrorCode != "scoring_invalid" ||
				result.FidelityScore != nil || result.Breakdown != nil {
				t.Fatalf("invalid evaluator receipt was accepted: %+v", result)
			}
		})
	}
}

func TestReplayExample_ScoresAndClassifies(t *testing.T) {
	gen := &fakeGenerator{out: map[string]string{"campaign_draft|b": "great copy"}}
	eval := &scoreEvaluator{byText: map[string]float64{"great copy": 82}}
	r := NewReplayer(gen, eval)
	res := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{ID: "g1", SurfaceKind: "campaign_draft", Brief: "b"})
	if res.Severity != "ok" {
		t.Errorf("severity = %q, want ok", res.Severity)
	}
	if scoreValue(t, res.FidelityScore) != 82 {
		t.Errorf("score = %v, want 82", res.FidelityScore)
	}
	if res.ReplayedOutput != "great copy" {
		t.Errorf("replayed output = %q", res.ReplayedOutput)
	}
}

func TestReplayExample_BelowThresholds(t *testing.T) {
	gen := &fakeGenerator{out: map[string]string{"x|warn": "w", "x|crit": "c"}}
	eval := &scoreEvaluator{byText: map[string]float64{"w": 55, "c": 30}}
	r := NewReplayer(gen, eval)
	if got := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{SurfaceKind: "x", Brief: "warn"}).Severity; got != "warn" {
		t.Errorf("severity = %q, want warn", got)
	}
	if got := r.ReplayExample(ctx(), profile.VoiceProfile{}, GoldenExample{SurfaceKind: "x", Brief: "crit"}).Severity; got != "critical" {
		t.Errorf("severity = %q, want critical", got)
	}
}

func TestReplayBatch_Aggregates(t *testing.T) {
	gen := &fakeGenerator{out: map[string]string{
		"campaign_draft|a": "A",
		"campaign_draft|b": "B",
		"subject_line|c":   "C",
	}}
	eval := &scoreEvaluator{byText: map[string]float64{"A": 80, "B": 55, "C": 90}}
	r := NewReplayer(gen, eval)
	examples := []GoldenExample{
		{ID: "1", SurfaceKind: "campaign_draft", Brief: "a"},
		{ID: "2", SurfaceKind: "campaign_draft", Brief: "b"},
		{ID: "3", SurfaceKind: "subject_line", Brief: "c"},
	}
	out := r.ReplayBatch(ctx(), profile.VoiceProfile{}, examples)
	if out.Total != 3 {
		t.Errorf("total = %d, want 3", out.Total)
	}
	if out.Passed != 2 { // 80 and 90 >= 60; 55 < 60
		t.Errorf("passed = %d, want 2", out.Passed)
	}
	if out.Scored != 3 {
		t.Errorf("scored = %d, want 3", out.Scored)
	}
	if got := scoreValue(t, out.MeanScore); got < 74.9 || got > 75.1 { // (80+55+90)/3 = 75
		t.Errorf("mean = %v, want ~75", got)
	}
	if scoreValue(t, out.P25Score) != 55 { // sorted [55,80,90], nearest-rank p25 => index 0 => 55
		t.Errorf("p25 = %v, want 55", out.P25Score)
	}
	cd := out.BySurface["campaign_draft"]
	if cd.Total != 2 || cd.Scored != 2 || cd.Passed != 1 {
		t.Errorf("campaign_draft agg = %+v, want total 2 passed 1", cd)
	}
	if got := scoreValue(t, cd.MeanScore); got < 67.4 || got > 67.6 { // (80+55)/2 = 67.5
		t.Errorf("campaign_draft mean = %v, want ~67.5", got)
	}
	sl := out.BySurface["subject_line"]
	if sl.Total != 1 || sl.Passed != 1 {
		t.Errorf("subject_line agg = %+v, want total 1 passed 1", sl)
	}
}

func TestReplayBatch_PartialFailureStillCompletes(t *testing.T) {
	// Generator errors on every call, but the batch must still complete and
	// record per-example error results without panicking.
	r := NewReplayer(&fakeGenerator{err: errors.New("boom")}, &scoreEvaluator{})
	examples := []GoldenExample{
		{ID: "1", SurfaceKind: "campaign_draft", Brief: "a"},
		{ID: "2", SurfaceKind: "subject_line", Brief: "b"},
	}
	out := r.ReplayBatch(ctx(), profile.VoiceProfile{}, examples)
	if out.Total != 2 {
		t.Errorf("total = %d, want 2", out.Total)
	}
	if out.Passed != 0 {
		t.Errorf("passed = %d, want 0", out.Passed)
	}
	if out.Scored != 0 || out.MeanScore != nil || out.P25Score != nil {
		t.Errorf("all-error aggregate fabricated evidence: %+v", out)
	}
	for _, rr := range out.Results {
		if rr.Severity != "error" {
			t.Errorf("result %s severity = %q, want error", rr.ExampleID, rr.Severity)
		}
	}
}

func TestReplayBatch_Empty(t *testing.T) {
	r := NewReplayer(&fakeGenerator{}, &scoreEvaluator{})
	out := r.ReplayBatch(ctx(), profile.VoiceProfile{}, nil)
	if out.Total != 0 || out.Scored != 0 || out.MeanScore != nil || out.P25Score != nil {
		t.Errorf("empty batch = %+v, want no scored evidence", out)
	}
	if out.BySurface == nil {
		t.Error("BySurface should be non-nil even when empty")
	}
}

func TestStripHTMLExtractsOnlyNormalizedVisibleText(t *testing.T) {
	input := `<!doctype html><html><head><title>secret title</title><style>.x{display:none}</style></head>` +
		`<body><p>Hello&nbsp;<strong>world</strong> &amp; team.</p>` +
		`<script>steal("token")</script><ul><li>First</li><li>Second</li></ul></body></html>`
	got := stripHTML(input)
	if got != "Hello world & team.\nFirst\nSecond" {
		t.Fatalf("visible text = %q", got)
	}
	if got := stripHTML("Use 2 < 3 and 4 > 1."); got != "Use 2 < 3 and 4 > 1." {
		t.Fatalf("plain comparison text changed: %q", got)
	}
	plain := "Opening line.\n\n- First point\n- Second point"
	if got := stripHTML(plain); got != plain {
		t.Fatalf("plain paragraph structure changed: %q", got)
	}
}

// Integration-flavoured test: exercise the REAL embedding evaluator (with
// the deterministic MockEmbeddingClient) to prove that output resembling
// the profile's representative samples scores strictly higher than
// unrelated output. Relative assertion — robust to heuristic tuning.
func TestReplayExample_RealEvaluator_SimilarBeatsUnrelated(t *testing.T) {
	sample := "We shipped a small new feature today. It is fast and it is simple."
	prof := profile.VoiceProfile{
		RepresentativeSamples: []profile.Sample{{Text: sample}},
	}
	eval := fidelity.NewEmbeddingEvaluator(&fidelity.MockEmbeddingClient{})

	similar := NewReplayer(&fakeGenerator{out: map[string]string{"campaign_draft|s": sample}}, eval)
	unrelated := NewReplayer(&fakeGenerator{out: map[string]string{"campaign_draft|u": "Quarterly synergy leverage paradigm enterprise blockchain rollout."}}, eval)

	sim := similar.ReplayExample(ctx(), prof, GoldenExample{SurfaceKind: "campaign_draft", Brief: "s"})
	unrel := unrelated.ReplayExample(ctx(), prof, GoldenExample{SurfaceKind: "campaign_draft", Brief: "u"})

	if sim.Severity == "error" || unrel.Severity == "error" {
		t.Fatalf("unexpected error: sim=%q unrel=%q", sim.ErrorCode, unrel.ErrorCode)
	}
	if scoreValue(t, sim.FidelityScore) <= scoreValue(t, unrel.FidelityScore) {
		t.Errorf("similar score %v should exceed unrelated score %v", sim.FidelityScore, unrel.FidelityScore)
	}
}
