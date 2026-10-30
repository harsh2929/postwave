// SPDX-License-Identifier: AGPL-3.0-only
//
// target_list_db_test.go — a CSV import that names a list, driven the way the
// wizard drives it: upload, PATCH the target list, exhaustive preflight,
// confirm, then the real worker, all as the RLS-bound application role.
// Membership and name columns are asserted in the database, not in the
// handlers' summaries.

package subscriber_import

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedTargetList gives the flow's tenant a live list identity (lists live in the
// engine; list_id_map is the gateway's identity for them) and returns both forms
// of its id, because the wizard's picker holds the engine id.
func (f *importFlow) seedTargetList() (listUUID string, engineID int64) {
	f.t.Helper()
	listUUID = uuid.NewString()
	// Engine ids are unique per tenant, and this tenant is brand new, so any
	// positive id will do; a random one keeps parallel runs apart regardless.
	engineID = int64(1 + rand.Int32N(1<<30))
	if _, err := f.admin.Exec(context.Background(), `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listUUID, engineID, f.tenantID); err != nil {
		f.t.Fatalf("seed list identity: %v", err)
	}
	return listUUID, engineID
}

// listMembership is one contact's membership of the target list, plus the
// ledger owner that claims it.
type listMembership struct {
	Source         string
	EngineID       *int64
	Email          string
	Removed        bool
	ActiveOwners   []string
	ActiveOwnerMDs []string
}

func (f *importFlow) membership(listUUID, email string) (listMembership, bool) {
	f.t.Helper()
	var got listMembership
	var removedAt *string
	err := f.admin.QueryRow(context.Background(), `
SELECT ls.source, ls.listmonk_list_id, COALESCE(ls.email::text, ''), ls.removed_at::text,
       COALESCE(ARRAY(
           SELECT lss.owner_key FROM list_subscriber_sources lss
            WHERE lss.tenant_id = ls.tenant_id AND lss.list_id = ls.list_id
              AND lss.subscriber_id = ls.subscriber_id AND lss.removed_at IS NULL
            ORDER BY lss.owner_key), '{}'::text[]),
       COALESCE(ARRAY(
           SELECT lss.metadata::text FROM list_subscriber_sources lss
            WHERE lss.tenant_id = ls.tenant_id AND lss.list_id = ls.list_id
              AND lss.subscriber_id = ls.subscriber_id AND lss.removed_at IS NULL
            ORDER BY lss.owner_key), '{}'::text[])
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid AND s.email = $3::citext`,
		f.tenantID, listUUID, email).
		Scan(&got.Source, &got.EngineID, &got.Email, &removedAt, &got.ActiveOwners, &got.ActiveOwnerMDs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return listMembership{}, false
		}
		f.t.Fatalf("read membership of %s: %v", email, err)
	}
	got.Removed = removedAt != nil
	return got, true
}

type subscriberNames struct {
	First   string
	Last    string
	Full    string
	Display string
}

func (f *importFlow) names(email string) subscriberNames {
	f.t.Helper()
	var out subscriberNames
	if err := f.admin.QueryRow(context.Background(), `
SELECT first_name, last_name, full_name, display_name
  FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext`,
		f.tenantID, email).Scan(&out.First, &out.Last, &out.Full, &out.Display); err != nil {
		f.t.Fatalf("read names of %s: %v", email, err)
	}
	return out
}

func (f *importFlow) seedExistingContact(email, fullName string) {
	f.t.Helper()
	if _, err := f.admin.Exec(context.Background(), `
INSERT INTO subscribers (tenant_id, email, status, consent_source, full_name, display_name)
VALUES ($1::uuid, $2::citext, 'enabled', 'api', $3, $3)`, f.tenantID, email, fullName); err != nil {
		f.t.Fatalf("seed existing contact: %v", err)
	}
}

// The whole point of the follow-up: an import can name the list its contacts
// join, so "import into a new list" is one pass instead of an import followed by
// a bulk add nobody remembers to do. A contact who already exists joins too —
// on_existing=skip is about not overwriting their fields, and joining a list
// overwrites nothing.
func TestImportAddsEveryImportedContactToItsTargetListDB(t *testing.T) {
	flow := newImportFlow(t)
	listUUID, engineID := flow.seedTargetList()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	fresh := "fresh-" + suffix + "@example.com"
	existing := "existing-" + suffix + "@example.com"
	flow.seedExistingContact(existing, "Already Here")

	preview := flow.upload("contacts.csv",
		"email,first_name,last_name\n"+
			fresh+",Ada,Lovelace\n"+
			existing+",Grace,Hopper\n")
	// The picker sends the engine id; the import stores the canonical uuid.
	if rec := flow.patch(preview.ID, fmt.Sprintf(
		`{"configuration_revision":%d,"target_list_id":"%d"}`,
		preview.ConfigurationRevision, engineID)); rec.Code != http.StatusOK {
		t.Fatalf("patch target list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var stored string
	if err := flow.admin.QueryRow(context.Background(),
		`SELECT COALESCE(target_list_id::text, '') FROM subscriber_imports WHERE id = $1::uuid`,
		preview.ID).Scan(&stored); err != nil {
		t.Fatalf("read stored target list: %v", err)
	}
	if stored != listUUID {
		t.Fatalf("stored target_list_id = %q, want the canonical uuid %q", stored, listUUID)
	}

	flow.preflight(preview.ID)
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)

	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 1 {
		t.Fatalf("import outcome=%+v, want ready with the one new contact imported", outcome)
	}

	for _, email := range []string{fresh, existing} {
		member, ok := flow.membership(listUUID, email)
		if !ok {
			t.Fatalf("%s was imported but never joined the list", email)
		}
		if member.Removed {
			t.Fatalf("%s joined the list as a removed member: %+v", email, member)
		}
		// 'csv' is the source migration 0249 reserved for an import, so list
		// growth attributes the audience to the import and not to a manual add.
		if member.Source != "csv" {
			t.Errorf("%s membership source = %q, want csv", email, member.Source)
		}
		// The engine id and address are denormalised on every membership, which
		// is how the subscriber's Lists panel names a list.
		if member.EngineID == nil || *member.EngineID != engineID {
			t.Errorf("%s membership engine id = %v, want %d", email, member.EngineID, engineID)
		}
		if !strings.EqualFold(member.Email, email) {
			t.Errorf("%s membership email = %q", email, member.Email)
		}
		// The ledger records WHO claimed the membership, so a later CRM sync
		// that drops the contact cannot silently undo the import.
		if len(member.ActiveOwners) != 1 || member.ActiveOwners[0] != "source:csv" {
			t.Errorf("%s ledger owners = %v, want [source:csv]", email, member.ActiveOwners)
		}
		if len(member.ActiveOwnerMDs) != 1 || !strings.Contains(member.ActiveOwnerMDs[0], "subscriber_import") {
			t.Errorf("%s ledger owner metadata = %v", email, member.ActiveOwnerMDs)
		}
	}

	// The names: first/last columns exist on subscribers (migration 0413) and
	// the import used to drop first_name/last_name into brand-new custom fields.
	got := flow.names(fresh)
	want := subscriberNames{First: "Ada", Last: "Lovelace", Full: "Ada Lovelace", Display: "Ada Lovelace"}
	if got != want {
		t.Errorf("imported names = %+v, want %+v", got, want)
	}
	var custom string
	if err := flow.admin.QueryRow(context.Background(),
		`SELECT COALESCE(custom_fields::text, '{}') FROM subscribers WHERE tenant_id = $1::uuid AND email = $2::citext`,
		flow.tenantID, fresh).Scan(&custom); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(custom, "first_name") || strings.Contains(custom, "last_name") {
		t.Errorf("name columns leaked into custom_fields: %s", custom)
	}
	// on_existing=skip: the contact who was already here keeps their own name.
	if existingNames := flow.names(existing); existingNames.Full != "Already Here" {
		t.Errorf("existing contact's name was overwritten: %+v", existingNames)
	}
}

// A file with no first/last column still fills full_name from the name column,
// and an import that names no list writes no membership at all — the default is
// unchanged.
func TestImportWithoutATargetListWritesNoMembershipDB(t *testing.T) {
	flow := newImportFlow(t)
	listUUID, _ := flow.seedTargetList()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	email := "nolist-" + suffix + "@example.com"

	preview := flow.upload("contacts.csv", "email,name\n"+email+",Ada Lovelace\n")
	flow.preflight(preview.ID)
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)
	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 1 {
		t.Fatalf("import outcome=%+v", outcome)
	}
	if _, ok := flow.membership(listUUID, email); ok {
		t.Fatal("an import that named no list added the contact to one anyway")
	}
	if got := flow.names(email); got.Full != "Ada Lovelace" || got.First != "" || got.Last != "" {
		t.Errorf("names = %+v, want only the full name", got)
	}
}

// A list id that is malformed, or that names no live list of this tenant, is
// refused where the operator can still fix it — never stored.
func TestImportTargetListIsResolvedForThisTenantDB(t *testing.T) {
	flow := newImportFlow(t)
	preview := flow.upload("contacts.csv", "email,name\nada@example.com,Ada\n")

	rec := flow.patch(preview.ID, fmt.Sprintf(
		`{"configuration_revision":%d,"target_list_id":"not-a-list"}`, preview.ConfigurationRevision))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_target_list_id") {
		t.Fatalf("malformed list id: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = flow.patch(preview.ID, fmt.Sprintf(
		`{"configuration_revision":%d,"target_list_id":"%s"}`,
		preview.ConfigurationRevision, uuid.NewString()))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "target_list_not_found") {
		t.Fatalf("unknown list id: status=%d body=%s", rec.Code, rec.Body.String())
	}

	var stored string
	if err := flow.admin.QueryRow(context.Background(),
		`SELECT COALESCE(target_list_id::text, '') FROM subscriber_imports WHERE id = $1::uuid`,
		preview.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Fatalf("a refused list id was stored anyway: %q", stored)
	}
}

// The list can be deleted between choosing it and confirming. Confirm is the
// commit point, so it is refused there — not discovered by the worker with half
// the file already written.
func TestImportConfirmRefusesADeletedTargetListDB(t *testing.T) {
	flow := newImportFlow(t)
	listUUID, engineID := flow.seedTargetList()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	email := "retired-" + suffix + "@example.com"

	preview := flow.upload("contacts.csv", "email,name\n"+email+",Ada\n")
	if rec := flow.patch(preview.ID, fmt.Sprintf(
		`{"configuration_revision":%d,"target_list_id":"%d"}`,
		preview.ConfigurationRevision, engineID)); rec.Code != http.StatusOK {
		t.Fatalf("patch target list status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.preflight(preview.ID)
	// Deleting a list retires its identity row (migration 2051).
	if _, err := flow.admin.Exec(context.Background(),
		`UPDATE list_id_map SET retired_at = now() WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid`,
		flow.tenantID, listUUID); err != nil {
		t.Fatalf("retire list identity: %v", err)
	}
	rec := flow.confirm(preview.ID)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "target_list_not_found") {
		t.Fatalf("confirm after the list was deleted: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if flow.subscriberCount(email) != 0 {
		t.Fatal("a refused confirm imported contacts anyway")
	}
}
