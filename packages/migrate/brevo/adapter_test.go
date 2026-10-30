// SPDX-License-Identifier: MIT

package brevo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// ---------------------------------------------------------------------------
// Fixtures (canned Brevo responses, embedded as Go string literals so tests
// stay hermetic — no I/O, no network).
// ---------------------------------------------------------------------------

const brevoAccountResponseFixture = `{
  "organization_id":"org-test",
  "user_id":123,
  "email":"alice@example.com",
  "firstName":"Alice",
  "lastName":"Liddell",
  "companyName":"Wonderland Ltd",
  "plan":[]
}`

const brevoContactsPage1Fixture = `{
  "count": 2,
  "contacts": [
    {
      "email":"alice@example.com",
      "id":1,
      "emailBlacklisted":false,
      "smsBlacklisted":false,
      "createdAt":"2024-03-01T10:00:00.000+00:00",
      "modifiedAt":"2024-03-02T10:00:00.000+00:00",
      "attributes":{"FIRSTNAME":"Alice","CITY":"London"},
      "listIds":[10,11]
    },
    {
      "email":"bob@example.com",
      "id":2,
      "emailBlacklisted":true,
      "smsBlacklisted":false,
      "createdAt":"2024-03-03T10:00:00.000+00:00",
      "modifiedAt":"2024-03-04T10:00:00.000+00:00",
      "attributes":{"FIRSTNAME":"Bob"},
      "listIds":[10]
    }
  ]
}`

const brevoContactsPage2Fixture = `{
  "count": 501,
  "contacts": [{"id":501,"email":"last@example.com","emailBlacklisted":false}]
}`

const brevoListsFixture = `{
  "count": 2,
  "lists":[
    {"id":10,"name":"Newsletter","totalSubscribers":1200,"folderId":1},
    {"id":11,"name":"VIPs","totalSubscribers":42,"folderId":1}
  ]
}`

const brevoSegmentsFixture = `{
  "count": 1,
  "segments":[
    {"id":99,"segment":"Engaged in last 30 days","categoryId":3}
  ]
}`

const brevoCampaignsSentFixture = `{
  "count": 1,
  "campaigns":[
    {
      "id":501,
      "name":"March newsletter",
      "subject":"Spring is here",
      "status":"sent",
      "type":"classic",
      "htmlContent":"<p>hi</p>",
      "sentDate":"2024-03-15T08:30:00.000+00:00",
      "statistics":{"globalStats":{"uniqueViews":120,"uniqueClicks":15,"sent":1000}}
    }
  ]
}`

const brevoCampaignsDraftFixture = `{
  "count": 0,
  "campaigns":[]
}`

const brevoWorkflowsFixture = `{
  "count": 1,
  "workflows":[
    {
      "id":7,
      "name":"Welcome series",
      "status":"active",
      "trigger":{"type":"list_addition","listId":10},
      "steps":[
        {"id":"s1","type":"email","templateId":42,"nextStepId":"s2"},
        {"id":"s2","type":"delay","delaySeconds":86400}
      ]
    }
  ]
}`

// ---------------------------------------------------------------------------
// Helpers — set up an httptest.Server and adapter wired to it.
// ---------------------------------------------------------------------------

// fixtureServer returns an httptest.Server whose handler dispatches based on
// (method, path). Each registered handler must write exactly one canned body
// (and optionally set status). Any unregistered route fails the test loudly.
func fixtureServer(t *testing.T, routes map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Match by path-only first, then method+path for stricter routes.
		key := r.Method + " " + r.URL.Path
		if h, ok := routes[key]; ok {
			h(w, r)
			return
		}
		if h, ok := routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		t.Errorf("unexpected request to %s", r.URL.String())
		http.Error(w, "no handler", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newAdapterAt returns an *Adapter pointed at the given httptest.Server URL,
// with a generously-sized rate limit so tests don't sleep.
func newAdapterAt(srv *httptest.Server) *Adapter {
	a := New()
	a.BaseURL = srv.URL
	// Effectively disable the rate limiter for tests — 1000 rps capacity.
	a.limiter = adapter.NewTokenBucket(1000, time.Second, 1000)
	return a
}

// requireAPIKeyHeader fails the test if the api-key header is missing/empty.
func requireAPIKeyHeader(t *testing.T, r *http.Request) {
	t.Helper()
	if strings.TrimSpace(r.Header.Get("api-key")) == "" {
		t.Errorf("missing api-key header on %s", r.URL.String())
	}
}

// ---------------------------------------------------------------------------
// Tests — Authenticate
// ---------------------------------------------------------------------------

func TestAuthenticate_Success(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /account": func(w http.ResponseWriter, r *http.Request) {
			requireAPIKeyHeader(t, r)
			_, _ = w.Write([]byte(brevoAccountResponseFixture))
		},
	})
	a := newAdapterAt(srv)

	sess, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "xkeysib-test"})
	require.NoError(t, err)
	require.Equal(t, "xkeysib-test", sess.AccessToken)
	require.Equal(t, "org-test", sess.AccountID)
	require.Equal(t, canonical.SourceBrevo, sess.Source)
}

