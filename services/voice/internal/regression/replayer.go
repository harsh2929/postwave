// Package regression implements the AI-output regression harness replay
// core. It regenerates a frozen golden-set manifest through an explicitly
// versioned replay policy and scores each result against a tenant voice
// profile. Replay is evidence about that policy; it is not claimed to be
// byte-equivalent to every production authoring path.
//
// The replay algorithm is isolated behind the Generator interface (the
// real adapter wraps the LLM; tests pass a deterministic fake) so the
// scoring/aggregation logic is fully unit-testable without network calls —
// the same isolation the diagnostician eval harness uses.
package regression

import (
	"context"
	stdhtml "html"
	"math"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/profile"
	xhtml "golang.org/x/net/html"
)

// Severity bands, mirroring handlers.DriftWarnThreshold /
// DriftCriticalThreshold (60/40). Defined locally to avoid importing the
// handlers package, which imports this package to mount the endpoint.
const (
	DefaultWarnThreshold     = 60.0
	DefaultCriticalThreshold = 40.0
	maxReplayedOutputRunes   = 32_000
	// PromptPolicyVersion is part of every replay receipt. Bump it whenever a
	// replay prompt, schema, or output projection changes.
	PromptPolicyVersion = "voice-regression-replay-v2"
)

// Generator re-generates an output for a stored brief on a given surface,
// using the service's current model/prompt configuration.
type Generator interface {
	Generate(ctx context.Context, surfaceKind, brief string) (string, error)
}

// GoldenExample is the minimal shape the replayer consumes.
type GoldenExample struct {
	ID          string
	SurfaceKind string
	Brief       string
	// ApprovedOutput is the original human-approved text. Retained for the
	// side-by-side evidence view; scoring in v1 is against the voice
	// profile (the canonical ground truth), not this frozen output.
	ApprovedOutput string
}

// ReplayResult is the per-example outcome.
type ReplayResult struct {
	ExampleID      string                      `json:"example_id"`
	SurfaceKind    string                      `json:"surface_kind"`
	ReplayedOutput string                      `json:"replayed_output,omitempty"`
	FidelityScore  *float64                    `json:"fidelity_score,omitempty"`
	Breakdown      *fidelity.FidelityBreakdown `json:"breakdown,omitempty"`
	Severity       string                      `json:"severity"` // ok|warn|critical|error
	ErrorCode      string                      `json:"error_code,omitempty"`
}

// SurfaceAggregate is the per-surface roll-up within a batch.
type SurfaceAggregate struct {
	Total     int      `json:"total"`
	Scored    int      `json:"scored"`
	Passed    int      `json:"passed"`
	MeanScore *float64 `json:"mean_score,omitempty"`
}

// BatchResult aggregates a full replay batch.
type BatchResult struct {
	Total     int                         `json:"total"`
	Scored    int                         `json:"scored"`
	Passed    int                         `json:"passed"` // score >= WarnThreshold
	MeanScore *float64                    `json:"mean_score,omitempty"`
	P25Score  *float64                    `json:"p25_score,omitempty"`
	BySurface map[string]SurfaceAggregate `json:"by_surface"`
	Results   []ReplayResult              `json:"results"`
}

// Replayer scores a tenant's golden set against the current model config.
type Replayer struct {
	Generator         Generator
	Evaluator         fidelity.Evaluator
	WarnThreshold     float64
	CriticalThreshold float64
}

// NewReplayer constructs a Replayer with the default severity bands.
func NewReplayer(gen Generator, eval fidelity.Evaluator) *Replayer {
	return &Replayer{
		Generator:         gen,
		Evaluator:         eval,
		WarnThreshold:     DefaultWarnThreshold,
		CriticalThreshold: DefaultCriticalThreshold,
	}
}

func (r *Replayer) warn() float64 {
	if r != nil && !math.IsNaN(r.WarnThreshold) && !math.IsInf(r.WarnThreshold, 0) &&
		r.WarnThreshold >= 0 && r.WarnThreshold <= 100 {
		return r.WarnThreshold
	}
	return DefaultWarnThreshold
}

