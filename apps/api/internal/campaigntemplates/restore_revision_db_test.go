// SPDX-License-Identifier: AGPL-3.0-only
//
// TMPL-040 — DB-backed proof that editing captures revisions (with the actor),
// that RestoreRevision brings back an earlier snapshot, and that the restore is
// itself recorded so nothing is lost. Guarded by DATABASE_URL.
package campaigntemplates

import (
	"testing"
)

func TestRestoreRevisionAndActorCaptureDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	repo := &Repo{Pool: pool}
	prefix := "restore-" + randHex4(t) + "-"

	tpl, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "t", Name: "V1 name", Subject: "V1 subject", BodyHTML: "<p>v1</p>",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if tpl.Version != 1 {
		t.Fatalf("initial version = %d, want 1", tpl.Version)
	}

	// Edit to v2 with a recorded actor.
	name2, subj2, body2 := "V2 name", "V2 subject", "<p>v2</p>"
	tpl2, err := repo.Update(ctx, tenantID, tpl.ID, UpdateInput{
		Name: &name2, Subject: &subj2, BodyHTML: &body2,
		IfMatch: templateETag(tpl), ActorUserID: userID,
	})
	if err != nil {
		t.Fatalf("update to v2: %v", err)
	}
	if tpl2.Version != 2 || tpl2.Name != "V2 name" {
		t.Fatalf("v2 = version %d name %q", tpl2.Version, tpl2.Name)
	}

	// The revision trail records who made the v2 edit.
	page, err := repo.ListRevisions(ctx, tenantID, tpl.ID, 1, 50)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	var v1Actor, v2Actor string
	for _, rev := range page.Items {
		switch rev.Version {
		case 1:
			v1Actor = rev.ChangedByEmail
		case 2:
			v2Actor = rev.ChangedByEmail
		}
	}
	if v2Actor == "" {
		t.Fatalf("v2 revision did not record an actor (changed_by_email empty)")
	}
	if v1Actor != "" {
		t.Fatalf("v1 (create) revision unexpectedly recorded actor %q", v1Actor)
	}

	// Restore v1's content → a NEW version whose content matches v1.
	tpl3, err := repo.RestoreRevision(ctx, tenantID, tpl.ID, 1, userID)
	if err != nil {
		t.Fatalf("restore v1: %v", err)
	}
	if tpl3.Version != 3 {
		t.Fatalf("post-restore version = %d, want 3", tpl3.Version)
	}
	if tpl3.Name != "V1 name" || tpl3.Subject != "V1 subject" {
		t.Fatalf("restored content = name %q subject %q, want V1", tpl3.Name, tpl3.Subject)
	}

	// The pre-restore (v2) state is preserved in history — restore never loses.
	page2, err := repo.ListRevisions(ctx, tenantID, tpl.ID, 1, 50)
	if err != nil {
		t.Fatalf("list revisions after restore: %v", err)
	}
	if page2.Total < 3 {
		t.Fatalf("revision total = %d, want >= 3 (v1 create, v2 edit, v3 restore)", page2.Total)
	}
}
