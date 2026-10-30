// channel_consent.go — GAP-LS-074: "can_receive_on email/sms/push"
// predicates. Reads the consent vector columns on subscribers
// (added in 0318_subscribers_consent_vector.sql).
//
// Klaviyo + Iterable expose the same surface as a first-class
// predicate; without it operators reach for the raw column via
// the JSONB extract path, which silently does the wrong thing
// (the vector lives on the row, not in custom_fields).

package predicates

import (
	"fmt"
	"strings"
)

// ChannelConsentInput is the call shape: which channel + which
// state the predicate is asking about.
type ChannelConsentInput struct {
	// Channel: email | sms | push. push currently has no vector
	// column so the helper returns FALSE for push until the writer
	// exists — explicit rather than silent.
	Channel string
	// CanReceive: true → vector column IS NOT NULL; false → IS NULL.
	CanReceive bool
}

// CompileChannelConsent returns the WHERE-fragment.
func CompileChannelConsent(in ChannelConsentInput) (Fragment, error) {
	channel := strings.ToLower(strings.TrimSpace(in.Channel))
	col, err := channelToConsentColumn(channel)
	if err != nil {
		return Fragment{}, err
	}
	if col == "" {
		// Channel known but no vector column yet (push). Return a
		// deterministic FALSE so segment counts do not silently
		// include the entire base.
		if in.CanReceive {
			return Fragment{SQL: "FALSE"}, nil
		}
		return Fragment{SQL: "TRUE"}, nil
	}
	if channel == "email" {
		// The subscriber-level vector is necessary but not sufficient. Campaign
		// delivery uses subscribers.email, so that exact canonical address must
		// independently be subscribed and unsuppressed on the same profile.
		// lower(email::text) deliberately matches the unique expression index on
		// subscriber_emails and keeps canonical matching case-insensitive.
		eligible := `(subscribers.consent_email_marketing_at IS NOT NULL AND EXISTS (
    SELECT 1
      FROM subscriber_emails AS channel_email
     WHERE channel_email.tenant_id = subscribers.tenant_id
       AND channel_email.subscriber_id = subscribers.id
       AND lower(channel_email.email::text) = lower(subscribers.email::text)
       AND channel_email.consent_status = 'subscribed'
       AND channel_email.suppressed = false
))`
		if in.CanReceive {
			return Fragment{SQL: eligible}, nil
		}
		return Fragment{SQL: "NOT " + eligible}, nil
	}
	op := "IS NOT NULL"
	if !in.CanReceive {
		op = "IS NULL"
	}
	return Fragment{SQL: fmt.Sprintf("subscribers.%s %s", col, op)}, nil
}

func channelToConsentColumn(channel string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(channel)) {
	case "email":
		return "consent_email_marketing_at", nil
	case "sms":
		return "consent_sms_marketing_at", nil
	case "push":
		// No dedicated column yet — return ""/sentinel.
		return "", nil
	}
	return "", fmt.Errorf("predicates: unsupported channel %q", channel)
}
