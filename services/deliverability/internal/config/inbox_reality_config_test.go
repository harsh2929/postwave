// SPDX-License-Identifier: AGPL-3.0-only

package config

import "testing"

func TestInboxRealityLifecycleConfigIsExplicitAndComplete(t *testing.T) {
	t.Setenv("POSTWAVE_ENABLE_INBOX_REALITY_LIFECYCLE", "true")
	t.Setenv("POSTWAVE_INBOX_REALITY_SIGNING_SECRETS", "current,previous")
	t.Setenv("POSTWAVE_API_BASE_URL", "https://api.internal.example")
	t.Setenv("INBOX_REALITY_SES_REGION", "us-east-1")
	t.Setenv("INBOX_REALITY_SES_CONFIGURATION_SET", "controlled-seeds")
	t.Setenv("POSTWAVE_ENABLE_DURABLE_SEED_REGISTRY", "true")
	config := Load()
	if !config.InboxRealityLifecycleEnabled || config.InboxRealitySigningSecrets != "current,previous" ||
		config.InboxRealityGatewayURL != "https://api.internal.example" ||
		config.InboxRealitySESRegion != "us-east-1" ||
		config.InboxRealitySESConfigurationSet != "controlled-seeds" ||
		!config.DurableControlledSeedRegistryEnabled {
		t.Fatal("Inbox Reality deliverability configuration was not loaded")
	}
}
