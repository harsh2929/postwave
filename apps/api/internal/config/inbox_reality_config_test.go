// SPDX-License-Identifier: AGPL-3.0-only

package config

import "testing"

func TestInboxRealityLifecycleConfigIsExplicitAndCarriesRotationSet(t *testing.T) {
	t.Setenv("POSTWAVE_ENABLE_INBOX_REALITY_LIFECYCLE", "true")
	t.Setenv("POSTWAVE_INBOX_REALITY_SIGNING_SECRETS", "current,previous")
	config := Load()
	if !config.InboxRealityLifecycleEnabled || config.InboxRealitySigningSecrets != "current,previous" {
		t.Fatal("Inbox Reality enablement or signing rotation set was not loaded")
	}
}
