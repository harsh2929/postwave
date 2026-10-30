package seedlist

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

func TestFinalizeRawMIMECompleteHashesAndParsesMultipart(t *testing.T) {
	raw := []byte("MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=postwave-boundary\r\n" +
		"\r\n" +
		"--postwave-boundary\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\n" +
		"Hello plain\r\n" +
		"--postwave-boundary\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n\r\n" +
		"<p>Hello HTML</p>\r\n" +
		"--postwave-boundary--\r\n")

	got := finalizeRawMIME(raw, int64(len(raw)), int64(len(raw)+10), 42, 99, false)
	if got.Status != categorizers.RawMIMEComplete || got.Truncated {
		t.Fatalf("status/truncated = %q/%v", got.Status, got.Truncated)
	}
	if string(got.Raw) != string(raw) {
		t.Fatal("complete capture did not preserve exact bytes")
	}
	sum := sha256.Sum256(raw)
	if got.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha256 = %q", got.SHA256)
	}
	if got.UID != 42 || got.UIDValidity != 99 {
		t.Fatalf("uid provenance = %d/%d", got.UID, got.UIDValidity)
	}
	if got.Manifest.Status != categorizers.MIMEParseParsed {
		t.Fatalf("parse status = %q (%s)", got.Manifest.Status, got.Manifest.ErrorCode)
	}
	if len(got.Manifest.Parts) != 2 {
		t.Fatalf("parts = %#v", got.Manifest.Parts)
	}
	if got.Manifest.Parts[0].MediaType != "text/plain" || got.Manifest.Parts[1].MediaType != "text/html" {
		t.Fatalf("part media types = %#v", got.Manifest.Parts)
	}
}

func TestMIMEManifestRetainsOrderedHeaderDigestsAndAuthVerdictsWithoutPII(t *testing.T) {
	raw := []byte("Received: by mx.example.test for <private-seed@example.test>\r\n" +
		"Authentication-Results: mx.example.test; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example; dmarc=pass\r\n" +
		"Message-ID: <recipient-specific@example.test>\r\n" +
		"X-Private-Seed-Alice: should-not-retain-name\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=x\r\n\r\n" +
		"--x\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20plain\r\n" +
		"--x\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Hello=20HTML</p>\r\n" +
		"--x--\r\n")
	got := finalizeRawMIME(raw, int64(len(raw)), 4096, 1, 2, false)
	manifest := got.Manifest
	if manifest.Status != categorizers.MIMEParseParsed || len(manifest.Headers) != 6 {
		t.Fatalf("manifest headers = %#v", manifest)
	}
	if manifest.Headers[0].Name != "received" || manifest.Headers[0].Position != 1 || manifest.Headers[0].ValueSHA256 == "" {
		t.Fatalf("first header receipt = %#v", manifest.Headers[0])
	}
	if len(manifest.AuthenticationResults) != 3 {
		t.Fatalf("authentication results = %#v", manifest.AuthenticationResults)
	}
	if manifest.StructureSHA256 == "" || manifest.TextBodySHA256 == "" || manifest.HTMLBodySHA256 == "" {
		t.Fatalf("structural/body hashes missing: %#v", manifest)
	}
	if manifest.StructureSHA256 != "b9a8eaa29465b0bb556f43c644795bef75a123985652b8834319f046016377aa" {
		t.Fatalf("received structure hash diverged from postwave.mime-composer.v1: %s", manifest.StructureSHA256)
	}
	if manifest.TextBodySHA256 != digestHexBytes([]byte("Hello plain")) ||
		manifest.HTMLBodySHA256 != digestHexBytes([]byte("<p>Hello HTML</p>")) {
		t.Fatalf("received body hashes do not match canonical decoded composer bytes: text=%s html=%s",
			manifest.TextBodySHA256, manifest.HTMLBodySHA256)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(manifest.Headers[3].Name, "other-sha256:") {
		t.Fatalf("private extension header name was not digested: %#v", manifest.Headers[3])
	}
	for _, secret := range []string{"private-seed@example.test", "recipient-specific@example.test", "sender.example", "private-seed-alice"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("PII/auth identity leaked into manifest: %s", encoded)
		}
	}
}

