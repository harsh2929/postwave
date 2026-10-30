// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

func commerceEgressClient(client *http.Client, provider string, timeout time.Duration) *http.Client {
	return integration_egress.EnforceClient(client, integration_egress.FamilyCommerce, provider, timeout)
}
