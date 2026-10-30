/**
 * Renders a QR code with `react-native-svg/css` REPLACED BY AN EMPTY MODULE —
 * the exact state `metro.config.js` puts the native bundle in.
 *
 * WHY THIS FILE EXISTS. The css-tree stub removes 413 KB by making
 * `react-native-svg/css` resolve to `{ type: "empty" }`. Every other test in
 * this repo passes with or without that stub, because jest does not use
 * Metro's resolver — so the existing 42 render assertions on these screens
 * prove nothing about it. The reasoning that the stub is safe (binding an
 * undefined export does not throw; only RENDERING `LocalSvg` would) was
 * argument, not evidence.
 *
 * This mock makes jest agree with Metro for one file, so the claim is tested
 * rather than asserted. The two screens covered are 2FA enrolment and phone
 * sign-in approval: a QR that fails to draw locks people out of their account.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { FC } from "react";
import type { SvgProps } from "react-native-svg";

import QRCode from "react-native-qrcode-svg";

// Exactly what `{ type: "empty" }` produces: a module with no exports.
// babel-jest hoists this above the import regardless of where it is written;
// the "CRASHES on a local-asset logoSVG" case below is the proof it applied —
// that error can only come from an empty react-native-svg/css.
jest.mock("react-native-svg/css", () => ({}));

describe("QR codes render with the CSS parser stubbed out", () => {
  it("renders without a logo prop — the shipped configuration", async () => {
    await render(
      <QRCode
        value="otpauth://totp/Moosewave:someone@example.com?secret=ABC"
        size={200}
        backgroundColor="#ffffff"
        color="#000000"
        testID="qr"
      />,
    );
    expect(screen.getByTestId("qr")).toBeTruthy();
    // A QR that rendered an EMPTY svg would still satisfy getByTestId, so
    // assert the matrix actually produced path geometry.
    expect(JSON.stringify(screen.toJSON())).toContain("Path");
  });

  it("CRASHES on a local-asset logoSVG — the hazard the tripwire guards", async () => {
    // Not a wish, a measurement. This is the exact failure a future `logoSVG`
    // would ship to 2FA enrolment, and it is why
    // src/lib/qrcodeLogoPropUnused.test.ts watches `logoSVG` and not `logo`.
    // If this ever stops throwing, react-native-qrcode-svg changed how it
    // reaches LocalSvg and the tripwire needs revisiting.
    // `logoSVG` is typed `string | FC<SvgProps>`. A string goes through
    // SvgXml/SvgUri on the MAIN entry and is safe; a component value falls to
    // the LocalSvg branch, which is the one the stub empties.
    const AssetLogo: FC<SvgProps> = () => null;
    let threw: unknown = null;
    try {
      await render(
        <QRCode value="x" size={100} logoSVG={AssetLogo} testID="boom" />,
      );
    } catch (error) {
      threw = error;
    }
    expect(String(threw)).toContain("displayName");
  });

  it("does NOT crash on the harmless `logo` prop", async () => {
    // The distinction that made the first tripwire useless: `logo` renders a
    // plain <Image> and never touches the CSS entry.
    await render(
      <QRCode
        value="x"
        size={100}
        logo={{ uri: "https://example.com/x.png" }}
        testID="logo-ok"
      />,
    );
    expect(screen.getByTestId("logo-ok")).toBeTruthy();
  });

  it("renders the device-sign-in shape too", async () => {
    // Same component, the second call site's props (ecl differs).
    await render(
      <QRCode
        value="https://example.com/device?user_code=ABCD-EFGH"
        size={220}
        ecl="M"
        backgroundColor="white"
        color="black"
        testID="qr2"
      />,
    );
    expect(screen.getByTestId("qr2")).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain("Path");
  });
});
