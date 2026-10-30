// SPDX-License-Identifier: AGPL-3.0-only
//
// support_realpayload_test.go — certifies mapSupportWebhook against REAL provider
// webhook bodies from official docs: Tidio (developers.tidio.com) nests every
// event under a top-level "content" envelope, and Freshchat
// (developers.freshchat.com) carries NO email (must be enriched), so its
// webhooks are correctly ignored by the tolerant ticket mapper.
package support_integrations

import "testing"

// Tidio contact.created: email at content.email, id at content.id, topic at root.
func TestMapSupportWebhookTidioContact(t *testing.T) {
	body := []byte(`{
      "created_at":1687177445,"project_public_key":"m8ixolegtgfvo6ckzvmuempdq0obbqsy",
      "topic":"contact.created","version":1,"webhook_id":"7307ac4d-0000",
      "content":{"id":"147ae37d-0000","email":"Email@Example.com","phone":"123 456 789",
                 "first_name":"John","last_name":"Doe","distinct_id":"123456"}
    }`)
	req, ok := mapSupportWebhook(ProviderTidio, body)
	if !ok || len(req.Tickets) != 1 {
		t.Fatalf("tidio contact not mapped: ok=%v req=%+v", ok, req)
	}
	tk := req.Tickets[0]
	if tk.Email != "email@example.com" {
		t.Fatalf("tidio email path (content.email) not extracted: %q", tk.Email)
	}
	if tk.ConversationID != "147ae37d-0000" {
		t.Fatalf("tidio id path (content.id) not extracted: %q", tk.ConversationID)
	}
}

// Tidio ticket: email at content.contact_email, status/subject under content.
func TestMapSupportWebhookTidioTicket(t *testing.T) {
	body := []byte(`{"topic":"ticket.created","content":{"id":"tkt_1","status":"open","subject":"Where is my order?","priority":"high","contact_email":"buyer@example.com"}}`)
	req, ok := mapSupportWebhook(ProviderTidio, body)
	if !ok || len(req.Tickets) != 1 {
		t.Fatalf("tidio ticket not mapped: ok=%v req=%+v", ok, req)
	}
	tk := req.Tickets[0]
	if tk.Email != "buyer@example.com" {
		t.Fatalf("tidio email path (content.contact_email) not extracted: %q", tk.Email)
	}
	if tk.Status != "open" || tk.Subject != "Where is my order?" {
		t.Fatalf("tidio status/subject under content not extracted: %+v", tk)
	}
}

// Freshchat message_create: NO email anywhere in the webhook (only a user_id
// UUID). Landing a ticket needs a GET /v2/users/{id} enrichment hop, so the
// tolerant mapper must IGNORE it rather than land an emailless ticket.
func TestMapSupportWebhookFreshchatNoEmailIgnored(t *testing.T) {
	body := []byte(`{
      "actor":{"actor_type":"agent","actor_id":"1b8d2418-0000"},
      "action":"message_create","action_time":"2022-11-22T10:55:23.126Z",
      "data":{"message":{"message_parts":[{"text":{"content":"Hi there!"}}],
              "conversation_id":"35e80ec8-0000","user_id":"9047e655-0000"}}
    }`)
	if _, ok := mapSupportWebhook(ProviderFreshchat, body); ok {
		t.Fatal("freshchat webhook has no email and must be ignored (needs /v2/users enrichment)")
	}
}
