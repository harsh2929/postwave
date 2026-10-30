// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestCurrentRegistryRemovesTheHistoricalSummarizationOverlabel_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	repo := &Repo{Pool: (*db.Pool)(app)}

	if got := DefaultConfig().RegistryVersion; got != CurrentRegistryV2 {
		t.Fatalf("default registry = %q, want %q", got, CurrentRegistryV2)
	}
	entries, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil {
		t.Fatalf("load current registry: %v", err)
	}
	if len(entries) != 18 {
		t.Fatalf("current registry entries = %d, want 18", len(entries))
	}
	if _, err := repo.LoadRegistry(ctx, HistoricalRegistryV1); err == nil ||
		!strings.Contains(err.Error(), "not an admissible sealed snapshot") {
		t.Fatalf("historical append-ambiguous v1 load error = %v", err)
	}
	computedSnapshot, err := registrySnapshotFingerprint(CurrentRegistryV2, entries)
	if err != nil {
		t.Fatalf("compute current registry snapshot: %v", err)
	}
	var manifestCount int
	var manifestSnapshot, provenance string
	if err := admin.QueryRow(ctx, `
SELECT entry_count, snapshot_fingerprint, provenance_state
  FROM engagement_machine_registry_versions
 WHERE registry_version=$1`, CurrentRegistryV2).Scan(
		&manifestCount, &manifestSnapshot, &provenance,
	); err != nil {
		t.Fatalf("load current registry manifest as auditor: %v", err)
	}
	if manifestCount != len(entries) || manifestSnapshot != computedSnapshot ||
		provenance != "sealed_snapshot" {
		t.Fatalf("current registry manifest count=%d fingerprint=%q provenance=%q", manifestCount, manifestSnapshot, provenance)
	}

	var corrected *RegistryEntry
	for index := range entries {
		entry := &entries[index]
		if entry.EntryID == "R_AI_SUMMARIZER_UA" || entry.MachineSubtype == SubtypeAISummarizer {
			t.Fatalf("current registry retained historical summarization overlabel: %+v", *entry)
		}
		if strings.Contains(strings.ToLower(entry.MatcherValue), "anthropic-ai") ||
			strings.Contains(strings.ToLower(entry.MatcherValue), "google-extended") {
			t.Fatalf("current registry retained a non-current-documented matcher token: %+v", *entry)
		}
		if entry.EntryID == "R_SELF_DECLARED_AGENT_UA" {
			corrected = entry
		}
	}
	if corrected == nil {
		t.Fatal("current registry has no corrected self-declared-agent rule")
	}
	if corrected.MachineSubtype != SubtypeUnknownBot ||
		!strings.Contains(corrected.SourceNote, "machine-like request evidence only") ||
		!strings.Contains(corrected.SourceNote, "does not establish inbox summarization") ||
		!strings.Contains(corrected.SourceNote, "human absence, or prevalence") {
		t.Fatalf("corrected rule claim boundary drifted: %+v", *corrected)
	}
	if err := repo.PublishRegistryEntries(ctx, entries); err != nil {
		t.Fatalf("exact current-registry replay: %v", err)
	}

	extra := append([]RegistryEntry(nil), entries...)
	extra = append(extra, RegistryEntry{
		RegistryVersion: CurrentRegistryV2,
		EntryID:         "R_UNCALIBRATED_APPEND",
		MatcherType:     MatchUASubstring,
		MatcherValue:    "uncalibrated-agent",
		MachineSubtype:  SubtypeUnknownBot,
		Confidence:      0.95,
		SourceNote:      "must not append under a calibrated immutable version",
		LastVerified:    time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC),
	})
	if err := repo.PublishRegistryEntries(ctx, extra); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("append to sealed registry error = %v, want ErrIdempotencyConflict", err)
	}

	mutated := append([]RegistryEntry(nil), entries...)
	mutated[0].SourceNote += " mutated"
	if err := repo.PublishRegistryEntries(ctx, mutated); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("mutation of sealed registry error = %v, want ErrIdempotencyConflict", err)
	}
	if err := repo.PublishRegistryEntries(ctx, entries[:len(entries)-1]); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("partial replay of sealed registry error = %v, want ErrIdempotencyConflict", err)
	}
}

func TestRegistrySnapshotFingerprintIsOrderIndependentAndMutationSensitive(t *testing.T) {
	entries := []RegistryEntry{
		registryEntry("R_SNAPSHOT_ALPHA", MatchUASubstring, "alpha", SubtypeUnknownBot, 0.95),
		registryEntry("R_SNAPSHOT_BETA", MatchSource, "beta", SubtypeSeedAutomation, 1),
	}
	first, err := registrySnapshotFingerprint(CurrentRegistryV2, entries)
	if err != nil {
		t.Fatal(err)
	}
	reversed := []RegistryEntry{entries[1], entries[0]}
	second, err := registrySnapshotFingerprint(CurrentRegistryV2, reversed)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("snapshot hash depends on publication order: %q != %q", first, second)
	}
	mutated := append([]RegistryEntry(nil), entries...)
	mutated[0].SourceNote += " changed"
	third, err := registrySnapshotFingerprint(CurrentRegistryV2, mutated)
	if err != nil {
		t.Fatal(err)
	}
	if third == first {
		t.Fatal("snapshot hash did not change when a rule changed")
	}
	if _, err := registrySnapshotFingerprint(CurrentRegistryV2, append(entries, entries[0])); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("duplicate snapshot entry error=%v, want ErrInvalidInput", err)
	}
}

func TestRegistryVersionChangesTheClassifierConfigurationHash(t *testing.T) {
	current := DefaultConfig()
	legacy := current
	legacy.RegistryVersion = HistoricalRegistryV1
	currentHash, err := current.Hash()
	if err != nil {
		t.Fatal(err)
	}
	legacyHash, err := legacy.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if currentHash == legacyHash {
		t.Fatal("v1 and v2 registry identities produced the same classifier configuration hash")
	}
}

func TestGovernedRegistryPublisherSerializesCompetingWholeSnapshots_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, app := classifierDBPools(t, ctx)
	repo := &Repo{Pool: (*db.Pool)(app)}
	base, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil {
		t.Fatal(err)
	}
	version := fmt.Sprintf("postwave.machine-source-registry.test.%d", time.Now().UnixNano())
	left := cloneRegistryVersion(base, version)
	right := cloneRegistryVersion(base, version)
	right[0].SourceNote += " competing mutation"

	start := make(chan struct{})
	errorsOut := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, proposal := range [][]RegistryEntry{left, right} {
		proposal := proposal
		go func() {
			ready.Done()
			<-start
			errorsOut <- repo.PublishRegistryEntries(ctx, proposal)
		}()
	}
	ready.Wait()
	close(start)
	firstErr, secondErr := <-errorsOut, <-errorsOut
	if !((firstErr == nil && errors.Is(secondErr, ErrIdempotencyConflict)) ||
		(secondErr == nil && errors.Is(firstErr, ErrIdempotencyConflict))) {
		t.Fatalf("competing publication errors=(%v, %v), want one success and one conflict", firstErr, secondErr)
	}
	loaded, err := repo.LoadRegistry(ctx, version)
	if err != nil || len(loaded) != len(base) {
		t.Fatalf("load winning sealed snapshot count=%d err=%v", len(loaded), err)
	}
}

func cloneRegistryVersion(entries []RegistryEntry, version string) []RegistryEntry {
	cloned := append([]RegistryEntry(nil), entries...)
	for index := range cloned {
		cloned[index].RegistryVersion = version
		cloned[index].Fingerprint = ""
	}
	return cloned
}
