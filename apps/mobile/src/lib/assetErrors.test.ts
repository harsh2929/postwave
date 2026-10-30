/**
 * Every refusal this surface can receive, and how hard the delete confirm gets.
 *
 * The upload endpoint collapses three genuinely different failures into one
 * `validation_failed` code, so these tests exist mostly to prove the second
 * level of branching survives — and that a Go sentinel never reaches a person.
 */
import { describe, expect, it } from "vitest";

import {
  assetDeleteErrorMessage,
  assetDeletePrompt,
  assetUploadErrorMessage,
  isAssetReferencedError,
} from "./assetErrors";

function tagged(code: string, message: string, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

describe("assetUploadErrorMessage", () => {
  it("splits the THREE refusals that share the validation_failed code", () => {
    expect(
      assetUploadErrorMessage(
        tagged("validation_failed", "assets: exceeds max size"),
        "fallback",
      ),
    ).toContain("too large");
    expect(
      assetUploadErrorMessage(
        tagged("validation_failed", "assets: not a recognised image"),
        "fallback",
      ),
    ).toContain("couldn't read that as an image");
    expect(
      assetUploadErrorMessage(
        tagged("validation_failed", "assets: empty body"),
        "fallback",
      ),
    ).toContain("arrived empty");
  });

  it("never puts a raw Go sentinel in front of an operator", () => {
    for (const sentinel of [
      "assets: exceeds max size",
      "assets: not a recognised image",
      "assets: empty body",
    ]) {
      expect(
        assetUploadErrorMessage(tagged("validation_failed", sentinel), "f"),
      ).not.toContain("assets:");
    }
  });

  it("still says something useful for an unrecognised validation text", () => {
    const message = assetUploadErrorMessage(
      tagged("validation_failed", "assets: some future rule"),
      "f",
    );
    expect(message).toContain("PNG, JPEG, GIF and WebP");
    expect(message).not.toContain("assets:");
  });

  it("explains an unconfigured storage backend as configuration, not fault", () => {
    expect(
      assetUploadErrorMessage(
        tagged("storage_unavailable", "asset storage is not configured", 503),
        "fallback",
      ),
    ).toContain("no asset storage configured");
    expect(
      assetUploadErrorMessage(
        tagged("repo_unavailable", "asset repository is not configured", 503),
        "fallback",
      ),
    ).toContain("no asset storage configured");
  });

  it("names the ceiling for both ways the server reports oversize", () => {
    // 413 `payload_too_large` fires before parsing; 422 fires after decoding.
    expect(
      assetUploadErrorMessage(
        tagged("payload_too_large", "asset JSON upload exceeds", 413),
        "f",
      ),
    ).toContain("10 MB");
    expect(
      assetUploadErrorMessage(Object.assign(new Error("x"), { status: 413 }), "f"),
    ).toContain("10 MB");
  });

  it("falls back to status when the server sent no code", () => {
    expect(
      assetUploadErrorMessage(Object.assign(new Error("x"), { status: 403 }), "f"),
    ).toContain("role");
    expect(
      assetUploadErrorMessage(Object.assign(new Error("x"), { status: 401 }), "f"),
    ).toContain("session expired");
    expect(
      assetUploadErrorMessage(Object.assign(new Error("x"), { status: 500 }), "f"),
    ).toContain("couldn't store");
  });

  it("uses the caller's fallback only when there is nothing else to say", () => {
    expect(assetUploadErrorMessage(null, "fallback sentence")).toBe(
      "fallback sentence",
    );
  });
});

describe("assetDeleteErrorMessage / isAssetReferencedError", () => {
  it("recognises the 409 the server uses to protect live drafts", () => {
    const conflict = tagged("has_references", "asset is used by live drafts", 409);
    expect(isAssetReferencedError(conflict)).toBe(true);
    expect(assetDeleteErrorMessage(conflict, "f")).toContain("live drafts");
  });

  it("recognises a bare 409 even without the code", () => {
    expect(
      isAssetReferencedError(Object.assign(new Error("conflict"), { status: 409 })),
    ).toBe(true);
  });

  it("does not mistake an ordinary failure for a reference conflict", () => {
    const boom = Object.assign(new Error("boom"), { status: 500 });
    expect(isAssetReferencedError(boom)).toBe(false);
    expect(assetDeleteErrorMessage(boom, "f")).toContain("couldn't delete");
  });

  it("reads a 404 as already gone, not as a failure to act on", () => {
    expect(
      assetDeleteErrorMessage(Object.assign(new Error("x"), { status: 404 }), "f"),
    ).toContain("already gone");
  });
});

describe("assetDeletePrompt — the escalation mirrors the server's 409", () => {
  it("keeps an unreferenced delete to an ordinary confirm", () => {
    const prompt = assetDeletePrompt("hero.png", 0);
    expect(prompt.title).toContain("hero.png");
    expect(prompt.confirmLabel).toBe("Delete");
    expect(prompt.confirmPhrase).toBeUndefined();
    expect(prompt.destructive).toBe(true);
  });

  it("demands the file name typed when live drafts still use it", () => {
    const prompt = assetDeletePrompt("hero.png", 3);
    expect(prompt.confirmPhrase).toBe("hero.png");
    expect(prompt.confirmLabel).toBe("Delete anyway");
    expect(prompt.message).toContain("3 live campaigns");
    expect(prompt.message).toContain("scheduled to send");
  });

  it("says '1 live campaign' rather than '1 live campaigns'", () => {
    expect(assetDeletePrompt("a.png", 1).message).toContain(
      "1 live campaign, template or form",
    );
  });

  it("treats an UNKNOWN count as referenced, which is the safe direction", () => {
    // The cheap confirm on a used image costs a live send; the expensive one
    // on an unused image costs a few seconds.
    const prompt = assetDeletePrompt("a.png", null);
    expect(prompt.confirmPhrase).toBe("a.png");
    expect(prompt.message).toContain("couldn't confirm");
  });

  it("never asks for an empty phrase when the file has no name", () => {
    const prompt = assetDeletePrompt("   ", 2);
    expect(prompt.confirmPhrase).toBe("this image");
  });
});
