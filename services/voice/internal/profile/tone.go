package profile

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// ToneAxes is a 5-axis tonal fingerprint. All values are normalized to
// the 0..1 range (clamped). The axes are intentionally orthogonal so a
// writer can be (e.g.) high-humor AND high-formality without
// contradiction (think a witty academic).
type ToneAxes struct {
	Humor      float64 `json:"humor"`      // 0 = no humor; 1 = often jokes/playful
	Formality  float64 `json:"formality"`  // 0 = texting; 1 = academic
	Optimism   float64 `json:"optimism"`   // 0 = pessimistic; 1 = optimistic
	Directness float64 `json:"directness"` // 0 = circuitous/hedged; 1 = blunt
	Warmth     float64 `json:"warmth"`     // 0 = cold/distant; 1 = warm/inviting
}

// ToneClassifier produces ToneAxes from a list of writing samples.
// Implementations must:
//   - return a zero-value ToneAxes (all 0.5 = neutral) plus an error if
//     they cannot make any assessment;
//   - clamp all axes to [0, 1] before returning;
//   - be safe for concurrent use.
type ToneClassifier interface {
	Classify(ctx context.Context, samples []string) (ToneAxes, error)
}

// HeuristicClassifier is a lexicon + structural-cue tone scorer. It is
// strictly better than the existing regex-based classification (more
// signals, per-axis tuning, structural features) but it remains a
// HEURISTIC — calibration is hand-tuned against the test fixtures, NOT
// against a labeled corpus. Treat its outputs as a useful prior, not a
// ground truth.
//
// Provenance of the lexicons:
//   - humorMarkers: gathered from common humor cues (laughter spellings,
//     interjection markers). Hand-curated; no licensed corpus.
//   - formal/casual lexicons: derived from contrast lists in academic
//     writing guides (Strunk & White's contractions list etc.) plus
//     observation of typical Slack vs. press-release vocab.
//   - optimism/pessimism word lists: short curated subset of the
//     well-known LIWC posemo/negemo categories. We ship our own ~30
//     words per side because LIWC itself is not redistributable.
//   - directness lexicon: imperatives + negation of hedges. Hedges are
//     lifted from the existing builder.go list.
//   - warmth lexicon: appreciation/affiliation markers. Hand-curated.
//
// All weights are unit-tested via tone_test.go; see that file for the
// hand-crafted fixtures the heuristic is calibrated against.
type HeuristicClassifier struct{}

// Classify implements ToneClassifier. Empty input yields a neutral
// ToneAxes (all 0.5) and no error.
func (HeuristicClassifier) Classify(_ context.Context, samples []string) (ToneAxes, error) {
	joined := strings.Join(samples, "\n\n")
	if strings.TrimSpace(joined) == "" {
		return neutralTone(), nil
	}
	return scoreHeuristic(joined), nil
}

func neutralTone() ToneAxes {
	return ToneAxes{Humor: 0.5, Formality: 0.5, Optimism: 0.5, Directness: 0.5, Warmth: 0.5}
}

// ----- shared lexicons -----

var humorMarkers = []string{
	// Laughter / interjection — these are very high-precision humor signals.
	"haha", "lol", "rofl", "lmao", "lmfao", "hehe", "heh",
	// Playful punctuation+word combos
	"jk", "kidding", "joking", "joke", "punchline",
	// Intensifier + absurd
	"hilarious", "ridiculous", "absurd", "silly", "goofy",
	// Self-deprecating / playful framing
	"oops", "whoops", "yikes",
}

var humorPunctRe = regexp.MustCompile(`!{2,}|\?!|!\?`) // "!!", "?!" — playful

// formalLex are words that strongly indicate formal/academic register.
var formalLex = []string{
	"furthermore", "moreover", "consequently", "therefore", "thereby",
	"hereafter", "wherein", "whereupon", "henceforth", "notwithstanding",
	"accordingly", "subsequently", "nevertheless", "nonetheless",
	"aforementioned", "pursuant", "regarding", "regards", "respectfully",
	"sincerely", "kindly", "shall", "ought",
}