func (r *Replayer) crit() float64 {
	if r.CriticalThreshold > 0 {
		return r.CriticalThreshold
	}
	return DefaultCriticalThreshold
}

// ReplayExample re-generates a single golden example and scores it. A
// generation or scoring error is captured as a severity="error" result
// (never a panic / never a fabricated score) so a batch always completes.
func (r *Replayer) ReplayExample(ctx context.Context, prof profile.VoiceProfile, ex GoldenExample) ReplayResult {
	res := ReplayResult{ExampleID: ex.ID, SurfaceKind: ex.SurfaceKind}
	if r == nil || r.Generator == nil {
		res.Severity = "error"
		res.ErrorCode = "generation_unavailable"
		return res
	}
	out, err := r.Generator.Generate(ctx, ex.SurfaceKind, ex.Brief)
	if err != nil {
		res.Severity = "error"
		res.ErrorCode = "generation_unavailable"
		return res
	}
	if strings.TrimSpace(out) == "" || utf8.RuneCountInString(out) > maxReplayedOutputRunes || !utf8.ValidString(out) {
		res.Severity = "error"
		res.ErrorCode = "generation_invalid"
		return res
	}
	res.ReplayedOutput = out
	if r.Evaluator == nil {
		res.Severity = "error"
		res.ErrorCode = "scoring_unavailable"
		return res
	}
	score, br, serr := r.Evaluator.Score(ctx, stripHTML(out), prof)
	if serr != nil {
		res.Severity = "error"
		res.ErrorCode = "scoring_unavailable"
		return res
	}
	if !validScoreReceipt(score, br) {
		res.Severity = "error"
		res.ErrorCode = "scoring_invalid"
		return res
	}
	res.FidelityScore = &score
	res.Breakdown = &br
	res.Severity = severityFromScore(score, r.warn(), r.crit())
	return res
}

// validScoreReceipt closes the evaluator boundary before its values reach
// JSON or durable evidence. A finite top-level score is insufficient: any
// non-finite/out-of-range component would make an NDJSON stream unencodable,
// while a mismatched Combined value would let two different scores describe
// the same result. Treat either case as an explicitly unscored result.
func validScoreReceipt(score float64, breakdown fidelity.FidelityBreakdown) bool {
	if math.IsNaN(score) || math.IsInf(score, 0) || score < 0 || score > 100 {
		return false
	}
	components := [...]float64{
		breakdown.EmbeddingSimilarity,
		breakdown.StylisticDistance,
		breakdown.VocabularyOverlap,
		breakdown.StructuralMatch,
	}
	for _, component := range components {
		if math.IsNaN(component) || math.IsInf(component, 0) || component < 0 || component > 1 {
			return false
		}
	}
	return !math.IsNaN(breakdown.Combined) &&
		!math.IsInf(breakdown.Combined, 0) &&
		breakdown.Combined >= 0 && breakdown.Combined <= 100 &&
		math.Abs(breakdown.Combined-score) <= 0.000001
}

// ReplayBatch replays every example and returns the aggregate. Error
// results are excluded from score statistics but counted in Total and the
// per-surface Total (so the UI can honestly show "1 of 5 failed to generate").
func (r *Replayer) ReplayBatch(ctx context.Context, prof profile.VoiceProfile, examples []GoldenExample) BatchResult {
	out := BatchResult{BySurface: map[string]SurfaceAggregate{}, Results: make([]ReplayResult, 0, len(examples))}
	scores := make([]float64, 0, len(examples))
	surfaceScores := map[string][]float64{}
	for _, ex := range examples {
		rr := r.ReplayExample(ctx, prof, ex)
		out.Results = append(out.Results, rr)
		out.Total++
		agg := out.BySurface[rr.SurfaceKind]
		agg.Total++
		if rr.Severity != "error" && rr.FidelityScore != nil {
			score := *rr.FidelityScore
			out.Scored++
			agg.Scored++
			scores = append(scores, score)
			surfaceScores[rr.SurfaceKind] = append(surfaceScores[rr.SurfaceKind], score)
			if score >= r.warn() {
				out.Passed++
				agg.Passed++
			}
		}
		out.BySurface[rr.SurfaceKind] = agg
	}
	out.MeanScore = meanPointer(scores)
	out.P25Score = percentilePointer(scores, 25)
	for k, ss := range surfaceScores {
		agg := out.BySurface[k]
		agg.MeanScore = meanPointer(ss)
		out.BySurface[k] = agg
	}
	return out
}

