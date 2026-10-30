/**
 * The receiver preset gallery on the outbound-webhook CREATE form.
 *
 * Desktop opens its create dialog FROM a gallery of named receivers; the phone
 * has no room for a dialog stack, so the gallery is a chip row above the fields
 * it fills. That collapse is the whole risk this file exists to pin: on desktop
 * the gallery is a step BEFORE a form, here it is a control INSIDE one, a
 * thumb's width from Create. So the assertions are about restraint —
 *
 *   1. picking a preset fills fields and sends NOTHING,
 *   2. a field the operator edits after picking stays edited (a preset is a
 *      starting point, not a mode), and the edited value is what Create sends,
 *   3. below the role the create route requires, the templates are withheld
 *      with the rule named rather than offered and then 403'd,
 *
 * plus the two things a phone can hide that a desktop dialog cannot: the URL a
 * template must never invent, and the signing convention the mobile create body
 * silently commits to.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";
import { OutboundWebhookForm } from "@/components/settings/OutboundWebhookForm";

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

/** What `resolveEventCatalog` hands the form once the server catalog lands. */
const CATALOG = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "audit.created",
];

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

function asAdmin(role = "admin") {
  gateHarness.__setOnlineGateForTests({ enabled: true, effectiveRole: role });
}

async function renderCreateForm(
  overrides: Partial<Parameters<typeof OutboundWebhookForm>[0]> = {},
) {
  const onCreate = jest.fn();
  const onCancel = jest.fn();
  const view = await render(
    <OutboundWebhookForm
      catalog={CATALOG}
      creating={false}
      online
      onCancel={onCancel}
      onCreate={onCreate as () => void}
      {...overrides}
    />,
    { wrapper },
  );
  return { onCreate, onCancel, view };
}

function textValue(label: string): string {
  return String(screen.getByLabelText(label).props.value ?? "");
}

describe("picking a receiver template", () => {
  it("fills the draft in place and sends nothing", async () => {
    asAdmin();
    const { onCreate } = await renderCreateForm();

    expect(textValue("Webhook description")).toBe("");
    expect(
      screen.getByLabelText("campaign.sent event").props.accessibilityState
        .selected,
    ).toBe(false);

    await fireEvent.press(screen.getByLabelText("Zapier receiver template"));

    // The fields the operator can see now hold the template's values...
    expect(textValue("Webhook description")).toBe(
      "Zapier — created via gallery",
    );
    expect(
      screen.getByLabelText("campaign.sent event").props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      screen.getByLabelText("subscriber.added event").props.accessibilityState
        .selected,
    ).toBe(true);
    // ...and a topic the template does not ask for is still unselected.
    expect(
      screen.getByLabelText("audit.created event").props.accessibilityState
        .selected,
    ).toBe(false);

    // ...and NOTHING has been submitted. A preset is a convenience, not a
    // create: the operator still presses the button.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("hints at the receiver's URL shape without ever filling the URL", async () => {
    asAdmin();
    await renderCreateForm();
    await fireEvent.press(screen.getByLabelText("Zapier receiver template"));

    const url = screen.getByLabelText("Webhook URL");
    expect(url.props.placeholder).toBe(
      "https://hooks.zapier.com/hooks/catch/…",
    );
    // A placeholder is not a value: an endpoint that posts to an ellipsis is
    // worse than one the operator had to type.
    expect(url.props.value).toBe("");
  });

  it("shows the picked receiver as selected, and only that one", async () => {
    asAdmin();
    await renderCreateForm();
    await fireEvent.press(screen.getByLabelText("n8n receiver template"));

    expect(
      screen.getByLabelText("n8n receiver template").props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      screen.getByLabelText("Zapier receiver template").props.accessibilityState
        .selected,
    ).toBe(false);
  });

  it("states the signing convention in the form rather than hiding it", async () => {
    asAdmin();
    await renderCreateForm();
    await fireEvent.press(screen.getByLabelText("Discord receiver template"));

    // The mobile create body carries no `algorithm`, so every endpoint made
    // here is HMAC, permanently — desktop offers a select for this, so on a
    // phone it has to be a sentence.
    expect(
      screen.getByText(/signed with HMAC-SHA256/),
    ).toBeTruthy();
    // The receiver's own setup instruction is desktop's copy, verbatim.
    expect(screen.getByText(/Channel settings → Integrations → Webhooks/)).toBeTruthy();
  });

  it("names what it took away when it replaces a selection the operator made", async () => {
    asAdmin();
    await renderCreateForm();

    await fireEvent.press(screen.getByLabelText("audit.created event"));
    expect(
      screen.getByLabelText("audit.created event").props.accessibilityState
        .selected,
    ).toBe(true);

    await fireEvent.press(screen.getByLabelText("Zapier receiver template"));

    expect(
      screen.getByLabelText("audit.created event").props.accessibilityState
        .selected,
    ).toBe(false);
    expect(
      screen.getByText(/Replaced your event selection — audit\.created/),
    ).toBeTruthy();
  });

  it("is offered on create only — an endpoint that exists already has a receiver", async () => {
    asAdmin();
    await renderCreateForm({
      initial: {
        url: "https://mine.example/hook",
        description: "Primary handler",
        events: ["campaign.sent"],
      },
      submitLabel: "Save",
    });

    expect(screen.queryByLabelText("Zapier receiver template")).toBeNull();
    expect(screen.queryByText("Start from a receiver")).toBeNull();
  });
});

