package quota

import (
	"context"
	"errors"
	"strings"
	"time"

	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"
)

// CommercialQuota adapts the shared monthly commercial meter to the Voice
// handler contract. Costs are expressed in milli-credits so inexpensive
// embedding work does not have to round up to a whole credit.
type CommercialQuota struct {
	Meter *sharedusage.Meter
	Tier  TierResolver
}

func (q *CommercialQuota) CheckAndConsume(ctx context.Context, tenantID, kind string, costMilliCredits int) error {
	if q == nil || q.Meter == nil {
		return errors.New("ai credit meter is not configured")
	}
	if costMilliCredits <= 0 {
		return errors.New("ai credit cost must be positive")
	}
	_, err := q.Meter.Reserve(ctx, tenantID, sharedusage.ResourceAICreditMillis, int64(costMilliCredits), "", "voice:"+strings.TrimSpace(kind))
	if errors.Is(err, sharedusage.ErrExceeded) {
		return ErrOverQuota
	}
	return err
}

func (q *CommercialQuota) Limits(ctx context.Context, tenantID string) (Limits, error) {
	tier, err := q.LookupTier(ctx, tenantID)
	if err != nil {
		return Limits{}, err
	}
	milli := sharedusage.LimitForTier(tier, sharedusage.ResourceAICreditMillis)
	return Limits{DailyTotal: int(milli), MonthlyCreditMillis: int(milli)}, nil
}

func (q *CommercialQuota) LookupTier(ctx context.Context, tenantID string) (string, error) {
	if q == nil || q.Tier == nil {
		return "sandbox", nil
	}
	tier, err := q.Tier(ctx, tenantID)
	if err != nil {
		return "", err
	}
	return sharedusage.CanonicalTier(tier), nil
}

// CostMilliCredits is a server-owned liability schedule for the current
// Gemini 3 Flash configuration (4,096 output-token ceiling). One public credit
// represents $0.002 of provider liability. The standard 10-credit reservation
// covers the maximum output plus a bounded text prompt at the reviewed list
// rate; profile builds reserve more for their larger corpus input. Internal
// transport retries are part of the same logical operation and never charge a
// customer twice.
func CostMilliCredits(kind string, items int) int {
	if items <= 0 {
		items = 1
	}
	perItem := 10_000
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "profile_build", "profile_auto_rebuild":
		perItem = 15_000
	case "drift_embedding", "fidelity_embedding":
		perItem = 500
	}
	return perItem * items
}

// ResetsAtNextMonth returns the next UTC month boundary.
func ResetsAtNextMonth(now time.Time) string {
	now = now.UTC()
	next := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return next.Format(time.RFC3339)
}
