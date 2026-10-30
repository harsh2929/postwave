// Package content runs Layer 4 — body-level analysis. The SpamScore is a
// calibrated logistic-regression scorer over a fixed feature vector derived
// from ~80 spam-trigger words plus structural HTML signals.
//
// Provenance update (historical):
//   - V1 weights were hand-tuned from public deliverability research
//     (SpamAssassin score table, Mailchimp's "spam trigger" guidance,
//     Litmus' subject-line study, Validity 2024 Sender's Snapshot).
//   - V2 (`WeightsVersion = "v0.2-fitted-2026-05"`) was fitted via
//     mini-batch SGD against the synthetic corpus at
//     internal/content/corpus/synthetic_data.go.
//   - V3 (current default, `WeightsVersion = "v0.3-public-corpora-2026-05"`)
//     is fitted against public spam/ham corpora. See weights.go for the full
//     calibration provenance and caveats.
//
// TODO(ml-seedlist-corpus): v0.3 is stronger than the old synthetic model but
// still is not trained against Moosewave's own inbox-placement outcomes. Replace
// or blend it with a model trained against real per-provider seedlist outcomes
// once `seedlist_outcomes` (or the equivalent table) is live in production.
// Would close by running `go run -tags=calibrate ./internal/content/calibrate`
// against the real CSV and pasting the printed weight block into weights.go.
// The loader at LoadWeightsWithSource also reads JSON from
// $SPAM_WEIGHTS_PATH for hot-swap without a rebuild.
package content

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/net/html"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

const maxSpamWeightsFileBytes int64 = 1 << 20

// SpamWeights captures every weight + bias used by SpamScore. Exposed as a
// type so we can serialize/deserialize it for the override path.
type SpamWeights struct {
	// TriggerWords maps lowercase phrase → coefficient applied per-1000-words
	// of body density. Weights derived from SpamAssassin's score table
	// (https://spamassassin.apache.org/old/tests_3_3_x.html), capped at 0.6
	// per term so a single phrase cannot dominate the logistic input.
	TriggerWords map[string]float64 `json:"trigger_words"`

	// SubjectTriggerMultiplier — receivers weight subject content more
	// heavily than body (Gmail "Promotions" classifier, per Litmus 2023).
	SubjectTriggerMultiplier float64 `json:"subject_trigger_multiplier"`

	CapsRatioWeight      float64 `json:"caps_ratio_weight"`
	ExclamationDensityWt float64 `json:"exclamation_density_weight"`
	ImageTextRatioWeight float64 `json:"image_text_ratio_weight"`
	LinkDensityWeight    float64 `json:"link_density_weight"`
	SubjectLengthSoftPen float64 `json:"subject_length_soft_penalty"` // applied >60 chars
	SubjectLengthHardPen float64 `json:"subject_length_hard_penalty"` // applied >100 chars
	AllCapsWordsWeight   float64 `json:"all_caps_words_weight"`       // per word
	SuspiciousLinkWeight float64 `json:"suspicious_link_weight"`      // per flagged link

	// Bias is added pre-sigmoid; calibrated so a "typical clean newsletter"
	// scores ~0.05 and a "stacked spam-trigger blast" scores ~0.85.
	Bias float64 `json:"bias"`
}

