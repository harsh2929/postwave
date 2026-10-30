// SPDX-License-Identifier: AGPL-3.0-only

// Command engagement-corpus extracts real observations into calibration
// CANDIDATES for a human to label (PRD F01).
//
// WHY THIS EXISTS. The calibration gate cannot pass without a labelled corpus,
// and no corpus existed — not because labelling is hard, but because there was
// nothing to label. Every candidate had to be assembled by hand out of the
// database before a reviewer could even begin. This turns "produce a corpus"
// into "review these rows", which is the part that genuinely needs a person.
//
// WHAT IT REFUSES TO DO, AND WHY THAT IS THE POINT.
//
// It never writes a ground-truth label derived from the classifier. Measuring a
// classifier against its own output is circular: it would report perfect recall
// and perfect precision on any classifier whatsoever, including a broken one,
// and the resulting bounds would be arithmetic dressed as measurement. The
// classification column is therefore not read at all — the query does not select
// it — so a label cannot leak in through a later edit either.
//
// The one exception is not an exception to that rule. `--kind controlled_machine`
// labels rows machine, and it may only extract rows where `is_seed` is true. The
// label there comes from the SEED REGISTRY — we know those mailboxes are ours and
// that traffic to them is generated — not from any verdict the classifier
// reached. Asked for controlled_machine, the tool refuses any row that is not a
// seed rather than quietly widening the definition.
//
// For every other kind it emits `ground_truth: ""`, which the corpus LOADER
// rejects. That is deliberate: an unlabelled candidate file cannot be mistaken
// for a corpus and fed to the gate by accident. The file has to pass through a
// human before it means anything.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

const maxExtract = 50000

// contractVersion is IMPORTED from the package that validates it, never
// retyped. The first version of this tool declared its own string literal, got
// one word wrong, and produced a directory the loader refused — after a reviewer
// would have done all the labelling. A shared constant makes that impossible
// rather than merely unlikely.
const contractVersion = engagementclassification.CalibrationCorpusContractV2

type options struct {
	databaseURL string
	tenantID    string
	since       time.Time
	until       time.Time
	kind        string
	limit       int
	outputDir   string
	name        string
	version     string
	provider    string
}

func main() { os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr)) }

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	opts, err := parseOptions(args, getenv, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-corpus:", err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, opts.databaseURL)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-corpus: connect:", err)
		return 1
	}
	defer pool.Close()

	examples, err := extract(ctx, pool, opts)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-corpus: extract:", err)
		return 1
	}
	if len(examples) == 0 {
		// Exit 4 mirrors engagement-calibrate's insufficient_corpus, so a script
		// wiring the two together does not have to learn two vocabularies for
		// "there was nothing to work with".
		_, _ = fmt.Fprintln(stderr, "engagement-corpus: no observations matched; nothing written")
		return 4
	}
	written, err := write(opts, examples)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-corpus: write:", err)
		return 1
	}
	report(stdout, opts, examples, written)
	return 0
}

