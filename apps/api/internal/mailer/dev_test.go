// SPDX-License-Identifier: AGPL-3.0-only

package mailer

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestDevMailerSpoolsRawMIMEWithoutRerendering(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	dev, err := NewDevMailer(slog.New(slog.NewTextHandler(io.Discard, nil)), directory)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("From: sender@example.test\r\nTo: fixture@example.test\r\nSubject: Raw\r\n\r\nexact=3Dbytes\r\n")
	if err := dev.Send(context.Background(), Message{
		From: "sender@example.test", To: "fixture@example.test", Raw: append([]byte(nil), raw...),
	}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("spool entries = %d, want 1", len(entries))
	}
	stored, err := os.ReadFile(filepath.Join(directory, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, raw) {
		t.Fatalf("spooled raw MIME changed:\ngot  %q\nwant %q", stored, raw)
	}
}
