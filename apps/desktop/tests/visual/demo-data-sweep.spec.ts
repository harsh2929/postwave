import type { Page } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";
import { PRIMARY_DESKTOP_SECTIONS } from "./sections";

interface DemoDataFinding {
  section: string;
  detail: string;
}

const CONTRACT_FAILURE =
  /couldn['’]t verify|returned (?:an )?invalid|invalid_[a-z0-9_]+_response_contract|snapshot unavailable/iu;

async function navigateToSection(page: Page, section: string): Promise<void> {
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator(`button[data-section="${section}"]`)
    .last();
  await destination.click({ timeout: 8_000 });
  await expect(destination).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(450);
}

test("demo fixtures satisfy every primary page's initial read contracts", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(180_000);
  const findings: DemoDataFinding[] = [];
  const activeSection = { value: "boot" };

  page.on("pageerror", (error) => {
    findings.push({
      section: activeSection.value,
      detail: `${error.name}: ${error.message}`.slice(0, 500),
    });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const detail = message.text();
    if (/favicon|Failed to load resource/iu.test(detail)) return;
    findings.push({
      section: activeSection.value,
      detail: `console: ${detail}`.slice(0, 500),
    });
  });

  await setTheme(page, "light");
  await bootApp(page);
  await page.addInitScript(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const previousInvoke = internals.invoke.bind(internals);
    internals.invoke = async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "session_broker_initialize") {
        return { baseUrl: String(args?.baseUrl ?? "http://localhost:8080") };
      }
      if (command === "session_broker_cancel") return null;
      if (command !== "session_broker_stream_request") {
        return previousInvoke(command, args);
      }

      const request = args?.request as { url?: string } | undefined;
      const pathname = new URL(
        request?.url ?? window.location.href,
        window.location.href,
      ).pathname;
      const payload =
        pathname === "/api/v1/auth/me"
          ? {
              user_id: "visual-user",
              tenant_id: "00000000-0000-4000-8000-000000000099",
              email: "visual-test@example.invalid",
              role: "admin",
              effective_role: "admin",
              auth_provider: "password",
              email_verified: true,
              workspace_name: "Moosewave Demo",
              workspace_slug: "postwave-demo",
            }
          : pathname === "/api/v1/me"
            ? {
                user: "visual-test@example.invalid",
                tenant: "00000000-0000-4000-8000-000000000099",
              }
            : pathname.endsWith("/health")
              ? {
                  service: "postwave-api",
                  status: "ok",
                  version: "demo-sweep",
                }
              : {};
      const onEvent = args?.onEvent as
        | {
            onmessage?: (
              event:
                | number[]
                | { event: "complete" | "error"; message?: string },
            ) => void;
          }
        | undefined;
      queueMicrotask(() => {
        onEvent?.onmessage?.(
          Array.from(new TextEncoder().encode(JSON.stringify(payload))),
        );
        onEvent?.onmessage?.({ event: "complete" });
      });
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      };
    };
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);

  for (const section of PRIMARY_DESKTOP_SECTIONS) {
    activeSection.value = section.id;
    if (section.id !== "dashboard") {
      await navigateToSection(page, section.id);
    }

    const main = page.locator("#main-content");
    if ((await main.count()) === 0) {
      findings.push({
        section: section.id,
        detail: "application shell crashed before the page could render",
      });
      break;
    }
    const initialErrors = await main
      .locator('[data-remote-state="initial-error"]')
      .allInnerTexts();
    for (const detail of initialErrors) {
      findings.push({
        section: section.id,
        detail: detail.trim().slice(0, 500),
      });
    }

    const text = await main.innerText();
    const contractFailure = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => CONTRACT_FAILURE.test(line));
    if (contractFailure) {
      findings.push({
        section: section.id,
        detail: contractFailure.slice(0, 500),
      });
    }

    const crashed = await main
      .locator('.pw-screen[role="alert"]', { hasText: "Something went wrong" })
      .count();
    if (crashed > 0) {
      findings.push({ section: section.id, detail: "render error boundary" });
    }
  }

  expect(
    findings,
    `Demo read-contract failures:\n${JSON.stringify(findings, null, 2)}`,
  ).toEqual([]);
});
