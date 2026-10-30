// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

func TestEveryCampaignQueueEntrypointCallsTheAuthoritativeCore(t *testing.T) {
	// The queue entrypoints live across the handlers_queue*.go files: the
	// HTTP/scheduled handlers in handlers_queue.go, the approval hook in
	// handlers_queue_approval.go, and the agent entrypoint in
	// handlers_queue_agent.go. Every one of them must still converge on
	// queueCampaignCore.
	var declarations []ast.Decl
	for _, path := range []string{"handlers_queue.go", "handlers_queue_approval.go", "handlers_queue_agent.go"} {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		declarations = append(declarations, file.Decls...)
	}
	want := map[string]bool{
		"QueueCampaign":          false,
		"QueueScheduledCampaign": false,
		"QueueApprovedCampaign":  false,
		"QueueCampaignForAgent":  false,
	}
	for _, declaration := range declarations {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		if _, tracked := want[function.Name.Name]; !tracked {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if ok && selector.Sel.Name == "queueCampaignCore" {
				want[function.Name.Name] = true
			}
			return true
		})
	}
	for name, converged := range want {
		if !converged {
			t.Errorf("%s no longer calls queueCampaignCore", name)
		}
	}

	sendSource, err := os.ReadFile("send.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(sendSource), `r.Post("/api/v1/campaigns/{id}/send", base.QueueCampaign)`) {
		t.Fatal("compatibility /send route no longer aliases the canonical human queue handler")
	}
}

func TestResendSurfacesCannotDirectEnqueueDuringAssuranceRollout(t *testing.T) {
	legacy, err := os.ReadFile("handlers_send_domain.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(legacy)
	guard := strings.Index(text, "d.campaignAssuranceRolloutMode() != campaignassurancegate.RolloutOff")
	directEnqueue := strings.Index(text, "d.Repo.EnqueueRecipients")
	if guard < 0 || directEnqueue < 0 || guard > directEnqueue {
		t.Fatalf("legacy resend convergence guard=%d direct_enqueue=%d", guard, directEnqueue)
	}

	cloneOnly, err := os.ReadFile("../resend_unopened/resend_unopened.go")
	if err != nil {
		t.Fatal(err)
	}
	cloneText := string(cloneOnly)
	for _, forbidden := range []string{
		"INSERT INTO campaign_recipients", "EnqueueRecipients(", "QueueAndStartCampaign(",
	} {
		if strings.Contains(cloneText, forbidden) {
			t.Fatalf("clone-only resend gained direct queue mutation %q", forbidden)
		}
	}
	for _, required := range []string{
		`'draft'`, `"assurance_required": true`, `"queue_path":`,
		"freeze_non_opener_audience_then_run_campaign_assurance_and_queue",
	} {
		if !strings.Contains(cloneText, required) {
			t.Errorf("clone-only resend contract missing %q", required)
		}
	}
}
