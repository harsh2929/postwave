package seedlist

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

func TestVendorAPIConnectorFetchTaggedMessages(t *testing.T) {
	var gotAuth, gotMailbox, gotSince string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotMailbox = r.URL.Query().Get("mailbox_id")
		gotSince = r.URL.Query().Get("since")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages": []map[string]any{
				{
					"folder": "INBOX",
					"labels": []string{"CATEGORY_PROMOTIONS"},
					"headers": map[string]string{
						PostwaveTestHeader: "campaign-1",
					},
				},
				{
					"folder":  "INBOX",
					"headers": map[string]string{"Subject": "ignored"},
				},
			},
		})
	}))
	defer srv.Close()

	conn := &VendorAPIConnector{Endpoint: srv.URL, APIKey: "secret", HTTPClient: srv.Client()}
	since := time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC)
	msgs, err := conn.FetchTaggedMessages(context.Background(), &Inbox{
		ID:       "gmail-1",
		Provider: domain.ProviderGmail,
		Address:  "seed@example.com",
	}, since)
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer secret" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotMailbox != "gmail-1" {
		t.Fatalf("mailbox_id = %q", gotMailbox)
	}
	if gotSince == "" {
		t.Fatalf("missing since query")
	}
	if len(msgs) != 1 {
		t.Fatalf("len(msgs) = %d, want 1", len(msgs))
	}
	if msgs[0].Headers[PostwaveTestHeader] != "campaign-1" {
		t.Fatalf("message header not preserved")
	}
	if msgs[0].RawMIME == nil || msgs[0].RawMIME.Status != categorizers.RawMIMEUnavailable {
		t.Fatalf("vendor raw MIME = %#v, want explicit unavailable", msgs[0].RawMIME)
	}
	if got := conn.Capabilities(); got.RawMIME != CapabilityUnavailable || got.Headers != CapabilityAvailable || got.Placement != CapabilityAvailable {
		t.Fatalf("vendor capabilities = %#v", got)
	}
}

