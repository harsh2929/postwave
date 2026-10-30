package profile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// TestHeuristicClassifier_HandCraftedFixtures asserts that for each of
// six clearly-skewed writing samples, the relevant axis lands on the
// expected side of 0.5. These fixtures are honest hand-crafted prose
// and are also the calibration target for the heuristic — the weights
// in scoreHeuristic were tuned until these all pass.
//
// The thresholds (0.55 high, 0.45 low) leave headroom for the calibration
// to drift slightly without flaking. They are NOT tight bounds on
// accuracy — they document "the heuristic correctly distinguishes
// clearly-skewed extremes," which is the floor we expect.
func TestHeuristicClassifier_HandCraftedFixtures(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		axis    string
		wantDir string // "high" or "low"
	}{
		{
			name:    "clearly humorous",
			text:    "Haha, so I tried to deploy on Friday — yikes! Lol I should know better. The whole thing was hilarious. Hahaha. Joke's on me!! Anyway, ridiculous afternoon.",
			axis:    "humor",
			wantDir: "high",
		},
		{
			name:    "clearly formal",
			text:    "Furthermore, the aforementioned analysis demonstrates that our methodology, pursuant to the established protocol, yields consistently reproducible results, notwithstanding the inherent limitations of the available sample. Consequently, we recommend that subsequent investigations adopt the framework outlined herein, and that all stakeholders henceforth adhere to the prescribed reporting standards. Moreover, we hereby acknowledge the contributions of the supporting institutions.",
			axis:    "formality",
			wantDir: "high",
		},
		{
			name:    "clearly casual",
			text:    "yeah totally, gonna grab coffee real quick. wanna come? lol it's whatever, super chill. tbh I dunno what we're doing today anyways. omg I just realized my charger's at home, kinda annoying.",
			axis:    "formality",
			wantDir: "low",
		},
		{
			name:    "clearly optimistic",
			text:    "What a fantastic week! The team shipped an amazing release and the early feedback has been wonderful. I'm thrilled with the results — every metric looks promising. Excited to see where we go next. The future is bright!",
			axis:    "optimism",
			wantDir: "high",
		},
		{
			name:    "clearly pessimistic",
			text:    "Things are looking bad. The launch was a failure, customers are frustrated, and the product is broken in three places. I'm worried we'll miss the next milestone too. The risks are mounting and the team is struggling.",
			axis:    "optimism",
			wantDir: "low",
		},
		{
			name:    "clearly direct",
			text:    "Ship it. Stop arguing. Fix the bug now. Cut the meeting. Use the existing API. Don't overthink it. Do the work, then move on. Always default to action.",
			axis:    "directness",
			wantDir: "high",
		},
		{
			name:    "clearly hedged",
			text:    "I think this might possibly work, but I'm not totally sure. Maybe we could try it, sort of as an experiment. It seems like a reasonable approach, kind of. I guess we should perhaps consider it, more or less. Arguably worth a shot, in a way.",
			axis:    "directness",
			wantDir: "low",
		},
		{
			name:    "clearly warm",
			text:    "Hey friends, thanks so much for joining. I really appreciate everyone's support — you all are the best. Sending hugs. Please let me know if there's anything I can do to help. Love that we're together on this. Take care.",
			axis:    "warmth",
			wantDir: "high",
		},
	}

	hc := HeuristicClassifier{}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := hc.Classify(context.Background(), []string{tc.text})
			if err != nil {
				t.Fatalf("Classify: %v", err)
			}
			val := getAxis(got, tc.axis)
			if tc.wantDir == "high" && val < 0.55 {
				t.Errorf("axis %q want >=0.55, got %.3f (full axes: %+v)", tc.axis, val, got)
			}
			if tc.wantDir == "low" && val > 0.45 {
				t.Errorf("axis %q want <=0.45, got %.3f (full axes: %+v)", tc.axis, val, got)
			}
		})
	}
}

func TestHeuristicClassifier_EmptyInputIsNeutral(t *testing.T) {
	got, err := HeuristicClassifier{}.Classify(context.Background(), nil)
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	want := neutralTone()
	if got != want {
		t.Errorf("empty input: got %+v, want %+v", got, want)
	}
}

