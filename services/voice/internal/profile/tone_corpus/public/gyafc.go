package public

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GYAFC pairs informal and formal rewrites of the same Yahoo Answers
// posts. Layout (after the operator drops the licensed archive into
// cache/gyafc/):
//
//	cache/gyafc/<domain>/<split>/formal
//	cache/gyafc/<domain>/<split>/informal
//
// where <domain> is "Family_Relationships" or "Entertainment_Music"
// and <split> is "train", "tune", or "test". Files are plain text,
// one sentence per line, aligned line-for-line.
//
// We load (formal, informal) line pairs only when both files exist for
// a given (domain, split). Each pair contributes two LabeledSample
// rows to the composite corpus:
//
//	formal   -> formality = 0.9, other axes = 0.5 (unknown)
//	informal -> formality = 0.1, other axes = 0.5 (unknown)
//
// The 0.9/0.1 (not 1.0/0.0) labels reflect that even GYAFC's "formal"
// rewrites are not academic-paper formal — they're "carefully written
// answer" formal. Saturated labels at 1.0 push the sigmoid into the
// near-flat region and hurt gradient signal, so we hold back a tenth.

// LoadGYAFC returns the (formal, informal) pairs found under cacheRoot.
// If the GYAFC subdirectory is missing (the licensed corpus is a soft
// dependency), it returns (nil, nil) — composite.go treats that as
// "this corpus contributed no samples" and proceeds.
//
// All discovered splits (train+tune+test) are folded in; the trainer
// performs its own train/test split. Files that exist but mismatch in
// line count are loaded up to min(len) — better than failing.
func LoadGYAFC(cacheRoot string) ([]GYAFCPair, error) {
	root := DatasetCacheDir(cacheRoot, DatasetGYAFC)
	st, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("gyafc: stat %s: %w", root, err)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("gyafc: %s is not a directory", root)
	}

	// Walk one level: <root>/<domain>/<split>/{formal,informal}
	domains, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("gyafc: readdir: %w", err)
	}

	var pairs []GYAFCPair
	for _, d := range domains {
		if !d.IsDir() {
			continue
		}
		domainDir := filepath.Join(root, d.Name())
		splits, err := os.ReadDir(domainDir)
		if err != nil {
			continue
		}
		for _, sp := range splits {
			if !sp.IsDir() {
				continue
			}
			splitDir := filepath.Join(domainDir, sp.Name())
			formalPath := filepath.Join(splitDir, "formal")
			informalPath := filepath.Join(splitDir, "informal")
			formal, ferr := readLines(formalPath)
			informal, ierr := readLines(informalPath)
			if ferr != nil || ierr != nil {
				// One side missing → skip the split silently. GYAFC
				// ships some splits with only "test.formal" etc.; the
				// pipeline is robust to that.
				continue
			}
			n := len(formal)
			if len(informal) < n {
				n = len(informal)
			}
			for i := 0; i < n; i++ {
				f := strings.TrimSpace(formal[i])
				inf := strings.TrimSpace(informal[i])
				if f == "" || inf == "" {
					continue
				}
				pairs = append(pairs, GYAFCPair{
					Domain:   d.Name(),
					Split:    sp.Name(),
					Formal:   f,
					Informal: inf,
				})
			}
		}
	}
	return pairs, nil
}

// GYAFCPair is one aligned (formal, informal) line pair.
type GYAFCPair struct {
	Domain   string
	Split    string
	Formal   string
	Informal string
}

// readLines slurps a UTF-8 text file into a []string of trimmed lines.
// Blank lines are preserved so the formal/informal alignment by index
// stays intact (we filter blanks at the per-pair level instead).
func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	// GYAFC files have some long sentences; bump the scanner buffer
	// so we don't truncate them silently.
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	out := make([]string, 0, 1024)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
