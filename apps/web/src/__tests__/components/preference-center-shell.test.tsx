import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreferenceCenterShell } from "@/app/[locale]/preferences/[token]/preference-center-shell";

describe("PreferenceCenterShell", () => {
  it("renders verified tenant branding without leaking the capability URL", () => {
    const html = renderToStaticMarkup(
      <PreferenceCenterShell
        poweredBy="Powered by"
        customization={{
          logo_url: "https://assets.example.com/logo.png",
          primary_color: "#123ABC",
          footer_text: "Acme privacy controls",
          show_postwave_badge: true,
        }}
      >
        <h1>Preferences</h1>
      </PreferenceCenterShell>,
    );

    expect(html).toContain("border-top-color:#123ABC");
    expect(html).toContain('src="https://assets.example.com/logo.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("Acme privacy controls");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Moosewave</a>");
    expect(html).not.toContain("preferences/token");
  });

  it("fully honors a hidden badge and empty footer", () => {
    const html = renderToStaticMarkup(
      <PreferenceCenterShell
        poweredBy="Powered by"
        customization={{
          logo_url: "",
          primary_color: "#5B6CFF",
          footer_text: "",
          show_postwave_badge: false,
        }}
      >
        <h1>Preferences</h1>
      </PreferenceCenterShell>,
    );

    expect(html).not.toContain("<footer");
    expect(html).not.toContain("Moosewave");
    expect(html).not.toContain("<img");
  });
});
