//go:build calibrate

// Command calibrate runs SGD on logistic loss with L2 regularisation
// against a labeled corpus and prints a `var Weights = [...]float64{ ... }`
// block ready to paste into ../weights.go.
//
// This binary is build-tagged so it never participates in the default
// service build. Invoke it explicitly:
//
//	# real CSV (text,label) corpus
//	go run -tags=calibrate \
//	  ./services/deliverability/internal/content/calibrate \
//	  -input=corpus.csv
//
//	# embedded synthetic corpus (no DB or CSV required)
//	go run -tags=calibrate \
//	  ./services/deliverability/internal/content/calibrate \
//	  -corpus=synthetic -iters=2000 -lr=0.05 -lambda=0.01
//
// Two corpus shapes are supported:
//
//  1. CSV: columns text,label (label is 0 or 1). Subject is synthesised
//     as the first 10 whitespace tokens — fine for bootstrap, but real
//     recalibration should refactor this to take subject + html columns
//     separately.
//
//  2. Synthetic: pulls SyntheticSpam + SyntheticHam from the corpus
//     package. Each sample retains its real subject + body so the
//     feature extractor sees the same shape it does in production.
//
// Loss is reported every 100 iterations to stderr. The trainer also
// prints a final loss line so callers can compare runs.
//
// Determinism: the SGD shuffle uses math/rand seeded from -seed (default
// 42). Holding the seed and the corpus fixed yields identical weights.
package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/content"
	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
	"github.com/postwave/postwave/services/deliverability/internal/content/corpus/public"
)

func main() {
	var (
		input      = flag.String("input", "", "path to CSV with columns text,label")
		corpusFlag = flag.String("corpus", "", "named corpus: 'synthetic' uses the embedded slices; 'public' loads the SpamAssassin+Enron(+TREC) composite from -cache-dir")
		cacheDir   = flag.String("cache-dir", "services/deliverability/internal/content/corpus/public/cache", "cache directory for the public corpus loader (relative paths resolve to CWD)")
		maxSamples = flag.Int("max-samples", 0, "downsample the public corpus to this many rows (0 = take everything)")
		includeTr  = flag.Bool("include-trec", true, "include the TREC 2007 loader (large download — set false to skip)")
		iters      = flag.Int("iters", 1000, "number of SGD iterations (use 5000 for the public corpus)")
		lr         = flag.Float64("lr", 0.05, "SGD learning rate (use 0.03 for the public corpus)")
		lambda     = flag.Float64("lambda", 0.01, "L2 regularisation strength")
		batch      = flag.Int("batch", 32, "mini-batch size (use 64 for the public corpus)")
		seed       = flag.Int64("seed", 42, "RNG seed for SGD example shuffling")
		testSplit  = flag.Float64("test-split", 0.0, "fraction of samples held out for evaluation (0 = no holdout; 0.2 is the recommended public-corpus split)")
	)
	flag.Parse()

	var (
		X       [][]float64
		y       []float64
		samples []corpus.Sample
		err     error
	)

	switch {
	case strings.EqualFold(*corpusFlag, "synthetic"):
		X, y, samples = loadSynthetic()
	case strings.EqualFold(*corpusFlag, "public"):
		X, y, samples, err = loadPublic(*cacheDir, *maxSamples, *includeTr, *seed)
		if err != nil {
			log.Fatalf("calibrate: public corpus: %v", err)
		}
	case *input != "":
		X, y, err = loadCSV(*input)
		if err != nil {
			log.Fatalf("calibrate: load: %v", err)
		}
	default:
		log.Fatal("calibrate: -corpus=synthetic|public or -input=path/to.csv is required")
	}

	if len(X) == 0 {
		log.Fatal("calibrate: no rows loaded")
	}
	fmt.Fprintf(os.Stderr, "calibrate: loaded %d rows, %d features per row\n", len(X), len(X[0]))

	// Optional train/test split. Deterministic via -seed so a given
	// corpus + seed always yields the same partition.
	var (
		Xtrain, Xtest [][]float64
		ytrain, ytest []float64
	)
	if *testSplit > 0 && *testSplit < 1 {
		Xtrain, ytrain, Xtest, ytest = splitTrainTest(X, y, *testSplit, *seed)
		fmt.Fprintf(os.Stderr, "calibrate: train=%d test=%d (split=%.2f, seed=%d)\n",
			len(Xtrain), len(Xtest), *testSplit, *seed)
	} else {
		Xtrain, ytrain = X, y
	}

	w, finalLoss := train(Xtrain, ytrain, *iters, *lr, *lambda, *batch, rand.New(rand.NewSource(*seed)))
	fmt.Fprintf(os.Stderr, "calibrate: final_loss=%.6f\n", finalLoss)

	if len(Xtest) > 0 {
		m := evaluate(Xtest, ytest, w)
		fmt.Fprintf(os.Stderr,
			"calibrate: test_xent=%.6f test_acc=%.4f spam{P=%.4f R=%.4f F1=%.4f} ham{P=%.4f R=%.4f F1=%.4f} n=%d\n",
			m.CrossEntropy, m.Accuracy,
			m.SpamPrecision, m.SpamRecall, m.SpamF1,
			m.HamPrecision, m.HamRecall, m.HamF1,
			len(Xtest))
	}

	_ = samples // reserved for future per-source diagnostics
	printWeights(os.Stdout, w, finalLoss)
}