func TestAuthenticate_InvalidKey(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /account": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"code":"unauthorized","message":"Key not found"}`, http.StatusUnauthorized)
		},
	})
	a := newAdapterAt(srv)

	_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "bogus"})
	require.Error(t, err)
	require.ErrorIs(t, err, adapter.ErrAuth, "401 must surface as ErrAuth")
}

func TestAuthenticate_MissingKey(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{})
	require.ErrorIs(t, err, adapter.ErrAuth)
}

// ---------------------------------------------------------------------------
// Tests — Discover
// ---------------------------------------------------------------------------

func TestDiscover_AllResources(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts": func(w http.ResponseWriter, r *http.Request) {
			requireAPIKeyHeader(t, r)
			_, _ = w.Write([]byte(brevoContactsPage1Fixture))
		},
		"GET /contacts/lists": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(brevoListsFixture))
		},
		"GET /contacts/segments": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(brevoSegmentsFixture))
		},
		"GET /automations": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"count":3,"workflows":[]}`))
		},
		"GET /emailCampaigns": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"count":42,"campaigns":[]}`))
		},
	})
	a := newAdapterAt(srv)

	rep, err := a.Discover(context.Background(), adapter.Session{AccessToken: "k"})
	require.NoError(t, err)
	require.Equal(t, 2, rep.SubscribersTotal)
	require.Equal(t, 3, rep.SegmentsTotal, "lists + saved segments must sum")
	require.Zero(t, rep.AutomationsTotal)
	require.NotEmpty(t, rep.Warnings)
	require.Equal(t, 42, rep.ArchiveTotal)
	require.Equal(t, 42, rep.CampaignsTotal)
}

// ---------------------------------------------------------------------------
// Tests — ListSubscribers (pagination + cursor)
// ---------------------------------------------------------------------------

// Fixture A: a 500-row first page, then an empty second page. Used to exercise
// the offset-cursor handoff at the page-size boundary.
const brevoContactsBigPageHeader = `{"count":501,"contacts":[`

func bigContactsPage() string {
	var b strings.Builder
	b.WriteString(brevoContactsBigPageHeader)
	for i := 0; i < contactPageSize; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"email":"u`)
		b.WriteString(strings.Repeat("0", 0))
		b.WriteString(itoa(i))
		b.WriteString(`@example.com","id":`)
		b.WriteString(itoa(i + 1))
		b.WriteString(`,"emailBlacklisted":false,"createdAt":"2024-03-01T10:00:00.000+00:00"}`)
	}
	b.WriteString("]}")
	return b.String()
}