// casualLex are words that strongly indicate casual/spoken register.
var casualLex = []string{
	"yeah", "yep", "nope", "gonna", "wanna", "gotta", "kinda", "sorta",
	"dunno", "y'all", "totally", "super", "stuff", "thing", "thingy",
	"whatever", "anyway", "anyways", "basically", "literally",
	"awesome", "cool", "omg", "btw", "fyi", "imo", "tbh",
}

// posLex / negLex are short, hand-curated lists. NOT exhaustive.
var posLex = []string{
	"great", "amazing", "wonderful", "fantastic", "excellent", "love",
	"loved", "loving", "exciting", "excited", "thrilled", "delighted",
	"happy", "glad", "joy", "joyful", "win", "winning", "succeed",
	"success", "successful", "best", "better", "beautiful", "brilliant",
	"hopeful", "hope", "optimistic", "promising", "bright",
}

var negLex = []string{
	"bad", "worse", "worst", "terrible", "awful", "horrible", "hate",
	"hated", "hating", "fail", "failed", "failure", "broken", "wrong",
	"sad", "angry", "frustrated", "frustrating", "disappointed",
	"disappointing", "concern", "concerned", "concerns", "worried",
	"worry", "worrying", "risk", "risks", "risky", "danger", "dangerous",
	"problem", "problems", "issue", "issues", "struggle", "struggling",
}

// directLex are imperative/blunt markers. We score directness as
// (direct - hedge) signals.
var directLex = []string{
	"do", "must", "stop", "don't", "ship", "fix", "kill", "cut",
	"now", "immediately", "today", "always", "never", "exactly",
	"absolutely", "definitely", "obviously", "clearly", "simply",
}

// hedgeLex mirrors builder.go's hedgeWords plus a few phrase markers
// caught at substring level below.
var hedgeLex = []string{
	"maybe", "perhaps", "might", "could", "seems", "kind", "sort",
	"possibly", "probably", "somewhat", "fairly", "rather", "arguably",
	"apparently", "presumably", "supposedly",
}

// hedgePhrases are multi-word hedges checked via substring-Contains.
var hedgePhrases = []string{
	"i think", "i guess", "i suppose", "i feel like", "kind of",
	"sort of", "a bit", "a little", "in a way", "to some extent",
	"if anything", "more or less", "for the most part",
}

// warmLex are appreciation / affiliation markers.
var warmLex = []string{
	"thanks", "thank", "appreciate", "appreciated", "grateful", "kindly",
	"please", "welcome", "warm", "hug", "hugs", "love", "lovely",
	"friend", "friends", "team", "we're", "together", "support",
	"sorry", "apologies", "care", "care",
}

// coldLex are clinical / detached markers.
var coldLex = []string{
	"per", "regarding", "subject", "above", "below", "attached",
	"attached.", "the user", "the system", "the customer", "the entity",
}

