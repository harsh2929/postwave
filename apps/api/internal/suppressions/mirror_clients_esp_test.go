// mirror_clients_esp_test.go — GAP-LS-026. Mailgun + Postmark are
// faked with httptest.Server via the BaseURL override; SES is exercised
// through a mock of the narrow sesSuppressionAPI interface. No real
// network or AWS credentials are touched.

package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

/* ---------- SES --------------------------------------------------- */

// fakeSESSuppressionAPI is a deterministic mock of the two-method
// sesSuppressionAPI the mirror depends on.
type fakeSESSuppressionAPI struct {
	pages     []*sesv2.ListSuppressedDestinationsOutput
	listErr   error
	getAttrs  map[string]*sestypes.SuppressedDestinationAttributes
	getErr    error
	listCalls int
	getCalls  []string
}

func (f *fakeSESSuppressionAPI) ListSuppressedDestinations(_ context.Context, _ *sesv2.ListSuppressedDestinationsInput, _ ...func(*sesv2.Options)) (*sesv2.ListSuppressedDestinationsOutput, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	idx := f.listCalls
	f.listCalls++
	if idx >= len(f.pages) {
		return &sesv2.ListSuppressedDestinationsOutput{}, nil
	}
	return f.pages[idx], nil
}

func (f *fakeSESSuppressionAPI) GetSuppressedDestination(_ context.Context, in *sesv2.GetSuppressedDestinationInput, _ ...func(*sesv2.Options)) (*sesv2.GetSuppressedDestinationOutput, error) {
	email := ""
	if in != nil && in.EmailAddress != nil {
		email = *in.EmailAddress
	}
	f.getCalls = append(f.getCalls, email)
	if f.getErr != nil {
		return nil, f.getErr
	}
	return &sesv2.GetSuppressedDestinationOutput{
		SuppressedDestination: &sestypes.SuppressedDestination{
			EmailAddress:   aws.String(email),
			Reason:         sestypes.SuppressionListReasonBounce,
			LastUpdateTime: aws.Time(time.Now().UTC()),
			Attributes:     f.getAttrs[email],
		},
	}, nil
}

func sesSummary(email string, reason sestypes.SuppressionListReason, updated time.Time) sestypes.SuppressedDestinationSummary {
	return sestypes.SuppressedDestinationSummary{
		EmailAddress:   aws.String(email),
		Reason:         reason,
		LastUpdateTime: aws.Time(updated),
	}
}

// TestSESMirrorClient_FetchRecent checks BOUNCE/COMPLAINT reason
// mapping, the since window filter, stable per-address source ids, and
// best-effort GetSuppressedDestination enrichment.
func TestSESMirrorClient_FetchRecent(t *testing.T) {
	since := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	api := &fakeSESSuppressionAPI{
		pages: []*sesv2.ListSuppressedDestinationsOutput{{
			SuppressedDestinationSummaries: []sestypes.SuppressedDestinationSummary{
				sesSummary("keep-bounce@example.com", sestypes.SuppressionListReasonBounce, since.Add(time.Hour)),
				sesSummary("keep-complaint@example.com", sestypes.SuppressionListReasonComplaint, since.Add(2*time.Hour)),
				sesSummary("old@example.com", sestypes.SuppressionListReasonBounce, since.Add(-48*time.Hour)),
			},
		}},
		getAttrs: map[string]*sestypes.SuppressedDestinationAttributes{
			"keep-bounce@example.com": {FeedbackId: aws.String("fb-1"), MessageId: aws.String("msg-1")},
		},
	}
	c := &SESMirrorClient{API: api}

	recs, err := c.FetchRecent(context.Background(), "t1", since, 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("len(recs) = %d, want 2 (old row filtered by since)", len(recs))
	}
	byEmail := map[string]MirrorRecord{}
	for _, rec := range recs {
		byEmail[rec.Email] = rec
	}
	bounce, ok := byEmail["keep-bounce@example.com"]
	if !ok || bounce.Reason != ReasonHardBounce {
		t.Fatalf("bounce rec = %+v, want hard_bounce", bounce)
	}
	if bounce.SourceEventID != "ses:keep-bounce@example.com" {
		t.Errorf("bounce source_event_id = %q", bounce.SourceEventID)
	}
	if bounce.Metadata["feedback_id"] != "fb-1" || bounce.Metadata["message_id"] != "msg-1" {
		t.Errorf("bounce metadata missing enrichment: %+v", bounce.Metadata)
	}
	if got := byEmail["keep-complaint@example.com"]; got.Reason != ReasonSpamComplaint {
		t.Errorf("complaint reason = %q, want spam_complaint", got.Reason)
	}
	// Enrichment runs only for rows we keep — the since-filtered address
	// must never trigger a GetSuppressedDestination call.
	for _, e := range api.getCalls {
		if e == "old@example.com" {
			t.Errorf("enriched a since-filtered address: %q", e)
		}
	}
	if len(api.getCalls) != 2 {
		t.Errorf("GetSuppressedDestination calls = %d, want 2", len(api.getCalls))
	}
}

