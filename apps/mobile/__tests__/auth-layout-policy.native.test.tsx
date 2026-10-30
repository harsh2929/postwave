import {
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import React from "react";

let mockPathname = "/(auth)/sign-in";

jest.mock("expo-router", () => {
  const actual = jest.requireActual("expo-router") as Record<string, unknown>;
  return { ...actual, usePathname: () => mockPathname };
});

// eslint-disable-next-line import/first
import AuthLayout from "../app/(auth)/_layout";
// eslint-disable-next-line import/first
import * as authStore from "@/store/auth";

const authHarness = authStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

type MfaGate = "none" | "enrollment" | "challenge";
type ActiveMfaGate = Exclude<MfaGate, "none">;

const VERIFY_CASES: [boolean, ActiveMfaGate][] = [
  [true, "enrollment"],
  [true, "challenge"],
  [false, "enrollment"],
  [false, "challenge"],
];

const RECOVERY_CASES: [string, ActiveMfaGate][] = [
  ["/(auth)/magic-return", "enrollment"],
  ["/(auth)/reset-confirm", "challenge"],
];

const ENFORCEMENT_CASES: [ActiveMfaGate, string][] = [
  ["enrollment", "/(auth)/mfa-enroll"],
  ["challenge", "/(auth)/totp"],
];

afterEach(() => {
  mockPathname = "/(auth)/sign-in";
  authHarness.__resetAuthStateForTests();
});

async function renderPolicy({
  path,
  isAuthed,
  mfaGate,
}: {
  path: string;
  isAuthed: boolean;
  mfaGate: MfaGate;
}) {
  mockPathname = path;
  authHarness.__setAuthStateForTests({
    canEnterApp: () => isAuthed,
    mfaGate: () => mfaGate,
  });
  return await render(<AuthLayout />);
}

function redirectTarget(): string | null {
  return (
    screen.queryByTestId("mock-redirect")?.props.children as string | undefined
  ) ?? null;
}

describe("(auth) layout redirect policy", () => {
  it.each(VERIFY_CASES)(
    "renders verify-email when authenticated=%s and MFA=%s",
    async (isAuthed, mfaGate) => {
      await renderPolicy({
        path: "/(auth)/verify-email",
        isAuthed,
        mfaGate,
      });

      expect(screen.getByTestId("mock-navigator")).toBeTruthy();
      expect(redirectTarget()).toBeNull();
    },
  );

  it.each(RECOVERY_CASES)("keeps %s reachable through the %s gate", async (path, mfaGate) => {
    await renderPolicy({ path, isAuthed: true, mfaGate });
    expect(screen.getByTestId("mock-navigator")).toBeTruthy();
    expect(redirectTarget()).toBeNull();
  });

  it.each(ENFORCEMENT_CASES)("still enforces the %s gate on sign-in", async (mfaGate, target) => {
    await renderPolicy({
      path: "/(auth)/sign-in",
      isAuthed: false,
      mfaGate,
    });
    expect(redirectTarget()).toBe(target);
    expect(screen.queryByTestId("mock-navigator")).toBeNull();
  });
});