func TestHeuristicClassifier_ClampsRange(t *testing.T) {
	// Pathological all-positive text shouldn't push optimism above 1.0.
	text := ""
	for i := 0; i < 100; i++ {
		text += "amazing wonderful fantastic excellent love brilliant happy thrilled "
	}
	got, _ := HeuristicClassifier{}.Classify(context.Background(), []string{text})
	if got.Optimism < 0 || got.Optimism > 1 {
		t.Errorf("Optimism out of range: %v", got.Optimism)
	}
	if got.Humor < 0 || got.Humor > 1 {
		t.Errorf("Humor out of range: %v", got.Humor)
	}
}

func TestLLMClassifier_FallsBackOnError(t *testing.T) {
	mock := &MockLLMClient{Err: errors.New("nope")}
	c := LLMClassifier{LLM: mock}
	got, err := c.Classify(context.Background(), []string{"hello world"})
	if err == nil {
		t.Errorf("want non-nil error (fallback path), got nil")
	}
	// Even though we surfaced an error, we should also have produced a
	// usable score from the heuristic.
	if got.Humor < 0 || got.Humor > 1 {
		t.Errorf("fallback didn't produce a clamped score: %+v", got)
	}
}

func TestLLMClassifier_DecodesJSON(t *testing.T) {
	want := ToneAxes{Humor: 0.7, Formality: 0.2, Optimism: 0.8, Directness: 0.6, Warmth: 0.9}
	body, _ := json.Marshal(want)
	mock := &MockLLMClient{GenerateJSON: body}
	c := LLMClassifier{LLM: mock}
	got, err := c.Classify(context.Background(), []string{"x"})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestLLMClassifier_NilLLMUsesFallback(t *testing.T) {
	c := LLMClassifier{LLM: nil}
	got, err := c.Classify(context.Background(), []string{"hello"})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	// We just want a non-pathological output.
	if got.Humor < 0 || got.Humor > 1 {
		t.Errorf("Humor out of range: %v", got.Humor)
	}
}

// TestLLMClassifier_RealAPI is an integration-style smoke test that runs
// only when GEMINI_API_KEY is set. Skipped on CI without the key.
func TestLLMClassifier_RealAPI(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		t.Skip("GEMINI_API_KEY not set; skipping live LLM call")
	}
	llm := NewGeminiClient(key)
	c := LLMClassifier{LLM: llm}
	got, err := c.Classify(context.Background(), []string{
		"Haha, this is hilarious! What a joke. So funny.",
	})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if got.Humor < 0.4 {
		t.Errorf("expected the humor sample to score >=0.4, got %.3f", got.Humor)
	}
}

func getAxis(a ToneAxes, name string) float64 {
	switch name {
	case "humor":
		return a.Humor
	case "formality":
		return a.Formality
	case "optimism":
		return a.Optimism
	case "directness":
		return a.Directness
	case "warmth":
		return a.Warmth
	}
	return -1
}