// itoa avoids importing strconv just for this tiny test helper.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestSubscribers_Pagination(t *testing.T) {
	var calls int32
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts": func(w http.ResponseWriter, r *http.Request) {
			n := atomic.AddInt32(&calls, 1)
			offset := r.URL.Query().Get("offset")
			switch n {
			case 1:
				require.Equal(t, "0", offset)
				_, _ = w.Write([]byte(bigContactsPage()))
			case 2:
				require.Equal(t, itoa(contactPageSize), offset)
				_, _ = w.Write([]byte(brevoContactsPage2Fixture))
			default:
				t.Errorf("unexpected extra call %d", n)
			}
		},
	})
	a := newAdapterAt(srv)
	sess := adapter.Session{AccessToken: "k"}

	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, subs1, contactPageSize)
	require.NotEmpty(t, next1)
	decoded, err := decodePageCursor(next1, "contacts", "")
	require.NoError(t, err)
	require.Equal(t, contactPageSize, decoded.Offset)

	// First contact properly normalized.
	require.Equal(t, "u0@example.com", subs1[0].Email)
	require.Equal(t, canonical.StatusEnabled, subs1[0].Status)
	require.Equal(t, canonical.SourceBrevo, subs1[0].SourcePlatform)
	require.Equal(t, "1", subs1[0].SourceID)

	subs2, next2, err := a.ListSubscribers(context.Background(), sess, next1)
	require.NoError(t, err)
	require.Len(t, subs2, 1)
	require.Equal(t, "", next2, "last record ends iteration")
}

func TestSubscribers_Cursor(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts": func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "0", r.URL.Query().Get("offset"))
			require.Equal(t, itoa(contactPageSize), r.URL.Query().Get("limit"))
			_, _ = w.Write([]byte(brevoContactsPage1Fixture))
		},
	})
	a := newAdapterAt(srv)
	sess := adapter.Session{AccessToken: "k"}

	subs, _, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, subs, 2)
	require.Equal(t, "alice@example.com", subs[0].Email)
	require.Equal(t, canonical.StatusEnabled, subs[0].Status)
	require.Equal(t, canonical.StatusDisabled, subs[1].Status, "blacklisted contacts disabled")
}

func TestSubscribers_BadCursor(t *testing.T) {
	a := New()
	a.BaseURL = "http://127.0.0.1:1" // never reached
	a.limiter = adapter.NewTokenBucket(1000, time.Second, 1000)
	_, _, err := a.ListSubscribers(context.Background(), adapter.Session{AccessToken: "k"}, "not-a-number")
	require.Error(t, err)
}

// ---------------------------------------------------------------------------
// Tests — RateLimit (429 with Retry-After)
// ---------------------------------------------------------------------------

func TestRateLimit_429(t *testing.T) {
	var calls int32
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts": func(w http.ResponseWriter, _ *http.Request) {
			n := atomic.AddInt32(&calls, 1)
			if n == 1 {
				w.Header().Set("Retry-After", "0")
				http.Error(w, "rate limited", http.StatusTooManyRequests)
				return
			}
			_, _ = w.Write([]byte(brevoContactsPage1Fixture))
		},
	})
	a := newAdapterAt(srv)

	subs, _, err := a.ListSubscribers(context.Background(), adapter.Session{AccessToken: "k"}, "")
	require.NoError(t, err, "429 with retry-after must retry and succeed")
	require.Len(t, subs, 2)
	require.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(2), "retry must hit upstream twice")
}

func TestRateLimit_429_ExhaustedSurfaceErrRateLimited(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "0")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
		},
	})
	a := newAdapterAt(srv)

	_, _, err := a.ListSubscribers(context.Background(), adapter.Session{AccessToken: "k"}, "")
	require.Error(t, err)
	var rl *adapter.ErrRateLimited
	require.True(t, errors.As(err, &rl), "exhausted retries must surface ErrRateLimited")
}

// ---------------------------------------------------------------------------
// Tests — Segments (lists + segments merged, dedup'd)
// ---------------------------------------------------------------------------

func TestSegments_BothListsAndSegments(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts/lists": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(brevoListsFixture))
		},
		"GET /contacts/segments": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(brevoSegmentsFixture))
		},
	})
	a := newAdapterAt(srv)

	segs, err := a.ListSegments(context.Background(), adapter.Session{AccessToken: "k"})
	require.NoError(t, err)
	require.Len(t, segs, 3, "two lists + one saved segment should produce three records")

	names := make([]string, 0, len(segs))
	for _, s := range segs {
		names = append(names, s.Name)
	}
	require.Contains(t, names, "List: Newsletter")
	require.Contains(t, names, "List: VIPs")
	require.Contains(t, names, "Engaged in last 30 days")
}

