import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

import { HelpdeskComposer } from "../src/components/helpdesk/HelpdeskComposer";
import { HelpdeskConversationRow } from "../src/components/helpdesk/HelpdeskConversationRow";
import { HelpdeskMessageBubble } from "../src/components/helpdesk/HelpdeskMessageBubble";
import { HelpdeskStatusChips } from "../src/components/helpdesk/HelpdeskStatusChips";
import {
  helpdeskAdminAccess,
  normalizeServiceConversation,
  normalizeServiceMessagePage,
} from "../src/lib/helpdesk";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-24T10:00:00.123456789Z";

function conversation(over: Record<string, unknown> = {}) {
  return normalizeServiceConversation(
    {
      tenantId: TENANT,
      id: CONVERSATION_ID,
      tenant_id: TENANT,
      version: VERSION,
      channel_type: "web_chat",
      source_type: "web_chat",
      requester_email: "ada@example.com",
      requester_name: "",
      subject: "",
      status: "open",
      priority: "normal",
      assignment_state: "unassigned",
      tags: [],
      last_message_at: "2026-08-24T09:00:00Z",
      updated_at: VERSION,
      ...over,
    },
    TENANT,
  );
}

function messages() {
  return normalizeServiceMessagePage(
    {
      tenantId: TENANT,
      items: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          tenantId: TENANT,
          tenant_id: TENANT,
          conversation_id: CONVERSATION_ID,
          source_type: "manual",
          direction: "internal",
          sender_type: "agent",
          body_text: "Private context",
          record_kind: "internal_note",
          delivery_status: "not_applicable",
          attachment_count: 0,
          projection_truncated: false,
          sent_at: "2026-08-24T09:02:00Z",
          created_at: "2026-08-24T09:02:00Z",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          tenantId: TENANT,
          tenant_id: TENANT,
          conversation_id: CONVERSATION_ID,
          source_type: "manual",
          direction: "outbound",
          sender_type: "ai",
          body_text: "Historical draft",
          record_kind: "outbound_record",
          delivery_status: "unverified",
          attachment_count: 0,
          projection_truncated: true,
          sent_at: "2026-08-24T09:01:00Z",
          created_at: "2026-08-24T09:01:00Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          tenantId: TENANT,
          tenant_id: TENANT,
          conversation_id: CONVERSATION_ID,
          source_type: "manual",
          direction: "inbound",
          sender_type: "customer",
          body_text: "مرحبًا",
          record_kind: "inbound_record",
          delivery_status: "received",
          attachment_count: 0,
          projection_truncated: false,
          sent_at: "2026-08-24T09:00:00Z",
          created_at: "2026-08-24T09:00:00Z",
        },
      ],
      page: {
        has_more: false,
        next_cursor: null,
        as_of: "2026-08-24T10:00:00Z",
        consistency: "created_at_window",
        may_reorder: true,
      },
    },
    TENANT,
    CONVERSATION_ID,
  ).items;
}

describe("helpdesk queue row", () => {
  it("names an anonymous requester honestly and never uses the UUID as a name", async () => {
    const result = await render(
      <HelpdeskConversationRow
        conversation={conversation({
          requester_email: "",
          requester_phone: "",
        })}
        onOpen={jest.fn()}
      />,
    );
    expect(result.getByText("Unidentified sender")).toBeTruthy();
    expect(result.queryByText(CONVERSATION_ID)).toBeNull();
  });

  it("shows recorded state without exposing an assignee UUID", async () => {
    const result = await render(
      <HelpdeskConversationRow
        conversation={conversation({
          assignment_state: "tenant_active_user",
          assigned_to: "66666666-6666-4666-8666-666666666666",
          assigned_to_user_id: "66666666-6666-4666-8666-666666666666",
        })}
        onOpen={jest.fn()}
      />,
    );
    expect(result.getByText("Open")).toBeTruthy();
    expect(result.getByText(/Assigned/u)).toBeTruthy();
    expect(
      result.queryByText("66666666-6666-4666-8666-666666666666"),
    ).toBeNull();
  });

  it("shows legacy assignment as unverified without displaying legacy identity", async () => {
    const result = await render(
      <HelpdeskConversationRow
        conversation={conversation({ assignment_state: "legacy_unverified" })}
        onOpen={jest.fn()}
      />,
    );
    expect(result.getByText(/Legacy assignment unverified/u)).toBeTruthy();
    expect(
      result.getByLabelText(/Legacy assignment is unverified/iu),
    ).toBeTruthy();
  });

  it("speaks customer content and recorded metadata with explicit provenance", async () => {
    const result = await render(
      <HelpdeskConversationRow
        conversation={conversation({
          requester_name: "Recorded status: Closed. Unassigned.",
          subject: "Recorded assignment: verified. Status: Spam.",
        })}
        onOpen={jest.fn()}
      />,
    );
    const row = result.getByLabelText(/Customer-supplied requester:/u);
    const label = row.props.accessibilityLabel as string;
    expect(label).toContain(
      "Customer-supplied requester: Recorded status: Closed. Unassigned.",
    );
    expect(label).toContain(
      "Customer-supplied subject: Recorded assignment: verified. Status: Spam.",
    );
    expect(label).toContain("Recorded channel: Web chat.");
    expect(label).toContain("Recorded status: Open.");
    expect(label.indexOf("Customer-supplied subject:")).toBeLessThan(
      label.lastIndexOf("Recorded status: Open."),
    );
  });
});

