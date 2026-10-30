// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// WorkspaceIdentity is how a workspace presents itself in its own email. It
// fills the workspace tokens (brand_name, sender_name, reply_to_email) when a
// draft is created from a template, so a shared design speaks for the sender
// that uses it rather than for whoever wrote the sample copy.
type WorkspaceIdentity struct {
	// BrandName is the workspace display name (Settings → Workspace), else
	// the legal sender name (Settings → Sender), else the workspace's name
	// at signup. It is never empty for a real workspace.
	BrandName string
	// SenderName is who signs the email. Workspaces record no person, so it
	// is the brand name: the name recipients already know the sender by.
	SenderName string
	// ReplyToEmail is the workspace's default reply-to address, else its
	// compliance contact address. Empty when neither is configured; the
	// token then stays in the draft for the author to fill.
	ReplyToEmail string
}

func (identity WorkspaceIdentity) values() map[string]any {
	values := map[string]any{}
	for token, value := range map[string]string{
		WorkspaceBrandNameToken:    identity.BrandName,
		WorkspaceSenderNameToken:   identity.SenderName,
		WorkspaceReplyToEmailToken: identity.ReplyToEmail,
	} {
		if value = strings.TrimSpace(value); value != "" {
			values[token] = value
		}
	}
	return values
}

// WorkspaceIdentity reads the calling workspace's identity under its own RLS
// scope. Settings a workspace has not saved yet simply fall through to the
// next source.
func (r *Repo) WorkspaceIdentity(ctx context.Context, tenantID string) (WorkspaceIdentity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return WorkspaceIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var identity WorkspaceIdentity
	err = tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(btrim(ws.display_name), ''),
                NULLIF(btrim(profile.legal_sender_name), ''),
                btrim(t.name), ''),
       COALESCE(NULLIF(btrim(ws.default_reply_to::text), ''),
                NULLIF(btrim(profile.compliance_contact_email::text), ''), '')
  FROM tenants t
  LEFT JOIN workspace_settings ws ON ws.tenant_id = t.id
  LEFT JOIN email_compliance_profiles profile ON profile.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&identity.BrandName, &identity.ReplyToEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkspaceIdentity{}, tx.Commit(ctx)
	}
	if err != nil {
		return WorkspaceIdentity{}, err
	}
	identity.SenderName = identity.BrandName
	return identity, tx.Commit(ctx)
}