func TestSegmentsUnavailableEndpointFailsInventory(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts/lists": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(brevoListsFixture))
		},
		"GET /contacts/segments": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "not found", http.StatusNotFound)
		},
	})
	a := newAdapterAt(srv)

	segs, err := a.ListSegments(context.Background(), adapter.Session{AccessToken: "k"})
	require.ErrorContains(t, err, "saved segments incomplete")
	require.Empty(t, segs, "partial inventories are not a successful result")
}

// ---------------------------------------------------------------------------
// Tests — CampaignArchive (status=sent filter)
// ---------------------------------------------------------------------------

func TestCampaignArchive_StatusFilter(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /emailCampaigns/501": func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "globalStats", r.URL.Query().Get("statistics"))
			var data struct {
				Campaigns []json.RawMessage `json:"campaigns"`
			}
			require.NoError(t, json.Unmarshal([]byte(brevoCampaignsSentFixture), &data))
			_, _ = w.Write(data.Campaigns[0])
		},
		"GET /emailCampaigns": func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "sent", r.URL.Query().Get("status"),
				"adapter must always filter by status=sent")
			_, _ = w.Write([]byte(brevoCampaignsSentFixture))
		},
	})
	a := newAdapterAt(srv)

	camps, _, err := a.ListCampaignArchive(context.Background(), adapter.Session{AccessToken: "k"}, "")
	require.NoError(t, err)
	require.Len(t, camps, 1)
	require.Equal(t, "501", camps[0].SourceID)
	require.Equal(t, "Spring is here", camps[0].Subject)
	require.Equal(t, 1000, camps[0].RecipientsCount)
	require.Equal(t, 120, camps[0].Opens)
	require.Equal(t, 15, camps[0].Clicks)
	require.Equal(t, canonical.SourceBrevo, camps[0].SourcePlatform)
}

// ---------------------------------------------------------------------------
// Tests — Automations / PaidSubs / Capabilities
// ---------------------------------------------------------------------------

func TestAutomationsDoesNotCallUndocumentedEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("automation inventory must not issue undocumented API requests")
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	autos, err := newAdapterAt(srv).ListAutomations(context.Background(), adapter.Session{AccessToken: "k"})
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	require.Empty(t, autos)
}

func TestPaidSubs_Unsupported(t *testing.T) {
	a := New()
	_, err := a.ListPaidSubs(context.Background(), adapter.Session{AccessToken: "k"}, "")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
}

func TestCapabilities_DeclaresAPIKeyAndExpectedFlags(t *testing.T) {
	caps := New().Capabilities()
	require.Equal(t, canonical.SourceBrevo, caps.Source)
	require.Equal(t, "api_key", caps.AuthMethod)
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.False(t, caps.Supports.Automations)
	require.True(t, caps.Supports.CampaignArchive)
	require.False(t, caps.Supports.PaidSubs)
	require.False(t, caps.Supports.ConsentTimestamps)
}

// ---------------------------------------------------------------------------
// Tests — Mappers (pure, no httptest)
// ---------------------------------------------------------------------------

func TestMapBrevoContactToCanonical_Normalization(t *testing.T) {
	c := brevoContact{
		Email:            "  Mixed.Case@Example.com  ",
		ID:               99,
		EmailBlacklisted: boolPointer(false),
		CreatedAt:        "2024-03-01T10:00:00.000+00:00",
		Attributes: map[string]interface{}{
			"FIRSTNAME": "Lewis",
			"NULL":      nil,
			"WEIRD":     []interface{}{1, 2, 3}, // non-scalar — must stringify, not drop email field
		},
		ListIDs: []int64{10, 20},
	}
	got := mapBrevoContactToCanonical(c)

	require.Equal(t, "mixed.case@example.com", got.Email, "emails must be lowercased + trimmed")
	require.Equal(t, canonical.StatusEnabled, got.Status)
	require.Equal(t, "99", got.SourceID)
	require.Equal(t, canonical.SourceBrevo, got.SourcePlatform)
	require.Equal(t, "Lewis", got.CustomFields["FIRSTNAME"])
	require.NotContains(t, got.CustomFields, "NULL", "nil attributes dropped")
	require.Contains(t, got.CustomFields, "WEIRD", "non-scalar attribute preserved as string")
	require.Nil(t, got.ConsentTimestamp)
	require.Equal(t, canonical.ConsentUnknown, got.ConsentSource)
	require.Equal(t, c.CreatedAt, got.CustomFields["brevo_created_at"])
	require.Equal(t, []string{"list:10", "list:20"}, got.Tags)
}

