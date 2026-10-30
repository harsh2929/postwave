package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds decide how much untrusted input this package holds at once.
// Each was enforced and unpinned: raising the constant to 999999999 left the
// package green, so a bound could be widened with no test noticing.

// consultSites counts lines in this package that USE a constant, excluding its
// own declaration. A value assertion alone passes on a bound nobody reads; a
// usage assertion alone passes on a bound raised to infinity.
func consultSites(t *testing.T, constant string) int {
	t.Helper()
	decl := regexp.MustCompile(`^\s*(?:const\s+)?` + regexp.QuoteMeta(constant) + `\s+(?:int64\s+|int\s+)?=`)
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	total := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || !strings.Contains(line, constant) {
				continue
			}
			if decl.MatchString(line) {
				continue
			}
			total++
		}
	}
	return total
}

// maxMigrationUploadBytes: Bounds one user-UPLOADED migration export. The uploader picks the file; this picks how much of it this service agrees to accept.
func TestBoundMaxMigrationUploadBytes(t *testing.T) {
	if maxMigrationUploadBytes != 200<<20 {
		t.Fatalf("maxMigrationUploadBytes changed to %d; confirm the new ceiling is intended", maxMigrationUploadBytes)
	}
	if sites := consultSites(t, "maxMigrationUploadBytes"); sites < 1 {
		t.Errorf("maxMigrationUploadBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxMigrationUploadChunkBytes: Bounds a single upload chunk held in memory while it is written.
func TestBoundMaxMigrationUploadChunkBytes(t *testing.T) {
	if maxMigrationUploadChunkBytes != 16<<20 {
		t.Fatalf("maxMigrationUploadChunkBytes changed to %d; confirm the new ceiling is intended", maxMigrationUploadChunkBytes)
	}
	if sites := consultSites(t, "maxMigrationUploadChunkBytes"); sites < 1 {
		t.Errorf("maxMigrationUploadChunkBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxMigrationUploadMetaBytes: Bounds the caller-supplied metadata blob that rides with an upload.
func TestBoundMaxMigrationUploadMetaBytes(t *testing.T) {
	if maxMigrationUploadMetaBytes != 64<<10 {
		t.Fatalf("maxMigrationUploadMetaBytes changed to %d; confirm the new ceiling is intended", maxMigrationUploadMetaBytes)
	}
	if sites := consultSites(t, "maxMigrationUploadMetaBytes"); sites < 1 {
		t.Errorf("maxMigrationUploadMetaBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxMigrationLabelLen: Bounds a user-supplied label that is stored and rendered.
func TestBoundMaxMigrationLabelLen(t *testing.T) {
	if maxMigrationLabelLen != 120 {
		t.Fatalf("maxMigrationLabelLen changed to %d; confirm the new ceiling is intended", maxMigrationLabelLen)
	}
	if sites := consultSites(t, "maxMigrationLabelLen"); sites < 1 {
		t.Errorf("maxMigrationLabelLen is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxMigrationNotesLen: Bounds user-supplied notes that are stored and rendered.
func TestBoundMaxMigrationNotesLen(t *testing.T) {
	if maxMigrationNotesLen != 2000 {
		t.Fatalf("maxMigrationNotesLen changed to %d; confirm the new ceiling is intended", maxMigrationNotesLen)
	}
	if sites := consultSites(t, "maxMigrationNotesLen"); sites < 1 {
		t.Errorf("maxMigrationNotesLen is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxSourceEventSyncCursorBytes: Bounds a cursor echoed back from a third-party source platform.
func TestBoundMaxSourceEventSyncCursorBytes(t *testing.T) {
	if maxSourceEventSyncCursorBytes != 64<<10 {
		t.Fatalf("maxSourceEventSyncCursorBytes changed to %d; confirm the new ceiling is intended", maxSourceEventSyncCursorBytes)
	}
	if sites := consultSites(t, "maxSourceEventSyncCursorBytes"); sites < 1 {
		t.Errorf("maxSourceEventSyncCursorBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}
