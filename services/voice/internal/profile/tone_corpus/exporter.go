package tone_corpus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

// Exporter pulls labeled tone samples for offline calibration. The production
// source is the shipped `voice_profile_labels` table — a hand-labeled set of
// samples tied to a tenant. The in-tree synthetic corpus remains an explicit,
// deterministic calibration seed; it is not a substitute for persisted labels.
//
// Lifecycle:
//
// DBExporter reads the persisted source; SyntheticExporter is used only when a
// caller explicitly requests the bundled seed set.
//
// The DB-backed implementation lives outside this file (see DBExporter
// stub below) because it needs a *pgxpool.Pool which we don't want to
// import here when unit-testing the synthetic path.
type Exporter interface {
	// ExportLabeled writes the labeled corpus to w as a JSON array of
	// LabeledSample objects. Returns the number of samples written.
	ExportLabeled(ctx context.Context, w io.Writer) (int, error)
}

// SyntheticExporter returns the bundled in-tree corpus. Used as the
// default when no DB is wired and as a deterministic fallback when the
// labels table is missing or empty.
type SyntheticExporter struct{}

// ExportLabeled implements Exporter.
func (SyntheticExporter) ExportLabeled(_ context.Context, w io.Writer) (int, error) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(LabeledSamples); err != nil {
		return 0, err
	}
	return len(LabeledSamples), nil
}

// LabelsTableSQL is the production query DBExporter runs against the
// table shipped in infra/migrations/0092_voice_profile_labels.sql.
//
// Schema (see 0092 for full DDL):
//
//	CREATE TABLE voice_profile_labels (
//	  id          uuid PRIMARY KEY,
//	  tenant_id   uuid NOT NULL,
//	  sample_id   text,
//	  sample_text text NOT NULL,
//	  axis        text NOT NULL CHECK (axis IN ('humor','formality','optimism','directness','warmth')),
//	  value       double precision NOT NULL CHECK (value BETWEEN 0 AND 1),
//	  labeled_by_user_id uuid,
//	  notes       text,
//	  created_at  timestamptz NOT NULL DEFAULT now()
//	);
//
// The row shape is one-axis-per-row (narrow). DBExporter pivots into
// the wide LabeledSample shape by GROUP BY sample_text + per-axis
// MAX(CASE WHEN axis = '<axis>' THEN value END). Samples missing any
// of the five axis labels are dropped (the trainer requires all five
// — zero is a label, not a missing-value sentinel).
const LabelsTableSQL = `
WITH tenant_scope AS MATERIALIZED (
    SELECT set_config('app.tenant_id', $1, true)
)
SELECT
    sample_text,
    MAX(CASE WHEN axis = 'humor'      THEN value END) AS humor,
    MAX(CASE WHEN axis = 'formality'  THEN value END) AS formality,
    MAX(CASE WHEN axis = 'optimism'   THEN value END) AS optimism,
    MAX(CASE WHEN axis = 'directness' THEN value END) AS directness,
    MAX(CASE WHEN axis = 'warmth'     THEN value END) AS warmth
FROM voice_profile_labels
CROSS JOIN tenant_scope
WHERE tenant_id = $1::uuid
GROUP BY sample_text
HAVING COUNT(DISTINCT axis) = 5
ORDER BY MIN(created_at) ASC
`

// ErrLabelsTableMissing is returned by DBExporter.ExportLabeled when a database
// is behind migration 0092. Production tenant exports surface this error; they
// must not silently replace persisted labels with a synthetic corpus.
var ErrLabelsTableMissing = errors.New("tone_corpus: voice_profile_labels table missing; apply migration 0092")

// DBQuerier is the minimal pgx surface needed by DBExporter; we accept
// an interface so callers can wire a *pgxpool.Pool, a *sql.DB shim, or a
// test double without taking a hard dep on pgx in this package.
type DBQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (DBRows, error)
}

// DBRows is the minimal Rows surface DBExporter consumes.
type DBRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// DBExporter is the production exporter. It runs LabelsTableSQL against the
// supplied DBQuerier; if the underlying table is missing it returns
// ErrLabelsTableMissing. LabelsTableSQL sets the same tenant GUC used by the
// service store in the statement before reading the FORCE-RLS relation.
type DBExporter struct {
	DB       DBQuerier
	TenantID string
}

// ExportLabeled implements Exporter. It pivots the narrow
// voice_profile_labels rows into wide LabeledSample tuples and writes
// them as JSON. A tenant with zero fully-labeled samples (samples
// missing any of the five axes) returns []. Callers that want
// fallback-to-synthetic behaviour should use ExportOrFallback or
// inspect the returned count themselves.
func (e DBExporter) ExportLabeled(ctx context.Context, w io.Writer) (int, error) {
	out, err := e.LoadSamples(ctx)
	if err != nil {
		return 0, err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return 0, err
	}
	return len(out), nil
}

// LoadSamples runs LabelsTableSQL and returns the result as a slice of
// LabeledSample. Exported so trainers can call it directly without
// round-tripping through io.Writer/JSON.
//
// Returns ErrLabelsTableMissing when the underlying relation does not
// exist (pg error code 42P01 — fresh DB, migration not yet applied).
// All other errors are returned as-is.
func (e DBExporter) LoadSamples(ctx context.Context) ([]LabeledSample, error) {
	if e.DB == nil {
		return nil, ErrLabelsTableMissing
	}
	rows, err := e.DB.Query(ctx, LabelsTableSQL, e.TenantID)
	if err != nil {
		if isUndefinedTable(err) {
			return nil, ErrLabelsTableMissing
		}
		return nil, err
	}
	defer rows.Close()
	out := make([]LabeledSample, 0, 64)
	for rows.Next() {
		var s LabeledSample
		if err := rows.Scan(&s.Text, &s.Humor, &s.Formality, &s.Optimism, &s.Directness, &s.Warmth); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// isUndefinedTable checks an error for the "undefined_table" (42P01)
// Postgres signature. Implemented via substring match so this package
// does not pull in pgx — the DBQuerier interface deliberately keeps the
// pgx dep at the call site. False positives are tolerable: the
// fallback path is "use synthetic corpus", which is safe.
func isUndefinedTable(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if msg == "" {
		return false
	}
	// pgx wraps these errors in two equivalent shapes depending on
	// driver path — substring on both signatures.
	for _, needle := range []string{"42P01", "does not exist", "undefined_table"} {
		if containsFold(msg, needle) {
			return true
		}
	}
	return false
}

// containsFold is a tiny case-insensitive substring helper so we don't
// import strings just for one call.
func containsFold(haystack, needle string) bool {
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			a := haystack[i+j]
			b := needle[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// ExportOrFallback is retained for callers that deliberately permit a
// synthetic fallback (for example a local smoke test). Production/operator
// tooling should use DBExporter directly so a missing migration cannot be
// mistaken for real tenant evidence.
func ExportOrFallback(ctx context.Context, w io.Writer, primary Exporter) (int, error) {
	if primary == nil {
		return SyntheticExporter{}.ExportLabeled(ctx, w)
	}
	n, err := primary.ExportLabeled(ctx, w)
	if errors.Is(err, ErrLabelsTableMissing) {
		return SyntheticExporter{}.ExportLabeled(ctx, w)
	}
	return n, err
}
