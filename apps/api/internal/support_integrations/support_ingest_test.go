// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import "testing"

func TestMapSupportWebhookExtractsTicket(t *testing.T) {
	body := []byte(`{"event":"conversation.created","conversation":{"id":"c1","subject":"Help"},"customer":{"email":"Ada@Example.com"},"status":"open"}`)
	req, ok := mapSupportWebhook("freshchat", body)
	if !ok {
		t.Fatal("expected mapped")
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Help" || tk.Status != "open" || tk.ConversationID != "c1" {
		t.Fatalf("ticket = %+v", tk)
	}
	if tk.SourceID != "freshchat://ticket/c1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.RunMode != "webhook" {
		t.Fatalf("run mode = %q", req.RunMode)
	}
}

func TestMapSupportWebhookTopLevelEmailFallsBackToEmailSourceID(t *testing.T) {
	req, ok := mapSupportWebhook("tidio", []byte(`{"email":"Bo@x.com","subject":"Question"}`))
	if !ok {
		t.Fatal("expected mapped")
	}
	tk := req.Tickets[0]
	if tk.Email != "bo@x.com" || tk.Subject != "Question" {
		t.Fatalf("ticket = %+v", tk)
	}
	if tk.SourceID != "tidio://ticket/bo@x.com" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
}

func TestMapSupportWebhookNoEmailSkipped(t *testing.T) {
	if _, ok := mapSupportWebhook("freshchat", []byte(`{"event":"conversation.created","conversation":{"id":"c1"}}`)); ok {
		t.Fatal("payload without email must not map")
	}
}