// DefaultWeights is the embedded V1 weight set. Each TriggerWord coefficient
// is the published SpamAssassin score (where available) divided by 5 — a
// rough scale alignment so the logistic input stays in [-3, +3] for
// realistic emails. Mailchimp spam-trigger and Validity flagged terms not
// in SpamAssassin get a default 0.10 weight.
//
// PRD reference: §11.2 Layer 4 (Content Analysis) — "spam-trigger ML, image
// ratio, link reputation, HTML quality".
var DefaultWeights = SpamWeights{
	TriggerWords: map[string]float64{
		// Tier-A SpamAssassin scores ≥3.0 → weight 0.50–0.60
		"viagra":            0.60,
		"cialis":            0.60,
		"lottery":           0.55,
		"winner":            0.40,
		"congratulations":   0.30,
		"million dollars":   0.55,
		"nigerian":          0.55,
		"pharmacy":          0.45,
		"weight loss":       0.40,
		"miracle":           0.35,
		"casino":            0.50,
		"bitcoin profit":    0.50,
		"crypto investment": 0.45,
		"forex":             0.40,
		// Tier-B financial / urgency triggers — weight 0.25–0.40
		"act now":            0.35,
		"limited time":       0.30,
		"urgent":             0.25,
		"order now":          0.25,
		"buy now":            0.25,
		"click here":         0.20,
		"click below":        0.20,
		"apply now":          0.20,
		"call now":           0.30,
		"don't delete":       0.40,
		"once in a lifetime": 0.40,
		"final notice":       0.40,
		"last chance":        0.25,
		"expires today":      0.30,
		"hurry":              0.20,
		// Tier-C money/free triggers — weight 0.15–0.30
		"free!":                  0.35,
		"100% free":              0.35,
		"risk free":              0.30,
		"risk-free":              0.30,
		"no obligation":          0.25,
		"no cost":                0.20,
		"earn money":             0.30,
		"make money fast":        0.45,
		"extra income":           0.30,
		"investment opportunity": 0.35,
		"double your":            0.40,
		"cash bonus":             0.30,
		"cash":                   0.10,
		"prize":                  0.20,
		"reward":                 0.10,
		"refund":                 0.15,
		"income":                 0.10,
		"money back":             0.20,
		"lowest price":           0.20,
		"cheap":                  0.20,
		"discount":               0.10,
		"save up to":             0.15,
		"save big":               0.15,
		"% off":                  0.10,
		"deal":                   0.05,
		// Tier-D guarantee / pressure — weight 0.15–0.30
		"guaranteed":       0.25,
		"100% satisfied":   0.25,
		"as seen on":       0.25,
		"as seen on tv":    0.30,
		"this isn't spam":  0.55,
		"not spam":         0.45,
		"this is not spam": 0.55,
		"all natural":      0.20,
		"miracle cure":     0.45,
		"lose weight":      0.30,
		// Tier-E adult/scam — weight 0.40–0.60
		"hot singles":  0.55,
		"meet singles": 0.55,
		"adult":        0.30,
		"xxx":          0.55,
		"escort":       0.55,
		"sex":          0.30,
		"replica":      0.40,
		"fake":         0.20,
		// Tier-F engagement-bait — weight 0.10–0.20
		"open immediately":  0.35,
		"don't hesitate":    0.20,
		"only today":        0.20,
		"per day":           0.10,
		"call free":         0.20,
		"toll free":         0.10,
		"work from home":    0.30,
		"be your own boss":  0.30,
		"pre-approved":      0.30,
		"pre approved":      0.30,
		"financial freedom": 0.25,
		"eliminate debt":    0.25,
		"consolidate debt":  0.20,
		"refinance":         0.10,
		"unsecured credit":  0.30,
	},
	SubjectTriggerMultiplier: 2.5,
	CapsRatioWeight:          2.5,
	ExclamationDensityWt:     1.5,
	ImageTextRatioWeight:     0.35,
	LinkDensityWeight:        0.10,
	SubjectLengthSoftPen:     0.20,
	SubjectLengthHardPen:     0.50,
	AllCapsWordsWeight:       0.15,
	SuspiciousLinkWeight:     0.30,
	Bias:                     -2.5, // baseline clean copy → sigmoid(-2.5) ≈ 0.076
}

var (
	weightsOnce sync.Once
	weightsCur  SpamWeights
	weightsSrc  string
)

// LoadWeights returns the active weight set. If $SPAM_WEIGHTS_PATH is set
// and the file parses, those weights win; otherwise DefaultWeights.
func LoadWeights() SpamWeights {
	w, _ := LoadWeightsWithSource()
	return w
}