func TestVendorConnectorNeverFabricatesRawMIMEFromClaimedMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"messages":[{"folder":"INBOX","headers":{"X-Postwave-Test-ID":"campaign-claim"},"raw_mime":{"status":"complete","sha256":"fabricated","captured_bytes":123}}]}`))
	}))
	defer srv.Close()

	conn := &VendorAPIConnector{Endpoint: srv.URL, HTTPClient: srv.Client()}
	messages, err := conn.FetchTaggedMessages(context.Background(), &Inbox{ID: "gmail-1"}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].RawMIME == nil {
		t.Fatalf("messages = %#v", messages)
	}
	if messages[0].RawMIME.Status != categorizers.RawMIMEUnavailable || messages[0].RawMIME.SHA256 != "" || messages[0].RawMIME.CapturedBytes != 0 {
		t.Fatalf("vendor claim was trusted: %#v", messages[0].RawMIME)
	}
}

func TestVendorAPIConnectorCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(vendorAPIResponseMaxBytes)+1)))
	}))
	defer srv.Close()

	conn := &VendorAPIConnector{Endpoint: srv.URL, HTTPClient: srv.Client()}
	_, err := conn.FetchTaggedMessages(context.Background(), &Inbox{ID: "gmail-1"}, time.Now())
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("FetchTaggedMessages err = %v, want response body too large", err)
	}
}

func TestRegistryLoadJSON(t *testing.T) {
	reg := NewRegistry()
	raw := `{"inboxes":[{"id":"gmail-1","provider":"gmail","address":"seed@example.com","imap_host":"imap.example.com","imap_user":"seed@example.com","imap_password_env":"SEED_PASSWORD"}]}`
	if err := reg.LoadJSON(raw); err != nil {
		t.Fatal(err)
	}
	in, ok := reg.Get("gmail-1")
	if !ok {
		t.Fatal("expected inbox to load")
	}
	if in.Status != StatusActive {
		t.Fatalf("status = %q, want active", in.Status)
	}
}

func TestRegistryLoadRejectsOversizedConfigFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "seedlist.json")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxSeedlistConfigBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	err = NewRegistry().Load(path)
	if err == nil || !strings.Contains(err.Error(), "file exceeds") {
		t.Fatalf("err = %v, want size error", err)
	}
}

func TestConnectorKindFromEnv(t *testing.T) {
	t.Setenv("SEEDLIST_CONFIG_PATH", "/secrets/seedlist.yaml")
	if got := ConnectorKindFromEnv(); got != "imap" {
		t.Fatalf("kind = %q, want imap", got)
	}
	t.Setenv("SEEDLIST_VENDOR_API_URL", "https://seed.example.com")
	if got := ConnectorKindFromEnv(); got != "vendor" {
		t.Fatalf("kind = %q, want vendor", got)
	}
	t.Setenv("SEEDLIST_CONNECTOR", "nop")
	if got := ConnectorKindFromEnv(); got != "nop" {
		t.Fatalf("kind = %q, want nop", got)
	}
}

func TestIMAPConnectorRequiresPassword(t *testing.T) {
	conn := &IMAPConnector{}
	_, err := conn.FetchTaggedMessages(context.Background(), &Inbox{
		ID:              "gmail-1",
		Provider:        domain.ProviderGmail,
		Address:         "seed@example.com",
		IMAPHost:        "imap.example.com",
		IMAPUser:        "seed@example.com",
		IMAPPasswordEnv: "MISSING_SEED_PASSWORD",
	}, time.Now())
	if err == nil {
		t.Fatal("expected missing password error")
	}
}

func TestParseSeedHeaders(t *testing.T) {
	raw := []byte("X-Postwave-Test-ID: campaign-1\r\nX-GM-LABELS: CATEGORY_PROMOTIONS,INBOX\r\nSubject: Test\r\n\r\n")
	headers := parseSeedHeaders(raw)
	if headers[PostwaveTestHeader] != "campaign-1" {
		t.Fatalf("missing test header: %#v", headers)
	}
	labels := seedLabels(headers)
	if len(labels) != 2 || labels[0] != "CATEGORY_PROMOTIONS" {
		t.Fatalf("labels = %#v", labels)
	}
}

func TestParsePostwaveTestID(t *testing.T) {
	tenant := "11111111-1111-1111-1111-111111111111"
	campaign := "22222222-2222-2222-2222-222222222222"
	gotTenant, gotCampaign := parsePostwaveTestID(tenant + ":" + campaign)
	if gotTenant != tenant || gotCampaign != campaign {
		t.Fatalf("colon parse = %q/%q", gotTenant, gotCampaign)
	}
	gotTenant, gotCampaign = parsePostwaveTestID(`{"tenant_id":"` + tenant + `","campaign_id":"` + campaign + `"}`)
	if gotTenant != tenant || gotCampaign != campaign {
		t.Fatalf("json parse = %q/%q", gotTenant, gotCampaign)
	}
	gotTenant, gotCampaign = parsePostwaveTestID("cmp_local")
	if gotTenant != "" || gotCampaign != "cmp_local" {
		t.Fatalf("bare parse = %q/%q", gotTenant, gotCampaign)
	}
}

type panicConnector struct{}

func (panicConnector) FetchTaggedMessages(context.Context, *Inbox, time.Time) ([]categorizers.Message, error) {
	panic("fetch exploded")
}

type panicHealthSender struct{}

func (panicHealthSender) SendHealthCheck(context.Context, *Inbox, string) error {
	panic("health exploded")
}

func TestPollerSafePollOnceRecoversProviderPanic(t *testing.T) {
	p := NewPoller(NewRegistry(), panicConnector{}, NopHealthSender{}, NopSink{}, nil)
	err := p.safePollOnce(context.Background(), &Inbox{
		ID:       "gmail-1",
		Provider: domain.ProviderGmail,
		Address:  "seed@example.com",
	}, time.Now(), map[string]time.Time{})
	if err == nil || !strings.Contains(err.Error(), "seedlist poll panic: fetch exploded") {
		t.Fatalf("err = %v; want recovered provider panic", err)
	}
}

func TestPollerSafeSendHealthRecoversPanic(t *testing.T) {
	p := NewPoller(NewRegistry(), NopConnector{}, panicHealthSender{}, NopSink{}, nil)
	err := p.safeSendHealth(context.Background(), &Inbox{
		ID:       "gmail-1",
		Provider: domain.ProviderGmail,
		Address:  "seed@example.com",
	}, "test-id")
	if err == nil || !strings.Contains(err.Error(), "seedlist health panic: health exploded") {
		t.Fatalf("err = %v; want recovered health panic", err)
	}
}
