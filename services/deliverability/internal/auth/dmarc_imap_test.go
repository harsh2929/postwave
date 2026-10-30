package auth

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"
)

// sampleDMARCXML is a tiny but RFC-7489-shaped report fixture used by
// the parser + decompress unit tests below.
const sampleDMARCXML = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>1234567890</report_id>
    <date_range>
      <begin>1700000000</begin>
      <end>1700086400</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>quarantine</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>10</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <result>pass</result>
        <selector>s1</selector>
      </dkim>
      <spf>
        <domain>example.com</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
</feedback>`

// TestExtractTenantFromAddress validates the plus-addressed envelope-To
// resolution. The poller relies on this for first-step tenant mapping.
func TestExtractTenantFromAddress(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "canonical shape",
			in:   "dmarc-tenant-11111111-2222-3333-4444-555555555555@reports.moosewave.com",
			want: "11111111-2222-3333-4444-555555555555",
		},
		{
			name: "case insensitive prefix",
			in:   "DMARC-Tenant-11111111-2222-3333-4444-555555555555@reports.moosewave.com",
			want: "11111111-2222-3333-4444-555555555555",
		},
		{
			name: "no match — wrong prefix",
			in:   "support@reports.moosewave.com",
			want: "",
		},
		{
			name: "no match — partial uuid",
			in:   "dmarc-tenant-deadbeef@reports.moosewave.com",
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractTenantFromAddress(tc.in)
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

// TestDefaultTenantResolver_FromEnvelope: envelope-To beats policy-domain
// when both are present.
func TestDefaultTenantResolver_FromEnvelope(t *testing.T) {
	res := DefaultTenantResolver{}
	tenantUUID := "abcdef01-2345-6789-abcd-ef0123456789"
	env := &imap.Envelope{
		To: []imap.Address{
			{Mailbox: "dmarc-tenant-" + tenantUUID, Host: "reports.moosewave.com"},
		},
	}
	parsed := &Report{
		PolicyPub: PolicyPublished{Domain: "example.com"},
	}
	got, err := res.Resolve(context.Background(), env, parsed)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != tenantUUID {
		t.Fatalf("got %q want %q", got, tenantUUID)
	}
}

// TestDefaultTenantResolver_NoMatchReturnsError surfaces the policy domain
// in the error so the poller can log useful context.
func TestDefaultTenantResolver_NoMatchReturnsError(t *testing.T) {
	res := DefaultTenantResolver{}
	env := &imap.Envelope{
		To: []imap.Address{{Mailbox: "support", Host: "reports.moosewave.com"}},
	}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "example.com"}}
	got, err := res.Resolve(context.Background(), env, parsed)
	if err == nil {
		t.Fatalf("expected error for unmappable report")
	}
	if got != "" {
		t.Fatalf("expected empty tenant id, got %q", got)
	}
	if !strings.Contains(err.Error(), "example.com") {
		t.Fatalf("error should mention domain; got %v", err)
	}
}

// TestDefaultTenantResolver_HasNoFallback proves hostile/unmapped evidence is
// never assigned to a global bring-up tenant.
func TestDefaultTenantResolver_HasNoFallback(t *testing.T) {
	res := DefaultTenantResolver{}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "example.com"}}
	got, err := res.Resolve(context.Background(), nil, parsed)
	if err == nil {
		t.Fatal("expected unmapped error")
	}
	if got != "" {
		t.Fatalf("got %q want empty tenant", got)
	}
}

// fakeSendDomainLookup is a deterministic stand-in for *SendDomainClient
// used by the resolver tests below. It records the last domain queried
// so we can assert the resolver actually consulted it.
type fakeSendDomainLookup struct {
	tenantID  string
	err       error
	lastQuery string
	calls     int
}

func (f *fakeSendDomainLookup) LookupTenant(_ context.Context, domain string) (string, error) {
	f.calls++
	f.lastQuery = domain
	return f.tenantID, f.err
}

// TestDefaultTenantResolver_SendDomainHit: when the envelope misses
// but the SendDomainClient returns a tenant for the policy domain,
// the resolver returns that tenant id.
func TestDefaultTenantResolver_SendDomainHit(t *testing.T) {
	want := "deadbeef-1234-5678-9abc-def012345678"
	lookup := &fakeSendDomainLookup{tenantID: want}
	res := DefaultTenantResolver{SendDomainClient: lookup}

	// Envelope-To has no plus-addressed match.
	env := &imap.Envelope{
		To: []imap.Address{{Mailbox: "support", Host: "reports.moosewave.com"}},
	}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "tenant.example.com"}}

	got, err := res.Resolve(context.Background(), env, parsed)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != want {
		t.Fatalf("tenant: got %q want %q", got, want)
	}
	if lookup.lastQuery != "tenant.example.com" {
		t.Fatalf("lookup query: got %q want tenant.example.com", lookup.lastQuery)
	}
	if lookup.calls != 1 {
		t.Fatalf("calls: got %d want 1", lookup.calls)
	}
}

// TestDefaultTenantResolver_SendDomainMissStaysUnmapped: ErrNotFound must not
// silently assign the report to another tenant.
func TestDefaultTenantResolver_SendDomainMissStaysUnmapped(t *testing.T) {
	lookup := &fakeSendDomainLookup{err: ErrNotFound}
	res := DefaultTenantResolver{SendDomainClient: lookup}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "unmapped.example.com"}}
	got, err := res.Resolve(context.Background(), nil, parsed)
	if err == nil {
		t.Fatal("expected unmapped error")
	}
	if got != "" {
		t.Fatalf("tenant: got %q want empty", got)
	}
	if lookup.calls != 1 {
		t.Fatalf("lookup must have been consulted once; calls = %d", lookup.calls)
	}
}

// TestDefaultTenantResolver_SendDomainErrorStaysUnmapped ensures a mapping
// outage cannot route evidence into an arbitrary tenant.
func TestDefaultTenantResolver_SendDomainErrorStaysUnmapped(t *testing.T) {
	lookup := &fakeSendDomainLookup{err: errors.New("connection refused")}
	res := DefaultTenantResolver{SendDomainClient: lookup}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "flaky.example.com"}}
	got, err := res.Resolve(context.Background(), nil, parsed)
	if err == nil {
		t.Fatal("expected unmapped error")
	}
	if got != "" {
		t.Fatalf("tenant: got %q want empty", got)
	}
}

// TestDefaultTenantResolver_SendDomainSkippedWhenNil: a nil client leaves the
// report unmapped; it never enables a compatibility fallback.
func TestDefaultTenantResolver_SendDomainSkippedWhenNil(t *testing.T) {
	res := DefaultTenantResolver{SendDomainClient: nil}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "any.example.com"}}
	got, err := res.Resolve(context.Background(), nil, parsed)
	if err == nil {
		t.Fatal("expected unmapped error")
	}
	if got != "" {
		t.Fatalf("tenant: got %q want empty", got)
	}
}

// TestDefaultTenantResolver_EnvelopeBeatsSendDomain: the plus-addressed
// envelope match is preferred over the policy-domain lookup; the
// SendDomainClient is never consulted when step 1 succeeds.
func TestDefaultTenantResolver_EnvelopeBeatsSendDomain(t *testing.T) {
	tenantUUID := "abcdef01-2345-6789-abcd-ef0123456789"
	lookup := &fakeSendDomainLookup{tenantID: "should-not-be-returned"}
	res := DefaultTenantResolver{SendDomainClient: lookup}

	env := &imap.Envelope{
		To: []imap.Address{{Mailbox: "dmarc-tenant-" + tenantUUID, Host: "reports.moosewave.com"}},
	}
	parsed := &Report{PolicyPub: PolicyPublished{Domain: "example.com"}}
	got, err := res.Resolve(context.Background(), env, parsed)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != tenantUUID {
		t.Fatalf("tenant: got %q want %q", got, tenantUUID)
	}
	if lookup.calls != 0 {
		t.Fatalf("SendDomainClient must not be consulted when envelope matches; calls = %d", lookup.calls)
	}
}

// TestExtractDMARCAttachments_Gzip synthesizes a multipart message with
// a base64-encoded application/gzip part and asserts the parser sees
// the inner XML.
func TestExtractDMARCAttachments_Gzip(t *testing.T) {
	gzData := gzipBytes(t, []byte(sampleDMARCXML))
	encoded := base64.StdEncoding.EncodeToString(gzData)

	boundary := "POSTWAVE_TEST_BOUNDARY"
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "From: noreply-dmarc-support@google.com\r\n")
	fmt.Fprintf(&buf, "To: dmarc-tenant-11111111-2222-3333-4444-555555555555@reports.moosewave.com\r\n")
	fmt.Fprintf(&buf, "Subject: Report Domain: example.com Submitter: google.com\r\n")
	fmt.Fprintf(&buf, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&buf, "Content-Type: multipart/mixed; boundary=\"%s\"\r\n\r\n", boundary)
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	fmt.Fprintf(&buf, "Content-Type: text/plain; charset=us-ascii\r\n\r\n")
	fmt.Fprintf(&buf, "DMARC report attached.\r\n")
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	fmt.Fprintf(&buf, "Content-Type: application/gzip; name=\"google.com!example.com!1700000000!1700086400.xml.gz\"\r\n")
	fmt.Fprintf(&buf, "Content-Disposition: attachment; filename=\"google.com!example.com!1700000000!1700086400.xml.gz\"\r\n")
	fmt.Fprintf(&buf, "Content-Transfer-Encoding: base64\r\n\r\n")
	// Wrap base64 at 76 cols like real MUAs.
	for i := 0; i < len(encoded); i += 76 {
		end := i + 76
		if end > len(encoded) {
			end = len(encoded)
		}
		fmt.Fprintf(&buf, "%s\r\n", encoded[i:end])
	}
	fmt.Fprintf(&buf, "--%s--\r\n", boundary)

	readers, err := extractDMARCAttachments(buf.Bytes())
	if err != nil {
		t.Fatalf("extractDMARCAttachments: %v", err)
	}
	if len(readers) != 1 {
		t.Fatalf("readers: got %d want 1", len(readers))
	}
	parsed, err := ParseXML(readers[0])
	if err != nil {
		t.Fatalf("ParseXML: %v", err)
	}
	if parsed.PolicyPub.Domain != "example.com" {
		t.Fatalf("policy domain: got %q want example.com", parsed.PolicyPub.Domain)
	}
	if len(parsed.Records) != 1 {
		t.Fatalf("records: got %d want 1", len(parsed.Records))
	}
	if parsed.Records[0].Row.Count != 10 {
		t.Fatalf("count: got %d want 10", parsed.Records[0].Row.Count)
	}
}

// TestDecompressAttachment_FormatDispatch covers the three formats the
// poller is expected to handle: zip, gzip, and a plain XML body sent
// with octet-stream.
func TestDecompressAttachment_FormatDispatch(t *testing.T) {
	t.Run("plain xml under octet-stream", func(t *testing.T) {
		readers, err := decompressAttachment("application/octet-stream", "report.xml", []byte(sampleDMARCXML))
		if err != nil {
			t.Fatalf("decompressAttachment: %v", err)
		}
		if len(readers) != 1 {
			t.Fatalf("readers: got %d want 1", len(readers))
		}
		parsed, err := ParseXML(readers[0])
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if parsed.PolicyPub.Domain != "example.com" {
			t.Fatalf("domain: got %q", parsed.PolicyPub.Domain)
		}
	})
	t.Run("gzip", func(t *testing.T) {
		gz := gzipBytes(t, []byte(sampleDMARCXML))
		readers, err := decompressAttachment("application/gzip", "x.xml.gz", gz)
		if err != nil {
			t.Fatalf("decompressAttachment: %v", err)
		}
		if len(readers) != 1 {
			t.Fatalf("readers: got %d want 1", len(readers))
		}
		out, _ := readAllLimited(readers[0], maxDMARCDecompressedXMLBytes, "test gzip payload")
		if !strings.Contains(string(out), "<feedback>") {
			t.Fatalf("decoded body missing <feedback>")
		}
	})
}

func TestExtractDMARCAttachments_RejectsOversizedRawMessage(t *testing.T) {
	_, err := extractDMARCAttachments(bytes.Repeat([]byte("x"), maxRawDMARCMessageBytes+1))
	if err == nil || !strings.Contains(err.Error(), "dmarc message exceeds") {
		t.Fatalf("err = %v, want raw message size error", err)
	}
}

func TestDecompressAttachment_RejectsGzipExpansionBomb(t *testing.T) {
	gz := gzipBytes(t, bytes.Repeat([]byte("<"), maxDMARCDecompressedXMLBytes+1))
	_, err := decompressAttachment("application/gzip", "bomb.xml.gz", gz)
	if err == nil || !strings.Contains(err.Error(), "dmarc gzip payload exceeds") {
		t.Fatalf("err = %v, want gzip payload size error", err)
	}
}

func TestDecompressAttachment_RejectsZipExpansionBomb(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("bomb.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(bytes.Repeat([]byte("<"), maxDMARCDecompressedXMLBytes+1)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = decompressAttachment("application/zip", "bomb.zip", buf.Bytes())
	if err == nil || !strings.Contains(err.Error(), "dmarc zip entry") {
		t.Fatalf("err = %v, want zip entry size error", err)
	}
}

func TestDecompressAttachment_RejectsTooManyZipXMLFiles(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i < maxDMARCXMLAttachmentsPerMail+1; i++ {
		w, err := zw.Create(fmt.Sprintf("report-%02d.xml", i))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(sampleDMARCXML)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	_, err := decompressAttachment("application/zip", "many.zip", buf.Bytes())
	if err == nil || !strings.Contains(err.Error(), "more than") {
		t.Fatalf("err = %v, want too many XML entries error", err)
	}
}

// TestPollOnce_RequiresStore: the poller refuses to run with no store.
func TestPollOnce_RequiresStore(t *testing.T) {
	p := &Poller{Host: "imap.example", Port: 993}
	if err := p.pollOnce(context.Background()); err == nil {
		t.Fatalf("expected error from pollOnce with nil Store")
	}
}

func TestRecoverPollConvertsPanicToError(t *testing.T) {
	err := recoverPoll("dmarc poller", func() error {
		panic("imap exploded")
	})
	if err == nil || !strings.Contains(err.Error(), "dmarc poller panic: imap exploded") {
		t.Fatalf("err = %v; want recovered panic", err)
	}
}

// TestPollerFromEnv_Disabled proves credentials alone cannot activate the
// untrusted legacy path without the explicit break-glass flag.
func TestPollerFromEnv_Disabled(t *testing.T) {
	t.Setenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION", "false")
	t.Setenv("DMARC_IMAP_HOST", "imap.example.com")
	p, err := PollerFromEnv(nil, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p != nil {
		t.Fatalf("expected nil poller when legacy ingestion is disabled")
	}
}

// TestPollerFromEnv_Configured: with the env vars set we pick them up.
func TestPollerFromEnv_Configured(t *testing.T) {
	t.Setenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION", "true")
	t.Setenv("DMARC_IMAP_HOST", "imap.example.com")
	t.Setenv("DMARC_IMAP_PORT", "993")
	t.Setenv("DMARC_IMAP_USER", "rua@reports.moosewave.com")
	t.Setenv("DMARC_IMAP_PASSWORD", "supersecret")
	t.Setenv("DMARC_IMAP_FOLDER", "INBOX/dmarc")
	t.Setenv("DMARC_IMAP_INTERVAL_SECONDS", "60")

	p, err := PollerFromEnv(&Store{}, nil)
	if err != nil {
		t.Fatalf("PollerFromEnv: %v", err)
	}
	if p == nil {
		t.Fatalf("expected non-nil poller")
	}
	if p.Host != "imap.example.com" || p.Port != 993 {
		t.Fatalf("host/port: got %s:%d", p.Host, p.Port)
	}
	if p.User != "rua@reports.moosewave.com" || p.Password != "supersecret" {
		t.Fatalf("creds not picked up")
	}
	if p.Folder != "INBOX/dmarc" {
		t.Fatalf("folder: got %q", p.Folder)
	}
	if p.Interval.Seconds() != 60 {
		t.Fatalf("interval: got %v want 60s", p.Interval)
	}
}

// TestPollerIntegration_Skipped is the placeholder for full IMAP loop
// integration. We don't ship an in-process IMAP server (out of scope),
// so this just skips when no DMARC_IMAP_HOST is set.
func TestPollerIntegration_Skipped(t *testing.T) {
	if os.Getenv("DMARC_IMAP_HOST") == "" {
		t.Skip("DMARC_IMAP_HOST not set; skipping IMAP integration test")
	}
	t.Skip("integration path requires a running IMAP server with prepared messages; not implemented in CI")
}

// helpers --------------------------------------------------------------

func gzipBytes(t *testing.T, in []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(in); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// TestZipEntryCountIsCapped pins the second half of the decompression bound.
//
// A DMARC aggregate report arrives as an email attachment from ANY reporter
// that chooses to send one, so both dimensions of a zip bomb have to be
// bounded: how large each entry may expand to, and how many entries are read.
//
// The size cap (maxDMARCDecompressedXMLBytes) was already covered — raising it
// fails a test. The COUNT cap was not: raising maxDMARCXMLAttachmentsPerMail
// from 20 to 100000 left the suite green. With the 5 MiB per-entry limit that
// is the difference between 100 MiB and 500 GiB of decompression work from a
// single message.
func TestZipEntryCountIsCapped(t *testing.T) {
	build := func(entries int) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for i := 0; i < entries; i++ {
			w, err := zw.Create(fmt.Sprintf("report-%d.xml", i))
			if err != nil {
				t.Fatalf("zip create: %v", err)
			}
			if _, err := w.Write([]byte(sampleDMARCXML)); err != nil {
				t.Fatalf("zip write: %v", err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zip close: %v", err)
		}
		return buf.Bytes()
	}

	// The VALUE, not just the relationship. Every case below builds its input
	// from maxDMARCXMLAttachmentsPerMail, so raising the constant moves the
	// input and the expectation together and the test cannot notice — verified
	// by mutation: 20 -> 100000 left them all green. Pinning the number is what
	// makes a cap change a decision someone has to make on purpose.
	//
	// 20 entries x the 5 MiB per-entry cap bounds one message at 100 MiB of
	// decompression. At 100000 it would be 500 GiB.
	if maxDMARCXMLAttachmentsPerMail != 20 {
		t.Fatalf(
			"XML-entry cap changed to %d; with maxDMARCDecompressedXMLBytes this bounds "+
				"per-message decompression, so confirm the new ceiling is intended",
			maxDMARCXMLAttachmentsPerMail,
		)
	}
	if maxDMARCDecompressedXMLBytes != 5<<20 {
		t.Fatalf("per-entry decompressed cap changed to %d", maxDMARCDecompressedXMLBytes)
	}

	// At the limit: accepted, and every entry is returned.
	readers, err := decompressAttachment("application/zip", "reports.zip", build(maxDMARCXMLAttachmentsPerMail))
	if err != nil {
		t.Fatalf("a zip at the entry limit was rejected: %v", err)
	}
	if len(readers) != maxDMARCXMLAttachmentsPerMail {
		t.Fatalf("got %d readers, want %d", len(readers), maxDMARCXMLAttachmentsPerMail)
	}

	// One past it: refused rather than silently truncated. Truncation would be
	// worse than rejection here — a partial report is indistinguishable from a
	// complete one downstream.
	if _, err := decompressAttachment("application/zip", "reports.zip", build(maxDMARCXMLAttachmentsPerMail+1)); err == nil {
		t.Fatal("a zip past the entry limit was accepted")
	}

	// Guard the guard: non-XML entries do not count toward the cap, so an
	// archive of the same size made of other files must still work.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i < maxDMARCXMLAttachmentsPerMail+5; i++ {
		w, _ := zw.Create(fmt.Sprintf("noise-%d.txt", i))
		_, _ = w.Write([]byte("not xml"))
	}
	w, _ := zw.Create("report.xml")
	_, _ = w.Write([]byte(sampleDMARCXML))
	_ = zw.Close()
	readers, err = decompressAttachment("application/zip", "mixed.zip", buf.Bytes())
	if err != nil {
		t.Fatalf("non-XML entries counted toward the cap: %v", err)
	}
	if len(readers) != 1 {
		t.Fatalf("got %d readers from the mixed archive, want 1", len(readers))
	}
}