func TestFinalizeRawMIMEOversizeIsBoundedAndUnambiguous(t *testing.T) {
	raw := []byte(strings.Repeat("x", 65))
	got := finalizeRawMIME(raw, int64(len(raw)), 32, 7, 8, true)
	if got.Status != categorizers.RawMIMETruncated || !got.Truncated {
		t.Fatalf("status/truncated = %q/%v", got.Status, got.Truncated)
	}
	if got.ErrorCode != "message_too_large" {
		t.Fatalf("error code = %q", got.ErrorCode)
	}
	if len(got.Raw) != 32 || got.CapturedBytes != 32 || got.MaxBytes != 32 {
		t.Fatalf("raw/captured/max = %d/%d/%d", len(got.Raw), got.CapturedBytes, got.MaxBytes)
	}
	if got.Manifest.Status != categorizers.MIMEParseSkipped {
		t.Fatalf("truncated MIME parse status = %q", got.Manifest.Status)
	}
}

func TestFinalizeRawMIMEReportedSizeMismatchIsIncompleteNotComplete(t *testing.T) {
	got := finalizeRawMIME([]byte("short"), 99, 1024, 7, 8, false)
	if got.Status != categorizers.RawMIMETruncated || got.ErrorCode != "message_incomplete" {
		t.Fatalf("status/error = %q/%q", got.Status, got.ErrorCode)
	}
	if got.Manifest.Status != categorizers.MIMEParseSkipped {
		t.Fatalf("manifest status = %q", got.Manifest.Status)
	}
}

func TestFinalizeRawMIMEMalformedPreservesCaptureAndParseProvenance(t *testing.T) {
	raw := []byte("MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=declared\r\n\r\n" +
		"--different\r\nContent-Type: text/plain\r\n\r\nHello\r\n--different--\r\n")
	got := finalizeRawMIME(raw, int64(len(raw)), 1024, 1, 2, false)
	if got.Status != categorizers.RawMIMEComplete {
		t.Fatalf("capture status = %q", got.Status)
	}
	if got.Manifest.Status != categorizers.MIMEParseMalformed {
		t.Fatalf("parse status = %q", got.Manifest.Status)
	}
	if got.Manifest.ErrorCode != "invalid_multipart_boundary" {
		t.Fatalf("parse error = %q", got.Manifest.ErrorCode)
	}
	if len(got.Raw) != len(raw) || got.SHA256 == "" {
		t.Fatal("malformed MIME should retain the exact bounded capture and hash")
	}
}

func TestMIMEParserNeverLoadsRemoteResources(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	raw := []byte("Content-Type: text/html; charset=utf-8\r\n\r\n" +
		`<html><head><link rel="stylesheet" href="` + server.URL + `/style.css"></head>` +
		`<body><img src="` + server.URL + `/pixel.png"><a href="` + server.URL + `/click">go</a></body></html>`)
	got := finalizeRawMIME(raw, int64(len(raw)), 4096, 1, 1, false)
	if got.Manifest.Status != categorizers.MIMEParseParsed {
		t.Fatalf("parse status = %q", got.Manifest.Status)
	}
	if requests.Load() != 0 {
		t.Fatalf("parser made %d remote requests", requests.Load())
	}
}

func TestRawMIMEBytesAreExcludedFromJSON(t *testing.T) {
	got := finalizeRawMIME([]byte("Subject: secret\r\n\r\nprivate-body"), 32, 1024, 1, 1, false)
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private-body") {
		t.Fatalf("raw MIME leaked into JSON: %s", encoded)
	}
}

func TestReadLiteralBounded(t *testing.T) {
	got, truncated, err := readLiteralBounded(strings.NewReader(strings.Repeat("z", 100)), 17)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(got) != 17 {
		t.Fatalf("truncated/len = %v/%d", truncated, len(got))
	}
}

func TestCapabilitiesOfLegacyConnectorFailsClosed(t *testing.T) {
	got := CapabilitiesOf(legacyFixtureConnector{})
	if got.Headers != CapabilityUnavailable || got.RawMIME != CapabilityUnavailable || got.Placement != CapabilityUnavailable {
		t.Fatalf("legacy capabilities = %#v", got)
	}
}

func FuzzParseMIMEManifest(f *testing.F) {
	f.Add([]byte("Content-Type: text/plain\r\n\r\nhello"))
	f.Add([]byte("Content-Type: multipart/mixed; boundary=x\r\n\r\n--x--\r\n"))
	f.Add([]byte("not a valid header\r\n\r\nbody"))
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 1<<16 {
			t.Skip()
		}
		_ = parseMIMEManifest(raw)
	})
}