// TestSESMirrorClient_Paginates follows NextToken across pages.
func TestSESMirrorClient_Paginates(t *testing.T) {
	api := &fakeSESSuppressionAPI{
		pages: []*sesv2.ListSuppressedDestinationsOutput{
			{
				SuppressedDestinationSummaries: []sestypes.SuppressedDestinationSummary{
					sesSummary("a@example.com", sestypes.SuppressionListReasonBounce, time.Now()),
				},
				NextToken: aws.String("tok-2"),
			},
			{
				SuppressedDestinationSummaries: []sestypes.SuppressedDestinationSummary{
					sesSummary("b@example.com", sestypes.SuppressionListReasonComplaint, time.Now()),
				},
			},
		},
	}
	c := &SESMirrorClient{API: api}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Time{}, 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("len(recs) = %d, want 2", len(recs))
	}
	if api.listCalls != 2 {
		t.Errorf("list calls = %d, want 2", api.listCalls)
	}
}

// TestSESMirrorClient_LimitStopsPagination caps the record count and
// avoids fetching the next page once the cap is met.
func TestSESMirrorClient_LimitStopsPagination(t *testing.T) {
	api := &fakeSESSuppressionAPI{
		pages: []*sesv2.ListSuppressedDestinationsOutput{{
			SuppressedDestinationSummaries: []sestypes.SuppressedDestinationSummary{
				sesSummary("a@example.com", sestypes.SuppressionListReasonBounce, time.Now()),
				sesSummary("b@example.com", sestypes.SuppressionListReasonBounce, time.Now()),
				sesSummary("c@example.com", sestypes.SuppressionListReasonBounce, time.Now()),
			},
			NextToken: aws.String("more"),
		}},
	}
	c := &SESMirrorClient{API: api}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Time{}, 2)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if len(recs) != 2 {
		t.Errorf("len(recs) = %d, want 2 (limit)", len(recs))
	}
	if api.listCalls != 1 {
		t.Errorf("list calls = %d, want 1 (limit stops pagination)", api.listCalls)
	}
}

// TestSESMirrorClient_ListError surfaces a List failure.
func TestSESMirrorClient_ListError(t *testing.T) {
	api := &fakeSESSuppressionAPI{listErr: errors.New("boom")}
	c := &SESMirrorClient{API: api}
	if _, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10); err == nil {
		t.Fatal("expected error from ListSuppressedDestinations failure")
	}
}

// TestSESMirrorClient_NotWired pins the unavailable error when the
// client has no API handle.
func TestSESMirrorClient_NotWired(t *testing.T) {
	c := &SESMirrorClient{}
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorClientUnavailable) {
		t.Fatalf("err = %v, want ErrMirrorClientUnavailable", err)
	}
}

/* ---------- Mailgun ----------------------------------------------- */

