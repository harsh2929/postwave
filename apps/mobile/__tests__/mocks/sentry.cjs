// Mirrors the real src/lib/sentry.ts export surface. A missing export here is
// not a silently-absent mock: the screen calls it during render and dies with
// "is not a function", so every export a component reaches for must exist.
module.exports = {
  initSentry: jest.fn(),
  wrap: (component) => component,
  captureRootError: jest.fn(),
};
