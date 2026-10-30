package usagegate

import (
	"context"
	"errors"
	"net/http"
	"time"

	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type reservationMeter interface {
	Reserve(context.Context, string, sharedusage.Resource, int64, string, string) (sharedusage.Receipt, error)
}

// APIOperationMiddleware consumes one monthly API operation after API-key
// authentication, tenant resolution, and route authorization. Browser session
// traffic is not part of the API-operation product allowance.
func APIOperationMiddleware(meter reservationMeter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !middleware.IsAPIKeyAuth(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok || tenant == nil || tenant.ID == "" {
				httperror.Write(w, http.StatusUnauthorized, "tenant_required", "workspace context is required")
				return
			}
			if meter == nil {
				httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "API allowance could not be verified")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			receipt, err := meter.Reserve(ctx, tenant.ID, sharedusage.ResourceAPIOperations, 1, "", "authenticated_api")
			cancel()
			if err != nil {
				var limitErr *sharedusage.Error
				if errors.As(err, &limitErr) {
					limit, current := limitErr.Limit, limitErr.Used
					entitlement.Write(w, entitlement.Denial{
						Subject:  "workspace",
						Reason:   entitlement.ReasonQuota,
						Code:     "api_operations_limit_exceeded",
						Message:  "Monthly API operation allowance reached.",
						Resource: string(sharedusage.ResourceAPIOperations),
						Limit:    &limit,
						Current:  &current,
					})
					return
				}
				httperror.Write(w, http.StatusServiceUnavailable, "usage_meter_unavailable", "API allowance could not be verified")
				return
			}
			w.Header().Set("X-Moosewave-API-Operations-Used", formatInt(receipt.Used))
			w.Header().Set("X-Moosewave-API-Operations-Limit", formatInt(receipt.Limit))
			next.ServeHTTP(w, r)
		})
	}
}

func formatInt(value int64) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for value > 0 {
		pos--
		buf[pos] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[pos:])
}