func TestMapBrevoContact_BlacklistedDisabled(t *testing.T) {
	got := mapBrevoContactToCanonical(brevoContact{
		Email: "x@y.com", ID: 1, EmailBlacklisted: boolPointer(true),
	})
	require.Equal(t, canonical.StatusDisabled, got.Status)
}

func TestParseISO_HandlesCommonShapes(t *testing.T) {
	cases := []string{
		"2024-03-01T10:00:00.000+00:00",
		"2024-03-01T10:00:00Z",
		"2024-03-01 10:00:00",
	}
	for _, raw := range cases {
		got := parseISO(raw)
		require.NotNil(t, got, "should parse %q", raw)
	}
	require.Nil(t, parseISO(""), "empty → nil")
	require.Nil(t, parseISO("not-a-date"), "junk → nil")
}

func TestBuildAPIKeyEntryURL(t *testing.T) {
	got := BuildAPIKeyEntryURL("xyz123")
	require.Equal(t, "moosewave://migrate/brevo/api-key-entry?state=xyz123", got)
}

func boolPointer(value bool) *bool { return &value }

func TestDiscoveryPropagatesEveryRequiredReadFailure(t *testing.T) {
	for _, failed := range []string{"/contacts", "/contacts/lists", "/contacts/segments", "/emailCampaigns"} {
		t.Run(failed, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == failed {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write([]byte(`{"count":0}`))
			}))
			defer srv.Close()
			_, err := newAdapterAt(srv).Discover(context.Background(), adapter.Session{AccessToken: "k"})
			require.Error(t, err)
		})
	}
}

func TestSavedSegmentsCannotSilentlyDisappear(t *testing.T) {
	srv := fixtureServer(t, map[string]http.HandlerFunc{
		"GET /contacts/lists":    func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(brevoListsFixture)) },
		"GET /contacts/segments": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) },
	})
	_, err := newAdapterAt(srv).ListSegments(context.Background(), adapter.Session{AccessToken: "k"})
	require.ErrorContains(t, err, "saved segments incomplete")
}

func TestContactPermissionAndChannelBoundaries(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want canonical.SubscriberStatus
	}{
		{`{"id":1,"email":"a@example.com","createdAt":"2024-01-01"}`, canonical.StatusUnconfirmed},
		{`{"id":1,"email":"a@example.com","emailBlacklisted":false,"smsBlacklisted":true,"whatsappBlacklisted":true}`, canonical.StatusEnabled},
		{`{"id":1,"email":"a@example.com","emailBlacklisted":true}`, canonical.StatusDisabled},
		{`{"id":1,"email":"a@example.com","emailBlacklisted":false,"listUnsubscribed":[4]}`, canonical.StatusDisabled},
		{`{"id":1,"email":"a@example.com","emailBlacklisted":false,"consentGroups":[{"id":3,"status":"unsubscribed"}]}`, canonical.StatusDisabled},
		{`{"id":1,"email":"a@example.com","emailBlacklisted":false,"consentGroups":[{"id":3,"status":"unexpected"}]}`, canonical.StatusDisabled},
	} {
		var contact brevoContact
		require.NoError(t, json.Unmarshal([]byte(tc.raw), &contact))
		sub := mapBrevoContactToCanonical(contact)
		require.Equal(t, tc.want, sub.Status, tc.raw)
		require.Nil(t, sub.ConsentTimestamp)
		require.Equal(t, canonical.ConsentUnknown, sub.ConsentSource)
	}
}

func TestSavedSegmentUsesDocumentedName(t *testing.T) {
	var segment brevoSegment
	require.NoError(t, json.Unmarshal([]byte(`{"id":42,"segmentName":"Recent readers","categoryName":"Engagement"}`), &segment))
	require.Equal(t, "Recent readers", mapBrevoSegmentToCanonical(segment).Name)
}
