package mailchimpv3

import "testing"

func TestMailchimpMemberStatusFidelity(t *testing.T) {
	tests := []struct {
		mailchimp string
		postwave  string
	}{
		{mailchimp: "pending", postwave: "unconfirmed"},
		{mailchimp: "transactional", postwave: "disabled"},
		{mailchimp: "non_subscribed", postwave: "unconfirmed"},
	}
	for _, tt := range tests {
		t.Run(tt.mailchimp, func(t *testing.T) {
			if got := normalizeMailchimpStatus(tt.mailchimp); got != tt.mailchimp {
				t.Fatalf("normalizeMailchimpStatus(%q) = %q, want exact source status", tt.mailchimp, got)
			}
			if !validMailchimpStatus(tt.mailchimp) {
				t.Fatalf("validMailchimpStatus(%q) = false", tt.mailchimp)
			}
			if got := postwaveStatus(tt.mailchimp); got != tt.postwave {
				t.Fatalf("postwaveStatus(%q) = %q, want %q", tt.mailchimp, got, tt.postwave)
			}
		})
	}
}