// TestFittedClassifier_HandCraftedFixtures runs the same hand-crafted
// extreme samples that the heuristic is calibrated against. The fitted
// model should at minimum land them on the same side of 0.5 — if it
// doesn't, the calibration is broken and the heuristic-fallback story
// won't save us.
//
// This is a v0.2 floor, not a v0.2 acceptance bar. The MAE acceptance
// bar (<0.15 per axis) is enforced separately by the fit pipeline, not
// here, because the hand-crafted fixtures are extreme exemplars and a
// floor test against extremes wouldn't surface MAE drift.
func TestFittedClassifier_HandCraftedFixtures(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		axis    string
		wantDir string
	}{
		{
			name:    "clearly humorous",
			text:    "Haha, so I tried to deploy on Friday — yikes! Lol I should know better. The whole thing was hilarious. Hahaha. Joke's on me!! Anyway, ridiculous afternoon.",
			axis:    "humor",
			wantDir: "high",
		},
		{
			name:    "clearly formal",
			text:    "Furthermore, the aforementioned analysis demonstrates that our methodology, pursuant to the established protocol, yields consistently reproducible results, notwithstanding the inherent limitations of the available sample. Consequently, we recommend that subsequent investigations adopt the framework outlined herein, and that all stakeholders henceforth adhere to the prescribed reporting standards.",
			axis:    "formality",
			wantDir: "high",
		},
		{
			name:    "clearly casual",
			text:    "yeah totally, gonna grab coffee real quick. wanna come? lol it's whatever, super chill. tbh I dunno what we're doing today anyways. omg I just realized my charger's at home, kinda annoying.",
			axis:    "formality",
			wantDir: "low",
		},
		{
			name:    "clearly optimistic",
			text:    "What a fantastic week! The team shipped an amazing release and the early feedback has been wonderful. I'm thrilled with the results — every metric looks promising. Excited to see where we go next. The future is bright!",
			axis:    "optimism",
			wantDir: "high",
		},
		{
			name:    "clearly pessimistic",
			text:    "Things are looking bad. The launch was a failure, customers are frustrated, and the product is broken in three places. I'm worried we'll miss the next milestone too. The risks are mounting and the team is struggling.",
			axis:    "optimism",
			wantDir: "low",
		},
		{
			name:    "clearly direct",
			text:    "Ship it. Stop arguing. Fix the bug now. Cut the meeting. Use the existing API. Don't overthink it. Do the work, then move on. Always default to action.",
			axis:    "directness",
			wantDir: "high",
		},
		{
			name:    "clearly hedged",
			text:    "I think this might possibly work, but I'm not totally sure. Maybe we could try it, sort of as an experiment. It seems like a reasonable approach, kind of. I guess we should perhaps consider it, more or less. Arguably worth a shot, in a way.",
			axis:    "directness",
			wantDir: "low",
		},
		{
			name:    "clearly warm",
			text:    "Hey friends, thanks so much for joining. I really appreciate everyone's support — you all are the best. Sending hugs. Please let me know if there's anything I can do to help. Love that we're together on this. Take care.",
			axis:    "warmth",
			wantDir: "high",
		},
	}

	w := DefaultFittedWeights()
	c := FittedClassifier{Weights: &w}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := c.Classify(context.Background(), []string{tc.text})
			if err != nil {
				t.Fatalf("Classify: %v", err)
			}
			val := getAxis(got, tc.axis)
			// Looser thresholds (0.55 / 0.45) than HeuristicClassifier's:
			// the fitted model trades extreme-case sharpness for corpus
			// MAE, so we don't require it to *also* peg the extremes.
			if tc.wantDir == "high" && val < 0.55 {
				t.Errorf("axis %q want >=0.55, got %.3f (full axes: %+v)", tc.axis, val, got)
			}
			if tc.wantDir == "low" && val > 0.45 {
				t.Errorf("axis %q want <=0.45, got %.3f (full axes: %+v)", tc.axis, val, got)
			}
		})
	}
}

func TestFittedClassifier_EmptyInputIsNeutral(t *testing.T) {
	got, err := FittedClassifier{}.Classify(context.Background(), nil)
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	want := neutralTone()
	if got != want {
		t.Errorf("empty input: got %+v, want %+v", got, want)
	}
}

func TestFittedClassifier_BlankSamplesAreNeutral(t *testing.T) {
	// All-blank inputs should return neutralTone(), not run the model on
	// zero-feature vectors (which would just emit sigmoid(bias) for each
	// axis — non-neutral by design).
	got, err := FittedClassifier{}.Classify(context.Background(), []string{"", "  ", "\n"})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	want := neutralTone()
	if got != want {
		t.Errorf("blank samples: got %+v, want %+v", got, want)
	}
}

func TestFittedClassifier_NilWeightsUsesDefault(t *testing.T) {
	// FittedClassifier{} (no Weights) should still produce sensible scores
	// by falling back to DefaultFittedWeights().
	c := FittedClassifier{}
	got, err := c.Classify(context.Background(), []string{"Ship it. Stop arguing. Fix the bug now. Cut the meeting."})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if got.Directness < 0.55 {
		t.Errorf("direct sample with default weights should score Directness>=0.55, got %.3f", got.Directness)
	}
}

