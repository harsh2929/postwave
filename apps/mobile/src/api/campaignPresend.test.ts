/**
 * The transport seam for the pre-send check services: exact methods, exact
 * paths (ids encoded), exact wire bodies. These are the requests the
 * routeauth manifest rows were verified against — a drifted path here 404s
 * in production while every parser test stays green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPresendRefine,
  getPresendRefine,
  postPresendRefine,
  renderAcrossClients,
  renderEmailPreview,
  requestPresendVerdict,
  runA11yCheck,
} from "./campaignPresend";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: {}, error: null });
});

describe("pre-send transport", () => {
  it("email preview: POST /api/v1/email-preview/render with {mjml}", async () => {
    await renderEmailPreview({ mjml: "<p>x</p>" });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/email-preview/render",
      { mjml: "<p>x</p>" },
    );
  });

  it("cross-client: POST /api/v1/render with {html}", async () => {
    await renderAcrossClients("<p>x</p>");
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/render", {
      html: "<p>x</p>",
    });
  });

  it("a11y: POST /api/v1/a11y/check, subject only when present", async () => {
    await runA11yCheck({ html: "<p>x</p>" });
    expect(rawRequest).toHaveBeenLastCalledWith("POST", "/api/v1/a11y/check", {
      html: "<p>x</p>",
    });
    await runA11yCheck({ html: "<p>x</p>", subject: "s" });
    expect(rawRequest).toHaveBeenLastCalledWith("POST", "/api/v1/a11y/check", {
      html: "<p>x</p>",
      subject: "s",
    });
  });

  it("verdict: POST /api/v1/presend/verdict with the snake_case body", async () => {
    await requestPresendVerdict({
      subject: "s",
      html: "<p>x</p>",
      from: "Acme news@acme.com",
      campaignId: "c1",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/presend/verdict",
      { subject: "s", html: "<p>x</p>", from: "Acme news@acme.com", campaign_id: "c1" },
    );
  });

  it("refine: GET/POST/DELETE on …/{id}/presend-refine, id ENCODED", async () => {
    await getPresendRefine("c 1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/campaigns/c%201/presend-refine",
    );
    await postPresendRefine("c1", { churnThreshold: 80, dryRun: true });
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/campaigns/c1/presend-refine",
      { churn_threshold: 80, dry_run: true },
    );
    await clearPresendRefine("c1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "DELETE",
      "/api/v1/campaigns/c1/presend-refine",
    );
  });
});
