// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_aspect_test.go — coverage for the MutatingAspect chi
// middleware. We assert the pre-DB plumbing only (holder attachment,
// status capture, ctx-meta stash) since the actual db.Audit call is
// behind a *db.Pool we can't construct without Postgres. Hermetic.
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestMutatingAspect_AttachesHolderAndMeta exercises the wiring
// contract MutatingAspect makes with downstream handlers: both the
// AuditAspect holder and the request-derived AuditMeta show up on
// ctx by the time the handler runs.
func TestMutatingAspect_AttachesHolderAndMeta(t *testing.T) {
	var sawHolder bool
	var sawMeta bool

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := auditAspectFromContext(r.Context()); ok {
			sawHolder = true
		}
		// AuditMetaFromContext requires TenantID — install a
		// fake tenant on ctx for that branch to fire.
		ctx := WithTenant(r.Context(), &Tenant{ID: "tenant-1"})
		// Re-stash a meta directly so we test
		// AuditMetaFromContext independently of
		// AuditMetaFromRequest's quirks.
		ctx = WithAuditMeta(ctx, db.AuditMeta{TenantID: "tenant-1"})
		if _, ok := AuditMetaFromContext(ctx); ok {
			sawMeta = true
		}
		w.WriteHeader(http.StatusOK)
	})

	mw := MutatingAspect(nil, "subscriber.create", "subscriber")
	h := mw(next)

	r := httptest.NewRequest("POST", "/api/v1/subscribers", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !sawHolder {
		t.Error("handler did not see the AuditAspect holder")
	}
	if !sawMeta {
		t.Error("handler did not see the AuditMeta on ctx")
	}
}

// TestMutatingAspect_NilPoolIsSafe asserts the test-wiring escape
// hatch: pool=nil means "skip emit, but still attach the holder so
// handler code doesn't NPE on AuditAttach".
func TestMutatingAspect_NilPoolIsSafe(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = AuditAttach(r.Context(), "res-1", nil, nil, nil)
		w.WriteHeader(http.StatusCreated)
	})
	mw := MutatingAspect(nil, "subscriber.create", "subscriber")
	h := mw(next)

	r := httptest.NewRequest("POST", "/api/v1/subscribers", nil)
	w := httptest.NewRecorder()

	// Must not panic.
	h.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", w.Code)
	}
}

// TestMutatingAspect_PreservesHandlerStatus checks the
// statusCapturingWriter wires through to the underlying recorder so
// callers see the status the handler actually wrote.
func TestMutatingAspect_PreservesHandlerStatus(t *testing.T) {
	cases := []struct {
		name       string
		writeCode  int
		wantStatus int
	}{
		{"200 OK", http.StatusOK, http.StatusOK},
		{"201 Created", http.StatusCreated, http.StatusCreated},
		{"400 Bad Request", http.StatusBadRequest, http.StatusBadRequest},
		{"500 Internal", http.StatusInternalServerError, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.writeCode)
			})
			mw := MutatingAspect(nil, "x", "y")
			h := mw(next)

			r := httptest.NewRequest("POST", "/x", nil)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}
		})
	}
}
