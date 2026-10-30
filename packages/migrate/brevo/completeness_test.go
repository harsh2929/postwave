package brevo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/stretchr/testify/require"
)

func TestOrganizationIdentitySurvivesRenameAndRejectsAnotherAccount(t *testing.T) {
	account := brevoAccount{OrganizationID: "org-a", UserID: 42, CompanyName: "Shared name"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/account", r.URL.Path)
		require.Equal(t, "key", r.Header.Get("api-key"))
		_ = json.NewEncoder(w).Encode(account)
	}))
	defer srv.Close()
	ad := newAdapterAt(srv)
	first, err := ad.Authenticate(context.Background(), adapter.Credentials{APIKey: "key", Extra: map[string]string{"brevo_organization_id": "spoofed"}})
	require.NoError(t, err)
	account.CompanyName = "Renamed"
	account.UserID = 99
	rotated, err := ad.Authenticate(context.Background(), adapter.Credentials{APIKey: "key", AccountID: first.AccountID})
	require.NoError(t, err)
	require.Equal(t, first.AccountID, rotated.AccountID)
	require.Equal(t, "org-a", rotated.Extra["brevo_organization_id"])
	account.OrganizationID = "org-b"
	account.CompanyName = "Shared name"
	_, err = ad.Authenticate(context.Background(), adapter.Credentials{APIKey: "key", AccountID: first.AccountID})
	require.ErrorIs(t, err, adapter.ErrAuth)
	account.OrganizationID = ""
	_, err = ad.Authenticate(context.Background(), adapter.Credentials{APIKey: "key"})
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestShortContactPagesResumeAndCountNonEmailProfiles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "asc", r.URL.Query().Get("sort"))
		switch r.URL.Query().Get("offset") {
		case "0":
			_, _ = w.Write([]byte(`{"count":3,"contacts":[{"id":1,"email":"first@example.com","emailBlacklisted":false}]}`))
		case "1":
			_, _ = w.Write([]byte(`{"count":3,"contacts":[{"id":2,"attributes":{"SMS":"123"}},{"id":3,"email":"Display <not-a-primary@example.com>"}]}`))
		default:
			t.Fatal("incorrect resume offset")
		}
	}))
	defer srv.Close()
	sess := adapter.Session{AccessToken: "key", AccountID: "org"}
	rows, next, skipped, err := newAdapterAt(srv).subscriberPage(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotEmpty(t, next)
	require.Zero(t, skipped)
	rows, next, skipped, err = newAdapterAt(srv).subscriberPage(context.Background(), sess, next)
	require.NoError(t, err)
	require.Empty(t, rows)
	require.Empty(t, next)
	require.Equal(t, 2, skipped)
}

func TestPaginationRejectsTruncationDriftAndInvalidIdentity(t *testing.T) {
	for name, body := range map[string]string{
		"missing count": `{"contacts":[]}`, "missing collection": `{"count":0}`, "null collection": `{"count":0,"contacts":null}`,
		"early empty": `{"count":1,"contacts":[]}`, "extra rows": `{"count":0,"contacts":[{"id":1}]}`, "missing identity": `{"count":1,"contacts":[{}]}`,
		"duplicate": `{"count":2,"contacts":[{"id":1},{"id":1}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer srv.Close()
			_, _, err := newAdapterAt(srv).ListSubscribers(context.Background(), adapter.Session{}, "")
			require.Error(t, err)
		})
	}
	count := 3
	next, err := nextPage(pageCursor{Kind: "contacts", Account: "org", Total: -1}, &count, []int64{1}, true, 500)
	require.NoError(t, err)
	c, err := decodePageCursor(next, "contacts", "org")
	require.NoError(t, err)
	changed := 4
	_, err = nextPage(c, &changed, []int64{2}, true, 500)
	require.Error(t, err)
	_, err = nextPage(c, &count, []int64{1}, true, 500)
	require.Error(t, err)
	_, err = decodePageCursor(next, "campaigns", "org")
	require.Error(t, err)
	_, err = decodePageCursor(next, "contacts", "other")
	require.Error(t, err)
}

func TestCampaignReportFailureCannotBecomeZeroStatistics(t *testing.T) {
	for _, detail := range []string{`{}`, `{"id":501,"status":"sent","sentDate":"2024-03-15T08:30:00Z","htmlContent":"<p>old</p>","statistics":{"globalStats":{"sent":null,"uniqueViews":1,"uniqueClicks":1}}}`} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/emailCampaigns" {
				_, _ = w.Write([]byte(brevoCampaignsSentFixture))
				return
			}
			require.Equal(t, "/emailCampaigns/501", r.URL.Path)
			_, _ = w.Write([]byte(detail))
		}))
		_, _, err := newAdapterAt(srv).ListCampaignArchive(context.Background(), adapter.Session{}, "")
		require.ErrorContains(t, err, "incomplete")
		srv.Close()
	}
}

func TestHTTPRedirectAndErrorBodiesDoNotExposeCredential(t *testing.T) {
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls++ }))
	defer destination.Close()
	for _, status := range []int{302, 400, 401, 403} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", destination.URL)
			w.WriteHeader(status)
			_, _ = w.Write([]byte("secret-key contact@example.com"))
		}))
		_, _, err := newAdapterAt(srv).ListSubscribers(context.Background(), adapter.Session{AccessToken: "secret-key"}, "")
		require.Error(t, err)
		require.False(t, strings.Contains(err.Error(), "secret-key"))
		require.False(t, strings.Contains(err.Error(), "contact@example.com"))
		srv.Close()
	}
	require.Zero(t, destinationCalls)
}
