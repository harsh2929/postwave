// SPDX-License-Identifier: AGPL-3.0-only
//
// Package demographics provides a lightweight, deterministic demographic
// inference engine used by the SUB-063 predicted-gender / demographic-
// inference flow.
//
// The "right" production implementation is a trained classifier (a name→gender
// model, an age-bracket model from behavioural features, an interest model
// over catalog affinity); those models are large artifacts we do NOT ship in
// the repo. To keep inference deterministic, testable, and dependency-free,
// this package exposes a small interface (Predictor) with a concrete
// rule-based implementation (StaticPredictor) that:
//
//   - Infers gender from the given/first name against a curated name table,
//     returning a confidence in [0,1].
//   - Leaves age group + interests unpopulated unless the caller already has
//     the signals — the rule engine deliberately does NOT fabricate them.
//
// A nil/absent predictor degrades gracefully: callers treat "no predictor" as
// "no demographics inferred", so the subscriber Upsert path is unchanged for
// deployments that never wire one. This mirrors the geolocation.Detector
// optional-dependency pattern used by SUB-055.

package demographics

import "strings"

// Gender is a coarse predicted-gender label.
type Gender string

const (
	GenderUnknown Gender = "unknown"
	GenderMale    Gender = "male"
	GenderFemale  Gender = "female"
)

// Prediction is the composite demographic inference for one profile. Every
// field is confidence-labelled: a zero-confidence field means "not inferred".
type Prediction struct {
	// Gender is the inferred gender label; GenderUnknown when not inferred.
	Gender Gender
	// GenderConfidence is the model confidence in [0,1] for Gender.
	GenderConfidence float64
	// AgeGroup is a coarse age bracket (e.g. "25-34"); empty when not inferred.
	AgeGroup string
	// AgeGroupConfidence is the model confidence in [0,1] for AgeGroup.
	AgeGroupConfidence float64
	// Interests is a ranked list of inferred interest tags; nil when none.
	Interests []string
	// InterestsConfidence is the model confidence in [0,1] for Interests.
	InterestsConfidence float64
}

// HasAny reports whether the prediction inferred at least one demographic
// (a non-unknown gender, an age group, or one interest). Callers use this to
// decide whether to persist / surface the prediction at all.
func (p Prediction) HasAny() bool {
	return (p.Gender != GenderUnknown && p.Gender != "") || p.AgeGroup != "" || len(p.Interests) > 0
}

// Input is the feature bundle the predictor scores. All fields are optional;
// the predictor uses whatever it has and leaves the rest unset.
type Input struct {
	// FirstName is the subject's given/first name (drives gender inference).
	FirstName string
	// FullName is the subject's full name; the predictor falls back to its
	// first token when FirstName is empty.
	FullName string
}

// Predictor is the minimal inference interface the subscribers package needs.
// Implemented by StaticPredictor here; main.go wires a concrete predictor onto
// the subscriber Repo as an optional dependency.
type Predictor interface {
	// Predict scores the input into a composite demographic prediction. A
	// zero-value Prediction (Gender unknown, empty everything) is returned when
	// nothing could be inferred.
	Predict(in Input) Prediction
}

// StaticPredictor is a deterministic, in-memory name→gender inference engine.
// The zero value is usable (it carries the curated default name table). Seed
// additional names via Register.
type StaticPredictor struct {
	// names maps a lower-cased first name to (gender, confidence). When empty,
	// the curated default table is used.
	names map[string]nameVote
}

type nameVote struct {
	gender     Gender
	confidence float64
}

// NewStaticPredictor returns a StaticPredictor seeded with a small curated
// name table so the inference logic + tests have something concrete to run
// against. An operator can extend it via Register.
func NewStaticPredictor() *StaticPredictor {
	p := &StaticPredictor{names: map[string]nameVote{}}
	for name, v := range defaultNames {
		p.names[name] = v
	}
	return p
}

// Register adds/overrides a first-name → gender mapping with a confidence in
// [0,1]. Names are matched case-insensitively. Confidence is clamped to [0,1].
func (p *StaticPredictor) Register(firstName string, gender Gender, confidence float64) {
	if p.names == nil {
		p.names = map[string]nameVote{}
	}
	if confidence < 0 {
		confidence = 0
	}
	if confidence > 1 {
		confidence = 1
	}
	p.names[strings.ToLower(strings.TrimSpace(firstName))] = nameVote{gender: gender, confidence: confidence}
}

// Predict implements Predictor. It infers gender from the first name (or the
// first token of the full name) against the curated table. Age group +
// interests are left unset — the rule engine does not fabricate signals it
// has no basis for.
func (p *StaticPredictor) Predict(in Input) Prediction {
	first := strings.ToLower(strings.TrimSpace(in.FirstName))
	if first == "" {
		first = firstToken(in.FullName)
	}
	if first == "" {
		return Prediction{Gender: GenderUnknown}
	}
	table := p.names
	if len(table) == 0 {
		table = defaultNames
	}
	if v, ok := table[first]; ok {
		return Prediction{Gender: v.gender, GenderConfidence: v.confidence}
	}
	return Prediction{Gender: GenderUnknown}
}

// firstToken returns the lower-cased first whitespace-delimited token of s.
func firstToken(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexAny(s, " \t"); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(s)
}

// defaultNames is the curated seed table. Confidences are illustrative — a
// production deployment swaps this for a real model.
var defaultNames = map[string]nameVote{
	"john":      {GenderMale, 0.97},
	"michael":   {GenderMale, 0.97},
	"david":     {GenderMale, 0.96},
	"james":     {GenderMale, 0.96},
	"robert":    {GenderMale, 0.96},
	"william":   {GenderMale, 0.95},
	"alexander": {GenderMale, 0.93},
	"daniel":    {GenderMale, 0.95},
	"mary":      {GenderFemale, 0.97},
	"jennifer":  {GenderFemale, 0.97},
	"linda":     {GenderFemale, 0.96},
	"patricia":  {GenderFemale, 0.96},
	"elizabeth": {GenderFemale, 0.95},
	"susan":     {GenderFemale, 0.95},
	"emily":     {GenderFemale, 0.94},
	"sarah":     {GenderFemale, 0.95},
	// Ambiguous names get a lower confidence and a coin-flip-ish lean.
	"taylor": {GenderFemale, 0.55},
	"jordan": {GenderMale, 0.55},
	"casey":  {GenderFemale, 0.52},
}
