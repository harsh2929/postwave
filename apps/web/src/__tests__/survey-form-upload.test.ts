import { describe, expect, it } from "vitest";

import {
  normalizePublicUploadPresignResponse,
  safePresignedUploadURL,
} from "../lib/public-upload-presign";
import { validatePublicUpload } from "../lib/public-upload-validation";
import type { FormField } from "../lib/forms-types";

const field: FormField = {
  id: "brief",
  kind: "file_upload",
  label: "Brief",
  required: false,
};

describe("SurveyForm public upload validation", () => {
  it("rejects files over the platform hard cap before presign", () => {
    const file = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 26 * 1024 * 1024 });

    expect(validatePublicUpload(field, file)).toContain(
      "Maximum size is 25 MB",
    );
  });

  it("honors tighter per-field maxBytes", () => {
    const file = new File(["x"], "brief.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 2 * 1024 * 1024 });

    expect(
      validatePublicUpload({ ...field, maxBytes: 1024 * 1024 }, file),
    ).toContain("Maximum size is 1 MB");
  });

  it("rejects MIME types outside the configured allowlist", () => {
    const file = new File(["x"], "brief.exe", {
      type: "application/x-msdownload",
    });

    expect(
      validatePublicUpload(
        { ...field, acceptMime: ["application/pdf", "text/plain"] },
        file,
      ),
    ).toContain("File type is not allowed");
  });

  it("rejects empty files before presign", () => {
    const file = new File([], "empty.txt", { type: "text/plain" });

    expect(validatePublicUpload(field, file)).toContain("File is empty");
  });

  it("uses the platform MIME allowlist even when a field omits acceptMime", () => {
    const file = new File(["x"], "brief.exe", {
      type: "application/x-msdownload",
    });

    expect(validatePublicUpload(field, file)).toContain(
      "File type is not allowed",
    );
  });

  it("intersects field MIME settings with the platform allowlist", () => {
    const file = new File(["x"], "brief.html", { type: "text/html" });

    expect(
      validatePublicUpload({ ...field, acceptMime: ["text/html"] }, file),
    ).toContain("no supported file types");
  });

  it("accepts files within size and MIME constraints", () => {
    const file = new File(["hello"], "brief.txt", { type: "text/plain" });

    expect(
      validatePublicUpload(
        { ...field, maxBytes: 1024, acceptMime: ["text/plain"] },
        file,
      ),
    ).toBeNull();
  });
});

describe("SurveyForm public upload presign response", () => {
  it("requires every presign field before starting the upload", () => {
    expect(() =>
      normalizePublicUploadPresignResponse({
        upload_id: "upl_1",
        put_url: "https://uploads.example.com/object",
      }),
    ).toThrow(/incomplete/i);
  });

  it("accepts only the signed S3 PUT header allowlist", () => {
    expect(
      normalizePublicUploadPresignResponse({
        upload_id: "upl_1",
        put_url: "https://uploads.example.com/object",
        field_value: "upl_1",
        put_headers: {
          "Content-Type": "application/pdf",
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:test",
        },
      }).put_headers,
    ).toEqual({
      "Content-Type": "application/pdf",
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:test",
    });
    expect(() =>
      normalizePublicUploadPresignResponse({
        upload_id: "upl_1",
        put_url: "https://uploads.example.com/object",
        field_value: "upl_1",
        put_headers: { Authorization: "Bearer injected" },
      }),
    ).toThrow(/invalid PUT headers/i);
  });

  it("accepts HTTPS and local development upload URLs only", () => {
    expect(
      safePresignedUploadURL("https://uploads.example.com/object#frag"),
    ).toBe("https://uploads.example.com/object");
    expect(safePresignedUploadURL("http://localhost:9000/object")).toBe(
      "http://localhost:9000/object",
    );
    expect(safePresignedUploadURL("/api/internal/uploads/tenant%2Ffile")).toBe(
      "/api/internal/uploads/tenant%2Ffile",
    );
    expect(
      safePresignedUploadURL("http://uploads.example.com/object"),
    ).toBeNull();
    expect(
      safePresignedUploadURL("https://u:p@uploads.example.com/object"),
    ).toBeNull();
    expect(
      safePresignedUploadURL("/api/internal/uploads/../secret"),
    ).toBeNull();
    expect(safePresignedUploadURL("//uploads.example.com/object")).toBeNull();
    expect(
      safePresignedUploadURL("https://uploads.example.com/object\nx"),
    ).toBeNull();
    expect(safePresignedUploadURL("javascript:alert(1)")).toBeNull();
  });
});
