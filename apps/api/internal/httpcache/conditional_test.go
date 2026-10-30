// SPDX-License-Identifier: AGPL-3.0-only

package httpcache

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newConditionalChain(handler http.HandlerFunc) http.Handler {
	return Conditional()(handler)
}

func TestConditional_ComputesETagWhenHandlerOmits(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	et := w.Header().Get("ETag")
	if !strings.HasPrefix(et, `W/"sha256-`) {
		t.Fatalf("expected synthesised weak ETag, got %q", et)
	}
}

func TestConditional_304OnIfNoneMatchHit(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, max-age=30")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// First pass — collect the synthesised tag.
	w1 := httptest.NewRecorder()
	r1 := httptest.NewRequest(http.MethodGet, "/x", nil)
	h.ServeHTTP(w1, r1)
	tag := w1.Header().Get("ETag")
	if tag == "" {
		t.Fatal("expected ETag on first response")
	}

	// Second pass — same tag triggers 304.
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodGet, "/x", nil)
	r2.Header.Set("If-None-Match", tag)
	h.ServeHTTP(w2, r2)

	if w2.Code != http.StatusNotModified {
		t.Fatalf("status = %d want 304", w2.Code)
	}
	if w2.Body.Len() != 0 {
		t.Fatalf("304 body should be empty, got %q", w2.Body.String())
	}
	if w2.Header().Get("ETag") != tag {
		t.Fatalf("ETag missing on 304: %q", w2.Header().Get("ETag"))
	}
	if w2.Header().Get("Cache-Control") == "" {
		t.Fatalf("Cache-Control must be preserved on 304")
	}
	if w2.Header().Get("Content-Type") != "" {
		t.Fatalf("Content-Type must be stripped on 304, got %q", w2.Header().Get("Content-Type"))
	}
}

func TestConditional_WeakCompareIgnoresPrefix(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write([]byte(`hi`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"abc"`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotModified {
		t.Fatalf("expected 304 on weak match, got %d", w.Code)
	}
}

func TestConditional_ListFormMatches(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `W/"abc"`)
		_, _ = w.Write([]byte(`hi`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"x", W/"abc", W/"y"`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotModified {
		t.Fatalf("expected 304 on listed match, got %d", w.Code)
	}
}

func TestConditional_StarMatchesAny(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `W/"anything"`)
		_, _ = w.Write([]byte(`hi`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotModified {
		t.Fatalf("expected 304 on star match, got %d", w.Code)
	}
}

func TestConditional_MissReturns200WithBody(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `W/"abc"`)
		_, _ = w.Write([]byte(`hi`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"other"`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if w.Body.String() != "hi" {
		t.Fatalf("body = %q", w.Body.String())
	}
	if w.Header().Get("ETag") != `W/"abc"` {
		t.Fatalf("ETag must be preserved on miss")
	}
}

func TestConditional_NonGETPassesThrough(t *testing.T) {
	called := false
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"created":true}`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if !called {
		t.Fatal("handler must be called for POST")
	}
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d", w.Code)
	}
	if w.Body.String() == "" {
		t.Fatal("POST body must not be stripped")
	}
}

func TestConditional_HEADWithoutETagPassesThrough(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodHead, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestConditional_ErrorResponsesPassThrough(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"oops"}`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", w.Code)
	}
	if w.Body.String() == "" {
		t.Fatal("error body must be preserved")
	}
}

func TestConditional_NoStorePassesThrough(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = w.Write([]byte(`secret`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if w.Body.String() != "secret" {
		t.Fatalf("no-store body must pass through, got %q", w.Body.String())
	}
}

func TestConditional_HonoursHandlerETag(t *testing.T) {
	const fixedTag = `"campaign:42:v7"`
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", fixedTag)
		_, _ = w.Write([]byte(`{"v":7}`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", fixedTag)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotModified {
		t.Fatalf("expected 304 for handler-provided strong tag, got %d", w.Code)
	}
	if w.Header().Get("ETag") != fixedTag {
		t.Fatalf("strong ETag must be preserved verbatim, got %q", w.Header().Get("ETag"))
	}
}

func TestConditional_StreamingHandlerPassesThrough(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: first\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		_, _ = w.Write([]byte("data: second\n\n"))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `*`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "first") || !strings.Contains(w.Body.String(), "second") {
		t.Fatalf("stream bodies must be preserved, got %q", w.Body.String())
	}
}

func TestConditional_PreservesVary(t *testing.T) {
	h := newConditionalChain(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `W/"abc"`)
		w.Header().Add("Vary", "Authorization")
		w.Header().Add("Vary", "Accept-Encoding")
		_, _ = w.Write([]byte(`hi`))
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("If-None-Match", `W/"abc"`)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotModified {
		t.Fatalf("status = %d", w.Code)
	}
	vary := w.Header().Values("Vary")
	if len(vary) < 2 {
		t.Fatalf("expected Vary preserved across 304, got %v", vary)
	}
}
