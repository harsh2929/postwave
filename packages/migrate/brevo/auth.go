// SPDX-License-Identifier: MIT

// Package brevo implements the Brevo (formerly Sendinblue) source adapter.
//
// Auth: this adapter uses an account API key in the api-key header.
// Base URL: https://api.brevo.com/v3.
package brevo

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// BuildAPIKeyEntryURL returns the desktop deep-link the migration handler
// returns from /oauth/start when the user picks Brevo. The frontend pattern-
// matches the scheme to render an "API key entry" modal in lieu of opening
// the browser to an OAuth provider.
func BuildAPIKeyEntryURL(state string) string {
	return "moosewave://migrate/brevo/api-key-entry?state=" + state
}

// validateKey uses the provider's organization identity, never a display name.
func (a *Adapter) validateKey(ctx context.Context, apiKey string) (brevoAccount, error) {
	var acct brevoAccount
	if strings.TrimSpace(apiKey) == "" {
		return acct, fmt.Errorf("brevo: missing api key: %w", adapter.ErrAuth)
	}
	if err := a.do(ctx, adapter.Session{AccessToken: apiKey, Source: canonical.SourceBrevo}, http.MethodGet, "/account", nil, &acct); err != nil {
		return acct, err
	}
	acct.OrganizationID = strings.TrimSpace(acct.OrganizationID)
	if acct.OrganizationID == "" || acct.UserID <= 0 {
		return acct, fmt.Errorf("brevo: provider account identity missing: %w", adapter.ErrAuth)
	}
	return acct, nil
}
