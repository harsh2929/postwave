package orchestrator

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func mailchimpAutomationFixture(templateSourceID, audienceSourceID string) canonical.Automation {
	return canonical.Automation{
		Name:   "Mailchimp welcome",
		Status: "paused",
		Triggers: []canonical.AutomationTrigger{{
			Type:   "subscriber_added_to_list",
			ListID: audienceSourceID,
		}},
		Nodes: []canonical.AutomationNode{{
			ID:   "send-0",
			Type: "send_email",
			Metadata: map[string]interface{}{
				"source_template_id": templateSourceID,
				"source_content_id":  "mailchimp:classic-automation:auto-1:email:e-1",
			},
		}},
	}
}

func TestRemapMailchimpAutomationReferencesCommit(t *testing.T) {
	o := &Orchestrator{
		templateDestinationIDs:             map[string]string{"42": "9001"},
		automationTemplateReferencesLoaded: true,
		audienceMappings: map[string]listmonkx.AudienceMapping{
			"aud-1": {SourceID: "aud-1", PostwaveID: "80a86c3d-6017-4eed-8874-43d5c01716b1"},
		},
	}
	job := &canonical.MigrationJob{ID: "job-1", Source: canonical.SourceMailchimp}

	got, err := o.remapAutomationTemplates(context.Background(), job, mailchimpAutomationFixture("42", "aud-1"))
	require.NoError(t, err)
	require.Equal(t, "9001", got.Nodes[0].TemplateID)
	require.Equal(t, "42", got.Nodes[0].Metadata[listmonkx.MigrationSourceTemplateIDMetadataKey])
	require.Equal(t, "80a86c3d-6017-4eed-8874-43d5c01716b1", got.Triggers[0].ListID)
	require.Equal(t, "aud-1", got.Triggers[0].Metadata["source_list_id"])
}

func TestRemapMailchimpAutomationReferencesDryRun(t *testing.T) {
	o := &Orchestrator{
		DryRun:                 true,
		verifier:               NewVerifierInput(),
		templateDestinationIDs: map[string]string{"42": ""},
		audienceMappings: map[string]listmonkx.AudienceMapping{
			"aud-1": {SourceID: "aud-1", PostwaveID: plannedReferenceID("list", "aud-1")},
		},
	}
	job := &canonical.MigrationJob{ID: "job-1", Source: canonical.SourceMailchimp}

	got, err := o.remapAutomationTemplates(context.Background(), job, mailchimpAutomationFixture("42", "aud-1"))
	require.NoError(t, err)
	require.Equal(t, plannedReferenceID("template", "42"), got.Nodes[0].TemplateID)
	require.Equal(t, plannedReferenceID("list", "aud-1"), got.Triggers[0].ListID)
}

func TestRemapMailchimpAutomationReferencesMissingNeverExecutable(t *testing.T) {
	o := &Orchestrator{
		DryRun:                 true,
		verifier:               NewVerifierInput(),
		templateDestinationIDs: map[string]string{},
		audienceMappings: map[string]listmonkx.AudienceMapping{
			"aud-1": {SourceID: "aud-1", PostwaveID: plannedReferenceID("list", "aud-1")},
		},
	}
	job := &canonical.MigrationJob{ID: "job-1", Source: canonical.SourceMailchimp}

	got, err := o.remapAutomationTemplates(context.Background(), job, mailchimpAutomationFixture("42", "aud-1"))
	require.ErrorContains(t, err, "no tenant-verified imported destination template")
	require.Empty(t, got.Nodes[0].TemplateID, "an unresolved source reference must remain non-executable")
	require.NotEmpty(t, automationUnsupportedReason(canonical.Automation{Nodes: []canonical.AutomationNode{{Type: "send_email"}}}))
}

