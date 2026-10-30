//go:build calibrate

// Command tone-calibrate fits a single tone axis with SGD against the
// in-tree labeled corpus and prints a paste-ready AxisFeatureWeights{}
// block to stdout.
//
// Usage:
//
//	go run -tags=calibrate ./services/voice/internal/profile/tone_calibrate \
//	    --axis=humor   # one of humor|formality|optimism|directness|warmth
//
// The build tag keeps the trainer out of normal `go build ./...` output
// (it's a developer tool, not a production artifact). Re-run for each
// axis whenever the corpus changes; paste the five resulting blocks
// into tone_weights.go.
//
// Loss: per-sample MSE on the sigmoid output ((sigmoid(z) - y)^2).
// Optimizer: plain SGD, lr=0.03, l2 reg lambda=0.01, 2000 iterations,
// random shuffle each epoch (math/rand seeded with 42 for determinism).
package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/profile"
	tone_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus"
	public_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus/public"
)

const (
	defaultIters  = 2000
	defaultLR     = 0.03
	defaultLambda = 0.01
	defaultSeed   = 42
)

func main() {
	axis := flag.String("axis", "", "axis to fit: humor|formality|optimism|directness|warmth")
	iters := flag.Int("iters", defaultIters, "training iterations (epochs)")
	lr := flag.Float64("lr", defaultLR, "learning rate")
	lambda := flag.Float64("lambda", defaultLambda, "L2 regularization strength")
	seed := flag.Int64("seed", defaultSeed, "rand seed")
	allAxes := flag.Bool("all", false, "fit all 5 axes in sequence and print MAE summary")
	worst := flag.Int("worst", 0, "after fit, print the N worst-residual samples (debugging)")
	dbTenant := flag.String("db-tenant", "", "if set, merge labels from voice_profile_labels for this tenant id into the training set (requires DATABASE_URL)")
	corpus := flag.String("corpus", "synthetic", "corpus source: synthetic (in-tree LabeledSamples) | public (loaded from --cache-dir, see internal/profile/tone_corpus/public)")
	cacheDir := flag.String("cache-dir", public_corpus.DefaultCacheDir, "cache directory holding the operator-downloaded public corpora (only used with --corpus=public)")
	testSplit := flag.Float64("test-split", 0.2, "fraction held out for MAE evaluation when --corpus=public (default 0.2)")
	flag.Parse()

	// --corpus=public takes a separate code path: it loads a much
	// larger composite corpus from the operator-fetched cache, fits
	// each axis only on samples that have a labeled value for that
	// axis, and reports MAE on a held-out test split. The synthetic
	// in-tree corpus is bypassed entirely in this mode.
	if *corpus == "public" {
		if err := fitPublic(*cacheDir, *iters, *lr, *lambda, *seed, *testSplit); err != nil {
			fmt.Fprintf(os.Stderr, "calibrate: --corpus=public: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if *corpus != "synthetic" && *corpus != "" {
		fmt.Fprintf(os.Stderr, "calibrate: unknown --corpus=%s (want synthetic|public)\n", *corpus)
		os.Exit(2)
	}

	// Merge real DB-sourced labels onto the synthetic in-tree corpus
	// when --db-tenant is set. The merge is intentionally done by
	// mutating tone_corpus.LabeledSamples up front so every downstream
	// path (buildXY, fitAll, Coverage) sees the combined set.
	if *dbTenant != "" {
		merged, err := mergeDBLabels(*dbTenant)
		if err != nil {
			fmt.Fprintf(os.Stderr, "calibrate: --db-tenant load failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "calibrate: merged %d DB-sourced samples into corpus (synthetic=%d, total=%d)\n",
			len(merged)-len(tone_corpus.LabeledSamples), len(tone_corpus.LabeledSamples), len(merged))
		tone_corpus.LabeledSamples = merged
	}

	if *allAxes {
		if err := fitAll(*iters, *lr, *lambda, *seed); err != nil {
			fmt.Fprintf(os.Stderr, "calibrate: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *axis == "" {
		fmt.Fprintln(os.Stderr, "calibrate: --axis is required (or use --all)")
		os.Exit(2)
	}
	idx := tone_corpus.AxisIndex(*axis)
	if idx < 0 {
		fmt.Fprintf(os.Stderr, "calibrate: unknown axis %q\n", *axis)
		os.Exit(2)
	}

	stats := tone_corpus.Coverage()
	fmt.Fprintf(os.Stderr, "corpus: total=%d high=%d low=%d mid=%d (axis=%s)\n",
		stats.Total, stats.PerAxisHigh[idx], stats.PerAxisLow[idx], stats.PerAxisMid[idx], *axis)

	X, Y := buildXY(idx)
	fmt.Fprintf(os.Stderr, "training axis=%s: n=%d features=%d iters=%d lr=%g lambda=%g seed=%d\n",
		*axis, len(X), profile.ToneFeatureCount, *iters, *lr, *lambda, *seed)

	w := fit(X, Y, *iters, *lr, *lambda, *seed)
	mae, finalLoss := evaluate(X, Y, w)
	fmt.Fprintf(os.Stderr, "axis=%s MAE=%.4f finalMSE=%.4f\n", *axis, mae, finalLoss)

	if *worst > 0 {
		printWorstResiduals(X, Y, w, idx, *worst)
	}

	fmt.Println(formatWeightBlock(*axis, w))
}

func printWorstResiduals(X [][]float64, Y []float64, w profile.AxisFeatureWeights, axisIdx, n int) {
	type row struct {
		idx  int
		pred float64
		want float64
		diff float64
	}
	rows := make([]row, len(X))
	for i := range X {
		p := sigmoid(dot(w, X[i]))
		rows[i] = row{i, p, Y[i], math.Abs(p - Y[i])}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].diff > rows[j].diff })
	if n > len(rows) {
		n = len(rows)
	}
	fmt.Fprintf(os.Stderr, "\n--- worst %d residuals ---\n", n)
	for _, r := range rows[:n] {
		text := tone_corpus.LabeledSamples[r.idx].Text
		if len(text) > 80 {
			text = text[:80] + "..."
		}
		fmt.Fprintf(os.Stderr, "  pred=%.3f want=%.3f diff=%.3f | %s\n", r.pred, r.want, r.diff, text)
	}
}

func fitAll(iters int, lr, lambda float64, seed int64) error {
	stats := tone_corpus.Coverage()
	fmt.Fprintf(os.Stderr, "corpus coverage: total=%d\n", stats.Total)
	for i := 0; i < 5; i++ {
		fmt.Fprintf(os.Stderr, "  %s: high=%d low=%d mid=%d\n",
			tone_corpus.AxisName(i), stats.PerAxisHigh[i], stats.PerAxisLow[i], stats.PerAxisMid[i])
	}

	type result struct {
		axis     string
		mae      float64
		finalMSE float64
		block    string
	}
	results := make([]result, 0, 5)
	for i := 0; i < 5; i++ {
		axisName := tone_corpus.AxisName(i)
		X, Y := buildXY(i)
		w := fit(X, Y, iters, lr, lambda, seed)
		mae, finalMSE := evaluate(X, Y, w)
		results = append(results, result{
			axis:     axisName,
			mae:      mae,
			finalMSE: finalMSE,
			block:    formatWeightBlock(axisName, w),
		})
		fmt.Fprintf(os.Stderr, "fit axis=%s MAE=%.4f finalMSE=%.4f\n", axisName, mae, finalMSE)
	}

	fmt.Fprintln(os.Stderr, "\n--- per-axis summary ---")
	totalMSE := 0.0
	for _, r := range results {
		fmt.Fprintf(os.Stderr, "  %-10s MAE=%.4f MSE=%.4f\n", r.axis, r.mae, r.finalMSE)
		totalMSE += r.finalMSE
	}
	fmt.Fprintf(os.Stderr, "  total MSE across axes: %.4f\n", totalMSE)

	fmt.Println("// Paste-ready blocks below — copy into tone_weights.go.")
	for _, r := range results {
		fmt.Println(r.block)
		fmt.Println()
	}
	return nil
}

func buildXY(axisIdx int) ([][]float64, []float64) {
	samples := tone_corpus.LabeledSamples
	X := make([][]float64, len(samples))
	Y := make([]float64, len(samples))
	for i, s := range samples {
		X[i] = profile.ExtractToneFeatures(s.Text)
		Y[i] = s.AxisLabels()[axisIdx]
	}
	return X, Y
}

// fit trains a single axis with sigmoid output + MSE loss + L2.
//
// Update rule: dL/dz = 2 * (sigmoid(z) - y) * sigmoid'(z) * x_i.
// We fold the constant 2 into the learning rate (so lr=0.03 here is
// effectively 2*0.015 of the textbook gradient — tuning is empirical
// either way). L2 is applied once per *epoch* (not per sample) and on
// weights only, never on the bias — applying it per-sample drowns out
// the data signal because the per-token feature rates here are O(1e-2)
// while L2 keeps pulling weights toward zero on every one of N updates.
//
// Feature standardization: we z-score features in-place before fitting
// so each weight operates on a unit-variance signal. This keeps the
// learning rate sane across heterogeneous features (sentence length is
// ~log-scale, lexicon hit rates are tiny fractions). The fitted weights
// are de-standardized at the end so the saved AxisFeatureWeights apply
// directly to raw ExtractToneFeatures output — no preprocessing needed
// at inference time.
func fit(X [][]float64, Y []float64, iters int, lr, lambda float64, seed int64) profile.AxisFeatureWeights {
	rng := rand.New(rand.NewSource(seed))

	// Compute per-feature mean/std for standardization.
	n := len(X)
	mean := make([]float64, profile.ToneFeatureCount)
	std := make([]float64, profile.ToneFeatureCount)
	for _, x := range X {
		for i := 0; i < profile.ToneFeatureCount; i++ {
			mean[i] += x[i]
		}
	}
	for i := range mean {
		mean[i] /= float64(n)
	}
	for _, x := range X {
		for i := 0; i < profile.ToneFeatureCount; i++ {
			d := x[i] - mean[i]
			std[i] += d * d
		}
	}
	for i := range std {
		std[i] = math.Sqrt(std[i] / float64(n))
		if std[i] < 1e-9 {
			std[i] = 1 // degenerate column — leave it untouched
		}
	}
	// Build a standardized matrix to train on.
	Xz := make([][]float64, n)
	for k, x := range X {
		row := make([]float64, profile.ToneFeatureCount)
		for i := 0; i < profile.ToneFeatureCount; i++ {
			row[i] = (x[i] - mean[i]) / std[i]
		}
		Xz[k] = row
	}

	// Train in standardized space.
	bias := 0.0
	weights := make([]float64, profile.ToneFeatureCount)
	for i := range weights {
		weights[i] = rng.NormFloat64() * 0.01
	}

	indices := make([]int, n)
	for i := range indices {
		indices[i] = i
	}

	for it := 0; it < iters; it++ {
		rng.Shuffle(n, func(i, j int) { indices[i], indices[j] = indices[j], indices[i] })
		for _, idx := range indices {
			x := Xz[idx]
			y := Y[idx]
			z := bias
			for i, wi := range weights {
				z += wi * x[i]
			}
			p := sigmoid(z)
			diff := p - y
			grad := diff * p * (1 - p)

			bias -= lr * grad
			for i := range weights {
				weights[i] -= lr * grad * x[i]
			}
		}
		// Apply L2 once per epoch — see comment above.
		decay := 1 - lr*lambda
		for i := range weights {
			weights[i] *= decay
		}
	}

	// De-standardize: convert (w_z, b_z) on standardized X back to
	// (w_raw, b_raw) on raw X.  z = b_z + sum(w_z * (x - mean)/std)
	//                              = (b_z - sum(w_z*mean/std)) + sum(w_z/std * x)
	// So: w_raw[i] = w_z[i] / std[i]
	//     b_raw    = b_z - sum(w_z[i] * mean[i] / std[i])
	rawW := make([]float64, profile.ToneFeatureCount)
	rawB := bias
	for i := 0; i < profile.ToneFeatureCount; i++ {
		rawW[i] = weights[i] / std[i]
		rawB -= weights[i] * mean[i] / std[i]
	}

	var w profile.AxisFeatureWeights
	w.Bias = rawB
	for i := 0; i < profile.ToneFeatureCount; i++ {
		profile.SetAxisWeightAt(&w, i, rawW[i])
	}
	return w
}

func dot(w profile.AxisFeatureWeights, x []float64) float64 {
	z := w.Bias
	for i := 0; i < profile.ToneFeatureCount; i++ {
		z += profile.AxisWeightAt(w, i) * x[i]
	}
	return z
}

func sigmoid(x float64) float64 {
	if x > 30 {
		return 1
	}
	if x < -30 {
		return 0
	}
	return 1.0 / (1.0 + math.Exp(-x))
}

func evaluate(X [][]float64, Y []float64, w profile.AxisFeatureWeights) (mae, mse float64) {
	for i, x := range X {
		p := sigmoid(dot(w, x))
		d := p - Y[i]
		mae += math.Abs(d)
		mse += d * d
	}
	n := float64(len(X))
	return mae / n, mse / n
}

func formatWeightBlock(axis string, w profile.AxisFeatureWeights) string {
	names := profile.ToneFeatureNames()
	type kv struct {
		field string
		val   float64
	}
	pairs := []kv{
		{"Bias", w.Bias},
		{"SentenceLen", w.SentenceLen},
		{"WordLen", w.WordLen},
		{"HumorLexHits", w.HumorLexHits},
		{"FormalLexHits", w.FormalLexHits},
		{"CasualLexHits", w.CasualLexHits},
		{"PosLexHits", w.PosLexHits},
		{"NegLexHits", w.NegLexHits},
		{"DirectLexHits", w.DirectLexHits},
		{"HedgeLexHits", w.HedgeLexHits},
		{"WarmLexHits", w.WarmLexHits},
		{"ColdLexHits", w.ColdLexHits},
		{"SecondPerson", w.SecondPerson},
		{"FirstPerson", w.FirstPerson},
		{"Exclamations", w.Exclamations},
		{"QuestionMarks", w.QuestionMarks},
		{"HumorPunct", w.HumorPunct},
		{"AllCapsWords", w.AllCapsWords},
		{"Contractions", w.Contractions},
		{"ImperativeOpeners", w.ImperativeOpeners},
		{"HedgePhraseHits", w.HedgePhraseHits},
		{"EmojiOrEmoticon", w.EmojiOrEmoticon},
		{"Ellipsis", w.Ellipsis},
	}
	// keep deterministic ordering even if someone reorders the slice in future
	sort.SliceStable(pairs, func(i, j int) bool { return false })

	var b strings.Builder
	fmt.Fprintf(&b, "var default%sWeights = profile.AxisFeatureWeights{\n", titleCase(axis))
	for _, p := range pairs {
		fmt.Fprintf(&b, "\t%-18s %s,\n", p.field+":", formatFloat(p.val))
	}
	b.WriteString("}\n")
	_ = names // reserved for future per-feature comments
	return b.String()
}

func formatFloat(v float64) string {
	// Trim to 4 decimals — more precision than that is noise from SGD.
	return fmt.Sprintf("%.4f", v)
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// mergeDBLabels loads fully-labeled samples from voice_profile_labels
// for tenantID and returns the union of (synthetic, db). DB samples
// come last so they appear after the synthetic seed set; the trainer
// shuffles per epoch so ordering does not affect convergence.
//
// DATABASE_URL must be set in the environment. Returns an error if
// the connection fails or the query errors. ErrLabelsTableMissing is
// surfaced verbatim so the operator sees the migration hint.
func mergeDBLabels(tenantID string) ([]tone_corpus.LabeledSample, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required when --db-tenant is set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return nil, fmt.Errorf("pgxpool init: %w", err)
	}
	defer pool.Close()
	if perr := pool.Ping(ctx); perr != nil {
		return nil, fmt.Errorf("postgres ping: %w", perr)
	}
	exp := tone_corpus.DBExporter{DB: pgxQuerier{Pool: pool}, TenantID: tenantID}
	dbSamples, err := exp.LoadSamples(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]tone_corpus.LabeledSample, 0, len(tone_corpus.LabeledSamples)+len(dbSamples))
	out = append(out, tone_corpus.LabeledSamples...)
	out = append(out, dbSamples...)
	return out, nil
}

// pgxQuerier adapts a *pgxpool.Pool to tone_corpus.DBQuerier so the
// trainer can keep the corpus package free of pgx.
type pgxQuerier struct{ Pool *pgxpool.Pool }

func (q pgxQuerier) Query(ctx context.Context, sql string, args ...any) (tone_corpus.DBRows, error) {
	rows, err := q.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ----- public corpus path -----

// fitPublic implements the --corpus=public training path. It:
//
//  1. Loads the composite public corpus from cacheRoot (a no-op fast
//     fail when the operator hasn't run tone-corpus-download).
//  2. For each of the 5 axes: filters samples to those with a
//     non-sentinel label on that axis; carves out a deterministic
//     20% test split; fits SGD on the train remainder; evaluates MAE
//     on the test split.
//  3. Prints paste-ready AxisFeatureWeights blocks for tone_weights.go,
//     prefixed by per-axis sample counts and MAEs.
//
// Hyperparameters: 5000 iters, lr=0.02, lambda=0.005 (gentler L2 than
// the synthetic-corpus defaults because we have ~1000x more data and
// the L2 was previously compensating for overfit on a tiny set).
func fitPublic(cacheRoot string, iters int, lr, lambda float64, seed int64, testSplit float64) error {
	if iters == defaultIters {
		// Operator didn't override; apply the public-corpus defaults.
		iters = publicDefaultIters
	}
	if lr == defaultLR {
		lr = publicDefaultLR
	}
	if lambda == defaultLambda {
		lambda = publicDefaultLambda
	}
	if testSplit <= 0 || testSplit >= 1 {
		testSplit = 0.2
	}

	if cacheRoot == "" {
		return fmt.Errorf("--cache-dir is required with --corpus=public")
	}
	if st, err := os.Stat(cacheRoot); err != nil || !st.IsDir() {
		return fmt.Errorf("cache dir %q not found — run `tone-corpus-download --all` first", cacheRoot)
	}

	fmt.Fprintf(os.Stderr, "calibrate: loading public corpora from %s\n", cacheRoot)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	samples, stats, err := public_corpus.BuildCompositeCorpus(ctx, cacheRoot)
	if err != nil {
		return fmt.Errorf("BuildCompositeCorpus: %w", err)
	}
	if len(samples) == 0 {
		return fmt.Errorf("composite corpus is empty — operator must run tone-corpus-download --all first")
	}
	fmt.Fprintf(os.Stderr, "calibrate: composite stats: %s\n", stats)

	rng := rand.New(rand.NewSource(seed))

	// We will print per-axis blocks + a summary. Collect results
	// first so the summary is contiguous.
	type axisResult struct {
		axis     string
		nTrain   int
		nTest    int
		trainMAE float64
		testMAE  float64
		block    string
	}
	results := make([]axisResult, 0, 5)

	fmt.Println("// Paste-ready blocks below — copy into tone_weights.go.")
	fmt.Println("// Generated by `tone-calibrate --corpus=public`.")
	fmt.Println()

	for i := 0; i < 5; i++ {
		axisName := tone_corpus.AxisName(i)
		// Filter to samples with a known label on this axis.
		Xall, Yall := buildXYFromSamplesAxis(samples, i)
		if len(Xall) == 0 {
			fmt.Fprintf(os.Stderr, "axis=%s: 0 labeled samples; skipping (no fit)\n", axisName)
			continue
		}

		// Deterministic shuffle for the train/test split.
		idx := make([]int, len(Xall))
		for k := range idx {
			idx[k] = k
		}
		rng.Shuffle(len(idx), func(a, b int) { idx[a], idx[b] = idx[b], idx[a] })
		cut := int(float64(len(idx)) * (1 - testSplit))
		if cut <= 0 || cut >= len(idx) {
			cut = len(idx) - 1
		}
		trainIdx, testIdx := idx[:cut], idx[cut:]
		Xtrain := make([][]float64, len(trainIdx))
		Ytrain := make([]float64, len(trainIdx))
		for k, p := range trainIdx {
			Xtrain[k] = Xall[p]
			Ytrain[k] = Yall[p]
		}
		Xtest := make([][]float64, len(testIdx))
		Ytest := make([]float64, len(testIdx))
		for k, p := range testIdx {
			Xtest[k] = Xall[p]
			Ytest[k] = Yall[p]
		}

		fmt.Fprintf(os.Stderr, "axis=%s: train=%d test=%d iters=%d lr=%g lambda=%g\n",
			axisName, len(Xtrain), len(Xtest), iters, lr, lambda)
		w := fit(Xtrain, Ytrain, iters, lr, lambda, seed+int64(i))
		trainMAE, _ := evaluate(Xtrain, Ytrain, w)
		testMAE, _ := evaluate(Xtest, Ytest, w)
		fmt.Fprintf(os.Stderr, "axis=%s trainMAE=%.4f testMAE=%.4f\n", axisName, trainMAE, testMAE)

		results = append(results, axisResult{
			axis:     axisName,
			nTrain:   len(Xtrain),
			nTest:    len(Xtest),
			trainMAE: trainMAE,
			testMAE:  testMAE,
			block:    formatWeightBlock(axisName, w),
		})
		fmt.Println(results[len(results)-1].block)
		fmt.Println()
	}

	fmt.Fprintln(os.Stderr, "\n--- per-axis summary ---")
	for _, r := range results {
		fmt.Fprintf(os.Stderr, "  %-10s n=%d/%d trainMAE=%.4f testMAE=%.4f\n",
			r.axis, r.nTrain, r.nTest, r.trainMAE, r.testMAE)
	}
	return nil
}

const (
	publicDefaultIters  = 5000
	publicDefaultLR     = 0.02
	publicDefaultLambda = 0.005
)

// buildXYFromSamplesAxis is the public-corpus analog of buildXY: it
// filters the (text, label) pairs to those with a known label on the
// given axis, extracting features once per kept sample.
func buildXYFromSamplesAxis(samples []tone_corpus.LabeledSample, axisIdx int) ([][]float64, []float64) {
	X := make([][]float64, 0, len(samples))
	Y := make([]float64, 0, len(samples))
	for _, s := range samples {
		v := s.AxisLabels()[axisIdx]
		if !public_corpus.AxisIsKnown(v) {
			continue
		}
		X = append(X, profile.ExtractToneFeatures(s.Text))
		Y = append(Y, v)
	}
	return X, Y
}