// LoadWeightsWithSource returns the active weight set plus a provenance label
// that callers can surface in API responses.
func LoadWeightsWithSource() (SpamWeights, string) {
	weightsOnce.Do(func() {
		path := os.Getenv("SPAM_WEIGHTS_PATH")
		if path == "" {
			weightsCur = DefaultWeights
			weightsSrc = "embedded_hand_tuned_v1"
			return
		}
		b, err := readWeightsFile(path)
		if err != nil {
			weightsCur = DefaultWeights
			weightsSrc = "embedded_hand_tuned_v1"
			return
		}
		var w SpamWeights
		if err := json.Unmarshal(b, &w); err != nil || len(w.TriggerWords) == 0 {
			weightsCur = DefaultWeights
			weightsSrc = "embedded_hand_tuned_v1"
			return
		}
		weightsCur = w
		weightsSrc = "file:" + path
	})
	return weightsCur, weightsSrc
}

func readWeightsFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxSpamWeightsFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxSpamWeightsFileBytes {
		return nil, fmt.Errorf("spam weights file exceeds %d bytes", maxSpamWeightsFileBytes)
	}
	return b, nil
}

// Scanner runs all four content checks.
type Scanner struct {
	Weights      SpamWeights
	WeightSource string
	Resolver     Resolver // optional; used by LinkReputation when set
}

// New returns a Scanner with default weights and no DNS resolver
// (link-reputation DNSBL queries become no-ops).
func New() *Scanner {
	w, src := LoadWeightsWithSource()
	return &Scanner{Weights: w, WeightSource: src}
}

// NewWithResolver lets callers wire a real Resolver for URIBL/SURBL queries.
func NewWithResolver(r Resolver) *Scanner {
	w, src := LoadWeightsWithSource()
	return &Scanner{Weights: w, WeightSource: src, Resolver: r}
}

// ModelDisclosure documents the active scorer provenance for transparent
// local results. When logistic mode is on (the default) we surface the
// logistic-regression weights version; otherwise we fall back to the V0
// heuristic disclosure.
func (s Scanner) ModelDisclosure() domain.ModelDisclosure {
	src := s.WeightSource
	if src == "" {
		src = "embedded_hand_tuned_v1"
	}
	if useLogisticScorer() {
		return domain.ModelDisclosure{
			Name:    "postwave-content-spam-score",
			Version: WeightsVersion,
			Kind:    "heuristic", // hand-calibrated, NOT trained — be honest
			Source:  "logistic_handcal:" + WeightsVersion,
			Trained: false,
			Notes: []string{
				"Logistic regression over a fixed 25-feature vector.",
				"Weights are hand-calibrated, not trained against a labelled corpus.",
				"Set POSTWAVE_SCANNER_USE_LOGISTIC=0 to fall back to the V0 heuristic.",
				"To re-calibrate run go run -tags=calibrate ./internal/content/calibrate.",
			},
		}
	}
	return domain.ModelDisclosure{
		Name:    "postwave-content-spam-score",
		Version: "v1-legacy",
		Kind:    "heuristic",
		Source:  src,
		Trained: false,
		Notes: []string{
			"Legacy V0 heuristic (POSTWAVE_SCANNER_USE_LOGISTIC=0).",
			"Default weights are hand-tuned from public deliverability guidance.",
			"Set SPAM_WEIGHTS_PATH to load a local JSON weight override.",
		},
	}
}

