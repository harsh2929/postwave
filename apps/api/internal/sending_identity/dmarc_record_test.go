package sending_identity

import (
	"context"
	"strings"
	"testing"
)

type staticTXTResolver struct {
	records []string
}

func (resolver staticTXTResolver) LookupTXT(context.Context, string) ([]string, error) {
	return resolver.records, nil
}

func TestDMARCRecordDoesNotAdvertiseUnqualifiedReportingEndpoints(t *testing.T) {
	record := dmarcRecordValue(
		"123e4567-e89b-42d3-a456-426614174000",
		"example.com",
	)
	if record != "v=DMARC1; p=none; aspf=r; adkim=r" {
		t.Fatalf("record = %q", record)
	}
	for _, forbidden := range []string{"rua=", "ruf=", "pct=", "p=quarantine", "p=reject"} {
		if strings.Contains(strings.ToLower(record), forbidden) {
			t.Fatalf("unqualified DMARC record contains %q: %q", forbidden, record)
		}
	}
}

func TestDMARCVerificationRejectsFormerUnqualifiedPostwaveDestinations(t *testing.T) {
	tests := []struct {
		name    string
		records []string
		wantOK  bool
	}{
		{
			name:    "canonical monitor policy",
			records: []string{"v=DMARC1; p=none; aspf=r; adkim=r"},
			wantOK:  true,
		},
		{
			name:    "tenant managed external reports",
			records: []string{"v=DMARC1; p=reject; rua=mailto:dmarc@reports.example.com"},
			wantOK:  true,
		},
		{
			name:    "legacy aggregate endpoint",
			records: []string{"v=DMARC1; p=none; rua=mailto:dmarc-reports@tenant.postwave.io"},
		},
		{
			name:    "legacy failure endpoint",
			records: []string{"v=DMARC1; p=none; ruf=mailto:dmarc-failures@reports.postwave.io"},
		},
		{
			name:    "multiple policy records",
			records: []string{"v=DMARC1; p=none", "v=DMARC1; p=reject"},
		},
		{
			name:    "version prefix is not a policy record",
			records: []string{"v=DMARC10; p=none"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := &Deps{Resolver: staticTXTResolver{records: test.records}}
			got, message := deps.checkDMARC(context.Background(), "example.com")
			if got != test.wantOK {
				t.Fatalf("checkDMARC() = (%v, %q), want ok=%v", got, message, test.wantOK)
			}
			if !test.wantOK && message == "" {
				t.Fatal("failed DMARC verification returned no operator-safe reason")
			}
		})
	}
}

func TestIdentityUpsertRefreshesInstructionsAndInvalidatesRotatedProof(t *testing.T) {
	normalized := strings.ToLower(upsertSendingIdentitySQL)
	for _, required := range []string{
		"spf_record_value = excluded.spf_record_value",
		"dmarc_record_value = excluded.dmarc_record_value",
		"dkim_verified_at = null",
		"spf_verified_at = null",
		"dmarc_verified_at = null",
		"verify_state = 'pending'",
		"verified_at = null",
	} {
		if !strings.Contains(normalized, required) {
			t.Errorf("identity upsert does not enforce %q", required)
		}
	}
}