func loadCSV(path string) ([][]float64, []float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.FieldsPerRecord = 2

	header, err := r.Read()
	if err == io.EOF {
		return nil, nil, fmt.Errorf("empty CSV")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("header: %w", err)
	}
	if len(header) < 2 ||
		strings.ToLower(strings.TrimSpace(header[0])) != "text" ||
		strings.ToLower(strings.TrimSpace(header[1])) != "label" {
		return nil, nil, fmt.Errorf("expected header text,label; got %v", header)
	}

	var X [][]float64
	var y []float64
	row := 0
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, fmt.Errorf("row %d: %w", row, err)
		}
		row++
		text := rec[0]
		label, err := strconv.ParseFloat(strings.TrimSpace(rec[1]), 64)
		if err != nil {
			return nil, nil, fmt.Errorf("row %d label: %w", row, err)
		}
		if label != 0 && label != 1 {
			return nil, nil, fmt.Errorf("row %d: label must be 0 or 1, got %v", row, label)
		}
		// CSV-rows have no separated subject/body columns; we treat
		// the first two whitespace-separated lines as subject when a
		// blank line is present, otherwise we synthesize the subject
		// from the first 10 tokens. This matches the legacy behavior.
		subj, body := splitSubjectBody(text)
		feats := content.Extract(subj, body, nil)
		X = append(X, feats)
		y = append(y, label)
	}
	return X, y, nil
}

// loadSynthetic pulls the embedded synthetic corpus. Real subject +
// body are preserved per sample (no synthesis), so the feature
// extractor sees the same shapes it does in production.
func loadSynthetic() ([][]float64, []float64, []corpus.Sample) {
	now := time.Now().UTC()
	samples := corpus.SyntheticSamples(now)
	X, y := featuresFromSamples(samples)
	return X, y, samples
}

// loadPublic loads the public composite corpus (SpamAssassin + Enron
// + optionally TREC 2007) from cacheDir and extracts features. The
// operator is expected to have run `spam-corpus-download --all`
// against the same cacheDir at least once.
//
// maxSamples > 0 downsamples deterministically (seed determines
// which rows survive). The downsample seed is split from the SGD
// seed so changing the SGD seed alone doesn't reshape the training
// set.
func loadPublic(cacheDir string, maxSamples int, includeTREC bool, seed int64) ([][]float64, []float64, []corpus.Sample, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opts := public.CompositeOptions{
		CacheDir:    cacheDir,
		MaxSamples:  maxSamples,
		Seed:        seed,
		IncludeTREC: includeTREC,
		Logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, format+"\n", args...)
		},
	}
	samples, summary, err := public.BuildCompositeCorpus(ctx, opts)
	if err != nil {
		return nil, nil, nil, err
	}
	fmt.Fprintf(os.Stderr, "calibrate: %s\n", summary)
	if len(samples) == 0 {
		return nil, nil, nil, fmt.Errorf("public corpus is empty under %s — run `spam-corpus-download --all --cache-dir=%s` first", cacheDir, cacheDir)
	}
	X, y := featuresFromSamples(samples)
	return X, y, samples, nil
}

