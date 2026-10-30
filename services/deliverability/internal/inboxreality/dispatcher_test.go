// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"errors"
	"testing"
)

func TestInsertTestHeaderPreservesSourceMIMEAndAddsExactlyOneHeader(t *testing.T) {
	raw := []byte("From: sender@example.test\r\nSubject: Launch\r\nContent-Type: text/plain\r\n\r\nLaunch\r\n")
	value := "irt_0123456789abcdef0123456789abcdef"
	dispatched, err := insertTestHeader(raw, value)
	if err != nil {
		t.Fatal(err)
	}
	inserted := []byte("\r\nX-Postwave-Test-ID: " + value)
	if bytes.Count(dispatched, []byte("X-Postwave-Test-ID:")) != 1 {
		t.Fatalf("correlation header count=%d", bytes.Count(dispatched, []byte("X-Postwave-Test-ID:")))
	}
	reconstructed := bytes.Replace(dispatched, inserted, nil, 1)
	if !bytes.Equal(reconstructed, raw) {
		t.Fatalf("source MIME changed outside the correlation-header insertion\nwant=%q\n got=%q", raw, reconstructed)
	}
	if digest(dispatched) == digest(raw) {
		t.Fatal("source and dispatched hashes must be distinct")
	}
}

func TestInsertTestHeaderRejectsCallerSuppliedCorrelationHeader(t *testing.T) {
	raw := []byte("From: sender@example.test\r\nx-postwave-test-id: irt_existing\r\n\r\nLaunch\r\n")
	_, err := insertTestHeader(raw, "irt_0123456789abcdef0123456789abcdef")
	if !errors.Is(err, ErrCommandConflict) {
		t.Fatalf("error=%v, want ErrCommandConflict", err)
	}
}

func TestNormalizedRFCMessageIDHashIgnoresBracketsCaseAndWhitespace(t *testing.T) {
	left := normalizedRFCMessageIDHash([]byte("Message-ID: <PW.Example@Example.TEST>\r\n\r\nbody"))
	right := digest([]byte("pw.example@example.test"))
	if left == "" || left != right {
		t.Fatalf("message ID hash=%q, want %q", left, right)
	}
}