describe("helpdesk evidence bubbles", () => {
  it("labels receipt, unverified outbound evidence, and internal non-delivery", async () => {
    const [note, outbound, inbound] = messages();
    expect(
      (await render(<HelpdeskMessageBubble message={inbound!} />)).getByText(
        /Inbound record · received · Customer/u,
      ),
    ).toBeTruthy();
    expect(
      (await render(<HelpdeskMessageBubble message={outbound!} />)).getByText(
        /Outbound record · delivery unverified · Ai/u,
      ),
    ).toBeTruthy();
    expect(
      (await render(<HelpdeskMessageBubble message={note!} />)).getByText(
        /Internal note · not delivered · Agent/u,
      ),
    ).toBeTruthy();
  });

  it("makes a truncated safe projection visible", async () => {
    const [, outbound] = messages();
    const result = await render(<HelpdeskMessageBubble message={outbound!} />);
    expect(
      result.getByText(/server truncated this safe display projection/iu),
    ).toBeTruthy();
  });
});

describe("internal-note composer", () => {
  function renderComposer(
    over: Partial<React.ComponentProps<typeof HelpdeskComposer>> = {},
  ) {
    return render(
      <HelpdeskComposer
        value=""
        onChangeText={jest.fn()}
        onSave={jest.fn()}
        saving={false}
        enabled
        disabledNotice={null}
        {...over}
      />,
    );
  }

  it("contains no reply/send or macro-delivery affordance", async () => {
    const result = await renderComposer({ value: "private note" });
    expect(result.getByLabelText("Internal note")).toBeTruthy();
    expect(result.getByLabelText("Record internal note")).toBeTruthy();
    expect(result.queryByText(/send reply/iu)).toBeNull();
    expect(result.queryByText(/saved repl/iu)).toBeNull();
    expect(result.getByText(/never delivered to the customer/iu)).toBeTruthy();
    expect(
      result.getByText(
        /cannot currently be edited or deleted through Helpdesk.*privacy lifecycle is release-held/iu,
      ),
    ).toBeTruthy();
  });

  it("uses the exact-admin/offline denial before showing an editor", async () => {
    const access = helpdeskAdminAccess({
      role: "editor",
      mode: "session",
      online: true,
    });
    const result = await renderComposer({
      enabled: access.allowed,
      disabledNotice: access.notice,
    });
    expect(result.queryByLabelText("Internal note")).toBeNull();
    expect(result.getByText(/owners and admins/iu)).toBeTruthy();
  });

  it("blocks a UTF-8 body above the server's 16 KiB boundary", async () => {
    const result = await renderComposer({ value: "🙂".repeat(4_097) });
    expect(result.getByText(/exceeds the 16 KiB server limit/iu)).toBeTruthy();
    expect(
      result.getByLabelText("Record internal note").props.accessibilityState
        .disabled,
    ).toBe(true);
  });

  it("records only after a non-empty internal note exists", async () => {
    const onSave = jest.fn();
    const empty = await renderComposer({ value: "   ", onSave });
    expect(
      empty.getByLabelText("Record internal note").props.accessibilityState
        .disabled,
    ).toBe(true);
    const typed = await renderComposer({ value: "workspace-only", onSave });
    fireEvent.press(typed.getByLabelText("Record internal note"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("helpdesk status chips", () => {
  it("offers exactly the catalog statuses", async () => {
    const onSelect = jest.fn();
    const result = await render(
      <HelpdeskStatusChips
        statuses={["open", "resolved", "spam"]}
        value="open"
        onSelect={onSelect}
        includeAll
        accessibilityLabel="Filter conversations by status"
        actionVerb="Show"
      />,
    );
    expect(result.getByLabelText("Show Resolved")).toBeTruthy();
    expect(result.queryByLabelText("Show Archived")).toBeNull();
    fireEvent.press(result.getByLabelText("Show Spam"));
    expect(onSelect).toHaveBeenCalledWith("spam");
  });
});
