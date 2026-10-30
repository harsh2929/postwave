// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

type captureMailer struct{ message mailer.Message }

func (c *captureMailer) Send(_ context.Context, message mailer.Message) error {
	c.message = message
	return nil
}

func TestEmailNotifierDescribesPersonalScopeWithoutPersistingWorkspaceDeletionClaim(t *testing.T) {
	capture := &captureMailer{}
	notifier := &EmailNotifier{Mailer: capture, From: "Moosewave <noreply@example.test>"}
	if err := notifier.NotifyAccountDeleted(context.Background(), "user@example.test", "prv-1"); err != nil {
		t.Fatal(err)
	}
	if capture.message.To != "user@example.test" || !strings.Contains(capture.message.Body, "Shared workspace content was not deleted") {
		t.Fatalf("message=%+v", capture.message)
	}
}
