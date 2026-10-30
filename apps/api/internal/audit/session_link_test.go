// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBuildReplayURL_PostHog(t *testing.T) {
	start := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	end := start.Add(4 * time.Minute)
	out, err := buildReplayURL("posthog", "https://app.posthog.com/project/42", "sess-abc-123", start, end)
	if err != nil {
		t.Fatalf("buildReplayURL: %v", err)
	}
	u, perr := url.Parse(out)
	if perr != nil {
		t.Fatalf("parse: %v", perr)
	}
	if !strings.Contains(u.Path, "/replay/sess-abc-123") {
		t.Errorf("path missing session id: %s", u.Path)
	}
	q := u.Query()
	if q.Get("t") == "" {
		t.Error("expected start timestamp in `t` query param")
	}
	if q.Get("end") == "" {
		t.Error("expected end timestamp in `end` query param")
	}
}

func TestBuildReplayURL_RRWeb(t *testing.T) {
	start := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	end := start.Add(4 * time.Minute)
	out, err := buildReplayURL("rrweb", "https://cdn.example.com/replays", "sess-xyz", start, end)
	if err != nil {
		t.Fatalf("buildReplayURL: %v", err)
	}
	if !strings.Contains(out, "/sess-xyz.json") {
		t.Errorf("expected rrweb JSON suffix, got %q", out)
	}
	if !strings.Contains(out, "start=") || !strings.Contains(out, "end=") {
		t.Errorf("expected start/end query params, got %q", out)
	}
}

func TestBuildReplayURL_UnknownProvider(t *testing.T) {
	_, err := buildReplayURL("metabase", "https://example.com", "sess", time.Now(), time.Now().Add(time.Minute))
	if err == nil {
		t.Fatal("expected error for unknown provider, got nil")
	}
	if err != ErrNotAvailable {
		t.Errorf("expected ErrNotAvailable, got %v", err)
	}
}

func TestBuildReplayURL_EscapesSessionID(t *testing.T) {
	// Session ids that contain URL-unsafe chars (slashes, spaces) must
	// be percent-encoded into the path segment so the resulting URL
	// remains parseable.
	out, err := buildReplayURL("posthog", "https://app.posthog.com", "sess/with space", time.Now(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("buildReplayURL: %v", err)
	}
	if strings.Contains(out, " ") {
		t.Errorf("output contains raw space — escaping failed: %q", out)
	}
}

func TestReplayScopeWindow(t *testing.T) {
	// Guard against accidental regressions on the ±2min spec — the UI
	// (AuditReplayModal) wires the same window from the response so a
	// change here without UI alignment would surface a confused player.
	if ReplayScopeWindow != 2*time.Minute {
		t.Errorf("ReplayScopeWindow drifted from spec: got %v, want 2m", ReplayScopeWindow)
	}
}
