// SPDX-License-Identifier: AGPL-3.0-only

package mimecomposer

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"testing"
)

func FuzzComposeNeverEmitsInjectedHeader(f *testing.F) {
	f.Add("Normal sender", "Normal subject", "normal-value")
	f.Add("Sender\r\nBcc: victim@example.com", "Normal subject", "normal-value")
	f.Add("Normal sender", "Subject\r\nBcc: victim@example.com", "normal-value")
	f.Add("Normal sender", "Normal subject", "value\r\nBcc: victim@example.com")
	f.Add("Renée", "Résumé ready 🚀", "ascii-value")

	f.Fuzz(func(t *testing.T, displayName, subject, headerValue string) {
		message := validMessage()
		message.From.Name = displayName
		message.Subject = subject
		message.Headers = map[string]string{"X-Fuzz": headerValue}
		result, err := Compose(message, validMetadata())
		if err != nil {
			return
		}
		if !usesOnlyCRLF(result.Raw) {
			t.Fatal("successful composition emitted a bare CR or LF")
		}
		parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
		if err != nil {
			t.Fatalf("successful composition is not parseable: %v", err)
		}
		if parsed.Header.Get("Bcc") != "" {
			t.Fatalf("untrusted input emitted a Bcc header: %#v", parsed.Header)
		}
	})
}

func FuzzComposeBoundaryRoundTrip(f *testing.F) {
	f.Add("postwave-boundary")
	f.Add("boundary(with)paren")
	f.Add("unsafe boundary")
	f.Add("bad\r\nboundary")

	f.Fuzz(func(t *testing.T, boundary string) {
		metadata := validMetadata()
		metadata.Boundary = boundary
		result, err := Compose(validMessage(), metadata)
		if err != nil {
			return
		}
		parsed, err := mail.ReadMessage(bytes.NewReader(result.Raw))
		if err != nil {
			t.Fatalf("successful composition is not parseable: %v", err)
		}
		mediaType, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("successful Content-Type is not parseable: %v", err)
		}
		if mediaType != "multipart/alternative" || params["boundary"] != boundary {
			t.Fatalf("Content-Type round trip = %q %#v, want boundary %q", mediaType, params, boundary)
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
	})
}