// severityFromScore maps a 0..100 fidelity score into the advisory band.
// Boundaries are inclusive at the top: exactly warn => ok, exactly crit => warn.
func severityFromScore(score, warn, crit float64) string {
	// The frozen warning threshold is the authoritative pass boundary. Check
	// it first so a deliberately permissive threshold (including zero) cannot
	// produce the contradictory receipt "passed, but critical" merely because
	// the advisory critical band has its default value of 40.
	if score >= warn {
		return "ok"
	}
	if score < crit {
		return "critical"
	}
	return "warn"
}

func meanOf(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func meanPointer(xs []float64) *float64 {
	if len(xs) == 0 {
		return nil
	}
	v := meanOf(xs)
	return &v
}

// percentile returns the p-th percentile (nearest-rank) of xs. Empty => 0.
func percentile(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := make([]float64, len(xs))
	copy(s, xs)
	sort.Float64s(s)
	if p <= 0 {
		return s[0]
	}
	if p >= 100 {
		return s[len(s)-1]
	}
	rank := int(math.Ceil(p / 100.0 * float64(len(s))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(s) {
		rank = len(s)
	}
	return s[rank-1]
}

func percentilePointer(xs []float64, p float64) *float64 {
	if len(xs) == 0 {
		return nil
	}
	v := percentile(xs, p)
	return &v
}

// stripHTML extracts normalized visible prose with the HTML parser. Replay
// output is model-controlled, so a toggle-on-`<` scanner is not a trustworthy
// content boundary: malformed tags, entities, and script/style content would
// otherwise distort the evidence score.
func stripHTML(s string) string {
	document, err := xhtml.Parse(strings.NewReader(s))
	if err != nil {
		return strings.TrimSpace(s)
	}
	var out strings.Builder
	hasMarkup := false
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode {
			switch strings.ToLower(node.Data) {
			case "html", "head", "body":
			default:
				hasMarkup = true
			}
		}
		if node.Type == xhtml.ElementNode && hiddenHTMLNode(node.Data) {
			return
		}
		block := node.Type == xhtml.ElementNode && blockHTMLNode(node.Data)
		if block {
			appendTextBoundary(&out)
		}
		if node.Type == xhtml.TextNode {
			appendVisibleText(&out, node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
		if block {
			appendTextBoundary(&out)
		}
	}
	walk(document)
	if !hasMarkup {
		// x/net/html creates html/head/body wrappers for plain text. Preserve
		// its original line and paragraph structure because the stylistic and
		// structural evaluators intentionally measure those boundaries.
		return strings.TrimSpace(stdhtml.UnescapeString(s))
	}
	return strings.TrimSpace(out.String())
}

func hiddenHTMLNode(name string) bool {
	switch strings.ToLower(name) {
	case "head", "script", "style", "template", "noscript", "svg", "canvas":
		return true
	default:
		return false
	}
}

func blockHTMLNode(name string) bool {
	switch strings.ToLower(name) {
	case "address", "article", "aside", "blockquote", "br", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul":
		return true
	default:
		return false
	}
}

func appendVisibleText(out *strings.Builder, value string) {
	normalized := strings.Join(strings.Fields(value), " ")
	if normalized == "" {
		return
	}
	current := out.String()
	if len(current) > 0 && current[len(current)-1] != '\n' && current[len(current)-1] != ' ' {
		out.WriteByte(' ')
	}
	out.WriteString(normalized)
}

func appendTextBoundary(out *strings.Builder) {
	current := out.String()
	if len(current) > 0 && current[len(current)-1] != '\n' {
		out.WriteByte('\n')
	}
}
