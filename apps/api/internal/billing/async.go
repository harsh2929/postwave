// SPDX-License-Identifier: AGPL-3.0-only

package billing

import (
	"fmt"
	"runtime/debug"
)

// Billing webhooks acknowledge only after durable state and audit writes, but
// notification/provider bridges stay off the response path. Bound those
// detached calls so a webhook burst cannot create unbounded goroutines.
const maxConcurrentBillingFanouts = 32

var billingFanoutSlots = make(chan struct{}, maxConcurrentBillingFanouts)

func (h *WebhookHandler) startAsync(name string, run func()) bool {
	select {
	case billingFanoutSlots <- struct{}{}:
	default:
		return false
	}
	go func() {
		defer func() { <-billingFanoutSlots }()
		defer func() {
			if recovered := recover(); recovered != nil && h != nil && h.Logger != nil {
				h.Logger.Error("billing async fanout panic",
					"worker", name,
					"panic", fmt.Sprint(recovered),
					"stack", string(debug.Stack()))
			}
		}()
		run()
	}()
	return true
}
