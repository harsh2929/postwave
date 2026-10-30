import { describe, expect, it } from "vitest";

import {
  buildReceiverAuthConfig,
  createReceiverAuthDraft,
  receiverAuthDraftIsDirty,
  validateReceiverAuthDraft,
} from "../../components/webhooks/ReceiverAuthFields";

describe("receiver authentication draft contract", () => {
  it("distinguishes preserve, clear, and a complete replacement", () => {
    const preserve = createReceiverAuthDraft("preserve");
    const clear = createReceiverAuthDraft("none");
    const bearer = {
      ...createReceiverAuthDraft("bearer"),
      bearerToken: "receiver-token",
    };

    expect(receiverAuthDraftIsDirty(preserve)).toBe(false);
    expect(receiverAuthDraftIsDirty(clear)).toBe(false);
    expect(receiverAuthDraftIsDirty(bearer)).toBe(true);
    expect(buildReceiverAuthConfig(preserve)).toBeUndefined();
    expect(buildReceiverAuthConfig(clear)).toBeNull();
    expect(buildReceiverAuthConfig(bearer)).toEqual({
      type: "bearer",
      bearer_token: "receiver-token",
    });
  });

  it("rejects incomplete, reserved, duplicate, and conflicting headers", () => {
    const incomplete = createReceiverAuthDraft("headers");
    expect(validateReceiverAuthDraft(incomplete)).toContain(
      "complete custom header",
    );

    const reserved = {
      ...incomplete,
      headers: [
        {
          id: "one",
          name: "X-Postwave-Signature",
          value: "replace-me",
        },
      ],
    };
    expect(validateReceiverAuthDraft(reserved)).toContain("owned by Moosewave");

    const duplicate = {
      ...incomplete,
      headers: [
        { id: "one", name: "X-Api-Key", value: "one" },
        { id: "two", name: "x-api-key", value: "two" },
      ],
    };
    expect(validateReceiverAuthDraft(duplicate)).toContain(
      "configured more than once",
    );

    const conflict = {
      ...createReceiverAuthDraft("combined"),
      bearerToken: "bearer",
      headers: [
        { id: "one", name: "Authorization", value: "Basic credential" },
      ],
      mtlsCertPEM: "-----BEGIN CERTIFICATE-----\ncertificate",
      mtlsKeyPEM: "-----BEGIN PRIVATE KEY-----\nkey",
    };
    expect(validateReceiverAuthDraft(conflict)).toContain(
      "either the Bearer token field",
    );
  });

  it("requires a complete PEM pair and enforces the encrypted-size ceiling", () => {
    const mtls = createReceiverAuthDraft("mtls");
    expect(validateReceiverAuthDraft(mtls)).toContain(
      "both the certificate chain",
    );

    const malformed = {
      ...mtls,
      mtlsCertPEM: "certificate",
      mtlsKeyPEM: "private key",
    };
    expect(validateReceiverAuthDraft(malformed)).toContain("PEM encoded");

    const oversized = {
      ...createReceiverAuthDraft("bearer"),
      bearerToken: "x".repeat(70 * 1024),
    };
    expect(validateReceiverAuthDraft(oversized)).toContain("64 KiB");
  });

  it("builds a bounded custom-header replacement without retaining blank rows", () => {
    const draft = {
      ...createReceiverAuthDraft("headers"),
      headers: [
        { id: "one", name: " X-Api-Key ", value: " secret " },
        { id: "blank", name: "", value: "" },
      ],
    };

    expect(validateReceiverAuthDraft(draft)).toBeNull();
    expect(buildReceiverAuthConfig(draft)).toEqual({
      type: "headers",
      headers: { "X-Api-Key": "secret" },
    });
  });
});