// useLogisticScorer reports whether SpamScore should delegate to the new
// logistic-regression scorer (default true). Setting
// POSTWAVE_SCANNER_USE_LOGISTIC=0 forces the legacy heuristic path — useful
// for A/B comparisons against the V0 scorer.
func useLogisticScorer() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("POSTWAVE_SCANNER_USE_LOGISTIC")))
	if v == "" {
		return true
	}
	switch v {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// Score is the rich scorer return — it includes the calibrated probability,
// the per-feature contribution map, and the weights version. Existing
// callers that only need a float continue to use SpamScore() unchanged.
type Score struct {
	Probability    float64            `json:"probability"`
	Reasons        []string           `json:"reasons,omitempty"`
	Features       map[string]float64 `json:"features,omitempty"`
	WeightsVersion string             `json:"weights_version,omitempty"`
	Scorer         string             `json:"scorer"` // "logistic" | "legacy_heuristic"
}

// LogisticScore runs the calibrated logistic-regression scorer. It is the
// default code path for SpamScore when POSTWAVE_SCANNER_USE_LOGISTIC is
// unset or set to a truthy value.
func (s Scanner) LogisticScore(htmlStr, subject string) Score {
	return s.LogisticScoreWithThread(htmlStr, subject, nil)
}

// LogisticScoreWithThread is LogisticScore with optional thread metadata so
// the "fake reply" feature can fire.
func (s Scanner) LogisticScoreWithThread(htmlStr, subject string, thread *ThreadContext) Score {
	feats := Extract(subject, htmlStr, thread)
	z := 0.0
	type contrib struct {
		name string
		v    float64
	}
	contribs := make([]contrib, 0, FeatureCount)
	for i := 0; i < FeatureCount && i < len(feats); i++ {
		c := Weights[i] * feats[i]
		z += c
		contribs = append(contribs, contrib{FeatureNames[i], c})
	}
	prob := sigmoid(z)
	// Sort contribs by absolute magnitude (desc) and surface only those
	// that meaningfully push the logit (|c| > 0.15).
	sort.Slice(contribs, func(i, j int) bool {
		return math.Abs(contribs[i].v) > math.Abs(contribs[j].v)
	})
	reasons := make([]string, 0, 6)
	for _, c := range contribs {
		if math.Abs(c.v) < 0.15 || c.name == "intercept" {
			continue
		}
		direction := "+"
		if c.v < 0 {
			direction = "-"
		}
		reasons = append(reasons, direction+c.name)
		if len(reasons) >= 6 {
			break
		}
	}
	return Score{
		Probability:    prob,
		Reasons:        reasons,
		Features:       FeatureMap(feats),
		WeightsVersion: WeightsVersion,
		Scorer:         "logistic",
	}
}

// SpamScore returns a 0..1 calibrated score and the ordered triggering
// reasons (highest-impact first). Public API kept stable for handlers.
//
// Behaviour: by default delegates to LogisticScore (the new logistic
// regression scorer). When POSTWAVE_SCANNER_USE_LOGISTIC=0 it falls back
// to LegacyScore, which is the V0 hand-tuned heuristic preserved verbatim
// for A/B comparison.
func (s Scanner) SpamScore(htmlStr, subject string) (float64, []string) {
	if useLogisticScorer() {
		sc := s.LogisticScore(htmlStr, subject)
		return sc.Probability, sc.Reasons
	}
	return s.LegacyScore(htmlStr, subject)
}

// LegacyScore is the V0 hand-tuned heuristic, preserved verbatim so we can
// run side-by-side comparisons against the new logistic regression scorer.
// Callers should generally use SpamScore (which honours the feature flag).
func (s Scanner) LegacyScore(htmlStr, subject string) (float64, []string) {
	w := s.Weights
	if len(w.TriggerWords) == 0 {
		w = DefaultWeights
	}
	bodyText := stripHTML(htmlStr)
	bodyLow := strings.ToLower(bodyText)
	subjLow := strings.ToLower(subject)
	wordCount := wordsIn(bodyText)
	if wordCount == 0 {
		wordCount = 1
	}

	type contrib struct {
		reason string
		value  float64
	}
	var parts []contrib
	logit := w.Bias

	// Trigger words — body density (per-1000-words) + subject hits.
	for phrase, coef := range w.TriggerWords {
		bodyHits := strings.Count(bodyLow, phrase)
		if bodyHits > 0 {
			density := float64(bodyHits) / float64(wordCount) * 1000.0
			contribV := coef * density
			if contribV > coef*8 { // density cap so spam-only emails cannot blow up
				contribV = coef * 8
			}
			logit += contribV
			parts = append(parts, contrib{"body contains spam phrase: " + phrase, contribV})
		}
		if strings.Contains(subjLow, phrase) {
			contribV := coef * w.SubjectTriggerMultiplier
			logit += contribV
			parts = append(parts, contrib{"subject contains spam phrase: " + phrase, contribV})
		}
	}

	// Caps ratio (body+subject combined, weighted by length).
	combined := subject + " " + bodyText
	capsR := capsRatio(combined)
	if capsR > 0.30 && len(combined) > 12 {
		v := w.CapsRatioWeight * (capsR - 0.30)
		logit += v
		parts = append(parts, contrib{"high uppercase ratio (shouting)", v})
	}

	// Exclamation density (per 1000 chars of subject+body).
	combinedLen := len(combined)
	if combinedLen > 0 {
		excl := strings.Count(combined, "!")
		density := float64(excl) / float64(combinedLen) * 1000.0
		if density > 1.0 { // ~1 per 1000 chars is normal threshold (Litmus)
			v := w.ExclamationDensityWt * (density - 1.0)
			if v > 1.5 {
				v = 1.5
			}
			logit += v
			parts = append(parts, contrib{"high exclamation density", v})
		}
	}

	// Image/text ratio integration (real value computed by ImageTextRatio).
	itr := imageTextRatioStr(htmlStr)
	if itr > 1.5 { // 1.5 ~ "image-leaning"; >4 is bad
		v := w.ImageTextRatioWeight * (itr - 1.5)
		if v > 1.5 {
			v = 1.5
		}
		logit += v
		parts = append(parts, contrib{"image-heavy body (image/text ratio high)", v})
	}

	// Link density: links per 100 visible words.
	links := extractLinks(htmlStr)
	if wordCount > 0 && len(links) > 0 {
		density := float64(len(links)) / float64(wordCount) * 100.0
		if density > 3.0 { // mailbox guidance: keep <3 links per 100 words
			v := w.LinkDensityWeight * (density - 3.0)
			if v > 1.0 {
				v = 1.0
			}
			logit += v
			parts = append(parts, contrib{"link-heavy body", v})
		}
	}

	// Subject length penalties (Litmus 2023: subjects >60 chars truncate;
	// >100 chars correlate with -8% open and ~+3% promo placement).
	if n := len(subject); n > 100 {
		logit += w.SubjectLengthHardPen
		parts = append(parts, contrib{"subject exceeds 100 chars", w.SubjectLengthHardPen})
	} else if n > 60 {
		logit += w.SubjectLengthSoftPen
		parts = append(parts, contrib{"subject exceeds 60 chars", w.SubjectLengthSoftPen})
	}

	// All-caps words (≥3 chars, fully uppercase letters).
	if n := allCapsWords(combined); n > 1 {
		v := w.AllCapsWordsWeight * float64(n-1)
		if v > 1.2 {
			v = 1.2
		}
		logit += v
		parts = append(parts, contrib{"contains all-caps words", v})
	}

	// Suspicious links (raw IP, shortener, mismatched display vs href).
	susp := suspiciousLinkCount(htmlStr, links)
	if susp > 0 {
		v := w.SuspiciousLinkWeight * float64(susp)
		logit += v
		parts = append(parts, contrib{"suspicious link patterns detected", v})
	}

	score := sigmoid(logit)

	// Sort reasons by descending contribution.
	sortedReasons := make([]string, 0, len(parts))
	used := map[int]bool{}
	for range parts {
		bestIdx := -1
		bestVal := math.Inf(-1)
		for i, p := range parts {
			if used[i] {
				continue
			}
			if p.value > bestVal {
				bestVal = p.value
				bestIdx = i
			}
		}
		if bestIdx < 0 {
			break
		}
		used[bestIdx] = true
		sortedReasons = append(sortedReasons, parts[bestIdx].reason)
	}
	return score, sortedReasons
}

// ImageTextRatio returns image-byte-equivalents / visible-text-chars.
// V1 approximation: count <img> tags and weight each as 200 chars; divide
// by rendered text length. Mailbox providers flag ratios significantly
// above 1.0 as suspicious image-only mail.
func (Scanner) ImageTextRatio(htmlStr string) float64 { return imageTextRatioStr(htmlStr) }

// LinkReputation returns the worst link-reputation status across the link
// set. The new richer implementation lives in link_reputation.go and uses
// the configured Resolver. This wrapper preserves the legacy signature.
func (s Scanner) LinkReputation(ctx context.Context, links []string) domain.AuthStatus {
	rep := s.LinkReputationDetailed(ctx, links)
	return domain.AuthStatus(rep.Aggregate)
}

// HTMLIssues runs structural checks. The richer implementation lives in
// html_quality.go. This wrapper preserves the legacy signature and adds
// the new findings on top.
func (s Scanner) HTMLIssues(htmlStr string) []string {
	return AnalyzeHTMLQuality(htmlStr)
}

// Scan runs every check and returns a populated ContentScan.
func (s Scanner) Scan(ctx context.Context, htmlStr, subject string, links []string) domain.ContentScan {
	score, reasons := s.SpamScore(htmlStr, subject)
	return domain.ContentScan{
		SpamScore:      score,
		SpamReasons:    reasons,
		ImageTextRatio: s.ImageTextRatio(htmlStr),
		LinkReputation: s.LinkReputation(ctx, links),
		HTMLIssues:     s.HTMLIssues(htmlStr),
		Model:          s.ModelDisclosure(),
	}
}

// --- helpers shared across content/* files

func sigmoid(x float64) float64 { return 1.0 / (1.0 + math.Exp(-x)) }

func capsRatio(s string) float64 {
	letters, caps := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				caps++
			}
		}
	}
	if letters == 0 {
		return 0
	}
	return float64(caps) / float64(letters)
}

