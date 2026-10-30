// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { forwardRef, memo, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import {
  mintSubmissionAttemptID,
  postPublicForm,
  publicFormSuccessURL,
  resetPublicFormCaptcha,
  setSubmissionAttemptField,
  SUBMISSION_ATTEMPT_FIELD,
} from "@/lib/public-form-submission";
import styles from "./hosted-compiled-form.module.css";

export function HostedCompiledForm({
  html,
  actionURL,
  slug,
}: {
  html: string;
  actionURL: string;
  slug: string;
}) {
  const tForms = useTranslations("forms");
  // The form rendered, so an uncertain outcome is a failed SUBMISSION: the
  // page-load "refresh" copy would send the visitor to reload a form that
  // already works.
  const unavailableMessage = tForms("submit_unavailable_body");
  const rootRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const [attemptID, setAttemptID] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!attemptID) setAttemptID(mintSubmissionAttemptID());
  }, [attemptID]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (submitting) root.setAttribute("aria-busy", "true");
    else root.removeAttribute("aria-busy");
  }, [submitting]);

  useEffect(() => {
    const form = rootRef.current?.querySelector<HTMLFormElement>("form");
    if (!form || !attemptID) return;
    setSubmissionAttemptField(form, attemptID);

    const rotateAttempt = () => {
      const next = mintSubmissionAttemptID();
      if (!next) return;
      setSubmissionAttemptField(form, next);
      setAttemptID(next);
    };
    const onIntentChange = (event: Event) => {
      const control = event.target;
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLSelectElement) &&
        !(control instanceof HTMLTextAreaElement)
      )
        return;
      if (
        control.name === SUBMISSION_ATTEMPT_FIELD ||
        control.name === "g-recaptcha-response"
      ) {
        return;
      }
      // Every authored-field change is a new intent. A transport retry with no
      // changes keeps the exact same token, including after an uncertain 5xx.
      rotateAttempt();
      setError("");
    };
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault();
      if (inFlightRef.current || !form.checkValidity()) {
        if (!form.checkValidity()) form.reportValidity();
        return;
      }
      inFlightRef.current = true;
      setSubmitting(true);
      setError("");
      const outcome = await postPublicForm(actionURL, form);
      inFlightRef.current = false;
      setSubmitting(false);
      if (outcome.kind === "uncertain") {
        // Do not rotate: the server may have crossed the paid boundary.
        resetPublicFormCaptcha(form);
        setError(unavailableMessage);
        return;
      }
      // Both accepted and rejected responses are deterministic.
      rotateAttempt();
      if (outcome.kind === "rejected") {
        resetPublicFormCaptcha(form);
        setError(outcome.message);
        return;
      }
      window.location.assign(
        publicFormSuccessURL(slug, outcome.state, outcome.redirect),
      );
    };

    form.addEventListener("input", onIntentChange);
    form.addEventListener("change", onIntentChange);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("input", onIntentChange);
      form.removeEventListener("change", onIntentChange);
      form.removeEventListener("submit", onSubmit);
    };
  }, [actionURL, attemptID, slug, unavailableMessage]);

  return (
    <>
      <CompiledMarkup ref={rootRef} html={html} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

// Keep the authored form DOM stable while status/error state changes. Replacing
// dangerouslySetInnerHTML on an uncertain response would erase the visitor's
// inputs and the exact retry token we are explicitly trying to preserve.
const CompiledMarkup = memo(
  forwardRef<HTMLDivElement, { html: string }>(function CompiledMarkup(
    { html },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={styles.root}
        // The compiler escapes all authored text/attributes.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }),
);
