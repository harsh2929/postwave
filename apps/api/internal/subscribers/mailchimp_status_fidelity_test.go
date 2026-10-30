package subscribers

import "testing"

func TestSubscriberInputAcceptsExactMailchimpStatuses(t *testing.T) {
	for _, status := range []string{"pending", "transactional", "non_subscribed"} {
		t.Run(status, func(t *testing.T) {
			if !validMailchimpStatus(status) {
				t.Fatalf("validMailchimpStatus(%q) = false", status)
			}
			if got := normalizeMailchimpStatus(status, StatusEnabled); got != status {
				t.Fatalf("normalizeMailchimpStatus(%q, enabled) = %q, want exact source status", status, got)
			}
		})
	}
}
