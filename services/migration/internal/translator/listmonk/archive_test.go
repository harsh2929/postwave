package listmonk

import (
	"testing"
	"time"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestCampaignArchiveContentFingerprintBindsFullCanonicalEvidence(t *testing.T) {
	base := canonical.CampaignArchive{
		SourceID: "campaign-1", Subject: "Subject", HTML: "<p>Hello</p>", Text: "Hello",
		SentAt: time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC), SourcePlatform: canonical.SourceKlaviyo,
		Report:   map[string]interface{}{"channel": "email", "messages": []interface{}{map[string]interface{}{"id": "message-1"}}},
		Warnings: []string{"reports unavailable"},
	}
	first, err := campaignArchiveContentFingerprint(base)
	require.NoError(t, err)
	retry, err := campaignArchiveContentFingerprint(base)
	require.NoError(t, err)
	require.Equal(t, first, retry)

	for name, mutate := range map[string]func(*canonical.CampaignArchive){
		"html": func(c *canonical.CampaignArchive) { c.HTML = "<p>Changed</p>" },
		"report": func(c *canonical.CampaignArchive) {
			c.Report = map[string]interface{}{"channel": "email", "messages": []interface{}{map[string]interface{}{"id": "message-2"}}}
		},
		"warning": func(c *canonical.CampaignArchive) { c.Warnings = []string{"different limitation"} },
	} {
		t.Run(name, func(t *testing.T) {
			changed := base
			mutate(&changed)
			fingerprint, err := campaignArchiveContentFingerprint(changed)
			require.NoError(t, err)
			require.NotEqual(t, first, fingerprint)
		})
	}
}
