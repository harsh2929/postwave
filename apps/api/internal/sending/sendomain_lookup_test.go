// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the cross-service send-domain lookup endpoint. The actual
// Postgres-backed repo is exercised against an httptest.Server with a
// fake repo so we don't need a live database in unit tests; the SQL
// shape itself is covered by the wider api integration tests.

package sending

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeSendDomainRepo is a deterministic in-memory implementation of
// SendDomainRepo used by these tests.
type fakeSendDomainRepo struct {
	// verified maps domain -> tenant id for rows where verified_at IS
	// NOT NULL.
	verified map[string]string
	// fail forces an arbitrary error path so we can exercise the 500
	// branch.
	fail error
}

func (f fakeSendDomainRepo) LookupTenantByDomain(_ context.Context, domain string) (string, error) {
	if f.fail != nil {
		return "", f.fail
	}
	if id, ok := f.verified[strings.ToLower(domain)]; ok {
		return id, nil
	}
	return "", ErrSendDomainNotFound
}

// TestSendDomainLookupHandler_Hit: a verified domain returns 200 with
// the tenant id in the JSON body.
func TestSendDomainLookupHandler_Hit(t *testing.T) {
	repo := fakeSendDomainRepo{
		verified: map[string]string{
			"acme.example.com": "11111111-2222-3333-4444-555555555555",
		},
	}
	h := SendDomainLookupHandler(repo)

	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/?domain=acme.example.com")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d want 200", resp.StatusCode)
	}
	var body struct {
		TenantID string `json:"tenant_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.TenantID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("tenant_id: got %q", body.TenantID)
	}
}

// TestSendDomainLookupHandler_Miss: an unknown domain returns 404 with
// {"error": "not_found"}.
func TestSendDomainLookupHandler_Miss(t *testing.T) {
	repo := fakeSendDomainRepo{verified: map[string]string{}}
	h := SendDomainLookupHandler(repo)

	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/?domain=unknown.example.com")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d want 404", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "not_found" {
		t.Fatalf("error: got %q want not_found", body.Error)
	}
}

// TestSendDomainLookupHandler_UnverifiedTreatedAsMiss confirms the
// repo treats unverified rows as ErrSendDomainNotFound so the handler
// returns 404 rather than 200 with a tenant id we can't trust.
func TestSendDomainLookupHandler_UnverifiedTreatedAsMiss(t *testing.T) {
	// Simulate the repo behavior: verified-only map. The unverified
	// domain is intentionally absent from the map, mirroring the
	// `WHERE verified_at IS NOT NULL` filter in the SQL query.
	repo := fakeSendDomainRepo{
		verified: map[string]string{
			"verified.example.com": "tenant-uuid-1",
		},
	}
	h := SendDomainLookupHandler(repo)

	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/?domain=pending.example.com")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d want 404 for unverified domain", resp.StatusCode)
	}
}

// TestSendDomainLookupHandler_InvalidDomain: malformed query rejects
// with 400 before touching the repo.
func TestSendDomainLookupHandler_InvalidDomain(t *testing.T) {
	repo := fakeSendDomainRepo{}
	h := SendDomainLookupHandler(repo)

	srv := httptest.NewServer(h)
	defer srv.Close()

	cases := []string{
		"",                             // missing
		"not a domain",                 // space
		"-leading-hyphen.example.com",  // leading hyphen on label
		"trailing-hyphen-.example.com", // trailing hyphen on label
		"double..dot.example.com",      // empty label
		".leading-dot.example.com",     // leading dot
		"trailing-dot.example.com.",    // trailing dot
		"just-one-label",               // no dot at all
		"bad chars$.example.com",       // disallowed punctuation
	}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			resp, err := http.Get(srv.URL + "/?domain=" + url.QueryEscape(in))
			if err != nil {
				t.Fatalf("GET: %v", err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("input %q: status got %d want 400", in, resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("content-type = %q, want application/json", ct)
			}
		})
	}
}

// TestSendDomainLookupHandler_RepoError: an unexpected repo error maps
// to 500.
func TestSendDomainLookupHandler_RepoError(t *testing.T) {
	repo := fakeSendDomainRepo{fail: errors.New("connection refused")}
	h := SendDomainLookupHandler(repo)

	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/?domain=anything.example.com")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status: got %d want 500", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "internal" {
		t.Fatalf("error: got %q want internal", body.Error)
	}
}

// TestValidDomain spot-checks the local validator. Most permutations are
// covered by the handler-level invalid-domain test; this just ensures
// the function itself stays correct in isolation as we modify it.
func TestValidDomain(t *testing.T) {
	good := []string{
		"example.com",
		"sub.example.com",
		"a-b.example.co.uk",
		"x.y",
	}
	bad := []string{
		"",
		"no-dot",
		".lead.com",
		"trail.com.",
		"two..dot.com",
		"-bad.com",
		"bad-.com",
		"BAD$.com",
	}
	for _, d := range good {
		if !validDomain(d) {
			t.Errorf("validDomain(%q) = false, want true", d)
		}
	}
	for _, d := range bad {
		if validDomain(d) {
			t.Errorf("validDomain(%q) = true, want false", d)
		}
	}
}
