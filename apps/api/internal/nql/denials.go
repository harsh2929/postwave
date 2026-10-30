// SPDX-License-Identifier: AGPL-3.0-only
package nql

import (
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// writeNLQCostCapDenial is the one product-facing representation for the
// tenant's daily NLQ window. It is a resettable quota, not an authentication or
// transport failure, so clients can offer the correct wait-and-retry guidance.
func writeNLQCostCapDenial(w http.ResponseWriter, message string) {
	now := time.Now().UTC()
	reset := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	retryAfter := int(reset.Sub(now).Seconds())
	if retryAfter < 1 {
		retryAfter = 1
	}
	entitlement.Write(w, entitlement.Denial{
		Subject:           "analytics_nlq",
		Reason:            entitlement.ReasonQuota,
		Code:              "cost_cap_exceeded",
		Message:           message,
		Resource:          "daily_nlq_tokens",
		RetryAfterSeconds: retryAfter,
	})
}