// TestMailgunMirrorClient_FetchRecent walks the three per-domain
// suppression lists and checks basic auth, reason mapping, stable
// source ids, tag metadata, and the client-side since filter.
func TestMailgunMirrorClient_FetchRecent(t *testing.T) {
	const domain = "mail.example.com"
	since := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	kept := "Fri, 05 Jun 2026 00:00:00 +0000"
	old := "Wed, 01 Jan 2020 00:00:00 +0000"

	var gotUser, gotPass string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		switch r.URL.Path {
		case "/v3/" + domain + "/bounces":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{"address": "Bounce@Example.com", "code": "550", "error": "user unknown", "created_at": kept},
				},
				"paging": map[string]any{},
			})
		case "/v3/" + domain + "/complaints":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{"address": "spam@example.com", "created_at": kept},
					{"address": "ancient@example.com", "created_at": old},
				},
				"paging": map[string]any{},
			})
		case "/v3/" + domain + "/unsubscribes":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{
					{"address": "unsub@example.com", "tags": []string{"promos"}, "created_at": kept},
				},
				"paging": map[string]any{},
			})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := &MailgunMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "mg-key"},
		BaseURL:     srv.URL,
		Domain:      domain,
	}
	recs, err := c.FetchRecent(context.Background(), "t1", since, 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if gotUser != "api" || gotPass != "mg-key" {
		t.Errorf("basic auth = %q/%q, want api/mg-key", gotUser, gotPass)
	}
	if len(recs) != 3 {
		t.Fatalf("len(recs) = %d, want 3 (ancient complaint filtered by since)", len(recs))
	}
	byEmail := map[string]MirrorRecord{}
	for _, rec := range recs {
		byEmail[rec.Email] = rec
	}
	if got := byEmail["Bounce@Example.com"]; got.Reason != ReasonHardBounce ||
		got.SourceEventID != "mailgun:bounces:bounce@example.com" {
		t.Errorf("bounce rec = %+v", got)
	}
	if got := byEmail["spam@example.com"]; got.Reason != ReasonSpamComplaint {
		t.Errorf("complaint reason = %q, want spam_complaint", got.Reason)
	}
	unsub := byEmail["unsub@example.com"]
	if unsub.Reason != ReasonManualUnsubscribe || unsub.SourceEventID != "mailgun:unsubscribes:unsub@example.com" {
		t.Errorf("unsub rec = %+v", unsub)
	}
	if tags, _ := unsub.Metadata["tags"].([]string); len(tags) != 1 || tags[0] != "promos" {
		t.Errorf("unsub tags metadata = %v", unsub.Metadata["tags"])
	}
	if _, present := byEmail["ancient@example.com"]; present {
		t.Error("ancient complaint should have been filtered by since")
	}
}

// TestMailgunMirrorClient_Paginates follows the paging.next cursor
// (query only, re-applied against BaseURL) until a short page.
func TestMailgunMirrorClient_Paginates(t *testing.T) {
	const domain = "d.example.com"
	bouncePages := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/"+domain+"/bounces" {
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "paging": map[string]any{}})
			return
		}
		bouncePages++
		if r.URL.Query().Get("page") == "" { // first page: one full page + a cursor
			items := make([]map[string]any, 0, mirrorPageSize)
			for i := 0; i < mirrorPageSize; i++ {
				items = append(items, map[string]any{"address": "a@b.c", "created_at": 1})
			}
			// Only the query of paging.next survives (mailgunNextQuery),
			// so the host here is immaterial — it is never dialed.
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":  items,
				"paging": map[string]any{"next": "https://mailgun.invalid" + r.URL.Path + "?limit=500&page=p2"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{ // second page: short → stop
			"items":  []map[string]any{{"address": "z@z.z", "created_at": 1}},
			"paging": map[string]any{},
		})
	}))
	defer srv.Close()

	c := &MailgunMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "k"},
		BaseURL:     srv.URL,
		Domain:      domain,
	}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Time{}, mirrorPageSize+10)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if bouncePages != 2 {
		t.Errorf("bounce pages fetched = %d, want 2", bouncePages)
	}
	if len(recs) != mirrorPageSize+1 {
		t.Errorf("len(recs) = %d, want %d", len(recs), mirrorPageSize+1)
	}
}

// TestMailgunMirrorClient_ServerError surfaces a 5xx as a non-nil error.
func TestMailgunMirrorClient_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := &MailgunMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "k"},
		BaseURL:     srv.URL,
		Domain:      "d.example.com",
	}
	if _, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10); err == nil {
		t.Fatal("expected error on 500")
	}
}

