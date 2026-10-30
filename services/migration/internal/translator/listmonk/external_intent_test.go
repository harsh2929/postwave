package listmonk

import (
	"encoding/json"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestSubscriberIntentBindsAuthoritativeMutationSemantics(t *testing.T) {
	sub := canonical.Subscriber{
		Email:          "authority-intent@example.test",
		SourceID:       "contact-42",
		SourcePlatform: canonical.SourceActiveCampaign,
	}
	base := SubscriberPayload{Email: sub.Email, Status: "enabled", Tags: []string{}}

	digest := func(mutation SubscriberPayload) string {
		t.Helper()
		intent, err := subscriberIntent("tenant", "job", sub, mutation)
		require.NoError(t, err)
		var payload subscriberIntentPayload
		require.NoError(t, json.Unmarshal(intent.Payload, &payload))
		return payload.MutationSHA256
	}

	baseDigest := digest(base)
	for name, mutate := range map[string]func(*SubscriberPayload){
		"status":   func(payload *SubscriberPayload) { payload.AuthoritativeStatus = true },
		"tags":     func(payload *SubscriberPayload) { payload.AuthoritativeTags = true },
		"fields":   func(payload *SubscriberPayload) { payload.AuthoritativeFields = true },
		"transfer": func(payload *SubscriberPayload) { payload.TransferSourceFrom = "contact-old" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := base
			mutate(&changed)
			require.NotEqual(t, baseDigest, digest(changed), "immutable intent must bind source-authoritative mutation semantics")
		})
	}
}
