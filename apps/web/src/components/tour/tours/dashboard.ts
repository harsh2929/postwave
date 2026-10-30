// SPDX-License-Identifier: AGPL-3.0-only
import type { Tour } from "../types";

export const dashboardTour: Tour = {
  id: "dashboard",
  startsOn: "/app",
  steps: [
    {
      id: "sidebar",
      route: "/app",
      target: "dashboard-sidebar",
      title: "Everything lives in this rail.",
      body: "Subscribers, campaigns, sequences, settings — one click away. The sidebar follows you everywhere.",
      placement: "right",
    },
    {
      id: "onboarding",
      route: "/app",
      target: "dashboard-onboarding",
      title: "Your first three moves.",
      body: "Import a list, check your sender health, ship a campaign. Most folks knock these out in under an hour.",
      placement: "bottom",
    },
    {
      id: "api-status",
      route: "/app",
      target: "dashboard-api-status",
      title: "Live signal, always on.",
      body: "Anything that talks to the API surfaces here. If something's off, you'll know before your subscribers do.",
      placement: "top",
    },
    {
      id: "to-campaigns",
      target: "dashboard-nav-campaigns",
      title: "Now to Campaigns.",
      body: "This is where you'll spend most of your time. Click through and we'll keep going.",
      placement: "right",
      primaryLabel: "Open Campaigns",
      navigateTo: "/app/campaigns",
      navigateDelayMs: 350,
    },
    {
      id: "campaign-library",
      route: "/app/campaigns",
      target: "dashboard-campaign-library",
      title: "Your campaigns, together.",
      body: "Review drafts, sent campaigns and paused work here. Sample campaigns are labeled, so you can explore their content without confusing them with a real send.",
      placement: "auto",
    },
    {
      id: "new-campaign",
      route: "/app/campaigns",
      target: "dashboard-new-campaign",
      title: "Start anything from here.",
      body: "Start a draft, choose its content and audience, then preview it before sending. The sample drafts give you something to open and edit after the tour.",
      placement: "auto",
    },
    {
      id: "to-subscribers",
      target: "dashboard-nav-subscribers",
      title: "Subscribers next.",
      body: "Explore the contact directory, consent fields and saved audiences. If sample data is loaded, these are fictional example contacts.",
      placement: "right",
      primaryLabel: "Open Subscribers",
      navigateTo: "/app/subscribers",
      navigateDelayMs: 350,
      // Skip the "go add subscribers" detour once the tenant already has one.
      skipIfGoalDone: "created_subscriber",
    },
    {
      id: "subscriber-directory",
      route: "/app/subscribers",
      target: "dashboard-subscriber-directory",
      title: "Meet your audience.",
      body: "Each row brings together an email address, subscription status, tags and consent. Search or filter the directory, then open a contact to inspect its details.",
      placement: "auto",
      skipIfGoalDone: "created_subscriber",
    },
    {
      id: "segments",
      route: "/app/subscribers",
      target: "dashboard-segments",
      title: "Turn filters into an audience.",
      body: "Segments save rules for selecting contacts. Let's open the saved audiences and inspect the sample segment.",
      placement: "auto",
      primaryLabel: "Open Segments",
      navigateTo: "/app/subscribers/segments",
      // This anchor only exists on the Subscribers route reached by the
      // preceding adaptive step. Filter the dependent spotlight with its route
      // step so a completed subscriber goal cannot leave a guaranteed-missing
      // intermediate step to time out at runtime.
      skipIfGoalDone: "created_subscriber",
    },
    {
      id: "saved-segments",
      route: "/app/subscribers/segments",
      target: "dashboard-segment-library",
      title: "Review who matches.",
      body: "Open a segment to inspect its rules and preview the matching contacts. The sample audience is restricted to the sample addresses.",
      placement: "auto",
      skipIfGoalDone: "created_subscriber",
    },
    {
      id: "to-sequences",
      target: "dashboard-nav-sequences",
      title: "Sequences in your voice.",
      body: "Build a series of email drafts with a consistent voice. Let's look at the sample welcome sequence.",
      placement: "right",
      primaryLabel: "Open Sequences",
      navigateTo: "/app/sequences",
      navigateDelayMs: 350,
    },
    {
      id: "sequence-drafts",
      route: "/app/sequences",
      target: "dashboard-sequence-library",
      title: "A welcome series you can inspect.",
      body: "The sample contains welcome, tips and next-step emails. Open it to review the messages and delays. This environment provides a draft designer; enrollment and automatic sending are not available here.",
      placement: "auto",
    },
    {
      id: "to-analytics",
      target: "dashboard-nav-analytics",
      title: "See how a campaign performed.",
      body: "Reports bring delivery, opens and clicks together. The sample sent campaign includes clearly labeled synthetic activity for exploring these views.",
      placement: "right",
      primaryLabel: "Open Analytics",
      navigateTo: "/app/analytics",
    },
    {
      id: "analytics-overview",
      route: "/app/analytics",
      target: "dashboard-analytics-overview",
      title: "Read the results.",
      body: "Compare campaign activity and change the reporting period. Sample activity demonstrates the charts; it is not evidence of messages delivered to real people.",
      placement: "auto",
    },
    {
      id: "to-settings",
      target: "dashboard-nav-settings",
      title: "Last stop — Settings.",
      body: "Manage workspace details, sending identity and security from Settings.",
      placement: "right",
      primaryLabel: "Open Settings",
      navigateTo: "/app/settings",
      navigateDelayMs: 350,
      // Skip the "go verify your domain" prompt once it's already verified.
      skipIfGoalDone: "verified_sending_identity",
    },
    {
      id: "workspace-settings",
      route: "/app/settings",
      target: "dashboard-workspace-settings",
      title: "Make the workspace yours.",
      body: "Set your workspace identity here. Sending domains and security have their own settings pages. Sample data can be managed or removed from Developer settings.",
      placement: "auto",
      skipIfGoalDone: "verified_sending_identity",
    },
    {
      id: "finish",
      title: "You're set.",
      body: "You can now explore the example contacts, campaign drafts, reports and welcome sequence. The ? menu replays the full walkthrough. Manage sample data in Settings → Developer when you're ready to use your own content.",
      // Always finish in a centred, route-independent card. The preceding
      // Settings navigation step is adaptive: once the sending identity is
      // verified it is correctly removed, which can leave the person on
      // Sequences. Targeting a Settings-only replay button made this final
      // `skipIfMissing` step auto-complete invisibly on that path.
      placement: "center",
      primaryLabel: "Finish",
      celebrate: true,
    },
  ],
};
