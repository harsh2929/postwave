package runtime

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// fakeEmailEmitter records what the engine hands to apps/api.
type fakeEmailEmitter struct {
	mu   sync.Mutex
	sent []EmailSendRequest
}

func (f *fakeEmailEmitter) Emit(_ context.Context, _ string, req EmailSendRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, req)
	return nil
}

// A flow's send_email called Listmonk's /api/tx DIRECTLY, skipping suppression,
// consent, frequency caps, quiet hours, send windows and the tenant kill switch
// — all of which are enforced only on the campaign path. When an emitter is
// wired, the send must go through apps/api instead, exactly as send_sms does.
func TestSendEmail_RoutesThroughTheComplianceStackWhenWired(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	em := &fakeEmailEmitter{}
	e.Email = em

	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "7"}},
	})
	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)

	if len(em.sent) != 1 {
		t.Fatalf("send_email must enqueue for apps/api to deliver; enqueued %d", len(em.sent))
	}
	if len(lm.sends) != 0 {
		t.Fatal("send_email must NOT bypass the compliance stack by calling Listmonk directly")
	}
	if em.sent[0].SubscriberEmail != "u@x.com" || em.sent[0].TemplateID != "7" {
		t.Fatalf("unexpected request: %+v", em.sent[0])
	}
}

// campaign_templates.id is a uuid. The engine did strconv.Atoi(node.TemplateID),
// so EVERY Moosewave template id failed to parse and the node failed permanently
// — the catalog declares template_id as a plain "string" with no format hint.
func TestSendEmail_AcceptsAPostwaveUUIDTemplateID(t *testing.T) {
	e, _, q, _, r := buildEngine(t)
	em := &fakeEmailEmitter{}
	e.Email = em

	const tpl = "9f1c2e3a-4b5d-6e7f-8a9b-0c1d2e3f4a5b"
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: tpl}},
	})
	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	// drain t.Fatal()s on an Execute error, so surviving this proves the uuid
	// no longer blows the node up.
	drain(t, e, q)

	if len(em.sent) != 1 || em.sent[0].TemplateID != tpl {
		t.Fatalf("a uuid template id must be passed through opaquely; got %+v", em.sent)
	}
}

// A send_email node with no template at all must fail loudly, not silently send
// nothing.
func TestSendEmail_MissingTemplateIsAnError(t *testing.T) {
	e, _, q, _, r := buildEngine(t)
	e.Email = &fakeEmailEmitter{}
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email"}},
	})
	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	exec, ok := q.PopReady()
	if !ok {
		t.Fatal("expected a queued execution")
	}
	if err := e.Execute(context.Background(), exec); err == nil {
		t.Fatal("a send_email node with no template_id must error, not silently pass")
	}
}
