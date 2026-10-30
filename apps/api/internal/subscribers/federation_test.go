package subscribers

// SUB-023 — federation repo-level unit tests that need no database.
//
// CreateFederationLink validates its input (required parent_tenant_id +
// master_subscriber_id, recognised match_type) BEFORE any DB call, so the
// pure-validation branches are reachable with a nil pool. The full agency-
// parent verification + insert round-trip needs postgres and follows the
// skip-on-DATABASE_URL-unset pattern used elsewhere in the package.

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestValidFederationMatchType(t *testing.T) {
	for _, ok := range []string{"email", "external_id", "manual"} {
		if !validFederationMatchType(ok) {
			t.Errorf("%q should be a valid match_type", ok)
		}
	}
	for _, bad := range []string{"", "phone", "EMAIL", "guess"} {
		if validFederationMatchType(bad) {
			t.Errorf("%q should be an invalid match_type", bad)
		}
	}
}

func TestCreateFederationLink_RejectsMissingParent(t *testing.T) {
	r := &Repo{Pool: nil}
	_, err := r.CreateFederationLink(context.Background(), "child-tenant", "sub-1",
		CreateFederationLinkInput{MasterSubscriberID: "master-1"}, "", db.AuditMeta{})
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput for missing parent_tenant_id", err)
	}
}

func TestCreateFederationLink_RejectsMissingMaster(t *testing.T) {
	r := &Repo{Pool: nil}
	_, err := r.CreateFederationLink(context.Background(), "child-tenant", "sub-1",
		CreateFederationLinkInput{ParentTenantID: "parent-1"}, "", db.AuditMeta{})
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput for missing master_subscriber_id", err)
	}
}

func TestCreateFederationLink_RejectsBadMatchType(t *testing.T) {
	r := &Repo{Pool: nil}
	_, err := r.CreateFederationLink(context.Background(), "child-tenant", "sub-1",
		CreateFederationLinkInput{
			ParentTenantID:     "parent-1",
			MasterSubscriberID: "master-1",
			MatchType:          "carrier-pigeon",
		}, "", db.AuditMeta{})
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput for unknown match_type", err)
	}
}

func TestCreateFederationLink_DefaultsMatchTypeBeforeDB(t *testing.T) {
	// An omitted match_type defaults to "manual" — which passes validation —
	// so the next step would be verifyAgencyParent (a DB call). With a nil pool
	// that surfaces as a non-validation error, confirming we got PAST the input
	// gate rather than being rejected by it.
	r := &Repo{Pool: nil}
	_, err := r.CreateFederationLink(context.Background(), "child-tenant", "sub-1",
		CreateFederationLinkInput{ParentTenantID: "parent-1", MasterSubscriberID: "master-1"}, "", db.AuditMeta{})
	if err == nil {
		t.Fatal("expected an error with a nil pool")
	}
	if errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v; default match_type should have passed input validation", err)
	}
}
