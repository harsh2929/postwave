import type { CampaignTemplate } from "@/lib/campaign-templates-api";

type TemplateVariable = NonNullable<CampaignTemplate["variables"]>[number];

function variableKey(variable: TemplateVariable): string {
  if (typeof variable.key === "string") return variable.key;
  if (typeof variable.name === "string") return variable.name;
  return "";
}

/**
 * The variable values the "Use template" dialog sends: each declared
 * variable's sample value, when it has one. A variable with no value is left
 * out rather than sent as "", so the draft keeps its visible {{ tag }} and
 * the server reports it, instead of writing an empty link.
 */
export function suppliedVariableValues(
  template: CampaignTemplate,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of template.variables ?? []) {
    const key = variableKey(variable);
    if (!key) continue;
    const raw = variable.default ?? variable.example ?? variable.value;
    const value = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    if (value.trim()) values[key] = value;
  }
  return values;
}

/** Tags the workspace fills from its settings, and where to set them. */
const WORKSPACE_SETTINGS: Record<string, string> = {
  reply_to_email: "a default reply-to address",
  brand_name: "a workspace name",
  sender_name: "a workspace name",
};

function humanize(name: string): string {
  const words = name
    .replace(/^subscriber\./, "")
    .split(/[_.\-\s]+/)
    .filter(Boolean)
    .map((word) => (/^(url|id)$/i.test(word) ? word.toUpperCase() : word));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listText(items: string[]): string {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(items);
}

/**
 * One sentence telling the author what a new draft still needs before it can
 * be sent, from the unresolved_variables the server returned: the template's
 * own labels for content it could not fill, and the setting behind each
 * workspace detail it had no value for. Null when nothing is missing.
 */
export function describeUnfilledDraftFields(
  template: CampaignTemplate,
  unresolved: readonly string[] | undefined,
): string | null {
  if (!unresolved?.length) return null;
  const labels = new Map<string, string>();
  for (const variable of template.variables ?? []) {
    const key = variableKey(variable);
    const label = typeof variable.label === "string" ? variable.label.trim() : "";
    if (key && label) labels.set(key, label);
  }
  const inDraft: string[] = [];
  const inSettings: string[] = [];
  for (const name of unresolved) {
    const setting = WORKSPACE_SETTINGS[name];
    if (setting) {
      if (!inSettings.includes(setting)) inSettings.push(setting);
      continue;
    }
    const label = labels.get(name) ?? humanize(name);
    if (!inDraft.includes(label)) inDraft.push(label);
  }
  const steps: string[] = [];
  if (inDraft.length) steps.push(`fill in ${listText(inDraft)} in the draft`);
  if (inSettings.length) steps.push(`add ${listText(inSettings)} in Settings`);
  return `Before you send, ${steps.join(", and ")}.`;
}