func parseOptions(args []string, getenv func(string) string, output io.Writer) (options, error) {
	if getenv == nil {
		return options{}, fmt.Errorf("environment reader is required")
	}
	parsed := options{kind: "labeled_human", limit: 2000, version: "v1"}
	var databaseURLFlag, sinceFlag, untilFlag string
	flags := flag.NewFlagSet("engagement-corpus", flag.ContinueOnError)
	flags.SetOutput(output)
	// Kept out of the FlagSet default like engagement-calibrate does, so --help
	// never prints database credentials.
	flags.StringVar(&databaseURLFlag, "database-url", "", "PostgreSQL URL (default DATABASE_URL)")
	flags.StringVar(&parsed.tenantID, "tenant", "", "tenant UUID to extract from (required)")
	flags.StringVar(&sinceFlag, "since", "", "inclusive RFC3339 window start (required)")
	flags.StringVar(&untilFlag, "until", "", "exclusive RFC3339 window end (required)")
	flags.StringVar(&parsed.kind, "kind", parsed.kind,
		"corpus kind: labeled_human | correlated_human | controlled_machine")
	flags.IntVar(&parsed.limit, "limit", parsed.limit, "maximum candidates to extract")
	flags.StringVar(&parsed.outputDir, "out", "", "output directory (required)")
	flags.StringVar(&parsed.name, "name", "", "corpus name (required)")
	flags.StringVar(&parsed.version, "corpus-version", parsed.version, "corpus version")
	flags.StringVar(&parsed.provider, "provider", "", "provider label recorded on every example")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	parsed.databaseURL = strings.TrimSpace(databaseURLFlag)
	if parsed.databaseURL == "" {
		parsed.databaseURL = strings.TrimSpace(getenv("DATABASE_URL"))
	}
	if parsed.databaseURL == "" {
		return options{}, fmt.Errorf("--database-url or DATABASE_URL is required")
	}
	for _, required := range []struct{ name, value string }{
		{"--tenant", parsed.tenantID}, {"--out", parsed.outputDir}, {"--name", parsed.name},
	} {
		if strings.TrimSpace(required.value) == "" {
			return options{}, fmt.Errorf("%s is required", required.name)
		}
	}
	switch parsed.kind {
	case "labeled_human", "correlated_human", "controlled_machine":
	default:
		return options{}, fmt.Errorf("--kind must be labeled_human, correlated_human or controlled_machine")
	}
	if parsed.limit < 1 || parsed.limit > maxExtract {
		return options{}, fmt.Errorf("--limit must be between 1 and %d", maxExtract)
	}
	var err error
	// An EXPLICIT window, both ends. A defaulted one would make the same command
	// produce a different corpus tomorrow, and a corpus whose contents depend on
	// when it was extracted cannot be re-derived by whoever audits the bounds.
	if parsed.since, err = time.Parse(time.RFC3339, strings.TrimSpace(sinceFlag)); err != nil {
		return options{}, fmt.Errorf("--since must be RFC3339: %w", err)
	}
	if parsed.until, err = time.Parse(time.RFC3339, strings.TrimSpace(untilFlag)); err != nil {
		return options{}, fmt.Errorf("--until must be RFC3339: %w", err)
	}
	if !parsed.until.After(parsed.since) {
		return options{}, fmt.Errorf("--until must be after --since")
	}
	return parsed, nil
}

// candidate mirrors CalibrationExampleV2's wire shape. It is declared here
// rather than imported so this tool cannot accidentally gain access to a
// constructor that fills GroundTruth in.
type candidate struct {
	ID                     string          `json:"id"`
	Provider               string          `json:"provider,omitempty"`
	SamplingUnitHash       string          `json:"sampling_unit_hash"`
	GroundTruth            string          `json:"ground_truth"`
	Source                 string          `json:"source"`
	EventType              string          `json:"event_type"`
	OccurredAt             time.Time       `json:"occurred_at"`
	DeliveredAt            *time.Time      `json:"delivered_at,omitempty"`
	IsSeed                 bool            `json:"is_seed,omitempty"`
	OrderedHeaders         json.RawMessage `json:"ordered_headers,omitempty"`
	OrderedHeadersComplete bool            `json:"ordered_headers_complete,omitempty"`
	UserAgent              string          `json:"user_agent,omitempty"`
	IP                     string          `json:"ip,omitempty"`
	NetworkASN             *uint32         `json:"network_asn,omitempty"`
	NetworkASNSource       string          `json:"network_asn_source,omitempty"`
	NetworkRegion          string          `json:"network_region,omitempty"`
	ReverseDNS             string          `json:"reverse_dns,omitempty"`
	TLSJA4                 string          `json:"tls_ja4,omitempty"`
	DwellMilliseconds      *int64          `json:"dwell_milliseconds,omitempty"`
	MessageLinkCount       *int            `json:"message_link_count,omitempty"`
}