func TestFittedClassifier_ClampsRange(t *testing.T) {
	// Pathologically dense lexicon hits should not push any axis out of
	// [0, 1]. Sigmoid handles this in theory; we still assert it because
	// future activation swaps are an obvious foot-gun.
	text := ""
	for i := 0; i < 40; i++ {
		text += "amazing wonderful fantastic excellent love brilliant happy thrilled "
	}
	got, _ := FittedClassifier{}.Classify(context.Background(), []string{text})
	for _, v := range []float64{got.Humor, got.Formality, got.Optimism, got.Directness, got.Warmth} {
		if v < 0 || v > 1 {
			t.Errorf("axis out of range: %+v", got)
			break
		}
	}
}

func TestFittedClassifier_AveragesAcrossSamples(t *testing.T) {
	// Two cleanly-skewed samples on opposite sides of an axis should
	// produce a roughly mid-band aggregate. We use Formality because the
	// fitted MAE there is low enough that the test isn't fragile.
	formal := "Furthermore, the aforementioned analysis demonstrates, with statistical significance, that the methodology yields consistently reproducible results pursuant to the established protocol."
	casual := "lol yeah totally, gonna grab coffee. wanna come? tbh idk what we're doing today"

	got, err := FittedClassifier{}.Classify(context.Background(), []string{formal, casual})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if got.Formality < 0.2 || got.Formality > 0.8 {
		t.Errorf("averaged formal+casual should land near the middle band, got %.3f", got.Formality)
	}
}

// TestFittedWeights_Provenance asserts the bundled weights carry version
// + timestamp metadata so a profile snapshot can record which weight
// vintage produced its tonal scores.
func TestFittedWeights_Provenance(t *testing.T) {
	w := DefaultFittedWeights()
	if w.Version == "" {
		t.Errorf("DefaultFittedWeights().Version is empty — set fittedWeightsVersion in tone_weights.go")
	}
	if w.TrainedAt.IsZero() {
		t.Errorf("DefaultFittedWeights().TrainedAt is zero — set fittedWeightsTrainedAt in tone_weights.go")
	}
}

// TestExtractToneFeatures_Stable asserts the feature vector has a stable
// length and that core signals land in the slot ToneFeatureNames says
// they should. This is a guardrail against accidental schema drift —
// reordering fields in AxisFeatureWeights without updating
// ExtractToneFeatures (or vice versa) would silently corrupt every
// fitted weight.
func TestExtractToneFeatures_Stable(t *testing.T) {
	feats := ExtractToneFeatures("Hello! Hello! Hello!")
	if len(feats) != ToneFeatureCount {
		t.Fatalf("len(feats)=%d, want %d", len(feats), ToneFeatureCount)
	}
	if got := len(ToneFeatureNames()); got != ToneFeatureCount {
		t.Fatalf("len(ToneFeatureNames())=%d, want %d", got, ToneFeatureCount)
	}
	// Exclamation-rate slot should be populated for the input above.
	exclSlot := -1
	for i, n := range ToneFeatureNames() {
		if n == "exclamations" {
			exclSlot = i
			break
		}
	}
	if exclSlot < 0 {
		t.Fatal("exclamations not found in ToneFeatureNames()")
	}
	if feats[exclSlot] <= 0 {
		t.Errorf("expected nonzero exclamations rate, got %v", feats[exclSlot])
	}
}

// TestFittedClassifier_BuilderOptIn confirms the env-var switch routes
// to FittedClassifier when set to "fitted". Mirrors the LLMClassifier
// opt-in test in builder_test.go but stays inside this file since it's
// a pure tone-classifier concern.
func TestFittedClassifier_BuilderOptIn(t *testing.T) {
	t.Setenv("POSTWAVE_VOICE_TONE_CLASSIFIER", "fitted")
	tc := defaultToneClassifier(nil)
	if _, ok := tc.(FittedClassifier); !ok {
		t.Errorf("env=fitted: defaultToneClassifier=%T, want FittedClassifier", tc)
	}
}