// featuresFromSamples turns a []Sample into (X, y) tensors. Shared
// between loadSynthetic and loadPublic so feature-extraction
// behaviour stays identical.
func featuresFromSamples(samples []corpus.Sample) ([][]float64, []float64) {
	X := make([][]float64, 0, len(samples))
	y := make([]float64, 0, len(samples))
	for _, s := range samples {
		subject := s.Subject
		body := s.BodyHTML
		// CSV-shaped samples (rare for the public loader) may have
		// only Text populated; recover subject/body via the same
		// "\n\n" convention the trainer used historically.
		if subject == "" && body == "" && s.Text != "" {
			subject, body = splitSubjectBody(s.Text)
		}
		feats := content.Extract(subject, body, nil)
		X = append(X, feats)
		var label float64
		if s.IsSpam {
			label = 1
		}
		y = append(y, label)
	}
	return X, y
}

// splitTrainTest deterministically partitions (X, y) into a training
// set and a held-out test set. The split is computed by shuffling
// indices under math/rand seeded with `seed`, so two runs against
// the same corpus + seed yield identical partitions.
func splitTrainTest(X [][]float64, y []float64, testFrac float64, seed int64) (Xtrain [][]float64, ytrain []float64, Xtest [][]float64, ytest []float64) {
	n := len(X)
	if n == 0 {
		return
	}
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	rng := rand.New(rand.NewSource(seed ^ 0x5a17fa11)) // distinct from SGD seed
	rng.Shuffle(n, func(i, j int) { idx[i], idx[j] = idx[j], idx[i] })
	testN := int(float64(n) * testFrac)
	if testN < 1 {
		testN = 1
	}
	if testN >= n {
		testN = n - 1
	}
	Xtest = make([][]float64, testN)
	ytest = make([]float64, testN)
	for i := 0; i < testN; i++ {
		Xtest[i] = X[idx[i]]
		ytest[i] = y[idx[i]]
	}
	rest := n - testN
	Xtrain = make([][]float64, rest)
	ytrain = make([]float64, rest)
	for i := 0; i < rest; i++ {
		Xtrain[i] = X[idx[testN+i]]
		ytrain[i] = y[idx[testN+i]]
	}
	return
}

// EvalMetrics is the per-class summary printed after a public-corpus
// training run. Fields are computed at decision threshold 0.5.
type EvalMetrics struct {
	CrossEntropy  float64
	Accuracy      float64
	SpamPrecision float64
	SpamRecall    float64
	SpamF1        float64
	HamPrecision  float64
	HamRecall     float64
	HamF1         float64
}

// evaluate runs the trained weights against a held-out set and
// computes accuracy + per-class precision/recall/F1. We use a fixed
// decision threshold of 0.5; the production scorer ultimately surfaces
// a calibrated probability, so threshold tuning happens downstream of
// this trainer.
func evaluate(X [][]float64, y []float64, w []float64) EvalMetrics {
	var (
		tp, fp, tn, fn int
		xent           float64
	)
	for i, xi := range X {
		var z float64
		for j := 0; j < len(w); j++ {
			z += w[j] * xi[j]
		}
		p := 1.0 / (1.0 + math.Exp(-z))
		if p < 1e-12 {
			p = 1e-12
		}
		if p > 1-1e-12 {
			p = 1 - 1e-12
		}
		xent -= y[i]*math.Log(p) + (1-y[i])*math.Log(1-p)
		pred := 0.0
		if p >= 0.5 {
			pred = 1
		}
		switch {
		case pred == 1 && y[i] == 1:
			tp++
		case pred == 1 && y[i] == 0:
			fp++
		case pred == 0 && y[i] == 0:
			tn++
		case pred == 0 && y[i] == 1:
			fn++
		}
	}
	n := float64(len(X))
	if n == 0 {
		return EvalMetrics{}
	}
	return EvalMetrics{
		CrossEntropy:  xent / n,
		Accuracy:      float64(tp+tn) / n,
		SpamPrecision: safeDiv(float64(tp), float64(tp+fp)),
		SpamRecall:    safeDiv(float64(tp), float64(tp+fn)),
		SpamF1:        safeF1(tp, fp, fn),
		HamPrecision:  safeDiv(float64(tn), float64(tn+fn)),
		HamRecall:     safeDiv(float64(tn), float64(tn+fp)),
		HamF1:         safeF1(tn, fn, fp),
	}
}

