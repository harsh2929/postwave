// SPDX-License-Identifier: AGPL-3.0-only

package mimecomposer

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func TestComposeGoldenMessage(t *testing.T) {
	if FormatVersion != "postwave.mime-composer.v1" || ContentHashVersion != "postwave.mime-content.v1" {
		t.Fatalf("unexpected composer versions: %q %q", FormatVersion, ContentHashVersion)
	}
	message := Message{
		From:     mail.Address{Name: "Moosewave", Address: "sender@example.com"},
		To:       []mail.Address{{Name: "Ada", Address: "ada@example.net"}},
		Subject:  "Launch",
		TextBody: "Plain = sign",
		HTMLBody: "<html><body>Rich ©</body></html>",
		Headers: map[string]string{
			"X-Z": "last",
			"X-A": "first",
		},
	}
	metadata := Metadata{
		Date:      time.Date(2023, time.November, 14, 22, 13, 20, 0, time.UTC),
		MessageID: "campaign.42@example.com",
		Boundary:  "pw-boundary-42",
	}

	result, err := Compose(message, metadata)
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}

	want := strings.Join([]string{
		"Date: Tue, 14 Nov 2023 22:13:20 +0000",
		"From: \"Moosewave\" <sender@example.com>",
		"To: \"Ada\" <ada@example.net>",
		"Subject: Launch",
		"Message-ID: <campaign.42@example.com>",
		"MIME-Version: 1.0",
		"X-A: first",
		"X-Z: last",
		"Content-Type: multipart/alternative; boundary=pw-boundary-42",
		"",
		"--pw-boundary-42",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"Plain =3D sign",
		"--pw-boundary-42",
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"<html><body>Rich =C2=A9</body></html>",
		"--pw-boundary-42--",
		"",
	}, "\r\n")
	if string(result.Raw) != want {
		t.Fatalf("Raw mismatch\n--- got ---\n%q\n--- want ---\n%q", result.Raw, want)
	}

	wantHashes := Hashes{
		MIME:    "f9e264d3a2afb70d457365473d45f8f91cb94ef671bdf3644746385e10d29b3f",
		Content: "8a2e670e268319368567213d6ff985f350d12185bfa6187a5d7020770c88301b",
		Text:    "2ddeb502af8804d89bcee5e050aa142bceda9fdd880bab0d7ebaf913c89d3fa7",
		HTML:    "c2bcc6bc6fe13c1bae8d886bcbe714d28e07282739fd680de4281959830b3d8b",
	}
	if result.Hashes != wantHashes {
		t.Fatalf("Hashes = %#v, want %#v", result.Hashes, wantHashes)
	}
}

func TestComposeProducesOrderedDecodableAlternatives(t *testing.T) {
	message := validMessage()
	message.TextBody = "alpha\nbeta\r\ngamma\rdelta\n"
	message.HTMLBody = "<p>café &amp; tea</p>"

	result, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}

	parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}
	mediaType, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("ParseMediaType() error = %v", err)
	}
	if mediaType != "multipart/alternative" {
		t.Fatalf("media type = %q, want multipart/alternative", mediaType)
	}
	if params["boundary"] != validMetadata().Boundary {
		t.Fatalf("boundary = %q, want %q", params["boundary"], validMetadata().Boundary)
	}

	reader := multipart.NewReader(parsed.Body, params["boundary"])
	parts := []struct {
		contentType string
		body        string
	}{
		{contentType: "text/plain", body: "alpha\r\nbeta\r\ngamma\r\ndelta\r\n"},
		{contentType: "text/html", body: "<p>café &amp; tea</p>"},
	}
	for i, want := range parts {
		part, err := reader.NextRawPart()
		if err != nil {
			t.Fatalf("NextPart(%d) error = %v", i, err)
		}
		partType, partParams, err := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("ParseMediaType(part %d) error = %v", i, err)
		}
		if partType != want.contentType || !strings.EqualFold(partParams["charset"], "UTF-8") {
			t.Fatalf("part %d Content-Type = %q %#v", i, partType, partParams)
		}
		if got := part.Header.Get("Content-Transfer-Encoding"); got != "quoted-printable" {
			t.Fatalf("part %d transfer encoding = %q", i, got)
		}
		decoded, err := io.ReadAll(quotedprintable.NewReader(part))
		if err != nil {
			t.Fatalf("decode part %d: %v", i, err)
		}
		if string(decoded) != want.body {
			t.Fatalf("part %d body = %q, want %q", i, decoded, want.body)
		}
	}
	if _, err := reader.NextRawPart(); err != io.EOF {
		t.Fatalf("third NextRawPart() error = %v, want io.EOF", err)
	}
}

