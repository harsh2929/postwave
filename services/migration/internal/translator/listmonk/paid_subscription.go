package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/postwave/migrate/canonical"
)

// PersistPaidSubscription mirrors an imported paid subscription into
// Moosewave-owned migration state. It is intentionally separate from the
// billing service's live subscription tables.
func PersistPaidSubscription(ctx context.Context, db *sql.DB, tenantID, jobID string, ps canonical.PaidSub) (id string, err error) {
	payload, err := json.Marshal(ps)
	if err != nil {
		return "", fmt.Errorf("marshal paid subscription %q: %w", paidSubSourceID(ps), err)
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return "", err
	}
	defer commitTx(tx, &err)

	if err := tx.QueryRowContext(ctx, `
		INSERT INTO migration_paid_subscriptions
			(tenant_id, job_id, source_platform, email, stripe_customer_id, stripe_subscription_id,
			 stripe_price_id, status, current_period_end, trial_end, source_payload)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
		ON CONFLICT (tenant_id, job_id, source_platform, stripe_subscription_id, email)
		DO UPDATE SET
			stripe_customer_id = EXCLUDED.stripe_customer_id,
			stripe_price_id = EXCLUDED.stripe_price_id,
			status = EXCLUDED.status,
			current_period_end = EXCLUDED.current_period_end,
			trial_end = EXCLUDED.trial_end,
			source_payload = EXCLUDED.source_payload,
			updated_at = now(),
			rolled_back_at = NULL
		RETURNING id::text
	`, tenantID, jobID, string(ps.SourcePlatform), ps.Email, ps.StripeCustomerID,
		ps.StripeSubscriptionID, ps.StripePriceID, ps.Status, nullableTime(ps.CurrentPeriodEnd),
		ps.TrialEnd, string(payload)).Scan(&id); err != nil {
		return "", fmt.Errorf("persist paid subscription %q: %w", paidSubSourceID(ps), err)
	}
	if jobID != "" {
		if err := recordImportedResourceTx(ctx, tx, ImportedResource{
			TenantID:        tenantID,
			JobID:           jobID,
			ResourceType:    ResourcePaidSubscription,
			SourcePlatform:  ps.SourcePlatform,
			SourceID:        paidSubSourceID(ps),
			DestinationType: DestinationPostwavePaidSub,
			DestinationID:   id,
			DestinationMetadata: map[string]interface{}{
				"operation":              "created",
				"email":                  ps.Email,
				"stripe_subscription_id": ps.StripeSubscriptionID,
				"status":                 ps.Status,
			},
		}); err != nil {
			return "", err
		}
	}
	return id, nil
}
