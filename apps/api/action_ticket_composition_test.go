// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/approvals"
)

func TestApprovalTicketDecisionMatchesExactActorAndOutcome(t *testing.T) {
	user := "11111111-1111-4111-8111-111111111111"
	other := "22222222-2222-4222-8222-222222222222"
	for _, test := range []struct {
		name    string
		current *approvals.Approval
		want    approvals.Status
		user    string
		match   bool
	}{
		{"exact", &approvals.Approval{Status: approvals.StatusApproved, DecidedByUserID: &user}, approvals.StatusApproved, user, true},
		{"wrong outcome", &approvals.Approval{Status: approvals.StatusRejected, DecidedByUserID: &user}, approvals.StatusApproved, user, false},
		{"wrong actor", &approvals.Approval{Status: approvals.StatusApproved, DecidedByUserID: &other}, approvals.StatusApproved, user, false},
		{"no actor", &approvals.Approval{Status: approvals.StatusApproved}, approvals.StatusApproved, user, false},
		{"missing", nil, approvals.StatusApproved, user, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := approvalTicketDecisionMatches(test.current, test.want, test.user); got != test.match {
				t.Fatalf("match=%v want=%v", got, test.match)
			}
		})
	}
}

func TestActionTicketRoutesStayOnTheDedicatedPublicBoundary(t *testing.T) {
	root := readAPICompositionRoot(t)
	source := root.main
	const mount = "apiserver.MountActionTicketRoutes(r, pool, logger,"
	if inRun, inRoot := strings.Count(root.run, mount), strings.Count(root.all, mount); inRun != 1 || inRoot != 1 {
		t.Fatalf("action-ticket mount count = %d in run() and %d in the composition root, want exactly one, "+
			"in run()", inRun, inRoot)
	}
	authStart := strings.Index(source, "mountAuthenticatedRoutesBehindAgentHold(r, func(r chi.Router) {")
	publicStart := strings.Index(source, "// Public form definitions are read-only")
	mountAt := strings.Index(source, mount)
	if authStart < 0 || publicStart < 0 || mountAt < 0 || authStart >= publicStart {
		t.Fatal("could not resolve authenticated/public composition boundaries")
	}
	if mountAt > authStart && mountAt < publicStart {
		t.Fatal("bearer action-ticket routes moved behind session/API-key tenant middleware")
	}
	marker := strings.Index(source, "// Single-use action links are bearer-authenticated, not session/API-key")
	if marker < publicStart || marker > mountAt {
		t.Fatal("action-ticket mount lost its explicit top-level public-token boundary")
	}
	block := source[marker:mountAt]
	protectAt := strings.Index(block, "r.Use(actionticket.ProtectResponses)")
	limitAt := strings.Index(block, "r.Use(actionTicketRateLimit.Middleware)")
	if protectAt < 0 || limitAt < 0 || protectAt > limitAt {
		t.Fatal("ticket response protection must wrap the dedicated distributed limiter")
	}
	for _, required := range []string{
		"actionTicketRateLimitOptions.Namespace = \"ip:action-ticket\"",
		"actionTicketLinker.Validate()",
		"POSTWAVE_PUBLIC_BASE_URL is required in production",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("action-ticket production composition is missing %q", required)
		}
	}
}

func TestApprovalTicketDecisionRegistryMatchesActionTicketGate(t *testing.T) {
	for _, action := range []string{"approval.approve", "approval.reject"} {
		if _, _, err := approvalTicketDecision(action); err != nil {
			t.Fatalf("%s is registered but has no executor: %v", action, err)
		}
	}
	if _, _, err := approvalTicketDecision("offer.decline"); err == nil {
		t.Fatal("offer.decline gained an executor without a tenant/subscriber-bound implementation")
	}
}
