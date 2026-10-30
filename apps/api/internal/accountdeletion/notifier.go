// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// EmailNotifier sends a terse post-commit confirmation. The worker passes the
// recipient from memory after removing the user; neither this adapter nor the
// deletion certificate persists the address.
type EmailNotifier struct {
	Mailer mailer.Mailer
	From   string
}

func (n *EmailNotifier) NotifyAccountDeleted(ctx context.Context, email, requestID string) error {
	if n == nil || n.Mailer == nil {
		return nil
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return nil
	}
	from := strings.TrimSpace(n.From)
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	body := fmt.Sprintf(`Your personal Moosewave account has been deleted.

Reference: %s

Shared workspace content was not deleted. Limited pseudonymized legal, security, billing, immutable audit, and encrypted backup records may remain until their documented retention periods expire.

If you did not request this action, contact security@moosewave.com immediately.`, requestID)
	return n.Mailer.Send(ctx, mailer.Message{
		From:    from,
		To:      email,
		Subject: "Your Moosewave account has been deleted",
		Body:    body,
		Tags:    map[string]string{"purpose": "account_deletion_complete"},
	})
}
