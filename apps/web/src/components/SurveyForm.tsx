// SPDX-License-Identifier: AGPL-3.0-only
//
// Multi-step survey renderer for forms that contain `step_break`
// fields. The plain-HTML compileFormHtml output is the fallback for
// JS-off / embed users; this component is only mounted on the hosted
// public page where we already require JS for nicer UX.
//
// Submission shape stays identical to the single-step form: a normal
// POST to /api/public/forms/:slug/submit with email + cf_* fields.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

import {
  chunkFieldsByStep,
  normalizeScaleRange,
  safeCustomFieldKey,
  type FormField,
  type FormRenderModel,
} from "@/lib/forms-types";
import {
  normalizePublicUploadPresignResponse,
  safePresignedUploadURL,
} from "@/lib/public-upload-presign";
import { publicUploadValidationIssue } from "@/lib/public-upload-validation";
import {
  mintSubmissionAttemptID,
  postPublicForm,
  publicFormSuccessURL,
  resetPublicFormCaptcha,
  SUBMISSION_ATTEMPT_FIELD,
} from "@/lib/public-form-submission";

interface Props {
  form: FormRenderModel;
  actionUrl: string;
}

const PUBLIC_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_UPLOAD_PRESIGN_BYTES = 32 * 1024;

// UploadState tracks an in-flight or completed file_upload field. It's
// keyed by the field's submit-name (cf_<key>) so the Next-button gate
// can quickly tell whether all required uploads finished.
type UploadState = {
  filename: string;
  progress: number; // 0..100
  state: "uploading" | "done" | "error";
  error?: string;
};

