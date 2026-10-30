/**
 * The TOTP setup key is a shared secret. It used to be a `selectable` Text
 * whose accessibility label spoke the secret and whose long-press put it on
 * the pasteboard with no expiry. Now the only copy path is a button that
 * clears itself, the way the webhook secret does, and the label names the
 * field rather than reading the key.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";

const mockSet = jest.fn<(value: string) => Promise<boolean>>();
const mockToast = jest.fn();
jest.mock("expo-clipboard", () => ({
  setStringAsync: (value: string) => mockSet(value),
  getStringAsync: async () => "",
}));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ toast: mockToast }) }));

// eslint-disable-next-line import/first
import { TotpSetupKeyBlock } from "../src/components/auth/TotpSetupKeyBlock";

const URI = "otpauth://totp/Moosewave:ana%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Moosewave";

beforeEach(() => {
  mockSet.mockReset().mockResolvedValue(true);
  mockToast.mockReset();
});

describe("TotpSetupKeyBlock", () => {
  it("names the field in its accessibility label instead of speaking the secret", async () => {
    await render(<TotpSetupKeyBlock otpauthUri={URI} />);
    expect(screen.getByLabelText("Setup key")).toBeTruthy();
    expect(screen.queryByLabelText(/JBSWY3DPEHPK3PXP/u)).toBeNull();
  });

  it("copies exactly the extracted secret through the clearing helper, and says it will clear", async () => {
    await render(<TotpSetupKeyBlock otpauthUri={URI} />);
    await fireEvent.press(screen.getByLabelText("Copy setup key"));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "success", message: expect.stringMatching(/clears from the clipboard/u) }),
      ),
    );
  });

  it("does not claim a copy it could not make", async () => {
    mockSet.mockResolvedValue(false);
    await render(<TotpSetupKeyBlock otpauthUri={URI} />);
    await fireEvent.press(screen.getByLabelText("Copy setup key"));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" })));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "success" }));
  });
});
