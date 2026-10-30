/**
 * Every component that OWNS its data, mounted for the first time.
 *
 * A component that calls a query hook and reads `.data` can be handed anything
 * the wire produces, and 76% of this app's components had never been mounted by
 * a test at all. The subset that owns its data is the subset that can CRASH on
 * a payload -- the rest take props and are exercised through their parents.
 *
 * Every case below is a shape a Go handler or a proxy actually produces:
 * `omitempty` dropping a list, a paged envelope where a bare array was
 * expected, and an SPA fallback serving HTML for an absent upstream (seen live
 * on 2026-08-19, where it became 1,293 rows of one character each).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import { FlowAbTestsScreen } from "@/components/flow-ab/FlowAbTestsScreen";
import { PrivacyRetentionSection } from "@/components/settings/PrivacyRetentionSection";
import { DigestPrefsSection } from "@/components/settings/DigestPrefsSection";
import { SecurityPolicySection } from "@/components/settings/SecurityPolicySection";
import { WorkspaceSettingsSection } from "@/components/settings/WorkspaceSettingsSection";
import { SettingsShortcuts } from "@/components/settings/SettingsShortcuts";
import { NotificationPreferencesSection } from "@/components/settings/NotificationPreferencesSection";
import { DataExportsSection } from "@/components/settings/DataExportsSection";
import { PlatformConfigSection } from "@/components/settings/PlatformConfigSection";
import { PrivacyRequestsSection } from "@/components/settings/PrivacyRequestsSection";
import { ApprovalGovernanceSection } from "@/components/settings/ApprovalGovernanceSection";
import { SlackWorkspaceCard } from "@/components/settings/SlackWorkspaceCard";
import { TotpSecuritySection } from "@/components/settings/TotpSecuritySection";
import { WebhookAlertPrefsSection } from "@/components/settings/WebhookAlertPrefsSection";
import { TransactionalTriageSection } from "@/components/deliverability/TransactionalTriageSection";
import { HubDiagnostics } from "@/components/deliverability/HubDiagnostics";
import { SmsCampaignControls } from "@/components/sms/SmsCampaignControls";
import { ReferralsScreen } from "@/components/referrals/ReferralsScreen";
import { SarQueueBanner } from "@/components/compliance/SarQueueBanner";
import { IdempotencyLedgerCard } from "@/components/diagnostics/IdempotencyLedgerCard";
import { FrequencyCapsScreen } from "@/components/frequency-caps/FrequencyCapsScreen";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
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

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

const HOSTILE: [string, unknown][] = [
  ["a bare object", {}],
  ["a paged envelope", { items: [], total: 0 }],
  ["an array where an object was expected", []],
  ["undefined", undefined],
  ["null", null],
  ["a string (an SPA fallback body)", "<!DOCTYPE html>"],
  ["a number", 1],
];

describe.each([
  ["FlowAbTestsScreen", FlowAbTestsScreen],
  ["PrivacyRetentionSection", PrivacyRetentionSection],
  ["DigestPrefsSection", DigestPrefsSection],
  ["SecurityPolicySection", SecurityPolicySection],
  ["WorkspaceSettingsSection", WorkspaceSettingsSection],
  ["SettingsShortcuts", SettingsShortcuts],
  ["NotificationPreferencesSection", NotificationPreferencesSection],
  ["DataExportsSection", DataExportsSection],
  ["PlatformConfigSection", PlatformConfigSection],
  ["PrivacyRequestsSection", PrivacyRequestsSection],
  ["ApprovalGovernanceSection", ApprovalGovernanceSection],
  ["SlackWorkspaceCard", SlackWorkspaceCard],
  ["TotpSecuritySection", TotpSecuritySection],
  ["WebhookAlertPrefsSection", WebhookAlertPrefsSection],
  ["TransactionalTriageSection", TransactionalTriageSection],
  ["HubDiagnostics", HubDiagnostics],
  ["SmsCampaignControls", SmsCampaignControls],
  ["ReferralsScreen", ReferralsScreen],
  ["SarQueueBanner", SarQueueBanner],
  ["IdempotencyLedgerCard", IdempotencyLedgerCard],
  ["FrequencyCapsScreen", FrequencyCapsScreen],
])("%s", (_name, Component) => {
  it.each(HOSTILE)("survives %s", async (_case, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<Component />, { wrapper })).not.toThrow();
  });
});
