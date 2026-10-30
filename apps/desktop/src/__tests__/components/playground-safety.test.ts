import { describe, expect, it } from "vitest";

import {
  classifyPlaygroundEnvironment,
  classifyPlaygroundRequestRisk,
  historyBody,
  isSensitivePlaygroundHeader,
  playgroundConfirmationPhrase,
} from "../../components/playground/playground-safety";

describe("API Playground safety boundary", () => {
  it("classifies only explicit local and non-production hosts less severely", () => {
    expect(classifyPlaygroundEnvironment("http://localhost:8080").kind).toBe(
      "local",
    );
    expect(
      classifyPlaygroundEnvironment("https://api.staging.example.com").kind,
    ).toBe("non-production");
    expect(classifyPlaygroundEnvironment("https://api.example.com").kind).toBe(
      "production",
    );
    expect(classifyPlaygroundEnvironment("not a URL").kind).toBe("production");
    expect(
      classifyPlaygroundEnvironment("https://contest.example.com").kind,
    ).toBe("production");
  });

  it("escalates DELETE and high-consequence mutation paths", () => {
    expect(classifyPlaygroundRequestRisk("GET", "/api/v1/campaigns")).toBe(
      "read",
    );
    expect(classifyPlaygroundRequestRisk("POST", "/api/v1/lists")).toBe(
      "mutation",
    );
    expect(
      classifyPlaygroundRequestRisk("POST", "/api/v1/campaigns/{id}/send"),
    ).toBe("destructive");
    expect(classifyPlaygroundRequestRisk("DELETE", "/api/v1/lists/1")).toBe(
      "destructive",
    );
    expect(playgroundConfirmationPhrase("delete", "/api/v1/lists/1")).toBe(
      "DELETE /api/v1/lists/1",
    );
  });

  it("blocks secret-bearing custom headers and never persists request bodies", () => {
    expect(isSensitivePlaygroundHeader("Authorization")).toBe(true);
    expect(isSensitivePlaygroundHeader("X-Customer-Token")).toBe(true);
    expect(isSensitivePlaygroundHeader("X-Debug-Mode")).toBe(false);
    expect(historyBody('{"password":"secret"}')).toEqual({
      body: "",
      bodyOmitted: true,
    });
    expect(historyBody(" ")).toEqual({ body: "", bodyOmitted: false });
  });
});
