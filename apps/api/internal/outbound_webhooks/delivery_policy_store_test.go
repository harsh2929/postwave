// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestOutboundDeliveryPolicyBoundsMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1797_outbound_webhook_delivery_policy_bounds.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1797: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1797_outbound_webhook_delivery_policy_bounds",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1797 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"outbound_webhooks_filter_expression_size",
		"octet_length(filter_expression) <= 4096",
		"outbound_webhooks_transform_template_shape",
		"jsonb_typeof(transform_template) = 'object'",
		"octet_length(transform_template::text) <= 16384",
		"NOT VALID",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1797 missing contract %q", contract)
		}
	}
}

func TestValidateActivationReadinessFailsClosed(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		webhook *Webhook
		want    error
	}{
		{
			name: "ready",
			webhook: &Webhook{
				AuthConfigStatus:     authConfigStateReady,
				URLStatus:            destinationStateReady,
				DeliveryPolicyStatus: "ready",
			},
		},
		{
			name: "auth migration pending",
			webhook: &Webhook{
				AuthConfigStatus:     authConfigStateLegacyPending,
				URLStatus:            destinationStateReady,
				DeliveryPolicyStatus: "ready",
			},
			want: ErrAuthConfigPending,
		},
		{
			name: "destination invalid",
			webhook: &Webhook{
				AuthConfigStatus:     authConfigStateReady,
				URLStatus:            destinationStateInvalid,
				DeliveryPolicyStatus: "ready",
			},
			want: ErrDestinationInvalid,
		},
		{
			name: "delivery policy invalid",
			webhook: &Webhook{
				AuthConfigStatus:     authConfigStateReady,
				URLStatus:            destinationStateReady,
				DeliveryPolicyStatus: "invalid",
			},
			want: ErrDeliveryPolicyInvalid,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateActivationReadiness(test.webhook)
			if !errors.Is(err, test.want) {
				t.Fatalf("readiness error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestStoreDeliveryPolicyCreateReadUpdateAndClear(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000001797"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"delivery-policy-store-test",
		"delivery-policy-store-test"+tenantID[len(tenantID)-12:],
	)

	t.Cleanup(func() {
		cleanup, cancel := context.WithCancel(context.Background())
		defer cancel()
		tx, err := db.WithTenantWorker(cleanup, (*db.Pool)(pool), tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanup) }()
		_, _ = tx.Exec(cleanup,
			`DELETE FROM outbound_webhooks WHERE tenant_id = $1::uuid`,
			tenantID,
		)
		_ = tx.Commit(cleanup)
	})

	store := &Store{
		Pool:         (*db.Pool)(pool),
		Cipher:       xorAuthCipher{},
		RequireHTTPS: true,
	}
	filter := `event.type == "campaign.sent"`
	transform := map[string]any{
		"event_id":   "/event/id",
		"event_type": "/event/type",
	}
	created, err := store.Create(ctx, tenantID, "", CreateInput{
		URL:               "https://receiver.example.test/hooks/capability?token=secret",
		Events:            []string{"campaign.sent"},
		FilterExpression:  filter,
		TransformTemplate: transform,
	}, true)
	if err != nil {
		t.Fatalf("create (migrations 1796/1797 may be absent): %v", err)
	}
	if created.Webhook.FilterExpression != filter {
		t.Fatalf("created filter = %q, want %q", created.Webhook.FilterExpression, filter)
	}
	if created.Webhook.TransformTemplate["event_id"] != "/event/id" {
		t.Fatalf("created transform = %#v", created.Webhook.TransformTemplate)
	}

	updatedFilter := "event.type == campaign.sent && event.id != ignored"
	updatedTransform := map[string]any{"id": "/event/id"}
	updated, err := store.Update(ctx, tenantID, created.Webhook.ID, UpdateInput{
		FilterExpression:  &updatedFilter,
		TransformTemplate: &updatedTransform,
	}, true)
	if err != nil {
		t.Fatalf("update delivery policy: %v", err)
	}
	if updated.FilterExpression != updatedFilter || updated.TransformTemplate["id"] != "/event/id" {
		t.Fatalf("updated policy = %#v", updated)
	}

	var clear UpdateInput
	if err := clear.UnmarshalJSON([]byte(
		`{"filter_expression":null,"transform_template":null}`,
	)); err != nil {
		t.Fatalf("decode clear patch: %v", err)
	}
	cleared, err := store.Update(ctx, tenantID, created.Webhook.ID, clear, true)
	if err != nil {
		t.Fatalf("clear delivery policy: %v", err)
	}
	if cleared.FilterExpression != "" || len(cleared.TransformTemplate) != 0 {
		t.Fatalf("cleared policy still present: %#v", cleared)
	}

	corruptTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := corruptTx.Exec(ctx, `
UPDATE outbound_webhooks
   SET filter_expression = 'not a valid filter',
       config_version = config_version + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, created.Webhook.ID,
	); err != nil {
		_ = corruptTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := corruptTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	invalid, err := store.Get(ctx, tenantID, created.Webhook.ID)
	if err != nil {
		t.Fatalf("read invalid legacy policy: %v", err)
	}
	if invalid.DeliveryPolicyStatus != "invalid" {
		t.Fatalf("delivery policy status = %q, want invalid", invalid.DeliveryPolicyStatus)
	}
	if _, err := store.LoadDeliveryConfig(
		ctx,
		tenantID,
		created.Webhook.ID,
	); !errors.Is(err, ErrInvalidFilter) {
		t.Fatalf("delivery config error = %v, want ErrInvalidFilter", err)
	}
	if _, err := store.EnqueueDelivery(
		ctx,
		tenantID,
		created.Webhook.ID,
		"campaign.sent",
		"17970000-0000-4000-8000-000000000001",
		[]byte(`{"event":{}}`),
	); !errors.Is(err, ErrDeliveryPolicyInvalid) {
		t.Fatalf("enqueue invalid delivery policy error = %v, want ErrDeliveryPolicyInvalid", err)
	}
}