// scoreHeuristic produces a ToneAxes from a concatenated text body.
// All scoring is bag-of-words over `strings.Fields` lowercased tokens
// plus a handful of structural signals.
func scoreHeuristic(text string) ToneAxes {
	lower := strings.ToLower(text)
	tokens := strings.Fields(lower)
	wc := len(tokens)
	if wc == 0 {
		return neutralTone()
	}

	// Count helper: how many tokens match any in the set?
	tokenSet := map[string]int{}
	for _, t := range tokens {
		tokenSet[stripPunct(t)]++
	}
	count := func(words []string) int {
		n := 0
		for _, w := range words {
			n += tokenSet[w]
		}
		return n
	}

	// Humor: lexicon + playful punctuation density.
	humorTok := count(humorMarkers)
	humorPunct := len(humorPunctRe.FindAllString(text, -1))
	// Per-1000 words baseline; ~3 hits per 1000 words = clearly humorous.
	humorRate := float64(humorTok+humorPunct) / float64(wc) * 1000.0
	humor := clamp01(humorRate / 3.0)

	// Formality: sentence length + formal/casual lexicon ratio. We use a
	// lenient segmenter (split on [.!?]+\s+) so lowercase-only casual
	// prose still produces multiple sentences; the strict SegmentSentences
	// requires capitalized continuations, which casual writers skip.
	sentences := splitForFormality(text)
	avgSentLen := float64(wc)
	if len(sentences) > 0 {
		var total int
		for _, s := range sentences {
			total += len(strings.Fields(s))
		}
		avgSentLen = float64(total) / float64(len(sentences))
	}
	// Sentence-length contribution: 6 tokens = casual, 24 tokens = formal.
	sentenceFormality := clamp01((avgSentLen - 6.0) / 18.0)
	formalCnt := count(formalLex)
	casualCnt := count(casualLex)
	contractions := strings.Count(text, "'") // any apostrophe — rough
	// Per-1000 baseline: ~2 hits per 1000 words tilts the axis.
	lexRate := (float64(formalCnt) - float64(casualCnt) - float64(contractions)*0.5) / float64(wc) * 1000.0
	lexFormality := 0.5 + lexRate/40.0 // ±20 per 1000 saturates the axis
	formality := clamp01(0.5*sentenceFormality + 0.5*clamp01(lexFormality))

	// Optimism: pos vs neg lexicon balance + exclamation rate as a small
	// bonus. ~2 net positive words per 1000 = clearly optimistic.
	posCnt := count(posLex)
	negCnt := count(negLex)
	exclRate := float64(strings.Count(text, "!")) / float64(wc) * 1000.0
	optRate := (float64(posCnt) - float64(negCnt)) / float64(wc) * 1000.0
	optimism := clamp01(0.5 + optRate/4.0 + exclRate/40.0)

	// Directness: directLex - (hedgeLex + hedge phrases). Imperative-style
	// sentence openers add a small bonus.
	directCnt := count(directLex)
	hedgeCnt := count(hedgeLex)
	for _, ph := range hedgePhrases {
		hedgeCnt += strings.Count(lower, ph)
	}
	// Imperative opener: capital-letter verb at sentence start. Cheap
	// proxy: count sentences starting with a verb-like word from directLex.
	imperativeBonus := 0
	for _, s := range sentences {
		first := strings.ToLower(strings.TrimSpace(s))
		for _, v := range []string{"do ", "go ", "stop ", "ship ", "fix ", "use ", "remember "} {
			if strings.HasPrefix(first, v) {
				imperativeBonus++
				break
			}
		}
	}
	directRate := (float64(directCnt) + float64(imperativeBonus)*2 - float64(hedgeCnt)) / float64(wc) * 1000.0
	directness := clamp01(0.5 + directRate/4.0)

	// Warmth: warm vs cold lexicon ratio + 2nd-person addressing.
	warmCnt := count(warmLex)
	coldCnt := count(coldLex)
	youCount := tokenSet["you"] + tokenSet["your"] + tokenSet["you're"] + tokenSet["you've"]
	warmRate := (float64(warmCnt) - float64(coldCnt) + float64(youCount)*0.3) / float64(wc) * 1000.0
	warmth := clamp01(0.5 + warmRate/4.0)

	return ToneAxes{
		Humor:      round3(humor),
		Formality:  round3(formality),
		Optimism:   round3(optimism),
		Directness: round3(directness),
		Warmth:     round3(warmth),
	}
}

// stripPunct removes punctuation around a token so we can match against
// the lexicons reliably ("haha!" -> "haha").
func stripPunct(s string) string {
	return strings.Trim(s, ".,!?;:'\"()[]{}—-")
}

// formalitySplitRe is a lenient sentence splitter used only for the
// formality avg-sentence-length feature. It splits on terminal
// punctuation followed by whitespace, regardless of the next word's
// case — so all-lowercase casual prose still segments correctly.
var formalitySplitRe = regexp.MustCompile(`[.!?]+\s+`)