func TestComposeEncodesInternationalizedSubjectAndDisplayNames(t *testing.T) {
	message := validMessage()
	message.From.Name = "Møøse Wavé"
	message.To = []mail.Address{
		{Name: "佐藤 はな", Address: "hana@example.net"},
		{Name: "Renée", Address: "renee@example.net"},
	}
	message.Cc = []mail.Address{{Name: "Jörg", Address: "jorg@example.net"}}
	message.ReplyTo = []mail.Address{{Name: "Søren Support", Address: "support@example.com"}}
	message.Subject = "Résumé ready 🚀"

	result, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}

	decodedSubject, err := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("DecodeHeader(Subject) error = %v", err)
	}
	if decodedSubject != message.Subject {
		t.Fatalf("decoded Subject = %q, want %q", decodedSubject, message.Subject)
	}
	assertAddressHeader(t, parsed.Header, "From", []mail.Address{message.From})
	assertAddressHeader(t, parsed.Header, "To", message.To)
	assertAddressHeader(t, parsed.Header, "Cc", message.Cc)
	assertAddressHeader(t, parsed.Header, "Reply-To", message.ReplyTo)

	rawHeader := string(result.Raw[:bytes.Index(result.Raw, []byte("\r\n\r\n"))])
	if strings.Contains(rawHeader, "Møøse") || strings.Contains(rawHeader, "Résumé") || strings.Contains(rawHeader, "佐藤") {
		t.Fatalf("internationalized header text was emitted without RFC 2047 encoding: %q", rawHeader)
	}
}

func TestComposeCanonicalizesLineEndingsAndUsesCRLFOnly(t *testing.T) {
	messageLF := validMessage()
	messageLF.TextBody = "one\ntwo\n"
	messageLF.HTMLBody = "<p>one</p>\n<p>two</p>\n"
	messageMixed := messageLF
	messageMixed.TextBody = "one\r\ntwo\r"
	messageMixed.HTMLBody = "<p>one</p>\r<p>two</p>\r\n"

	lf, err := Compose(messageLF, validMetadata())
	if err != nil {
		t.Fatalf("Compose(LF) error = %v", err)
	}
	mixed, err := Compose(messageMixed, validMetadata())
	if err != nil {
		t.Fatalf("Compose(mixed) error = %v", err)
	}
	if !bytes.Equal(lf.Raw, mixed.Raw) {
		t.Fatalf("line-ending variants produced different MIME")
	}
	if lf.Hashes != mixed.Hashes {
		t.Fatalf("line-ending variants produced different hashes: %#v != %#v", lf.Hashes, mixed.Hashes)
	}
	if !usesOnlyCRLF(lf.Raw) {
		t.Fatal("composed MIME contains bare CR or LF")
	}
}