describe("a field the template filled stays the operator's", () => {
  it("keeps an edit made after picking, and Create sends the edited value", async () => {
    asAdmin();
    const { onCreate } = await renderCreateForm();

    await fireEvent.press(screen.getByLabelText("Zapier receiver template"));
    expect(textValue("Webhook description")).toBe(
      "Zapier — created via gallery",
    );

    await fireEvent.changeText(
      screen.getByLabelText("Webhook description"),
      "Ops alerting hook",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Webhook URL"),
      "https://hooks.zapier.com/hooks/catch/1/abc",
    );
    // And a chip the template ticked can be un-ticked.
    await fireEvent.press(screen.getByLabelText("subscriber.added event"));

    await fireEvent.press(screen.getByLabelText("Create"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      url: "https://hooks.zapier.com/hooks/catch/1/abc",
      description: "Ops alerting hook",
      events: ["campaign.sent"],
    });
  });

  it("does not eat a description the operator typed BEFORE picking", async () => {
    asAdmin();
    await renderCreateForm();

    await fireEvent.changeText(
      screen.getByLabelText("Webhook description"),
      "Ops alerting hook",
    );
    await fireEvent.press(screen.getByLabelText("Zapier receiver template"));

    expect(textValue("Webhook description")).toBe("Ops alerting hook");
    expect(
      screen.getByText(/Kept the description you had already written/),
    ).toBeTruthy();
  });
});

describe("the role the create route requires", () => {
  it("withholds the templates below admin, and says which role is needed", async () => {
    // POST /api/v1/outbound-webhooks is session_minimum_role "admin"
    // (routeauth/manifest.json). An affordance whose only outcome is a 403 is
    // worse than no affordance — but silence is worse than either.
    asAdmin("viewer");
    await renderCreateForm();

    expect(screen.queryByLabelText("Zapier receiver template")).toBeNull();
    expect(
      screen.getByText(
        "Creating an outbound webhook needs an owner or admin role, so these receiver templates aren't offered.",
      ),
    ).toBeTruthy();
  });

  it("offers them to an owner", async () => {
    asAdmin("owner");
    await renderCreateForm();
    expect(screen.getByLabelText("Zapier receiver template")).toBeTruthy();
  });

  it("withholds them under an API key, with the API-key reason", async () => {
    asAdmin("owner");
    authHarness.__setAuthStateForTests({ mode: "api_key" });
    await renderCreateForm();

    expect(screen.queryByLabelText("Zapier receiver template")).toBeNull();
    expect(screen.getByText(/signed in with an API key/)).toBeTruthy();
  });
});
