/**
 * lib/paletteCreateItems.ts — the creation verbs of the mobile command palette.
 *
 * Desktop's palette runs DESKTOP_TASK_COMMANDS ("New campaign", "New form",
 * "New list", "New template", "Import subscribers" — lib/desktop-task-intents.ts,
 * CommandPalette.tsx:739). Mobile's palette navigated to SCREENS only, so
 * typing "new camp" landed on the Campaigns list with the create sheet still a
 * header tap away, and no creation verb ranked at all.
 *
 * Each verb routes to its list screen with the `?new=1` flag that
 * app/(tabs)/campaigns/index.tsx already consumes (CAMPAIGN_CREATE_PARAM), so
 * a palette verb and the onboarding CTA `campaigns.new` are the same wire: the
 * screen opens ITS OWN create sheet on arrival, and the palette never carries
 * a duplicate form. lists/index.tsx and forms/index.tsx consume the same flag
 * through hooks/useCreateParam.ts.
 *
 * ROLE GATES MIRROR THE TARGET SCREENS, verb by verb, rather than one shared
 * "can write" — the three screens do not agree, and the palette must not offer
 * a verb whose screen would withhold the button:
 *   New campaign  campaigns/index.tsx → useCampaignAccess → campaignAccess():
 *                 any non-viewer role, and no api-key term.
 *   New list      lists/index.tsx → canAccessMinimumRole("editor"), which
 *                 fails closed in api-key mode (scopes are invisible to mobile).
 *   New form      forms/index.tsx → canAccessMinimumRole("editor"), the same.
 * All three withhold creation without a usable online session, so the verbs
 * do too — `access.online`, the search screen's `gate.enabled`.
 *
 * Deliberately ABSENT:
 *   New template       — mobile has no template-create flow. templates.tsx is
 *                        browse / duplicate / start-a-campaign-from-a-design,
 *                        and its own read-only notice states that authoring
 *                        belongs on a big screen.
 *   Import subscribers — subscriber-imports.tsx records upload + mapping as the
 *                        desktop half; the phone only confirms.
 *
 * Node-run: no react-native imports.
 */
import { CAMPAIGN_CREATE_PARAM } from "@/components/onboarding/onboardingRoutes";
import { campaignAccess } from "@/lib/campaignAccess";
import { transitionLabel } from "@/lib/direction";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { PaletteAccess, PaletteItem } from "@/lib/paletteItems";

/**
 * The query flag every create verb carries. Aliased, not re-declared, so the
 * palette, the campaigns screen and the onboarding route map cannot disagree
 * about the spelling.
 */
export const PALETTE_CREATE_PARAM = CAMPAIGN_CREATE_PARAM;

interface CreateVerb {
  key: "campaign" | "form" | "list";
  title: string;
  /**
   * Desktop's hint, verbatim (lib/desktop-task-intents.ts).
   *
   * A hint that is a STAGE SEQUENCE is carried as its STAGES, not as a joined
   * string: the connector between them is a reading-direction glyph, so it
   * comes from lib/direction and flips with the layout instead of being baked
   * into the copy pointing one way forever.
   */
  subtitle: string | readonly string[];
  icon: PaletteItem["icon"];
  route: string;
  /**
   * Ranked, never rendered. Carries the NOUN as well as the verb because the
   * ranker scores one field at a time: "create list" can only hit if some one
   * field contains both words.
   */
  keywords: string;
  /** The target screen's ROLE rule; connectivity is applied once, below. */
  allowed: (access: PaletteAccess) => boolean;
}

function editorFloor(access: PaletteAccess): boolean {
  return canAccessMinimumRole("editor", access.role, access.mode);
}

/**
 * Render a verb's hint. Stage sequences are joined with the direction-correct
 * arrow at BUILD time rather than at module load, so the join happens after
 * `setLayoutDirection` has published the platform's answer.
 */
function hintOf(subtitle: string | readonly string[]): string {
  if (typeof subtitle === "string") return subtitle;
  return subtitle
    .slice(1)
    .reduce((acc, stage) => transitionLabel(acc, stage), subtitle[0] ?? "");
}

const CREATE_VERBS: readonly CreateVerb[] = [
  {
    key: "campaign",
    title: "New campaign",
    subtitle: ["Draft", "Subject", "Send"],
    icon: "send",
    route: "/(tabs)/campaigns",
    keywords: "create campaign add campaign draft broadcast send newsletter",
    // The same decision the campaigns list makes for its own header button
    // (`disabled={!access.canMutate}`); online/session are true here because
    // buildCreateItems has already applied the connectivity term.
    allowed: (access) =>
      campaignAccess({
        online: true,
        sessionUsable: true,
        effectiveRole: access.role,
      }).canMutate,
  },
  {
    key: "form",
    title: "New form",
    subtitle: "Create a signup form",
    icon: "check",
    route: "/(tabs)/forms",
    keywords: "create form add form signup sign up embed capture",
    allowed: editorFloor,
  },
  {
    key: "list",
    title: "New list",
    subtitle: "Group of subscribers",
    icon: "users",
    route: "/(tabs)/lists",
    keywords: "create list add list audience group subscribers",
    allowed: editorFloor,
  },
];

/**
 * The creation verbs this identity may run, in the order desktop lists them.
 * Empty without a usable online session — every target screen withholds its
 * own create control then, and a verb that lands on a screen with the button
 * missing is a broken verb.
 */
export function buildCreateItems(access: PaletteAccess): PaletteItem[] {
  if (access.online === false) return [];
  return CREATE_VERBS.filter((verb) => verb.allowed(access)).map((verb) => ({
    id: `create:${verb.key}`,
    kind: "create",
    title: verb.title,
    subtitle: hintOf(verb.subtitle),
    icon: verb.icon,
    route: verb.route,
    params: { [PALETTE_CREATE_PARAM]: "1" },
    keywords: verb.keywords,
  }));
}
