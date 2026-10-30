import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import type { ComponentType } from "react";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import RootLayout from "../app/_layout";
import Index from "../app/index";
import AuthLayout from "../app/(auth)/_layout";
import ForgotPassword from "../app/(auth)/forgot-password";
import Login from "../app/(auth)/login";
import MagicReturn from "../app/(auth)/magic-return";
import MfaEnroll from "../app/(auth)/mfa-enroll";
import ResetConfirm from "../app/(auth)/reset-confirm";
import SignIn from "../app/(auth)/sign-in";
import SignUp from "../app/(auth)/sign-up";
import Totp from "../app/(auth)/totp";
import TabsLayout from "../app/(tabs)/_layout";
import AccessDenied from "../app/(tabs)/access-denied";
import Agency from "../app/(tabs)/agency";
import Approvals from "../app/(tabs)/approvals";
import Archive from "../app/(tabs)/archive";
import AuditSinks from "../app/(tabs)/audit-sinks";
import Audit from "../app/(tabs)/audit";
import Campaigns from "../app/(tabs)/campaigns";
import CliApprove from "../app/(tabs)/cli-approve";
import CampaignDetail from "../app/(tabs)/campaigns/[id]";
import AbResults from "../app/(tabs)/campaigns/[id]/ab-results";
import CustomDomains from "../app/(tabs)/custom-domains";
import Dashboard from "../app/(tabs)/dashboard";
import Diagnostics from "../app/(tabs)/diagnostics";
import Discounts from "../app/(tabs)/discounts";
import Dmarc from "../app/(tabs)/dmarc";
import FrequencyCaps from "../app/(tabs)/frequency-caps";
import InboundWebhooks from "../app/(tabs)/inbound-webhooks";
import Integrations from "../app/(tabs)/integrations";
import Lists from "../app/(tabs)/lists";
import Migrations from "../app/(tabs)/migrations";
import More from "../app/(tabs)/more";
import Referrals from "../app/(tabs)/referrals";
import Scan from "../app/(tabs)/scan";
import Scim from "../app/(tabs)/scim";
import SendingSettings from "../app/(tabs)/sending-settings";
import SequenceDetail from "../app/(tabs)/sequences/[id]";
import Sequences from "../app/(tabs)/sequences/index";
import Settings from "../app/(tabs)/settings";
import SubscriberDetail from "../app/(tabs)/subscribers/[id]";
import Subscribers from "../app/(tabs)/subscribers";
import Suppressions from "../app/(tabs)/suppressions";
import Tags from "../app/(tabs)/tags";
import Voice from "../app/(tabs)/voice";

type RouteCase = readonly [name: string, Component: ComponentType];

const ROUTES: RouteCase[] = [
  ["root layout", RootLayout],
  ["root index", Index],
  ["auth layout", AuthLayout],
  ["forgot password", ForgotPassword],
  ["API-key login", Login],
  ["magic-link return", MagicReturn],
  ["MFA enrollment", MfaEnroll],
  ["password reset confirmation", ResetConfirm],
  ["session sign-in", SignIn],
  ["sign-up", SignUp],
  ["TOTP challenge", Totp],
  ["tabs layout", TabsLayout],
  ["access denied", AccessDenied],
  ["agency", Agency],
  ["approvals", Approvals],
  ["archive", Archive],
  ["audit sinks", AuditSinks],
  ["audit log", Audit],
  ["campaigns", Campaigns],
  ["campaign detail", CampaignDetail],
  ["campaign A/B results", AbResults],
  ["CLI device approval", CliApprove],
  ["custom domains", CustomDomains],
  ["dashboard", Dashboard],
  ["diagnostics", Diagnostics],
  ["discounts", Discounts],
  ["DMARC", Dmarc],
  ["frequency caps", FrequencyCaps],
  ["inbound webhooks", InboundWebhooks],
  ["integrations", Integrations],
  ["lists", Lists],
  ["migrations", Migrations],
  ["more", More],
  ["QR scanner", Scan],
  ["referrals", Referrals],
  ["SCIM", Scim],
  ["sending settings", SendingSettings],
  ["sequence detail", SequenceDetail],
  ["sequences", Sequences],
  ["settings", Settings],
  ["subscriber detail", SubscriberDetail],
  ["subscribers", Subscribers],
  ["suppressions", Suppressions],
  ["tags", Tags],
  ["voice", Voice],
];

describe("every Expo Router module renders a bounded native state", () => {
  it.each(ROUTES)("renders %s", async (_name, Component) => {
    const result = await render(React.createElement(Component), {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    });
    expect(result.toJSON()).not.toBeNull();
  });
});