func extract(ctx context.Context, pool *pgxpool.Pool, opts options) ([]candidate, error) {
	// NOTE THE ABSENT COLUMN. `classification` is not selected, and that is the
	// load-bearing property of this query: a ground-truth label derived from the
	// classifier would make the calibration measure the classifier against
	// itself. It cannot leak in through a later edit to the scan loop either,
	// because the value is never fetched.
	//
	// Seed scoping is applied in SQL rather than in Go so an operator asking for
	// controlled_machine cannot receive a non-seed row at all.
	seedPredicate := ""
	switch opts.kind {
	case "controlled_machine":
		seedPredicate = " AND o.is_seed = true"
	default:
		// A seed is OUR traffic. Including one in a human corpus would label
		// generated traffic as a person, which is the same fabrication in the
		// opposite direction.
		seedPredicate = " AND o.is_seed = false"
	}
	rows, err := pool.Query(ctx, `
SELECT o.id::text, o.source, o.event_type, o.occurred_at, o.delivered_at, o.is_seed,
       o.ordered_headers, o.ordered_headers_complete,
       COALESCE(o.user_agent, ''), COALESCE(host(o.ip_address), ''),
       o.network_asn, COALESCE(o.network_asn_source, ''),
       COALESCE(o.network_region, ''), COALESCE(o.reverse_dns, ''), COALESCE(o.tls_ja4, ''),
       o.dwell_milliseconds, o.message_link_count,
       o.observation_fingerprint
  FROM subscriber_event_observations o
 WHERE o.tenant_id = $1::uuid
   AND o.subscriber_event_at >= $2
   AND o.subscriber_event_at < $3
   AND o.degraded_at IS NULL`+seedPredicate+`
 ORDER BY o.subscriber_event_at, o.id
 LIMIT $4`, opts.tenantID, opts.since, opts.until, opts.limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groundTruth := ""
	if opts.kind == "controlled_machine" {
		// The ONLY auto-label in this tool, and it does not come from the
		// classifier: a seed mailbox is one we own, so traffic to it is generated
		// by construction. That is what makes ControlledMachineCorpus controlled.
		groundTruth = "machine"
	}

	out := make([]candidate, 0, 64)
	for rows.Next() {
		var c candidate
		var fingerprint string
		var headers []byte
		if err := rows.Scan(
			&c.ID, &c.Source, &c.EventType, &c.OccurredAt, &c.DeliveredAt, &c.IsSeed,
			&headers, &c.OrderedHeadersComplete,
			&c.UserAgent, &c.IP,
			&c.NetworkASN, &c.NetworkASNSource,
			&c.NetworkRegion, &c.ReverseDNS, &c.TLSJA4,
			&c.DwellMilliseconds, &c.MessageLinkCount,
			&fingerprint,
		); err != nil {
			return nil, err
		}
		if len(headers) > 0 && string(headers) != "[]" {
			c.OrderedHeaders = json.RawMessage(headers)
		}
		c.GroundTruth = groundTruth
		c.Provider = opts.provider
		// The sampling unit hash must be stable and globally unique so evaluation
		// can reject duplicates across corpora. The observation fingerprint
		// already carries that property; hashing it with the corpus name keeps
		// two corpora extracted from overlapping windows from colliding.
		c.SamplingUnitHash = hashUnit(opts.name, fingerprint)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if opts.kind == "controlled_machine" {
		for _, c := range out {
			if !c.IsSeed {
				return nil, fmt.Errorf("controlled_machine extraction produced a non-seed row (%s); refusing", c.ID)
			}
		}
	}
	return out, nil
}

func hashUnit(corpusName, fingerprint string) string {
	sum := sha256.Sum256([]byte(corpusName + "\x00" + fingerprint))
	return hex.EncodeToString(sum[:])
}

type manifest struct {
	ContractVersion string `json:"contract_version"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Version         string `json:"version"`
	Provider        string `json:"provider,omitempty"`
	SamplingUnit    string `json:"sampling_unit"`
	SampleCount     int    `json:"sample_count"`
	ExamplesFile    string `json:"examples_file"`
	ExamplesSHA256  string `json:"examples_sha256"`
}

func write(opts options, examples []candidate) (string, error) {
	if err := os.MkdirAll(opts.outputDir, 0o755); err != nil {
		return "", err
	}
	// NDJSON — one example per LINE, not a JSON array.
	//
	// That is the shape the loader reads (it splits on newlines and decodes each
	// line strictly), and the first version of this tool wrote an indented array
	// that the loader refused. It also happens to be the right shape for the job:
	// a reviewer labelling by hand edits one line per example, and a diff of a
	// labelling session shows exactly which examples changed rather than
	// reformatting the whole file.
	var buffer bytes.Buffer
	for _, example := range examples {
		line, err := json.Marshal(example)
		if err != nil {
			return "", err
		}
		buffer.Write(line)
		buffer.WriteByte('\n')
	}
	body := buffer.Bytes()
	examplesPath := filepath.Join(opts.outputDir, "examples.json")
	if err := os.WriteFile(examplesPath, body, 0o644); err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	m := manifest{
		ContractVersion: contractVersion,
		Name:            opts.name,
		Kind:            opts.kind,
		Version:         opts.version,
		Provider:        opts.provider,
		SamplingUnit:    "message_recipient_event",
		SampleCount:     len(examples),
		ExamplesFile:    "examples.json",
		ExamplesSHA256:  hex.EncodeToString(sum[:]),
	}
	manifestBody, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	return examplesPath, os.WriteFile(
		filepath.Join(opts.outputDir, "manifest.json"), append(manifestBody, '\n'), 0o644)
}

func report(stdout io.Writer, opts options, examples []candidate, path string) {
	byEvent := map[string]int{}
	unlabelled := 0
	for _, c := range examples {
		byEvent[c.EventType]++
		if c.GroundTruth == "" {
			unlabelled++
		}
	}
	kinds := make([]string, 0, len(byEvent))
	for k := range byEvent {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)

	_, _ = fmt.Fprintf(stdout, "extracted %d candidates to %s\n", len(examples), path)
	for _, k := range kinds {
		_, _ = fmt.Fprintf(stdout, "  %-12s %d\n", k, byEvent[k])
	}
	if unlabelled == 0 {
		_, _ = fmt.Fprintf(stdout, "\nkind=%s: every example is labelled machine from the SEED REGISTRY,\n"+
			"not from any classifier verdict. Review before use.\n", opts.kind)
		return
	}
	// The instruction is part of the output because the file is useless without
	// it, and because a reviewer who does not know the labels are missing may
	// assume an empty string means something.
	// The corpus kinds are SINGLE-CLASS: the loader requires every example in a
	// labeled_human or correlated_human corpus to be human, and every example in
	// a controlled_machine corpus to be machine. So the reviewer's task is not
	// "label each row" — it is "keep the rows that genuinely are this class and
	// DELETE the rest". Saying that here saves discovering it after labelling a
	// whole file the loader then rejects, which is exactly how this tool's own
	// round-trip test failed the first time.
	_, _ = fmt.Fprintf(stdout, `
%d of %d examples have ground_truth "" and must be reviewed by a person before
this is a corpus. The classifier's own verdict was deliberately NOT read: a
corpus labelled from it would measure the classifier against itself and report
perfect accuracy for any classifier at all, including a broken one.

kind=%s is SINGLE-CLASS. Every retained example must be ground_truth %q; the
loader refuses the whole corpus otherwise. Your task is therefore:

  1. read each line and decide whether it genuinely is %s traffic
  2. set ground_truth to %q on the ones that are
  3. DELETE the lines that are not — do not relabel them
  4. update sample_count and recompute examples_sha256 in manifest.json

Deleting rather than relabelling is the point: a row you are unsure about is
evidence of nothing, and a corpus padded with uncertain rows produces confident
bounds that were never earned.
`, unlabelled, len(examples), opts.kind, expectedTruth(opts.kind),
		expectedTruth(opts.kind), expectedTruth(opts.kind))
}

var _ = pgx.ErrNoRows

// expectedTruth is the single class a corpus kind admits. The loader enforces
// this; the tool states it so a reviewer learns it before doing the work rather
// than after.
func expectedTruth(kind string) string {
	if kind == "controlled_machine" {
		return "machine"
	}
	return "human"
}
