/**
 * The mobile dashboard tour script.
 *
 * Seven beats covering Moosewave's main mobile surfaces. Smaller
 * viewport than desktop, so we keep it concise — Welcome → Dashboard
 * stats → Recent activity → Campaigns tab → Voice tab → Settings
 * Replay row → outro.
 *
 * Tone: chirpy + warm. No emojis, no "Step 5 of 7" labels — the dot
 * indicator in the tooltip carries that load.
 */
import type { TourStep } from "./types";

export const DASHBOARD_TOUR: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Moosewave",
    body: "Let's take the scenic route — 60 seconds, tops.",
    placement: "center",
  },
  {
    id: "dashboard-stats",
    title: "Your numbers, live",
    body: "Live numbers, no refresh needed. Tap any card to drill in.",
    targetId: "dashboard.stats",
    placement: "bottom",
    navigateTo: "/(tabs)/dashboard",
  },
  {
    id: "dashboard-recent",
    title: "What's happening",
    body: "Anything that happens shows up here, freshest first.",
    targetId: "dashboard.recent",
    placement: "auto",
  },
  {
    id: "campaigns-tab",
    title: "Campaigns home",
    body: "Tap any campaign to see opens, clicks, and deliverability.",
    targetId: "campaigns.list",
    navigateTo: "/(tabs)/campaigns",
    placement: "auto",
    // A tenant who's already sent their first campaign knows this surface —
    // drop the beat so the replay stays tight.
    skipIfGoalDone: "sent_first_campaign",
  },
  {
    id: "voice-tab",
    title: "Your voice, on tap",
    body: "Train your voice once; we use it for every subject suggestion.",
    targetId: "voice.profile",
    navigateTo: "/(tabs)/voice",
    placement: "bottom",
  },
  {
    id: "settings-replay",
    title: "Tour, on demand",
    body: "Replay this anytime from Settings, or the question-mark in the corner.",
    targetId: "settings.replay",
    navigateTo: "/(tabs)/settings",
    placement: "auto",
  },
  {
    id: "outro",
    title: "You're all set",
    body: "That's the scenic route. The question-mark in the corner replays this anytime.",
    placement: "center",
  },
] as const;
