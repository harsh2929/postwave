/**
 * Moosewave share extension target.
 *
 * Lets the user share one actionable Moosewave entity link or bare email into
 * Moosewave. Generic URLs, arbitrary text, and compose notes are rejected. The
 * short-lived, bounded payload is stashed in the App Group and consumed on
 * foreground (see src/lib/sharedInbox.ts).
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "share",
  name: "PostwaveShare",
  deploymentTarget: "16.0",
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
