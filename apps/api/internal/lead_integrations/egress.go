// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

func leadEgressClient(client *http.Client, provider string, timeout time.Duration) *http.Client {
	return integration_egress.EnforceClient(client, integration_egress.FamilyLeads, provider, timeout)
}
