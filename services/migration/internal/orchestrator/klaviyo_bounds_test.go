package orchestrator

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestKlaviyoTemplateTraversalAllowsStructuredOnlyProviderPageButRequiresExactEditableTotal(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.Templates = true
	ad := &fixtureAdapter{
		caps: caps,
		templates: [][]canonical.EmailTemplate{
			{}, // provider page contained only structured templates archived elsewhere
			{{SourceID: "template_editable", SourcePlatform: canonical.SourceKlaviyo, Name: "Editable", HTML: "<p>ok</p>"}},
		},
	}
	discovery := adapter.DiscoveryReport{TemplatesTotal: 1, SourceArchiveTotal: 8}
	o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
	o.verifier.Discovery = discovery
	job := &canonical.MigrationJob{
		ID:     "klaviyo-template-bounds",
		Source: canonical.SourceKlaviyo,
		Cursor: map[string]*string{},
		Progress: canonical.MigrationProgress{
			TemplatesTotal: 1,
		},
	}
	require.NoError(t, o.runTemplates(context.Background(), ad, adapter.Session{Source: canonical.SourceKlaviyo}, job, nil))
	require.Equal(t, 1, job.Progress.TemplatesDone)
	require.Equal(t, 2, ad.calls["templates"])
}

func TestKlaviyoTemplateTraversalFailsClosedOnDiscoveryCountDrift(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.Templates = true
	ad := &fixtureAdapter{
		caps: caps,
		templates: [][]canonical.EmailTemplate{{
			{SourceID: "template_one", SourcePlatform: canonical.SourceKlaviyo, Name: "One", HTML: "<p>one</p>"},
		}},
	}
	o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
	o.verifier.Discovery = adapter.DiscoveryReport{TemplatesTotal: 2}
	job := &canonical.MigrationJob{
		ID:       "klaviyo-template-drift",
		Source:   canonical.SourceKlaviyo,
		Cursor:   map[string]*string{},
		Progress: canonical.MigrationProgress{TemplatesTotal: 2},
	}
	err := o.runTemplates(context.Background(), ad, adapter.Session{Source: canonical.SourceKlaviyo}, job, nil)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "1 of the exact 2")
}

func TestKlaviyoCampaignArchiveTraversalFailsClosedOnDiscoveryCountDrift(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.CampaignArchive = true
	ad := &fixtureAdapter{
		caps: caps,
		archive: [][]canonical.CampaignArchive{{
			{SourceID: "campaign_one", SourcePlatform: canonical.SourceKlaviyo},
		}},
	}
	o := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
	o.verifier.Discovery = adapter.DiscoveryReport{ArchiveTotal: 2, CampaignsTotal: 2}
	job := &canonical.MigrationJob{
		ID:       "klaviyo-archive-drift",
		Source:   canonical.SourceKlaviyo,
		Cursor:   map[string]*string{},
		Progress: canonical.MigrationProgress{ArchiveTotal: 2},
	}
	err := o.runArchive(context.Background(), ad, adapter.Session{Source: canonical.SourceKlaviyo}, job, nil)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "1 of the exact 2")
}
