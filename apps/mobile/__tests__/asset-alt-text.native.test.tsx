/**
 * AssetAltTextSection — the phone half of the alt-text edit (the PATCH itself
 * is pinned in src/api/assets.test.ts, the rune bound in
 * src/lib/assetLibrary.test.ts). What only a render test can hold:
 *   - the affordance is OMITTED, not disabled, when the role/online gate says
 *     no — a control a viewer cannot use must not be drawn;
 *   - Save sends the TRIMMED draft and leaves edit mode only on success;
 *   - a draft past the server's bound is refused at the button, with the
 *     reason on screen, before any request.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { AssetAltTextSection } from "@/components/assets/AssetAltTextSection";

describe("AssetAltTextSection", () => {
  it("shows the stored sentence and an edit affordance when allowed", async () => {
    await render(
      <AssetAltTextSection
        altText="A red banner"
        canEdit
        saving={false}
        onSave={jest.fn(async () => true)}
      />,
    );
    expect(screen.getByText("A red banner")).toBeTruthy();
    expect(screen.getByLabelText("Edit alt text")).toBeTruthy();
  });

  it("OMITS the affordance — not disables it — when the gate says no", async () => {
    await render(
      <AssetAltTextSection
        altText="A red banner"
        canEdit={false}
        saving={false}
        onSave={jest.fn(async () => true)}
      />,
    );
    expect(screen.queryByLabelText("Edit alt text")).toBeNull();
    expect(screen.queryByLabelText("Add alt text")).toBeNull();
  });

  it("saves the trimmed draft", async () => {
    const onSave = jest.fn(async () => true);
    await render(
      <AssetAltTextSection
        altText=""
        canEdit
        saving={false}
        onSave={onSave}
      />,
    );
    await fireEvent.press(screen.getByLabelText("Add alt text"));
    await fireEvent.changeText(
      screen.getByLabelText("Alt text for this image"),
      "  A rocket over the launch banner  ",
    );
    await fireEvent.press(screen.getByLabelText("Save alt text"));
    expect(onSave).toHaveBeenCalledWith("A rocket over the launch banner");
  });

  it("refuses a draft past the 1024-rune bound before any request", async () => {
    const onSave = jest.fn(async () => true);
    await render(
      <AssetAltTextSection altText="" canEdit saving={false} onSave={onSave} />,
    );
    await fireEvent.press(screen.getByLabelText("Add alt text"));
    await fireEvent.changeText(
      screen.getByLabelText("Alt text for this image"),
      "a".repeat(1025),
    );
    expect(screen.getByText(/limit is 1024/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Save alt text"));
    expect(onSave).not.toHaveBeenCalled();
  });
});
