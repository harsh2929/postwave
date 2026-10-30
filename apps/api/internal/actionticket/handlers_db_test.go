// SPDX-License-Identifier: AGPL-3.0-only

package actionticket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The property that matters most: a prefetch must change nothing.
//
// Email clients, gateways and security scanners fetch links. A GET that
// redeemed would approve things nobody clicked — from a scanner, before the
// message was opened. That is why the link previews and a button posts.

func newTicketRouter(t *testing.T, repo *Repo, perform func(*http.Request, Redeemed) error) chi.Router {
	t.Helper()
	r := chi.NewRouter()
	(&Deps{Repo: repo, Perform: perform}).MountRoutes(r)
	return r
}

func TestPreviewingALinkDoesNotConsumeIt(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	router := newTicketRouter(t, repo, func(*http.Request, Redeemed) error { return nil })

	// Three prefetches, as a scanner and two mail clients would do.
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
			"/api/v1/actions/preview?ticket="+ticket.Secret, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("preview %d: status %d", i, rec.Code)
		}
		var body previewResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		// The label comes from the shared catalog, so the page reads like the
		// in-app button rather than restating it.
		if body.Label != "Approve" {
			t.Errorf("label = %q, want the catalog's %q", body.Label, "Approve")
		}
		if body.ResourceID != "a-1" {
			t.Errorf("resource = %q; the person cannot see what they are approving", body.ResourceID)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Error("no no-store; a shared proxy could cache a ticket response")
		}
	}

	// And it is still redeemable. If preview consumed, every scanned email would
	// burn its own link before the person ever saw it.
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(redeemRequest{Ticket: ticket.Secret})
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/actions/redeem", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("redeem after three previews: status %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestRedeemPerformsTheActionExactlyOnce(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	var performed []Redeemed
	router := newTicketRouter(t, repo, func(_ *http.Request, red Redeemed) error {
		performed = append(performed, red)
		return nil
	})

	post := func() int {
		body, _ := json.Marshal(redeemRequest{Ticket: ticket.Secret})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/actions/redeem", bytes.NewReader(body)))
		return rec.Code
	}
	if code := post(); code != http.StatusOK {
		t.Fatalf("first redeem: status %d", code)
	}
	// The person refreshes the confirmation page.
	if code := post(); code != http.StatusGone {
		t.Fatalf("second redeem: status %d, want 410", code)
	}
	if len(performed) != 1 {
		t.Fatalf("the action ran %d times; refreshing a confirmation page approves "+
			"again", len(performed))
	}
	if performed[0].TenantID != tenantID || performed[0].Action != "approval.approve" {
		t.Fatalf("performed %+v", performed[0])
	}
}

// Every rejection reads the same. Distinguishing them turns the endpoint into an
// oracle for guessing secrets.
func TestEveryRejectionLooksIdentical(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	spent, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := repo.Redeem(ctx, spent.Secret, "approval.approve", "approval", "a-1", ""); err != nil {
		t.Fatalf("spend: %v", err)
	}
	router := newTicketRouter(t, repo, func(*http.Request, Redeemed) error { return nil })

	var bodies []string
	for _, secret := range []string{spent.Secret, "not-a-real-ticket", ""} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
			"/api/v1/actions/preview?ticket="+secret, nil))
		if rec.Code != http.StatusGone {
			t.Fatalf("secret %q: status %d, want 410 for every rejection", secret, rec.Code)
		}
		bodies = append(bodies, rec.Body.String())
	}
	for i := 1; i < len(bodies); i++ {
		if bodies[i] != bodies[0] {
			t.Fatalf("rejections differ:\n  %s\n  %s\nA bearer could tell a spent "+
				"ticket from a nonexistent one and probe for valid secrets.",
				bodies[0], bodies[i])
		}
	}
}

// An unwired action is refused without destroying the one-use credential.
func TestAnUnwiredActionReportsFailureWithoutSpendingTheTicket(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	router := newTicketRouter(t, repo, nil)

	body, _ := json.Marshal(redeemRequest{Ticket: ticket.Secret})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/actions/redeem", bytes.NewReader(body)))
	if rec.Code == http.StatusOK {
		t.Fatal("an unwired action reported success; the person believes their " +
			"approval landed and nothing happened")
	}

	// Wiring can recover and the original credential is still usable.
	recovered := newTicketRouter(t, repo, func(*http.Request, Redeemed) error { return nil })
	retry := httptest.NewRecorder()
	recovered.ServeHTTP(retry, httptest.NewRequest(http.MethodPost,
		"/api/v1/actions/redeem", bytes.NewReader(body)))
	if retry.Code != http.StatusOK {
		t.Fatalf("retry after wiring: status %d body %s", retry.Code, retry.Body.String())
	}
}

// A failing handler must surface, not be swallowed into a success.
func TestAFailingActionIsReportedNotSwallowed(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	router := newTicketRouter(t, repo, func(*http.Request, Redeemed) error {
		return errors.New("approval store unavailable")
	})
	body, _ := json.Marshal(redeemRequest{Ticket: ticket.Secret})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/actions/redeem", bytes.NewReader(body)))
	if rec.Code == http.StatusOK {
		t.Fatal("a failed action reported success")
	}

	// A transient executor failure must not spend the ticket. The old ordering
	// committed used_at first, making this retry return 410 forever.
	recovered := newTicketRouter(t, repo, func(*http.Request, Redeemed) error { return nil })
	retry := httptest.NewRecorder()
	recovered.ServeHTTP(retry, httptest.NewRequest(http.MethodPost,
		"/api/v1/actions/redeem", bytes.NewReader(body)))
	if retry.Code != http.StatusOK {
		t.Fatalf("retry after transient failure: status %d body %s", retry.Code, retry.Body.String())
	}
}

func TestHTMLPreviewRendersAccessiblePostConfirmation(t *testing.T) {
	pool := ticketPool(t)
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}
	ticket, err := repo.Mint(context.Background(), tenantID, userID,
		"approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	router := newTicketRouter(t, repo, func(*http.Request, Redeemed) error { return nil })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/actions/preview?ticket="+ticket.Secret, nil)
	req.Header.Set("Accept", "text/html")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, required := range []string{
		`<html lang="en">`, `aria-labelledby="action-title"`, `<form method="post"`,
		`name="ticket"`, `Confirm Approve`,
	} {
		if !bytes.Contains(rec.Body.Bytes(), []byte(required)) {
			t.Errorf("HTML preview missing %q: %s", required, rec.Body.String())
		}
	}
	if rec.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("ticket page can leak its bearer URL through Referer")
	}
}