func allCapsWords(s string) int {
	n := 0
	for _, w := range strings.Fields(s) {
		if len(w) < 3 {
			continue
		}
		letters, ups := 0, 0
		for _, r := range w {
			if unicode.IsLetter(r) {
				letters++
				if unicode.IsUpper(r) {
					ups++
				}
			}
		}
		if letters >= 3 && ups == letters {
			n++
		}
	}
	return n
}

func wordsIn(s string) int { return len(strings.Fields(s)) }

func stripHTML(htmlStr string) string {
	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return htmlStr
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			low := strings.ToLower(n.Data)
			if low == "script" || low == "style" {
				return
			}
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			b.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return b.String()
}

func imageTextRatioStr(htmlStr string) float64 {
	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return 0
	}
	imgs, text := 0, 0
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "img") {
			imgs++
		}
		if n.Type == html.TextNode {
			text += len(strings.TrimSpace(n.Data))
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if text == 0 {
		if imgs == 0 {
			return 0
		}
		return 999
	}
	return float64(imgs*200) / float64(text)
}

func extractLinks(htmlStr string) []anchor {
	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return nil
	}
	var out []anchor
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "a") {
			href := getAttr(n, "href")
			if href != "" {
				out = append(out, anchor{Href: href, Display: strings.TrimSpace(textOf(n))})
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return out
}

type anchor struct {
	Href    string
	Display string
}

var ipv4HostPattern = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

func suspiciousLinkCount(htmlStr string, links []anchor) int {
	count := 0
	for _, a := range links {
		u, err := url.Parse(a.Href)
		if err != nil || u.Host == "" {
			continue
		}
		host := strings.ToLower(u.Hostname())
		if isShortenerHost(host) {
			count++
			continue
		}
		// raw IP host
		if ipv4HostPattern.MatchString(host) {
			count++
			continue
		}
		// mismatched display URL vs href
		if a.Display != "" && looksLikeURL(a.Display) {
			dispU, err2 := url.Parse(a.Display)
			if err2 == nil && dispU.Host != "" &&
				strings.ToLower(dispU.Hostname()) != host {
				count++
				continue
			}
		}
	}
	_ = htmlStr
	return count
}

func looksLikeURL(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") ||
		strings.HasPrefix(s, "www.")
}

func hasAttr(n *html.Node, key string) bool {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return true
		}
	}
	return false
}

func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}