func splitForFormality(text string) []string {
	parts := formalitySplitRe.Split(text, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func round3(x float64) float64 {
	return math.Round(x*1000) / 1000
}

// ----- LLM classifier -----

// LLMClassifier delegates to an LLMClient (the same Gemini shim used
// by the rest of the package). Falls back to HeuristicClassifier on any
// error (network, parse, missing API key) so callers always get a usable
// score.
//
// Calibration: the model itself is the calibration, so this is "as good
// as the prompt + Gemini on this axis" — significantly better than the
// heuristic on subtle samples in informal testing, but it costs an API
// call per profile build.
type LLMClassifier struct {
	LLM      LLMClient
	Fallback ToneClassifier // defaults to HeuristicClassifier{}
}

const tonePrompt = `You are scoring writing samples on five axes. For each axis, return a number between 0.0 and 1.0.

- humor: how often does the writer crack jokes or use playful language? (0 = stone-faced; 1 = always joking)
- formality: how formal is the tone? (0 = texting/Slack; 1 = academic paper)
- optimism: how positive vs cautious is the framing? (0 = grim; 1 = sunny)
- directness: how blunt vs hedged? (0 = constantly qualifying; 1 = imperative/blunt)
- warmth: how warm vs distant? (0 = clinical/cold; 1 = personal/inviting)

Respond with ONLY a JSON object with this exact shape (no prose, no markdown fence):
{"humor": 0.X, "formality": 0.X, "optimism": 0.X, "directness": 0.X, "warmth": 0.X}`

// Classify implements ToneClassifier.
func (c LLMClassifier) Classify(ctx context.Context, samples []string) (ToneAxes, error) {
	fallback := c.Fallback
	if fallback == nil {
		fallback = HeuristicClassifier{}
	}
	if c.LLM == nil {
		return fallback.Classify(ctx, samples)
	}
	user := joinTaggedSamples(samples)
	raw, err := c.LLM.Generate(ctx, tonePrompt, user, "")
	if err != nil {
		// Fall back silently — any LLM error (no API key, network, 429)
		// should yield a heuristic score, not a build failure.
		ax, _ := fallback.Classify(ctx, samples)
		return ax, fmt.Errorf("tone llm: %w", err)
	}
	var out ToneAxes
	if err := json.Unmarshal(raw, &out); err != nil {
		ax, _ := fallback.Classify(ctx, samples)
		return ax, fmt.Errorf("tone llm: decode: %w", err)
	}
	return ToneAxes{
		Humor:      clamp01(out.Humor),
		Formality:  clamp01(out.Formality),
		Optimism:   clamp01(out.Optimism),
		Directness: clamp01(out.Directness),
		Warmth:     clamp01(out.Warmth),
	}, nil
}

// joinTaggedSamples wraps each sample in <sampleN>...</sampleN> tags so
// the model can refer to them collectively. We cap each sample at ~2K
// chars to keep the prompt bounded; long samples are truncated.
func joinTaggedSamples(samples []string) string {
	var b strings.Builder
	for i, s := range samples {
		if len(s) > 2000 {
			s = s[:2000] + "..."
		}
		fmt.Fprintf(&b, "<sample%d>\n%s\n</sample%d>\n\n", i+1, s, i+1)
	}
	return b.String()
}

// ----- Fitted classifier -----

// FittedWeights holds per-axis linear-regression weights produced by the
// offline calibrator (see tone_calibrate/calibrate.go). Each axis is
// scored as sigmoid(bias + dot(weights, features)) where the feature
// schema is exactly the one defined by ExtractToneFeatures below.
//
// Weights ship in tone_weights.go, frozen and timestamped so we have an
// audit trail of which corpus + which trainer run produced them.
type FittedWeights struct {
	Version   string    `json:"version"`
	TrainedAt time.Time `json:"trained_at"`
	// Notes captures the corpus + hyperparameter snapshot for provenance.
	Notes string `json:"notes,omitempty"`

	AxisHumor      AxisFeatureWeights `json:"axis_humor"`
	AxisFormality  AxisFeatureWeights `json:"axis_formality"`
	AxisOptimism   AxisFeatureWeights `json:"axis_optimism"`
	AxisDirectness AxisFeatureWeights `json:"axis_directness"`
	AxisWarmth     AxisFeatureWeights `json:"axis_warmth"`
}

// AxisFeatureWeights is the per-axis weight vector. The ordering of the
// fields here must match the ordering returned by ExtractToneFeatures
// (see toneFeatureNames). Adding a feature here means adding it in both
// places PLUS retraining all five axes.
type AxisFeatureWeights struct {
	Bias              float64 `json:"bias"`
	SentenceLen       float64 `json:"sentence_len"`       // log1p(avg sentence length tokens)
	WordLen           float64 `json:"word_len"`           // avg word length chars
	HumorLexHits      float64 `json:"humor_lex_hits"`     // per-token rate
	FormalLexHits     float64 `json:"formal_lex_hits"`    // per-token rate
	CasualLexHits     float64 `json:"casual_lex_hits"`    // per-token rate
	PosLexHits        float64 `json:"pos_lex_hits"`       // per-token rate
	NegLexHits        float64 `json:"neg_lex_hits"`       // per-token rate
	DirectLexHits     float64 `json:"direct_lex_hits"`    // per-token rate
	HedgeLexHits      float64 `json:"hedge_lex_hits"`     // per-token rate (incl. phrases)
	WarmLexHits       float64 `json:"warm_lex_hits"`      // per-token rate
	ColdLexHits       float64 `json:"cold_lex_hits"`      // per-token rate
	SecondPerson      float64 `json:"second_person"`      // per-token rate of you/your/yours
	FirstPerson       float64 `json:"first_person"`       // per-token rate of i/me/my/we/us
	Exclamations      float64 `json:"exclamations"`       // per-token rate
	QuestionMarks     float64 `json:"question_marks"`     // per-token rate
	HumorPunct        float64 `json:"humor_punct"`        // !!, ?! density per-token
	AllCapsWords      float64 `json:"all_caps_words"`     // per-token rate
	Contractions      float64 `json:"contractions"`       // apostrophe count per-token
	ImperativeOpeners float64 `json:"imperative_openers"` // per-sentence rate
	HedgePhraseHits   float64 `json:"hedge_phrase_hits"`  // multi-word hedges per-token
	EmojiOrEmoticon   float64 `json:"emoji_or_emoticon"`  // per-token rate
	Ellipsis          float64 `json:"ellipsis"`           // per-token rate of "..."
}

// toneFeatureNames is the ordered feature schema; ExtractToneFeatures
// returns a slice in this exact order. dotAxis below maps it back into
// AxisFeatureWeights.
var toneFeatureNames = []string{
	"sentence_len",
	"word_len",
	"humor_lex_hits",
	"formal_lex_hits",
	"casual_lex_hits",
	"pos_lex_hits",
	"neg_lex_hits",
	"direct_lex_hits",
	"hedge_lex_hits",
	"warm_lex_hits",
	"cold_lex_hits",
	"second_person",
	"first_person",
	"exclamations",
	"question_marks",
	"humor_punct",
	"all_caps_words",
	"contractions",
	"imperative_openers",
	"hedge_phrase_hits",
	"emoji_or_emoticon",
	"ellipsis",
}

// ToneFeatureCount is the size of the feature vector returned by
// ExtractToneFeatures. Exposed so the trainer can preallocate.
const ToneFeatureCount = 22

// ExtractToneFeatures computes the feature vector for a single text body.
// Order matches toneFeatureNames. Returns a length-ToneFeatureCount slice;
// empty input yields a zero vector (which sigmoid(bias) maps to neutral).
//
// Mirrors signals already used by HeuristicClassifier so the two share a
// single source of truth for "what the model sees."
func ExtractToneFeatures(text string) []float64 {
	feats := make([]float64, ToneFeatureCount)
	if strings.TrimSpace(text) == "" {
		return feats
	}
	lower := strings.ToLower(text)
	tokens := strings.Fields(lower)
	wc := len(tokens)
	if wc == 0 {
		return feats
	}
	wcF := float64(wc)

	// Bag-of-stripped-tokens for lexicon counts.
	tokenSet := map[string]int{}
	totalWordChars := 0
	for _, t := range tokens {
		stripped := stripPunct(t)
		tokenSet[stripped]++
		totalWordChars += len([]rune(stripped))
	}
	count := func(words []string) int {
		n := 0
		for _, w := range words {
			n += tokenSet[w]
		}
		return n
	}

	// Sentence-level features.
	sentences := splitForFormality(text)
	avgSentLen := wcF
	if len(sentences) > 0 {
		var total int
		for _, s := range sentences {
			total += len(strings.Fields(s))
		}
		avgSentLen = float64(total) / float64(len(sentences))
	}
	avgWordLen := float64(totalWordChars) / wcF

	// All-caps words: count tokens >=2 chars where all letters are upper.
	allCaps := 0
	for _, raw := range strings.Fields(text) {
		stripped := strings.Trim(raw, ".,!?;:'\"()[]{}—-")
		if len([]rune(stripped)) < 2 {
			continue
		}
		hasLetter := false
		isAllCaps := true
		for _, r := range stripped {
			if unicode.IsLetter(r) {
				hasLetter = true
				if !unicode.IsUpper(r) {
					isAllCaps = false
					break
				}
			}
		}
		if hasLetter && isAllCaps {
			allCaps++
		}
	}

	// Imperative opener — sentence starts with a verb-like token from
	// directLex (or one of the canonical imperatives below).
	imperativeBonus := 0
	for _, s := range sentences {
		first := strings.ToLower(strings.TrimSpace(s))
		for _, v := range []string{"do ", "go ", "stop ", "ship ", "fix ", "use ", "remember ", "don't ", "kill ", "cut "} {
			if strings.HasPrefix(first, v) {
				imperativeBonus++
				break
			}
		}
	}

	hedgePhraseHits := 0
	for _, ph := range hedgePhrases {
		hedgePhraseHits += strings.Count(lower, ph)
	}

	humorPunct := len(humorPunctRe.FindAllString(text, -1))
	exclamations := strings.Count(text, "!")
	questions := strings.Count(text, "?")
	contractions := strings.Count(text, "'")
	ellipsis := strings.Count(text, "...")

	// Emoji / emoticon: cheap detection. Counts occurrences of common
	// ASCII emoticons + any rune in U+1F000..U+1FAFF (most emoji blocks).
	emojiCount := 0
	for _, em := range []string{":)", ":(", ":D", ":P", ";)", ":/", ":'(", "<3", ":-)", ":-("} {
		emojiCount += strings.Count(text, em)
	}
	for _, r := range text {
		if r >= 0x1F000 && r <= 0x1FAFF {
			emojiCount++
		}
	}

	// Pronoun rates.
	you := tokenSet["you"] + tokenSet["your"] + tokenSet["yours"] + tokenSet["you're"] + tokenSet["you've"] + tokenSet["y'all"]
	first := tokenSet["i"] + tokenSet["me"] + tokenSet["my"] + tokenSet["mine"] + tokenSet["we"] + tokenSet["us"] + tokenSet["our"] + tokenSet["ours"]

	// Per-token rates (so feature magnitudes are comparable across docs of
	// different length). Sentence length uses log1p so a 50-word legalese
	// run doesn't dominate against a 6-word slack DM.
	feats[0] = math.Log1p(avgSentLen)
	feats[1] = avgWordLen
	feats[2] = float64(count(humorMarkers)) / wcF
	feats[3] = float64(count(formalLex)) / wcF
	feats[4] = float64(count(casualLex)) / wcF
	feats[5] = float64(count(posLex)) / wcF
	feats[6] = float64(count(negLex)) / wcF
	feats[7] = float64(count(directLex)) / wcF
	feats[8] = float64(count(hedgeLex)) / wcF
	feats[9] = float64(count(warmLex)) / wcF
	feats[10] = float64(count(coldLex)) / wcF
	feats[11] = float64(you) / wcF
	feats[12] = float64(first) / wcF
	feats[13] = float64(exclamations) / wcF
	feats[14] = float64(questions) / wcF
	feats[15] = float64(humorPunct) / wcF
	feats[16] = float64(allCaps) / wcF
	feats[17] = float64(contractions) / wcF
	if len(sentences) > 0 {
		feats[18] = float64(imperativeBonus) / float64(len(sentences))
	}
	feats[19] = float64(hedgePhraseHits) / wcF
	feats[20] = float64(emojiCount) / wcF
	feats[21] = float64(ellipsis) / wcF
	return feats
}

// dotAxis returns bias + dot(weights, x) using the canonical feature
// ordering from toneFeatureNames. Both halves must stay in lockstep.
func dotAxis(w AxisFeatureWeights, x []float64) float64 {
	if len(x) < ToneFeatureCount {
		return w.Bias
	}
	return w.Bias +
		w.SentenceLen*x[0] +
		w.WordLen*x[1] +
		w.HumorLexHits*x[2] +
		w.FormalLexHits*x[3] +
		w.CasualLexHits*x[4] +
		w.PosLexHits*x[5] +
		w.NegLexHits*x[6] +
		w.DirectLexHits*x[7] +
		w.HedgeLexHits*x[8] +
		w.WarmLexHits*x[9] +
		w.ColdLexHits*x[10] +
		w.SecondPerson*x[11] +
		w.FirstPerson*x[12] +
		w.Exclamations*x[13] +
		w.QuestionMarks*x[14] +
		w.HumorPunct*x[15] +
		w.AllCapsWords*x[16] +
		w.Contractions*x[17] +
		w.ImperativeOpeners*x[18] +
		w.HedgePhraseHits*x[19] +
		w.EmojiOrEmoticon*x[20] +
		w.Ellipsis*x[21]
}

// AxisWeightAt is a helper used only by the offline trainer (cannot live
// inside the build-tagged file because it depends on package-private
// field ordering). Returns the weight at slot i in the canonical ordering.
func AxisWeightAt(w AxisFeatureWeights, i int) float64 {
	switch i {
	case 0:
		return w.SentenceLen
	case 1:
		return w.WordLen
	case 2:
		return w.HumorLexHits
	case 3:
		return w.FormalLexHits
	case 4:
		return w.CasualLexHits
	case 5:
		return w.PosLexHits
	case 6:
		return w.NegLexHits
	case 7:
		return w.DirectLexHits
	case 8:
		return w.HedgeLexHits
	case 9:
		return w.WarmLexHits
	case 10:
		return w.ColdLexHits
	case 11:
		return w.SecondPerson
	case 12:
		return w.FirstPerson
	case 13:
		return w.Exclamations
	case 14:
		return w.QuestionMarks
	case 15:
		return w.HumorPunct
	case 16:
		return w.AllCapsWords
	case 17:
		return w.Contractions
	case 18:
		return w.ImperativeOpeners
	case 19:
		return w.HedgePhraseHits
	case 20:
		return w.EmojiOrEmoticon
	case 21:
		return w.Ellipsis
	}
	return 0
}

// SetAxisWeightAt is the inverse of AxisWeightAt — used by the trainer
// when applying gradient updates slot-by-slot. Out-of-range indices are
// silently ignored.
func SetAxisWeightAt(w *AxisFeatureWeights, i int, v float64) {
	switch i {
	case 0:
		w.SentenceLen = v
	case 1:
		w.WordLen = v
	case 2:
		w.HumorLexHits = v
	case 3:
		w.FormalLexHits = v
	case 4:
		w.CasualLexHits = v
	case 5:
		w.PosLexHits = v
	case 6:
		w.NegLexHits = v
	case 7:
		w.DirectLexHits = v
	case 8:
		w.HedgeLexHits = v
	case 9:
		w.WarmLexHits = v
	case 10:
		w.ColdLexHits = v
	case 11:
		w.SecondPerson = v
	case 12:
		w.FirstPerson = v
	case 13:
		w.Exclamations = v
	case 14:
		w.QuestionMarks = v
	case 15:
		w.HumorPunct = v
	case 16:
		w.AllCapsWords = v
	case 17:
		w.Contractions = v
	case 18:
		w.ImperativeOpeners = v
	case 19:
		w.HedgePhraseHits = v
	case 20:
		w.EmojiOrEmoticon = v
	case 21:
		w.Ellipsis = v
	}
}

// ToneFeatureNames returns a copy of the canonical feature ordering. The
// trainer prints these as labels on its weight dump.
func ToneFeatureNames() []string {
	out := make([]string, len(toneFeatureNames))
	copy(out, toneFeatureNames)
	return out
}

// FittedClassifier scores tone with calibrated linear-+-sigmoid weights.
// It uses the same feature extractor as the heuristic so the only thing
// that differs is per-feature weighting.
//
// Behavior contract (matches HeuristicClassifier):
//   - empty input returns neutralTone(), no error
//   - axes are clamped to [0, 1] (sigmoid already does this, but we
//     explicitly clamp for paranoia in case a future change replaces the
//     squash function)
//   - when scoring multiple samples, each is scored independently and the
//     final ToneAxes is the per-axis arithmetic mean (matches the spirit
//     of the existing heuristic's joined-text approach without losing
//     normalization for very long single samples)
type FittedClassifier struct {
	// Weights is the calibrated weight bundle. If nil at Classify time,
	// the classifier falls back to DefaultFittedWeights() so callers don't
	// have to special-case construction.
	Weights *FittedWeights
}

// Classify implements ToneClassifier.
func (c FittedClassifier) Classify(_ context.Context, samples []string) (ToneAxes, error) {
	w := c.Weights
	if w == nil {
		dw := DefaultFittedWeights()
		w = &dw
	}
	if len(samples) == 0 {
		return neutralTone(), nil
	}
	// Drop blanks; if everything is blank, return neutral.
	live := make([]string, 0, len(samples))
	for _, s := range samples {
		if strings.TrimSpace(s) != "" {
			live = append(live, s)
		}
	}
	if len(live) == 0 {
		return neutralTone(), nil
	}

	var sum ToneAxes
	for _, s := range live {
		feats := ExtractToneFeatures(s)
		sum.Humor += sigmoid(dotAxis(w.AxisHumor, feats))
		sum.Formality += sigmoid(dotAxis(w.AxisFormality, feats))
		sum.Optimism += sigmoid(dotAxis(w.AxisOptimism, feats))
		sum.Directness += sigmoid(dotAxis(w.AxisDirectness, feats))
		sum.Warmth += sigmoid(dotAxis(w.AxisWarmth, feats))
	}
	n := float64(len(live))
	return ToneAxes{
		Humor:      round3(clamp01(sum.Humor / n)),
		Formality:  round3(clamp01(sum.Formality / n)),
		Optimism:   round3(clamp01(sum.Optimism / n)),
		Directness: round3(clamp01(sum.Directness / n)),
		Warmth:     round3(clamp01(sum.Warmth / n)),
	}, nil
}

func sigmoid(x float64) float64 {
	// Clip extreme inputs to keep the gradient finite (also avoids
	// math.Exp overflow on garbage inputs).
	if x > 30 {
		return 1
	}
	if x < -30 {
		return 0
	}
	return 1.0 / (1.0 + math.Exp(-x))
}