func TestRemapAutomationNumericSourceIDNeverAdoptsCoincidentDestinationID(t *testing.T) {
	o := &Orchestrator{
		// Destination 42 is owned by a different source template. A Brevo source
		// template whose own numeric ID is also 42 must not collide into it.
		templateDestinationIDs:             map[string]string{"different-source-template": "42"},
		automationTemplateReferencesLoaded: true,
	}
	job := &canonical.MigrationJob{ID: "job-1", Source: canonical.SourceBrevo}
	automation := canonical.Automation{
		Name: "Brevo welcome",
		Nodes: []canonical.AutomationNode{{
			ID:         "send-1",
			Type:       "send_email",
			TemplateID: "42",
			Metadata:   map[string]interface{}{"source_template_id": "42"},
		}},
	}

	got, err := o.remapAutomationTemplates(context.Background(), job, automation)
	require.ErrorContains(t, err, "no tenant-verified imported destination template")
	require.Empty(t, got.Nodes[0].TemplateID, "numeric source/destination collisions must fail closed")
}

func TestRemapAutomationUsesExactTenantVerifiedDestinationMapping(t *testing.T) {
	o := &Orchestrator{
		templateDestinationIDs:             map[string]string{"42": "9001"},
		automationTemplateReferencesLoaded: true,
	}
	job := &canonical.MigrationJob{ID: "job-1", Source: canonical.SourceBrevo}
	automation := canonical.Automation{
		Name: "Brevo welcome",
		Nodes: []canonical.AutomationNode{{
			ID:       "send-1",
			Type:     "send_email",
			Metadata: map[string]interface{}{"source_template_id": "42"},
		}},
	}

	got, err := o.remapAutomationTemplates(context.Background(), job, automation)
	require.NoError(t, err)
	require.Equal(t, "9001", got.Nodes[0].TemplateID)
	require.Equal(t, "42", got.Nodes[0].Metadata[listmonkx.MigrationSourceTemplateIDMetadataKey])
}

func TestVerifiedTemplateReferenceMapRejectsCrossTenantOrUnattestedRows(t *testing.T) {
	base := listmonkx.ImportedResource{
		TenantID:        "tenant-a",
		JobID:           "job-a",
		ResourceType:    listmonkx.ResourceTemplate,
		SourcePlatform:  canonical.SourceBrevo,
		SourceID:        "42",
		DestinationType: listmonkx.DestinationListmonkTemplate,
		DestinationID:   "9001",
		DestinationMetadata: map[string]interface{}{
			"ownership_fingerprint": "attested",
		},
	}

	got, err := verifiedTemplateReferenceMap([]listmonkx.ImportedResource{base}, "tenant-a", "job-a", canonical.SourceBrevo)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"42": "9001"}, got)

	crossTenant := base
	crossTenant.TenantID = "tenant-b"
	_, err = verifiedTemplateReferenceMap([]listmonkx.ImportedResource{crossTenant}, "tenant-a", "job-a", canonical.SourceBrevo)
	require.ErrorContains(t, err, "exact tenant/job/source destination ownership")

	unattested := base
	unattested.DestinationMetadata = map[string]interface{}{}
	_, err = verifiedTemplateReferenceMap([]listmonkx.ImportedResource{unattested}, "tenant-a", "job-a", canonical.SourceBrevo)
	require.ErrorContains(t, err, "exact tenant/job/source destination ownership")
}

func TestMailchimpAutomationDryRunResumeUsesPersistedTemplatePlan(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Templates = true
	caps.Supports.Automations = true
	ad := &fixtureAdapter{
		caps: caps,
		discovery: adapter.DiscoveryReport{
			TemplatesTotal:   1,
			AutomationsTotal: 1,
			Audiences:        []adapter.DiscoveryAudience{{ID: "aud-1", Name: "Audience one"}},
		},
		automations: []canonical.Automation{mailchimpAutomationFixture("42", "aud-1")},
	}
	job := &canonical.MigrationJob{
		ID:     "job-resume",
		Source: canonical.SourceMailchimp,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
	}
	markStageCompleted(job, stageTemplates)
	require.NoError(t, persistTemplateReferenceMap(job, map[string]string{"42": ""}))

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.NoError(t, err)
	require.Zero(t, ad.calls["templates"], "completed template stage must not be replayed")
	require.Equal(t, 1, job.Progress.AutomationsDone)
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 1, job.VerificationReport.AutomationsTranslated)
}
