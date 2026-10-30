// SPDX-License-Identifier: AGPL-3.0-only

package httpcache

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestETagWeak_StableAcrossMapOrder(t *testing.T) {
	a := map[string]any{"a": 1, "b": 2, "c": []any{1, 2, 3}}
	b := map[string]any{"c": []any{1, 2, 3}, "b": 2, "a": 1}
	if ETagWeak(a) != ETagWeak(b) {
		t.Fatalf("expected equal etags for equal maps in different order: %s vs %s",
			ETagWeak(a), ETagWeak(b))
	}
}

func TestETagWeak_FormatAndPrefix(t *testing.T) {
	tag := ETagWeak(map[string]any{"x": 1})
	if !strings.HasPrefix(tag, `W/"sha256-`) || !strings.HasSuffix(tag, `"`) {
		t.Fatalf("unexpected etag shape: %q", tag)
	}
	// W/"sha256-XXXXXXXXXXXXXXXX" — 16 hex chars.
	const wantLen = len(`W/"sha256-`) + 16 + 1
	if len(tag) != wantLen {
		t.Fatalf("etag length = %d want %d (%q)", len(tag), wantLen, tag)
	}
}

func TestETagWeak_NilAndEmpty(t *testing.T) {
	if ETagWeak(nil) != `W/"empty"` {
		t.Fatalf("nil body should yield empty sentinel")
	}
}

func TestETagStrong_Shape(t *testing.T) {
	got := ETagStrong("campaign", "abc-123", 7)
	if got != `"campaign:abc-123:v7"` {
		t.Fatalf("ETagStrong = %q", got)
	}
}

func TestETagStrong_Sanitisation(t *testing.T) {
	got := ETagStrong("camp aign", `id"x`, 1)
	if strings.Contains(got, " ") || strings.Contains(got[1:len(got)-1], `"`) {
		t.Fatalf("expected sanitised tag, got %q", got)
	}
}

func TestETagFor_PrefersStrongWhenVersionSet(t *testing.T) {
	weak := ETagFor("campaign", "abc", 0, map[string]any{"v": 1})
	strong := ETagFor("campaign", "abc", 1, map[string]any{"v": 1})
	if !strings.HasPrefix(weak, "W/") {
		t.Fatalf("expected weak tag without version: %s", weak)
	}
	if strings.HasPrefix(strong, "W/") {
		t.Fatalf("expected strong tag with version: %s", strong)
	}
}

func TestIfNoneMatch_HitWrites304(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"abc"`)
	if !IfNoneMatch(w, r, `W/"abc"`) {
		t.Fatal("expected 304 hit")
	}
	if w.Code != http.StatusNotModified {
		t.Fatalf("status = %d", w.Code)
	}
	if w.Header().Get("ETag") != `W/"abc"` {
		t.Fatalf("ETag header missing")
	}
}

func TestIfNoneMatch_MissReturnsFalse(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"other"`)
	if IfNoneMatch(w, r, `W/"abc"`) {
		t.Fatal("expected miss")
	}
	if w.Header().Get("ETag") != `W/"abc"` {
		t.Fatalf("ETag header must still be set on miss")
	}
}

func TestIfNoneMatch_HandlesListedTags(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"x", W/"abc", W/"y"`)
	if !IfNoneMatch(w, r, `W/"abc"`) {
		t.Fatal("expected hit on listed tag")
	}
}

func TestPolicyApply_DefaultVisibilityIsPrivate(t *testing.T) {
	w := httptest.NewRecorder()
	(Policy{MaxAgeSec: 10}).Apply(w)
	if !strings.HasPrefix(w.Header().Get("Cache-Control"), "private") {
		t.Fatalf("default visibility should be private: %q",
			w.Header().Get("Cache-Control"))
	}
}

func TestPolicyApply_ZeroMaxAgeForcesRevalidation(t *testing.T) {
	w := httptest.NewRecorder()
	(Policy{Visibility: "public"}).Apply(w)
	cc := w.Header().Get("Cache-Control")
	if !strings.Contains(cc, "max-age=0") || !strings.Contains(cc, "must-revalidate") {
		t.Fatalf("zero max-age should force revalidation: %q", cc)
	}
}

func TestNoStore_SetsNoStore(t *testing.T) {
	w := httptest.NewRecorder()
	NoStore().Apply(w)
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("got %q", w.Header().Get("Cache-Control"))
	}
}

func TestCanonicalJSON_NestedStability(t *testing.T) {
	a := map[string]any{
		"z": map[string]any{"b": 1, "a": 2},
		"a": []any{map[string]any{"y": 1, "x": 2}},
	}
	b := map[string]any{
		"a": []any{map[string]any{"x": 2, "y": 1}},
		"z": map[string]any{"a": 2, "b": 1},
	}
	ab, err := CanonicalJSON(a)
	if err != nil {
		t.Fatal(err)
	}
	bb, err := CanonicalJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	if string(ab) != string(bb) {
		t.Fatalf("canonical JSON mismatch:\n a=%s\n b=%s", ab, bb)
	}
}