export function SurveyForm({ form, actionUrl }: Props) {
  const tCommon = useTranslations("common");
  const tForms = useTranslations("forms");
  const formRef = useRef<HTMLFormElement>(null);
  const stepRegionRef = useRef<HTMLDivElement>(null);
  const uploadGenerationRef = useRef<Record<string, number>>({});
  const activeUploadsRef = useRef<Record<string, XMLHttpRequest>>({});
  const submitInFlightRef = useRef(false);
  const steps = useMemo(
    () => chunkFieldsByStep(form.structure.fields),
    [form.structure.fields],
  );
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [showValidation, setShowValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionAttemptID, setSubmissionAttemptID] = useState("");
  const [submitError, setSubmitError] = useState("");

  const isLast = step === steps.length - 1;
  const current = steps[step] ?? [];

  useEffect(
    () => () => {
      for (const xhr of Object.values(activeUploadsRef.current)) xhr.abort();
      activeUploadsRef.current = {};
    },
    [],
  );

  useEffect(() => {
    if (!submissionAttemptID) {
      setSubmissionAttemptID(mintSubmissionAttemptID());
    }
  }, [submissionAttemptID]);

  const rotateSubmissionAttempt = () => {
    const next = mintSubmissionAttemptID();
    if (next) setSubmissionAttemptID(next);
  };

  const setField = (name: string, val: string) => {
    rotateSubmissionAttempt();
    setShowValidation(false);
    setSubmitError("");
    setValues((prev) => ({ ...prev, [name]: val }));
  };

  const validateStep = () => {
    for (const f of current) {
      const name = nameOf(f);
      if (!name) continue;
      // file_upload: gate on upload completion regardless of required —
      // an in-flight upload would arrive at the server as a stale id.
      if (f.kind === "file_upload") {
        const u = uploads[name];
        if (f.required && (!u || u.state !== "done")) return false;
        if (u && u.state === "uploading") return false;
        continue;
      }
      if (!f.required) continue;
      if (!values[name] || !values[name].trim()) return false;
    }
    return formRef.current
      ? [
          ...formRef.current.querySelectorAll<
            HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
          >("input, select, textarea"),
        ].every((control) => control.checkValidity())
      : true;
  };

  const focusFirstInvalid = () => {
    requestAnimationFrame(() => {
      const invalid = formRef.current
        ? [
            ...formRef.current.querySelectorAll<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >("input, select, textarea"),
          ].find((control) => !control.checkValidity())
        : undefined;
      if (
        invalid instanceof HTMLInputElement ||
        invalid instanceof HTMLSelectElement ||
        invalid instanceof HTMLTextAreaElement
      ) {
        invalid.reportValidity();
      }
      invalid?.focus();
    });
  };

  const revealValidation = () => {
    setShowValidation(true);
    focusFirstInvalid();
  };

  const next = () => {
    if (!validateStep()) {
      revealValidation();
      return;
    }
    setShowValidation(false);
    setStep((s) => Math.min(s + 1, steps.length - 1));
    requestAnimationFrame(() => stepRegionRef.current?.focus());
  };
  const prev = () => {
    setShowValidation(false);
    setStep((s) => Math.max(s - 1, 0));
    requestAnimationFrame(() => stepRegionRef.current?.focus());
  };

  // startUpload runs the presign + PUT dance for a file_upload field.
  // The field name (cf_<key>) is used as the key for both the values
  // map (so the eventual form POST carries the upload id) and the
  // uploads map (so the UI shows progress).
  const startUpload = async (name: string, field: FormField, file: File) => {
    rotateSubmissionAttempt();
    setSubmitError("");
    const attempt = (uploadGenerationRef.current[name] ?? 0) + 1;
    uploadGenerationRef.current[name] = attempt;
    activeUploadsRef.current[name]?.abort();
    delete activeUploadsRef.current[name];
    const validationIssue = publicUploadValidationIssue(field, file);
    if (validationIssue) {
      const validationMessage =
        validationIssue.code === "empty"
          ? tForms("upload_empty")
          : validationIssue.code === "too_large"
            ? tForms("upload_too_large", { max: validationIssue.max })
            : validationIssue.code === "no_supported_types"
              ? tForms("upload_no_supported_types")
              : tForms("upload_type_not_allowed", {
                  accepted: validationIssue.accepted,
                });
      setValues((prev) => ({ ...prev, [name]: "" }));
      setUploads((prev) => ({
        ...prev,
        [name]: {
          filename: file.name,
          progress: 0,
          state: "error",
          error: validationMessage,
        },
      }));
      return;
    }
    setUploads((prev) => ({
      ...prev,
      [name]: { filename: file.name, progress: 0, state: "uploading" },
    }));
    setValues((prev) => ({ ...prev, [name]: "" }));
    try {
      const presignRes = await fetchWithTimeout(
        `/api/public/forms/${encodeURIComponent(form.slug)}/upload-url`,
        {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
          }),
        },
      );
      if (!presignRes.ok) {
        throw new Error(`presign failed (${presignRes.status})`);
      }
      const presign = normalizePublicUploadPresignResponse(
        await readJsonLimited(presignRes, MAX_PUBLIC_UPLOAD_PRESIGN_BYTES),
      );
      if (uploadGenerationRef.current[name] !== attempt) return;

      const putURL = safePresignedUploadURL(presign.put_url);
      if (!putURL) {
        throw new Error("upload destination was not trusted");
      }
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeUploadsRef.current[name] = xhr;
        xhr.open("PUT", putURL, true);
        xhr.withCredentials = false;
        xhr.timeout = PUBLIC_UPLOAD_TIMEOUT_MS;
        const signedContentType = Object.keys(presign.put_headers).some(
          (name) => name.toLowerCase() === "content-type",
        );
        for (const [name, value] of Object.entries(presign.put_headers)) {
          xhr.setRequestHeader(name, value);
        }
        if (!signedContentType && file.type) {
          xhr.setRequestHeader("Content-Type", file.type);
        }
        xhr.upload.onprogress = (ev) => {
          if (uploadGenerationRef.current[name] !== attempt) return;
          if (!ev.lengthComputable) return;
          const pct = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
          setUploads((prev) => ({
            ...prev,
            [name]: {
              ...(prev[name] ?? {
                filename: file.name,
                progress: 0,
                state: "uploading",
              }),
              progress: pct,
            },
          }));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("upload network error"));
        xhr.ontimeout = () => reject(new Error("upload timed out"));
        xhr.onabort = () => reject(new Error("upload canceled"));
        xhr.send(file);
      });

      if (uploadGenerationRef.current[name] !== attempt) return;
      setUploads((prev) => ({
        ...prev,
        [name]: { filename: file.name, progress: 100, state: "done" },
      }));
      setValues((prev) => ({ ...prev, [name]: presign.field_value }));
    } catch {
      if (uploadGenerationRef.current[name] !== attempt) return;
      setUploads((prev) => ({
        ...prev,
        [name]: {
          filename: file.name,
          progress: 0,
          state: "error",
          error: tForms("upload_failed_retry"),
        },
      }));
    } finally {
      if (uploadGenerationRef.current[name] === attempt) {
        delete activeUploadsRef.current[name];
      }
    }
  };

  return (
    <form
      ref={formRef}
      method="POST"
      action={actionUrl}
      onSubmit={async (event) => {
        if (!validateStep()) {
          event.preventDefault();
          revealValidation();
          return;
        }
        if (!submissionAttemptID) {
          // Crypto/JS initialization failure degrades to the ordinary native POST.
          // The server intentionally performs local-only verification without a
          // token, so progressive enhancement never makes signup unavailable.
          setSubmitting(true);
          return;
        }
        event.preventDefault();
        if (submitInFlightRef.current) return;
        const target = event.currentTarget;
        submitInFlightRef.current = true;
        setSubmitting(true);
        setSubmitError("");
        const outcome = await postPublicForm(actionUrl, target);
        submitInFlightRef.current = false;
        setSubmitting(false);
        if (outcome.kind === "uncertain") {
          // Do not rotate: the paid provider may already have seen this intent.
          // The form itself loaded fine, so say the SUBMISSION failed and
          // that trying again is the way forward.
          resetPublicFormCaptcha(target);
          setSubmitError(tForms("submit_unavailable_body"));
          return;
        }
        rotateSubmissionAttempt();
        if (outcome.kind === "rejected") {
          resetPublicFormCaptcha(target);
          setSubmitError(outcome.message);
          return;
        }
        window.location.assign(
          publicFormSuccessURL(form.slug, outcome.state, outcome.redirect),
        );
      }}
      aria-busy={submitting}
      className="postwave-survey space-y-4"
    >
      <p
        id="survey-step-progress"
        className="text-xs font-medium text-muted-foreground"
        aria-live="polite"
      >
        {tForms("step_progress", { step: step + 1, total: steps.length })}
      </p>
      <div
        ref={stepRegionRef}
        role="group"
        tabIndex={-1}
        aria-labelledby="survey-step-progress"
        className="space-y-4 outline-none"
      >
        {current.map((f) => {
          const n = nameOf(f);
          return (
            <SurveyField
              key={f.id}
              field={f}
              value={values[n ?? ""] ?? ""}
              upload={n ? uploads[n] : undefined}
              onChange={(v) => {
                if (n) setField(n, v);
              }}
              onFile={(file) => {
                if (n) void startUpload(n, f, file);
              }}
              onClearFile={() => {
                if (!n) return;
                rotateSubmissionAttempt();
                setSubmitError("");
                uploadGenerationRef.current[n] =
                  (uploadGenerationRef.current[n] ?? 0) + 1;
                activeUploadsRef.current[n]?.abort();
                delete activeUploadsRef.current[n];
                setValues((prev) => ({ ...prev, [n]: "" }));
                setUploads((prev) => {
                  const nextUploads = { ...prev };
                  delete nextUploads[n];
                  return nextUploads;
                });
              }}
            />
          );
        })}
        {/* On the LAST step, also serialize all prior-step values as
            hidden inputs so the gateway sees the full submission. */}
        {isLast &&
          steps
            .slice(0, step)
            .flat()
            .map((f) => {
              const n = nameOf(f);
              if (!n) return null;
              return (
                <input
                  key={`hidden-${f.id}`}
                  type="hidden"
                  name={n}
                  value={values[n] ?? ""}
                />
              );
            })}
        <input
          type="hidden"
          name={SUBMISSION_ATTEMPT_FIELD}
          value={submissionAttemptID}
          readOnly
        />
      </div>
      <p
        id="survey-required-hint"
        role={showValidation ? "alert" : undefined}
        className={showValidation ? "text-sm text-destructive" : "sr-only"}
      >
        {tForms("complete_required")}
      </p>
      {submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      {isLast && form.captchaRequired && form.recaptchaSiteKey ? (
        <div
          tabIndex={0}
          className="flex justify-end overflow-x-auto py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div
            className="g-recaptcha"
            data-sitekey={form.recaptchaSiteKey}
            data-size="compact"
          />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 pt-2">
        {step > 0 && (
          <Button
            type="button"
            onClick={prev}
            variant="outline"
            className="min-h-11"
          >
            {tCommon("back")}
          </Button>
        )}
        <div className="flex-1" />
        {!isLast ? (
          <Button
            type="button"
            onClick={(event) => {
              // React reuses this DOM node when advancing to the final step,
              // where it becomes the submit button. Cancel the activation's
              // default action before that synchronous type change, otherwise
              // browsers can submit the form during the same click that was
              // only meant to reveal the last step.
              event.preventDefault();
              next();
            }}
            aria-describedby="survey-required-hint"
            className="min-h-11"
          >
            {tCommon("next")}
          </Button>
        ) : (
          <Button
            type="submit"
            loading={submitting}
            disabled={submitting}
            aria-describedby="survey-required-hint"
            className="min-h-11"
          >
            {tCommon("submit")}
          </Button>
        )}
      </div>
    </form>
  );
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number = PUBLIC_UPLOAD_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      credentials: "omit",
      redirect: "error",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonLimited(
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("upload presign response was too large");
  }

  let text = "";
  if (!res.body) {
    const read = res.text.bind(res);
    text = await read();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("upload presign response was too large");
    }
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("upload presign response was too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text.trim()) {
    throw new Error("upload presign returned an empty response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A proxy, WAF, or CDN in front of the API answers non-JSON (an HTML error
    // page) often enough to matter. startUpload renders err.message straight
    // into the field error, so letting the raw SyntaxError through would show a
    // subscriber `Unexpected token '<', "<html>..." is not valid JSON`.
    throw new Error("upload could not be prepared — please try again");
  }
}

function nameOf(f: FormField): string | null {
  switch (f.kind) {
    case "email":
      return "email";
    case "name":
      return "name";
    case "checkbox":
      return "consent";
    case "honeypot":
      return "website";
    case "text":
    case "heading":
    case "submit":
    case "step_break":
      return null;
    default:
      return `cf_${safeCustomFieldKey(f.customKey ?? f.id)}`;
  }
}

function fieldDomId(field: FormField, name: string): string {
  const raw = `${field.id || name}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `postwave-field-${safe || "field"}`;
}

function SurveyField({
  field,
  value,
  upload,
  onChange,
  onFile,
  onClearFile,
}: {
  field: FormField;
  value: string;
  upload?: UploadState;
  onChange: (v: string) => void;
  onFile: (file: File) => void;
  onClearFile: () => void;
}) {
  const tForms = useTranslations("forms");
  if (field.kind === "heading")
    return (
      <h2 className="break-words text-lg font-semibold tracking-tight">
        {field.content ?? field.label}
      </h2>
    );
  if (field.kind === "text")
    return (
      <p className="text-sm text-muted-foreground">
        {field.content ?? field.label}
      </p>
    );
  if (field.kind === "submit") return null;
  if (field.kind === "honeypot")
    return (
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ position: "absolute", left: -9999, opacity: 0 }}
      />
    );

  const name = nameOf(field) ?? field.id;
  const label = (
    <span className="block text-sm font-medium">
      {field.label}
      {field.required && " *"}
    </span>
  );

  if (field.kind === "long_text") {
    return (
      <label className="block space-y-1">
        {label}
        <textarea
          name={name}
          rows={4}
          required={field.required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-28 w-full resize-y rounded-md border bg-background p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-sm"
          placeholder={field.placeholder ?? ""}
        />
      </label>
    );
  }
  if (field.kind === "select") {
    const options = field.options ?? [];
    return (
      <label className="block space-y-1">
        {label}
        <select
          name={name}
          required={field.required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-sm"
        >
          <option value="">{tForms("select_placeholder")}</option>
          {options.map((o) => (
            <option key={o.value ?? o.label} value={o.value ?? o.label}>
              {o.label}
            </option>
          ))}
        </select>
        {options.length === 0 ? (
          <span role="alert" className="block text-xs text-destructive">
            {tForms("no_options")}
          </span>
        ) : null}
      </label>
    );
  }
  if (field.kind === "radio") {
    const options = field.options ?? [];
    return (
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          {field.label}
          {field.required && " *"}
        </legend>
        {options.map((o) => {
          const v = o.value ?? o.label;
          return (
            <label
              key={v}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring"
            >
              <input
                type="radio"
                name={name}
                value={v}
                required={field.required}
                checked={value === v}
                onChange={() => onChange(v)}
              />
              {o.label}
            </label>
          );
        })}
        {options.length === 0 ? (
          <p role="alert" className="text-xs text-destructive">
            {tForms("no_options")}
          </p>
        ) : null}
      </fieldset>
    );
  }
  if (field.kind === "scale") {
    // Shared with the published-HTML renderer so both agree on what a stored
    // range means; an inverted one would otherwise loop zero times and leave
    // this required question with nothing to select.
    const { min, max } = normalizeScaleRange(field.scaleMin, field.scaleMax);
    const items: number[] = [];
    for (let n = min; n <= max; n++) items.push(n);
    return (
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          {field.label}
          {field.required && " *"}
        </legend>
        <div className="flex flex-wrap gap-1 sm:gap-2">
          {items.map((n) => (
            <label
              key={n}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-md border px-2 text-sm hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring"
            >
              <input
                type="radio"
                name={name}
                value={String(n)}
                required={field.required}
                checked={value === String(n)}
                onChange={() => onChange(String(n))}
              />
              {n}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "file_upload") {
    const accept = (field.acceptMime ?? []).join(",");
    const fieldId = fieldDomId(field, name);
    const progressId = `${fieldId}-progress`;
    const statusId = `${fieldId}-status`;
    const errorId = `${fieldId}-error`;
    const describedBy = [
      upload && upload.state !== "error" ? progressId : null,
      upload && upload.state !== "error" ? statusId : null,
      upload?.state === "error" ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="space-y-2">
        <label htmlFor={fieldId} className="block text-sm font-medium">
          {field.label}
          {field.required && " *"}
        </label>
        {(!upload || upload.state === "error") && (
          <input
            id={fieldId}
            type="file"
            accept={accept || undefined}
            required={field.required && !value}
            aria-describedby={describedBy || undefined}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
            className="block min-h-11 w-full cursor-pointer rounded-md border bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        )}
        {upload && upload.state !== "error" && (
          <div className="space-y-1 rounded-md border p-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="truncate" title={upload.filename}>
                {upload.filename}
              </span>
              <Button
                type="button"
                onClick={onClearFile}
                variant="link"
                size="sm"
                className="min-h-11 shrink-0 px-2"
              >
                {tForms("upload_reupload")}
              </Button>
            </div>
            <div
              id={progressId}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={upload.progress}
              aria-valuetext={
                upload.state === "done"
                  ? tForms("upload_complete")
                  : tForms("upload_progress", { progress: upload.progress })
              }
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${upload.progress}%` }}
              />
            </div>
            <div
              id={statusId}
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {upload.state === "done"
                ? tForms("uploaded")
                : tForms("upload_progress", { progress: upload.progress })}
            </div>
          </div>
        )}
        {upload?.state === "error" && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {upload.error ?? tForms("upload_failed_retry")}
          </p>
        )}
        {/* The actual form value is the upload id (when done). We
            render it as a hidden input on the LAST step via the
            existing `values` flatten in the wizard. */}
        <input
          type="hidden"
          name={`cf_${safeCustomFieldKey(field.customKey ?? field.id)}`}
          value={value}
        />
      </div>
    );
  }
  if (field.kind === "checkbox") {
    return (
      <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring">
        <input
          type="checkbox"
          name={name}
          value="yes"
          required={field.required}
          checked={value === "yes"}
          onChange={(e) => onChange(e.target.checked ? "yes" : "")}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  // text / email / name / custom -> single-line input
  const inputType =
    field.kind === "email" ? "email" : field.kind === "name" ? "text" : "text";
  return (
    <label className="block space-y-1">
      {label}
      <input
        type={inputType}
        name={name}
        required={field.required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? ""}
        className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-sm"
      />
    </label>
  );
}
