/**
 * lib/campaignInboxRow.ts — the model behind the inbox-row mock.
 *
 * Desktop shows the sender + subject + preview text as one Gmail/Apple-Mail
 * style row while those fields are being typed (InboxRowPreview.tsx), because
 * the artifact being tuned IS an inbox row and raw form fields hide how the
 * three read together. This is the pure half of the mobile port; the component
 * renders exactly this model.
 */

export interface InboxRowInput {
  fromName: string;
  fromEmail: string;
  subject: string;
  previewText: string;
}

export interface InboxRowModel {
  /** From-name wins over address, mirroring what clients actually display. */
  sender: string;
  subject: string;
  /** Null when preview text is empty — the component then states the inbox's
   *  real fallback (start of the body) instead of showing a blank. */
  snippet: string | null;
}

export const INBOX_ROW_EMPTY_SNIPPET_NOTE =
  "inbox shows the start of your body — set preview text to control this";

export function inboxRowModel(input: InboxRowInput): InboxRowModel {
  const sender =
    input.fromName.trim() || input.fromEmail.trim() || "you@your-domain.com";
  const subject = input.subject.trim() || "(no subject)";
  const snippet = input.previewText.trim();
  return { sender, subject, snippet: snippet === "" ? null : snippet };
}
