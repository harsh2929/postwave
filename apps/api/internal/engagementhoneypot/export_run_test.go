// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"errors"
	"testing"
	"time"
)

type stubLister struct {
	fetches []Fetch
	err     error
}

func (s *stubLister) ListFetches(context.Context, string, time.Time, time.Time, int) ([]Fetch, error) {
	return s.fetches, s.err
}

func exportWindow() (time.Time, time.Time) {
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	return from, from.Add(90 * 24 * time.Hour)
}

func TestExportTenantCorpusCountsCollapsedObservations(t *testing.T) {
	from, until := exportWindow()
	// Three fetches, two of them the same recipient — two observations.
	lister := &stubLister{fetches: []Fetch{
		testFetch(1, TechniqueHTMLComment),
		testFetch(1, TechniqueDisplayNone),
		testFetch(2, TechniqueHTMLComment),
	}}
	summary, err := ExportTenantCorpus(context.Background(), lister, t.TempDir(),
		"8e3d1c6a-0000-4000-8000-000000000001", from, until, 0,
		CorpusOptions{Name: "hp", Version: "2026.08.17"})
	if err != nil {
		t.Fatalf("ExportTenantCorpus: %v", err)
	}
	if summary.FetchesRead != 3 {
		t.Errorf("FetchesRead = %d, want 3", summary.FetchesRead)
	}
	if summary.Examples != 2 {
		t.Errorf("Examples = %d, want 2 — repeat fetches of one recipient are one observation", summary.Examples)
	}
}

func TestExportTenantCorpusReportsDroppedRowsRatherThanSwallowingThem(t *testing.T) {
	// A run that silently discards rows reads afterwards as "we exported
	// everything", and a corpus that quietly lost evidence looks exactly like
	// one whose evidence never arrived.
	from, until := exportWindow()
	lister := &stubLister{fetches: []Fetch{
		testFetch(1, TechniqueHTMLComment),
		testFetch(2, TechniqueOffScreen),
	}}
	summary, err := ExportTenantCorpus(context.Background(), lister, t.TempDir(),
		"8e3d1c6a-0000-4000-8000-000000000001", from, until, 0,
		CorpusOptions{Name: "hp", Version: "2026.08.17"})
	if err != nil {
		t.Fatalf("ExportTenantCorpus: %v", err)
	}
	if summary.DroppedNonCertifying != 1 {
		t.Errorf("DroppedNonCertifying = %d, want 1", summary.DroppedNonCertifying)
	}
	if summary.Examples != 1 {
		t.Errorf("Examples = %d, want 1", summary.Examples)
	}
}

func TestExportTenantCorpusFlagsATruncatedWindow(t *testing.T) {
	// A full page means there may be more evidence than the corpus contains.
	// Reading a partial quarter as a complete one would understate machine
	// prevalence for the period.
	from, until := exportWindow()
	lister := &stubLister{fetches: []Fetch{
		testFetch(1, TechniqueHTMLComment),
		testFetch(2, TechniqueHTMLComment),
	}}
	summary, err := ExportTenantCorpus(context.Background(), lister, t.TempDir(),
		"8e3d1c6a-0000-4000-8000-000000000001", from, until, 2,
		CorpusOptions{Name: "hp", Version: "2026.08.17"})
	if err != nil {
		t.Fatalf("ExportTenantCorpus: %v", err)
	}
	if !summary.Truncated {
		t.Error("a full page was not reported as truncated")
	}
}

func TestExportTenantCorpusRefusesAnEmptyWindow(t *testing.T) {
	from, _ := exportWindow()
	if _, err := ExportTenantCorpus(context.Background(), &stubLister{}, t.TempDir(),
		"t", from, from, 0, CorpusOptions{Name: "hp", Version: "2026.08.17"}); err == nil {
		t.Error("accepted a zero-length export window")
	}
}

func TestExportTenantCorpusSurfacesAReadFailure(t *testing.T) {
	from, until := exportWindow()
	_, err := ExportTenantCorpus(context.Background(),
		&stubLister{err: errors.New("database is down")}, t.TempDir(),
		"t", from, until, 0, CorpusOptions{Name: "hp", Version: "2026.08.17"})
	if err == nil {
		t.Error("a read failure produced no error, so an empty corpus would look like an honest one")
	}
}
