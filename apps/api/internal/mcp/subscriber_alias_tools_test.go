// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type recordingMCPAliasWriter struct {
	tenantID, subscriberID, version string
	in                              subscribers.AliasInput
	meta                            db.AuditMeta
	out                             *subscribers.Alias
	err                             error
}

func (r *recordingMCPAliasWriter) UpsertAlias(
	_ context.Context,
	tenantID, subscriberID string,
	in subscribers.AliasInput,
	version string,
	meta db.AuditMeta,
) (*subscribers.Alias, error) {
	r.tenantID, r.subscriberID, r.version, r.in, r.meta = tenantID, subscriberID, version, in, meta
	return r.out, r.err
}

func TestMCPAliasToolDelegatesToCanonicalRevisionBoundWriter(t *testing.T) {
	writer := &recordingMCPAliasWriter{out: &subscribers.Alias{
		ID:                "alias-1",
		SubscriberID:      "subscriber-1",
		AliasType:         "external_id",
		AliasValue:        "crm-42",
		Confidence:        1,
		Source:            "mcp",
		SubscriberVersion: `"subscriber:subscriber-1:v2"`,
	}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithActor(ctx, "agent", "mcp-key")
	out, err := handleUpsertSubscriberAlias(ctx, &Deps{SubscriberRepo: writer}, json.RawMessage(`{
		"subscriber_id":"subscriber-1",
		"subscriber_version":"\"subscriber:subscriber-1:v1\"",
		"alias_type":"external_id",
		"alias_value":"crm-42"
	}`))
	if err != nil {
		t.Fatalf("alias tool: %v", err)
	}
	if out != writer.out {
		t.Fatalf("tool returned %#v, want canonical writer response %#v", out, writer.out)
	}
	if writer.tenantID != "tenant-1" || writer.subscriberID != "subscriber-1" || writer.version != `"subscriber:subscriber-1:v1"` {
		t.Fatalf("canonical writer identity/version = %q/%q/%q", writer.tenantID, writer.subscriberID, writer.version)
	}
	if writer.in.AliasType != "external_id" || writer.in.AliasValue != "crm-42" || writer.in.Source != "mcp" || writer.in.Provenance["surface"] != "mcp" {
		t.Fatalf("canonical alias input = %#v", writer.in)
	}
	if writer.meta.ActorType != "agent" || writer.meta.ActorLabel != "mcp-key" {
		t.Fatalf("canonical audit actor = %#v", writer.meta)
	}
}

func TestMCPAliasToolRejectsContactMethodsAndMissingRevisionBeforeWriter(t *testing.T) {
	writer := &recordingMCPAliasWriter{}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-1"})
	for _, args := range []string{
		`{"subscriber_id":"subscriber-1","subscriber_version":"\"v1\"","alias_type":"email","alias_value":"a@example.test"}`,
		`{"subscriber_id":"subscriber-1","subscriber_version":"\"v1\"","alias_type":"phone","alias_value":"+15551234567"}`,
		`{"subscriber_id":"subscriber-1","alias_type":"custom","alias_value":"value"}`,
		`{"subscriber_id":"subscriber-1","subscriber_version":"*","alias_type":"custom","alias_value":"value"}`,
	} {
		if _, err := handleUpsertSubscriberAlias(ctx, &Deps{SubscriberRepo: writer}, json.RawMessage(args)); err == nil {
			t.Fatalf("unsafe alias args unexpectedly accepted: %s", args)
		}
	}
	if writer.subscriberID != "" {
		t.Fatalf("unsafe alias args reached canonical writer: %#v", writer)
	}
}

func TestMCPAliasToolReturnsSafeStableConflictMessages(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-1"})
	base := json.RawMessage(`{"subscriber_id":"subscriber-1","subscriber_version":"\"v1\"","alias_type":"custom","alias_value":"value"}`)
	for _, tc := range []struct {
		err  error
		want string
	}{
		{subscribers.ErrPreconditionFailed, "stale"},
		{subscribers.ErrAliasOwnedByAnotherProfile, "another subscriber"},
		{errors.New("private database detail"), "without committing"},
	} {
		_, err := handleUpsertSubscriberAlias(ctx, &Deps{SubscriberRepo: &recordingMCPAliasWriter{err: tc.err}}, base)
		if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "private database detail") {
			t.Fatalf("error %v mapped to %v, want safe fragment %q", tc.err, err, tc.want)
		}
	}
}