func TestComposeIsDeterministicAndSeparatesContentFromWireHashes(t *testing.T) {
	message := validMessage()
	first, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose(first) error = %v", err)
	}
	second, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose(second) error = %v", err)
	}
	if !bytes.Equal(first.Raw, second.Raw) || first.Hashes != second.Hashes {
		t.Fatal("identical inputs did not produce an identical artifact")
	}

	changedMetadata := validMetadata()
	changedMetadata.Date = changedMetadata.Date.Add(time.Minute)
	changedMetadata.MessageID = "another@example.com"
	changedMetadata.Boundary = "another-boundary"
	metadataResult, err := Compose(message, changedMetadata)
	if err != nil {
		t.Fatalf("Compose(changed metadata) error = %v", err)
	}
	if metadataResult.Hashes.MIME == first.Hashes.MIME {
		t.Fatal("wire metadata change did not change MIME hash")
	}
	if metadataResult.Hashes.Content != first.Hashes.Content || metadataResult.Hashes.Text != first.Hashes.Text || metadataResult.Hashes.HTML != first.Hashes.HTML {
		t.Fatal("wire metadata change affected content hashes")
	}

	changedRecipient := message
	changedRecipient.To = []mail.Address{{Address: "other@example.net"}}
	recipientResult, err := Compose(changedRecipient, validMetadata())
	if err != nil {
		t.Fatalf("Compose(changed recipient) error = %v", err)
	}
	if recipientResult.Hashes.MIME == first.Hashes.MIME || recipientResult.Hashes.Content != first.Hashes.Content {
		t.Fatal("recipient must affect MIME hash but not content hash")
	}

	changedSubject := message
	changedSubject.Subject = "A different subject"
	subjectResult, err := Compose(changedSubject, validMetadata())
	if err != nil {
		t.Fatalf("Compose(changed subject) error = %v", err)
	}
	if subjectResult.Hashes.Content == first.Hashes.Content || subjectResult.Hashes.MIME == first.Hashes.MIME {
		t.Fatal("subject change did not affect content and MIME hashes")
	}
	if subjectResult.Hashes.Text != first.Hashes.Text || subjectResult.Hashes.HTML != first.Hashes.HTML {
		t.Fatal("subject change affected body hashes")
	}

	for name, digest := range map[string]string{
		"MIME": first.Hashes.MIME, "Content": first.Hashes.Content,
		"Text": first.Hashes.Text, "HTML": first.Hashes.HTML,
	} {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != 32 || digest != strings.ToLower(digest) {
			t.Fatalf("%s digest %q is not a lowercase SHA-256 hex value", name, digest)
		}
	}
}

func TestComposeSortsAndFoldsAdditionalHeadersDeterministically(t *testing.T) {
	messageA := validMessage()
	messageA.Headers = map[string]string{
		"X-Zeta":                "z",
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		"X-Alpha":               strings.Repeat("word ", 30) + "tail",
		"X-Postwave-Test-ID":    "test-42",
	}
	messageB := validMessage()
	messageB.Headers = map[string]string{
		"x-postwave-test-id":    "test-42",
		"x-alpha":               strings.Repeat("word ", 30) + "tail",
		"list-unsubscribe-post": "List-Unsubscribe=One-Click",
		"x-zeta":                "z",
	}

	a, err := Compose(messageA, validMetadata())
	if err != nil {
		t.Fatalf("Compose(A) error = %v", err)
	}
	b, err := Compose(messageB, validMetadata())
	if err != nil {
		t.Fatalf("Compose(B) error = %v", err)
	}
	if !bytes.Equal(a.Raw, b.Raw) {
		t.Fatal("header spelling/map order changed canonical output")
	}

	headerEnd := bytes.Index(a.Raw, []byte("\r\n\r\n"))
	if headerEnd < 0 {
		t.Fatal("missing header/body separator")
	}
	for _, line := range strings.Split(string(a.Raw[:headerEnd]), "\r\n") {
		if len(line) > hardHeaderLineLen {
			t.Fatalf("header line length = %d, exceeds %d: %q", len(line), hardHeaderLineLen, line)
		}
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(a.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}
	if strings.Join(strings.Fields(parsed.Header.Get("X-Alpha")), " ") != strings.Join(strings.Fields(messageA.Headers["X-Alpha"]), " ") {
		t.Fatalf("folded X-Alpha did not preserve field words: %q", parsed.Header.Get("X-Alpha"))
	}
	if got := parsed.Header.Get("List-Unsubscribe-Post"); got != "List-Unsubscribe=One-Click" {
		t.Fatalf("List-Unsubscribe-Post = %q", got)
	}
}

func TestComposeFoldsLongEncodedSubjectWithinHardLimit(t *testing.T) {
	message := validMessage()
	message.Subject = strings.Repeat("Résumé 🚀 ", 120) + "ready"
	result, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}

	headerEnd := bytes.Index(result.Raw, []byte("\r\n\r\n"))
	for _, line := range strings.Split(string(result.Raw[:headerEnd]), "\r\n") {
		if len(line) > hardHeaderLineLen {
			t.Fatalf("header line length = %d, exceeds hard limit", len(line))
		}
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}
	decoded, err := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
	if err != nil {
		t.Fatalf("DecodeHeader() error = %v", err)
	}
	if decoded != message.Subject {
		t.Fatalf("decoded subject differs after folding\ngot:  %q\nwant: %q", decoded, message.Subject)
	}
}

