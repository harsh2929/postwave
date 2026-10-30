// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// updateReport regenerates the committed artifact. A flag rather than an
// always-write step: a test that silently rewrites its own expectation can
// never fail, which is the whole failure mode the drift check exists to catch.
var updateReport = flag.Bool("update", false, "rewrite the committed calibration report")

func TestWriteCalibrationReport(t *testing.T) {
	if !*updateReport {
		t.Skip("pass -update to regenerate the committed calibration report")
	}
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Clean(reportPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(BuildReport(corpus).Markdown()), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", path)
}
