// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func insertProviderBindingSender(t *testing.T, pool *db.Pool, tenantID, phone, profile string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("sender tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO sms_sender_profiles (tenant_id, provider, phone_number, messaging_service_sid)
VALUES ($1::uuid, 'telnyx', NULLIF($2, ''), NULLIF($3, ''))
RETURNING id::text`, tenantID, phone, profile).Scan(&id); err != nil {
		t.Fatalf("insert sender: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit sender: %v", err)
	}
	return id
}

func TestResolveProviderWebhookSenderRejectsMixedTenantReceiverDimensionsDB(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantA := createBroadcastTenant(t, ctx, pool)
	tenantB := createBroadcastTenant(t, ctx, pool)
	phoneA := "+14155550101"
	idA := insertProviderBindingSender(t, pool, tenantA, phoneA, "")
	idB := insertProviderBindingSender(t, pool, tenantB, "", "profile-b")
	store := &Store{Pool: pool}

	if got, err := store.ResolveProviderWebhookSender(ctx, tenantA, ProviderTelnyx, phoneA, ""); err != nil || got != idA {
		t.Fatalf("phone-only binding=(%q,%v), want %q", got, err, idA)
	}
	if got, err := store.ResolveProviderWebhookSender(ctx, tenantB, ProviderTelnyx, "", "profile-b"); err != nil || got != idB {
		t.Fatalf("profile-only callback binding=(%q,%v), want %q", got, err, idB)
	}
	if got, err := store.ResolveProviderWebhookSender(ctx, tenantB, ProviderTelnyx, "+14155550102", "profile-b"); !errors.Is(err, ErrProviderTenantBinding) || got != "" {
		t.Fatalf("number-bearing callback for unassigned profile=(%q,%v), want tenant-binding rejection", got, err)
	}
	if got, err := store.ResolveProviderWebhookSender(ctx, tenantB, ProviderTelnyx, phoneA, "profile-b"); !errors.Is(err, ErrProviderTenantBinding) || got != "" {
		t.Fatalf("mixed cross-tenant binding=(%q,%v), want tenant-binding rejection", got, err)
	}
	if got, err := store.ResolveProviderWebhookSender(ctx, tenantA, ProviderTelnyx, "+14155550102", "profile-b"); !errors.Is(err, ErrProviderTenantBinding) || got != "" {
		t.Fatalf("wrong claimed tenant binding=(%q,%v), want tenant-binding rejection", got, err)
	}
}

func TestUpdateDeliveryStatusBindsAuthenticatedReceiverToMessageSenderDB(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	receiverSenderID := insertProviderBindingSender(t, pool, tenantID, "+14155550111", "profile-a")
	messageSenderID := insertProviderBindingSender(t, pool, tenantID, "+14155550112", "profile-b")

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("message tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO sms_messages (
  tenant_id, sender_profile_id, phone_e164, provider, provider_message_id,
  direction, body, segments, status, sent_at
) VALUES ($1::uuid, $2::uuid, '+14155550113', 'telnyx', 'provider-receipt-1',
          'outbound', 'bounded body', 1, 'accepted', now())`, tenantID, messageSenderID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert outbound message: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit outbound message: %v", err)
	}

	store := &Store{Pool: pool}
	if _, err := store.UpdateDeliveryStatus(ctx, tenantID, receiverSenderID, ProviderTelnyx,
		"provider-receipt-1", "queued", "", "", nil); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("mismatched authenticated receiver error = %v, want no rows", err)
	}
	message, err := store.UpdateDeliveryStatus(ctx, tenantID, messageSenderID, ProviderTelnyx,
		"provider-receipt-1", "queued", "", "", nil)
	if err != nil {
		t.Fatalf("matching authenticated receiver update: %v", err)
	}
	if message.SenderProfileID != messageSenderID || message.Status != "queued" {
		t.Fatalf("updated message = sender %q status %q", message.SenderProfileID, message.Status)
	}
}