func TestComposeQuotedPrintableLinesStayWithinMIMELimit(t *testing.T) {
	message := validMessage()
	message.TextBody = strings.Repeat("café = value with trailing space \n", 40)
	message.HTMLBody = "<p>" + strings.Repeat("🚀 &amp; launch = now ", 80) + "</p>"
	result, err := Compose(message, validMetadata())
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}
	_, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("ParseMediaType() error = %v", err)
	}
	reader := multipart.NewReader(parsed.Body, params["boundary"])
	for partIndex := 0; partIndex < 2; partIndex++ {
		part, err := reader.NextRawPart()
		if err != nil {
			t.Fatalf("NextRawPart(%d) error = %v", partIndex, err)
		}
		encoded, err := io.ReadAll(part)
		if err != nil {
			t.Fatalf("ReadAll(part %d) error = %v", partIndex, err)
		}
		for lineIndex, line := range bytes.Split(encoded, []byte("\r\n")) {
			if len(line) > 76 {
				t.Fatalf("part %d line %d length = %d, exceeds MIME quoted-printable limit", partIndex, lineIndex, len(line))
			}
		}
	}
}

func TestComposeRejectsUnsafeOrInvalidInput(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Message, *Metadata)
		wantErr string
	}{
		{name: "zero date", mutate: func(_ *Message, m *Metadata) { m.Date = time.Time{} }, wantErr: "Date is required"},
		{name: "sub-minute date offset", mutate: func(_ *Message, m *Metadata) { m.Date = time.Date(2025, 1, 1, 0, 0, 0, 0, time.FixedZone("odd", 30)) }, wantErr: "whole number of minutes"},
		{name: "positive 24 hour date offset", mutate: func(_ *Message, m *Metadata) {
			m.Date = time.Date(2025, 1, 1, 0, 0, 0, 0, time.FixedZone("invalid", 24*60*60))
		}, wantErr: "between -24:00 and +24:00"},
		{name: "negative 24 hour date offset", mutate: func(_ *Message, m *Metadata) {
			m.Date = time.Date(2025, 1, 1, 0, 0, 0, 0, time.FixedZone("invalid", -24*60*60))
		}, wantErr: "between -24:00 and +24:00"},
		{name: "missing message id", mutate: func(_ *Message, m *Metadata) { m.MessageID = "" }, wantErr: "MessageID is required"},
		{name: "oversized message id", mutate: func(_ *Message, m *Metadata) { m.MessageID = strings.Repeat("a", MaxMessageIDBytes) + "@example.com" }, wantErr: "MessageID exceeds"},
		{name: "message id injection", mutate: func(_ *Message, m *Metadata) { m.MessageID = "ok@example.com>\r\nBcc: victim@example.com" }, wantErr: "MessageID"},
		{name: "message id leading newline", mutate: func(_ *Message, m *Metadata) { m.MessageID = "\r\nok@example.com" }, wantErr: "control character"},
		{name: "message id mismatched brackets", mutate: func(_ *Message, m *Metadata) { m.MessageID = "<ok@example.com" }, wantErr: "mismatched"},
		{name: "message id quoted local", mutate: func(_ *Message, m *Metadata) { m.MessageID = "\"ok\"@example.com" }, wantErr: "dot-atom"},
		{name: "missing boundary", mutate: func(_ *Message, m *Metadata) { m.Boundary = "" }, wantErr: "Boundary is required"},
		{name: "invalid boundary", mutate: func(_ *Message, m *Metadata) { m.Boundary = strings.Repeat("a", 71) }, wantErr: "invalid Boundary"},
		{name: "boundary whitespace", mutate: func(_ *Message, m *Metadata) { m.Boundary = "unsafe boundary" }, wantErr: "must not contain whitespace"},
		{name: "text boundary collision", mutate: func(m *Message, metadata *Metadata) { m.TextBody = "--" + metadata.Boundary + "\ncontent" }, wantErr: "collides"},
		{name: "html boundary collision", mutate: func(m *Message, metadata *Metadata) { m.HTMLBody = "<p>x</p>\n--" + metadata.Boundary }, wantErr: "collides"},
		{name: "missing from", mutate: func(m *Message, _ *Metadata) { m.From = mail.Address{} }, wantErr: "From address is required"},
		{name: "from display injection", mutate: func(m *Message, _ *Metadata) { m.From.Name = "Safe\r\nBcc: victim@example.com" }, wantErr: "control character"},
		{name: "pre-encoded display name", mutate: func(m *Message, _ *Metadata) { m.From.Name = "=?UTF-8?Q?not_raw_text?=" }, wantErr: "display name must contain decoded text"},
		{name: "oversized display name", mutate: func(m *Message, _ *Metadata) { m.From.Name = strings.Repeat("a", MaxDisplayNameBytes+1) }, wantErr: "display name exceeds"},
		{name: "from address injection", mutate: func(m *Message, _ *Metadata) { m.From.Address = "safe@example.com\r\nBcc: victim@example.com" }, wantErr: "safe ASCII addr-spec"},
		{name: "oversized address", mutate: func(m *Message, _ *Metadata) {
			m.From.Address = strings.Repeat("a", MaxAddressBytes-10) + "@example.com"
		}, wantErr: "address exceeds"},
		{name: "full address instead of addr spec", mutate: func(m *Message, _ *Metadata) { m.From.Address = "Safe <safe@example.com>" }, wantErr: "must be an addr-spec"},
		{name: "international address", mutate: func(m *Message, _ *Metadata) { m.From.Address = "møøse@example.com" }, wantErr: "safe ASCII addr-spec"},
		{name: "missing to", mutate: func(m *Message, _ *Metadata) { m.To = nil }, wantErr: "To is required"},
		{name: "too many addresses", mutate: func(m *Message, _ *Metadata) { m.To = make([]mail.Address, MaxRecipients+1) }, wantErr: "address limit"},
		{name: "subject injection", mutate: func(m *Message, _ *Metadata) { m.Subject = "Safe\r\nBcc: victim@example.com" }, wantErr: "control character"},
		{name: "subject leading newline", mutate: func(m *Message, _ *Metadata) { m.Subject = "\r\nSafe" }, wantErr: "control character"},
		{name: "pre-encoded subject", mutate: func(m *Message, _ *Metadata) { m.Subject = "=?UTF-8?Q?not_raw_text?=" }, wantErr: "decoded text"},
		{name: "empty subject", mutate: func(m *Message, _ *Metadata) { m.Subject = "   " }, wantErr: "Subject is required"},
		{name: "oversized subject", mutate: func(m *Message, _ *Metadata) { m.Subject = strings.Repeat("a", MaxSubjectBytes+1) }, wantErr: "Subject exceeds"},
		{name: "missing text", mutate: func(m *Message, _ *Metadata) { m.TextBody = "" }, wantErr: "TextBody is required"},
		{name: "oversized text", mutate: func(m *Message, _ *Metadata) { m.TextBody = strings.Repeat("a", MaxTextBodyBytes+1) }, wantErr: "TextBody exceeds"},
		{name: "invalid text UTF-8", mutate: func(m *Message, _ *Metadata) { m.TextBody = string([]byte{0xff}) }, wantErr: "TextBody must be valid UTF-8"},
		{name: "missing html", mutate: func(m *Message, _ *Metadata) { m.HTMLBody = "" }, wantErr: "HTMLBody is required"},
		{name: "oversized html", mutate: func(m *Message, _ *Metadata) { m.HTMLBody = strings.Repeat("a", MaxHTMLBodyBytes+1) }, wantErr: "HTMLBody exceeds"},
		{name: "invalid html UTF-8", mutate: func(m *Message, _ *Metadata) { m.HTMLBody = string([]byte{0xff}) }, wantErr: "HTMLBody must be valid UTF-8"},
		{name: "header name injection", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Safe\r\nBcc": "value"} }, wantErr: "invalid additional header name"},
		{name: "header colon", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Safe:": "value"} }, wantErr: "invalid additional header name"},
		{name: "header value injection", mutate: func(m *Message, _ *Metadata) {
			m.Headers = map[string]string{"X-Safe": "value\r\nBcc: victim@example.com"}
		}, wantErr: "CR and LF are forbidden"},
		{name: "header leading newline", mutate: func(m *Message, _ *Metadata) {
			m.Headers = map[string]string{"X-Safe": "\r\nvalue"}
		}, wantErr: "CR and LF are forbidden"},
		{name: "header control", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Safe": "value\x00"} }, wantErr: "control characters"},
		{name: "header non ASCII", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Safe": "café"} }, wantErr: "must be ASCII"},
		{name: "empty header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Safe": "  "} }, wantErr: "must not be empty"},
		{name: "oversized header name", mutate: func(m *Message, _ *Metadata) {
			m.Headers = map[string]string{"X-" + strings.Repeat("a", MaxAdditionalHeaderNameBytes): "value"}
		}, wantErr: "header name exceeds"},
		{name: "oversized header value", mutate: func(m *Message, _ *Metadata) {
			m.Headers = map[string]string{"X-Safe": strings.Repeat("a", MaxAdditionalHeaderValueBytes+1)}
		}, wantErr: "exceeds"},
		{name: "too many headers", mutate: func(m *Message, _ *Metadata) {
			m.Headers = make(map[string]string, MaxAdditionalHeaders+1)
			for i := 0; i <= MaxAdditionalHeaders; i++ {
				m.Headers[fmt.Sprintf("X-Test-%d", i)] = "value"
			}
		}, wantErr: "additional-header limit"},
		{name: "owned header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"sUbJeCt": "replace"} }, wantErr: "owned by the composer or transport"},
		{name: "transport header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"DKIM-Signature": "replace"} }, wantErr: "owned by the composer or transport"},
		{name: "arc header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"ARC-Seal": "replace"} }, wantErr: "owned by the composer or transport"},
		{name: "resent header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"Resent-From": "replace"} }, wantErr: "owned by the composer or transport"},
		{name: "case insensitive duplicate", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Test": "one", "x-test": "two"} }, wantErr: "duplicate additional header"},
		{name: "unfoldable header", mutate: func(m *Message, _ *Metadata) { m.Headers = map[string]string{"X-Token": strings.Repeat("a", 1000)} }, wantErr: "unfolded token"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			message := validMessage()
			metadata := validMetadata()
			tt.mutate(&message, &metadata)
			result, err := Compose(message, metadata)
			if err == nil {
				t.Fatalf("Compose() result = %#v, want error containing %q", result, tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Compose() error = %q, want substring %q", err, tt.wantErr)
			}
			if result.Raw != nil || result.Hashes != (Hashes{}) {
				t.Fatalf("Compose() returned partial result on error: %#v", result)
			}
		})
	}
}

func TestComposeAcceptsBracketedMessageIDAndQuotedBoundary(t *testing.T) {
	metadata := validMetadata()
	metadata.MessageID = "<stable.42@example.com>"
	metadata.Boundary = strings.Repeat("a", 58) + "(quoted)"
	result, err := Compose(validMessage(), metadata)
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
	if err != nil {
		t.Fatalf("mail.ReadMessage() error = %v", err)
	}
	if got := parsed.Header.Get("Message-ID"); got != metadata.MessageID {
		t.Fatalf("Message-ID = %q, want %q", got, metadata.MessageID)
	}
	_, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("ParseMediaType() error = %v", err)
	}
	if params["boundary"] != metadata.Boundary {
		t.Fatalf("boundary = %q, want %q", params["boundary"], metadata.Boundary)
	}
	reader := multipart.NewReader(parsed.Body, params["boundary"])
	for i := 0; i < 2; i++ {
		if _, err := reader.NextRawPart(); err != nil {
			t.Fatalf("NextRawPart(%d) error = %v", i, err)
		}
	}
	if _, err := reader.NextRawPart(); err != io.EOF {
		t.Fatalf("third NextRawPart() error = %v, want io.EOF", err)
	}
}

func TestComposeAcceptsExtremeRFCDateOffsets(t *testing.T) {
	for _, offset := range []int{-23*60*60 - 59*60, 23*60*60 + 59*60} {
		metadata := validMetadata()
		metadata.Date = time.Date(2025, 1, 1, 0, 0, 0, 0, time.FixedZone("edge", offset))
		result, err := Compose(validMessage(), metadata)
		if err != nil {
			t.Fatalf("Compose(offset %d) error = %v", offset, err)
		}
		parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
		if err != nil {
			t.Fatalf("mail.ReadMessage(offset %d) error = %v", offset, err)
		}
		if _, err := parsed.Header.Date(); err != nil {
			t.Fatalf("Header.Date(offset %d) error = %v", offset, err)
		}
	}
}

func validMessage() Message {
	return Message{
		From:     mail.Address{Name: "Moosewave", Address: "sender@example.com"},
		To:       []mail.Address{{Name: "Ada", Address: "ada@example.net"}},
		Subject:  "A useful update",
		TextBody: "The plain-text meaning.\nAct: https://example.com/action",
		HTMLBody: "<!doctype html><html><body><p>The HTML meaning.</p><a href=\"https://example.com/action\">Act</a></body></html>",
	}
}

func validMetadata() Metadata {
	return Metadata{
		Date:      time.Date(2025, time.June, 1, 12, 30, 0, 0, time.FixedZone("IST", 5*60*60+30*60)),
		MessageID: "stable.42@example.com",
		Boundary:  "postwave-boundary-42",
	}
}

func assertAddressHeader(t *testing.T, header mail.Header, name string, want []mail.Address) {
	t.Helper()
	got, err := header.AddressList(name)
	if err != nil {
		t.Fatalf("AddressList(%s) error = %v", name, err)
	}
	if len(got) != len(want) {
		t.Fatalf("AddressList(%s) length = %d, want %d", name, len(got), len(want))
	}
	for i := range want {
		if got[i].Name != want[i].Name || got[i].Address != want[i].Address {
			t.Fatalf("AddressList(%s)[%d] = %#v, want %#v", name, i, got[i], want[i])
		}
	}
}