func safeDiv(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

func safeF1(tp, fp, fn int) float64 {
	p := safeDiv(float64(tp), float64(tp+fp))
	r := safeDiv(float64(tp), float64(tp+fn))
	if p+r == 0 {
		return 0
	}
	return 2 * p * r / (p + r)
}

// splitSubjectBody recovers a (subject, bodyHTML) pair from a single
// `text` field. We split on the first "\n\n" — the same convention
// the corpus.Sample.Text format uses. If no blank line is present,
// the first 10 whitespace tokens become the subject and the full
// text becomes the body so the model still sees something.
func splitSubjectBody(text string) (subject, bodyHTML string) {
	if idx := strings.Index(text, "\n\n"); idx >= 0 {
		return strings.TrimSpace(text[:idx]), strings.TrimSpace(text[idx+2:])
	}
	fields := strings.Fields(text)
	if len(fields) > 10 {
		subject = strings.Join(fields[:10], " ")
	} else {
		subject = strings.Join(fields, " ")
	}
	return subject, "<p>" + text + "</p>"
}

// train runs mini-batch SGD on logistic loss with L2 regularisation.
// Returns (weights, final_loss) so the caller can persist both.
//
// Why mini-batch instead of single-example SGD: features are not
// uniformly scaled — `body_link_density` ranges in [0, 50] while
// most others are in [0, 1]. Single-example updates on the high-scale
// feature dominate one step then are corrected on the next, causing
// loss to oscillate without converging. Averaging gradients across
// a small batch (default 32) smooths this out and the trainer hits
// loss < 0.3 reliably across the synthetic corpus.
func train(X [][]float64, y []float64, iters int, lr, lambda float64, batchSize int, rng *rand.Rand) ([]float64, float64) {
	n := len(X)
	d := content.FeatureCount
	w := make([]float64, d)

	if batchSize <= 0 {
		batchSize = 32
	}

	for it := 0; it < iters; it++ {
		grad := make([]float64, d)
		for b := 0; b < batchSize; b++ {
			i := rng.Intn(n)
			xi := X[i]
			var z float64
			for j := 0; j < d; j++ {
				z += w[j] * xi[j]
			}
			p := 1.0 / (1.0 + math.Exp(-z))
			errPredict := p - y[i]
			for j := 0; j < d; j++ {
				grad[j] += errPredict * xi[j]
			}
		}
		// Average data gradient + L2 term, then step.
		invBatch := 1.0 / float64(batchSize)
		for j := 0; j < d; j++ {
			g := grad[j]*invBatch + 2*lambda*w[j]
			w[j] -= lr * g
		}
		if it%100 == 0 {
			loss := totalLoss(X, y, w, lambda)
			fmt.Fprintf(os.Stderr, "iter=%d loss=%.4f\n", it, loss)
		}
	}
	final := totalLoss(X, y, w, lambda)
	return w, final
}

func totalLoss(X [][]float64, y []float64, w []float64, lambda float64) float64 {
	var loss float64
	for i, xi := range X {
		var z float64
		for j := 0; j < len(w); j++ {
			z += w[j] * xi[j]
		}
		p := 1.0 / (1.0 + math.Exp(-z))
		if p < 1e-12 {
			p = 1e-12
		}
		if p > 1-1e-12 {
			p = 1 - 1e-12
		}
		loss -= y[i]*math.Log(p) + (1-y[i])*math.Log(1-p)
	}
	loss /= float64(len(X))
	var l2 float64
	for _, wj := range w {
		l2 += wj * wj
	}
	loss += lambda * l2
	return loss
}

func printWeights(out io.Writer, w []float64, finalLoss float64) {
	fmt.Fprintf(out, "// Paste the block below into weights.go (Weights variable):\n")
	fmt.Fprintf(out, "// final cross-entropy + L2 loss: %.6f\n", finalLoss)
	fmt.Fprintln(out, "var Weights = [...]float64{")
	for i, v := range w {
		name := ""
		if i < len(content.FeatureNames) {
			name = content.FeatureNames[i]
		}
		fmt.Fprintf(out, "\t%+.6f, // %d %s\n", v, i, name)
	}
	fmt.Fprintln(out, "}")
}
