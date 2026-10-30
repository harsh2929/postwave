// SPDX-License-Identifier: AGPL-3.0-only

package observability

import "testing"

func TestRedactSensitivePathPreservesPreferenceRouteShape(t *testing.T) {
	t.Parallel()
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	tests := []struct {
		path string
		want string
	}{
		{
			path: "/api/public/preferences/" + token,
			want: "/api/public/preferences/[redacted]",
		},
		{
			path: "/api/public/preferences/" + token + "/one-click",
			want: "/api/public/preferences/[redacted]/one-click",
		},
		{
			path: "/api/public/preferences/" + token + "/frequency",
			want: "/api/public/preferences/[redacted]/frequency",
		},
		{
			path: "/api/public/preferences/",
			want: "/api/public/preferences/",
		},
		{
			path: "/api/public/consent",
			want: "/api/public/consent",
		},
		{
			path: "/reset/0123456789abcdef0123456789abcdef",
			want: "/reset/[redacted]",
		},
		{
			path: "/subscribers/person@example.test/preferences",
			want: "/subscribers/[redacted]/preferences",
		},
		{
			path: "/preferences/short-future-capability",
			want: "/preferences/[redacted]",
		},
		{
			path: "/api/v1/sms/conversations/+14155551212/messages",
			want: "/api/v1/sms/conversations/[redacted]/messages",
		},
		{
			path: "/api/v1/sms/conversations/%2B14155551212/reply",
			want: "/api/v1/sms/conversations/[redacted]/reply",
		},
		{
			path: "/api/v1/sms/conversations/%2B14155551212/tags/customer%40example.test%E2%80%AE",
			want: "/api/v1/sms/conversations/[redacted]/tags/[redacted]",
		},
		{
			path: "/api/v1/sms/conversations/search",
			want: "/api/v1/sms/conversations/search",
		},
		{
			path: "/en/preferences/short-future-capability/frequency",
			want: "/en/preferences/[redacted]/frequency",
		},
		{
			path: "/api/public/support-integrations/zendesk/acme/webhooks",
			want: "/api/public/support-integrations/zendesk/[redacted]/webhooks",
		},
		{
			path: "/api/public/support-integrations/gorgias/a/ingest/short-token",
			want: "/api/public/support-integrations/gorgias/[redacted]/ingest/[redacted]",
		},
		{
			path: "/api/public/support-integrations/future-provider/short-account/future-action/short-id",
			want: "/api/public/support-integrations/[redacted]/[redacted]/[redacted]/[redacted]",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			if got := RedactSensitivePath(test.path); got != test.want {
				t.Fatalf("RedactSensitivePath(%q)=%q want=%q", test.path, got, test.want)
			}
		})
	}
}