// TestMailgunMirrorClient_NotConfigured covers empty key and missing
// domain — both must be the typed not-configured error.
func TestMailgunMirrorClient_NotConfigured(t *testing.T) {
	t.Run("empty key", func(t *testing.T) {
		c := NewMailgunMirrorClient(StaticMirrorCredentials{Key: ""})
		c.Domain = "d.example.com"
		_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
		if !errors.Is(err, ErrMirrorNotConfigured) {
			t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
		}
	})
	t.Run("missing domain", func(t *testing.T) {
		t.Setenv(mailgunDomainEnvKey, "")
		c := NewMailgunMirrorClient(StaticMirrorCredentials{Key: "k"})
		_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
		if !errors.Is(err, ErrMirrorNotConfigured) {
			t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
		}
	})
	t.Run("domain from env", func(t *testing.T) {
		t.Setenv(mailgunDomainEnvKey, "env.example.com")
		sawEnvDomainBounces := false
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v3/env.example.com/bounces" {
				sawEnvDomainBounces = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "paging": map[string]any{}})
		}))
		defer srv.Close()
		c := &MailgunMirrorClient{Credentials: StaticMirrorCredentials{Key: "k"}, BaseURL: srv.URL}
		if _, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10); err != nil {
			t.Fatalf("FetchRecent: %v", err)
		}
		if !sawEnvDomainBounces {
			t.Error("env-fallback domain was not honored in the request path")
		}
	})
}

/* ---------- Postmark ---------------------------------------------- */

// TestPostmarkMirrorClient_FetchRecent checks the server-token header,
// bounce-type mapping (skipping transient types), stable numeric source
// ids, and the fromdate window.
func TestPostmarkMirrorClient_FetchRecent(t *testing.T) {
	since := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	var gotToken, gotFromdate, gotOffset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Postmark-Server-Token")
		gotFromdate = r.URL.Query().Get("fromdate")
		gotOffset = r.URL.Query().Get("offset")
		if r.URL.Path != "/bounces" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"TotalCount": 3,
			"Bounces": []map[string]any{
				{"ID": 111, "Type": "HardBounce", "Email": "Hard@Example.com", "BouncedAt": "2026-06-05T00:00:00Z", "Inactive": true, "MessageID": "m1"},
				{"ID": 222, "Type": "SpamComplaint", "Email": "spam@example.com", "BouncedAt": "2026-06-06T00:00:00Z"},
				{"ID": 333, "Type": "Transient", "Email": "soft@example.com", "BouncedAt": "2026-06-07T00:00:00Z"},
			},
		})
	}))
	defer srv.Close()

	c := &PostmarkMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "pm-token"},
		BaseURL:     srv.URL,
	}
	recs, err := c.FetchRecent(context.Background(), "t1", since, 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if gotToken != "pm-token" {
		t.Errorf("token header = %q, want pm-token", gotToken)
	}
	if gotFromdate != "2026-06-01" {
		t.Errorf("fromdate = %q, want 2026-06-01", gotFromdate)
	}
	if gotOffset != "0" {
		t.Errorf("offset = %q, want 0", gotOffset)
	}
	if len(recs) != 2 {
		t.Fatalf("len(recs) = %d, want 2 (Transient skipped)", len(recs))
	}
	byEmail := map[string]MirrorRecord{}
	for _, rec := range recs {
		byEmail[rec.Email] = rec
	}
	hard := byEmail["Hard@Example.com"]
	if hard.Reason != ReasonHardBounce || hard.SourceEventID != "postmark:bounce:111" {
		t.Errorf("hard rec = %+v", hard)
	}
	if hard.Metadata["message_id"] != "m1" || hard.Metadata["postmark_type"] != "HardBounce" {
		t.Errorf("hard metadata = %+v", hard.Metadata)
	}
	if got := byEmail["spam@example.com"]; got.Reason != ReasonSpamComplaint ||
		got.SourceEventID != "postmark:bounce:222" {
		t.Errorf("spam rec = %+v", got)
	}
	if _, present := byEmail["soft@example.com"]; present {
		t.Error("Transient bounce should have been skipped")
	}
}

// TestPostmarkMirrorClient_RejectedKeyIsNotConfigured maps a 401 onto
// the typed not-configured path.
func TestPostmarkMirrorClient_RejectedKeyIsNotConfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := &PostmarkMirrorClient{Credentials: StaticMirrorCredentials{Key: "bad"}, BaseURL: srv.URL}
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorNotConfigured) {
		t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
	}
}

// TestPostmarkMirrorClient_NotConfigured pins the empty-key path.
func TestPostmarkMirrorClient_NotConfigured(t *testing.T) {
	c := NewPostmarkMirrorClient(StaticMirrorCredentials{Key: ""})
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorNotConfigured) {
		t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
	}
}
