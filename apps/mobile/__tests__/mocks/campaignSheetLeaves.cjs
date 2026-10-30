/**
 * The campaign sheets' leaf components, for the two suites that render
 * CampaignSubjectModal / CampaignCreateModal for real
 * (campaign-subject-voice / campaign-subject-checkpoint).
 *
 * WHY THIS EXISTS AT ALL. jest.routes.config.cjs maps every
 * `@/components/campaigns/*` outside a short allowlist to
 * `mocks/nullComponent.cjs`, so a suite that renders a sheet through its own
 * relative import still gets NullComponent for the sheet's children — no
 * fields, nothing to type into. `jest.mock()` keys on the RESOLVED module, so
 * naming two of those specifiers registers two factories against one file and
 * the second silently wins. Hence ONE factory, a Proxy, for the whole family.
 *
 * Two shapes come out of it:
 *
 *   REAL — the leaves the assertions are actually about. CampaignFieldInput is
 *   the labelled TextInput every sheet field is made of, and
 *   CampaignIdentityFields is the half of the subject sheet that renders
 *   preview text / from-name / reply-to. Stub either and "reports every
 *   editable field" becomes a test of the stub. They are pulled with
 *   `requireActual` on a RELATIVE path, which the `^@/…` mappers cannot see.
 *
 *   everything else — a host element carrying the props it was handed, so the
 *   composition still renders and a prop can be read back without dragging in
 *   an AI stream, a WebView or an inbox-row preview.
 *
 * The requireActual is LAZY (inside the trap, not at factory time): a factory
 * that required the real CampaignIdentityFields eagerly would re-enter this
 * same mocked module for its own CampaignFieldInput import while the factory
 * was still running.
 */
/* global jest */
const { createElement } = require("react");

const REAL = {
  CampaignFieldInput: "../../src/components/campaigns/CampaignFieldInput",
  CampaignIdentityFields:
    "../../src/components/campaigns/CampaignIdentityFields",
};

const stubs = new Map();

function hostStub(name) {
  if (!stubs.has(name)) {
    // `children: undefined` because these leaves are self-closing in the
    // sheets; passing a component's children through to a host element with an
    // unknown type is how a stub starts rendering things it was meant to hide.
    stubs.set(name, (props) =>
      createElement(name, { ...props, children: undefined }),
    );
  }
  return stubs.get(name);
}

module.exports = new Proxy(
  { __esModule: true },
  {
    get(target, property) {
      if (property in target) return target[property];
      // Symbols (Symbol.toStringTag, Symbol.iterator) and `then` are asked for
      // by the runtime, not by a component; answering them with a component
      // makes the module look thenable and breaks `await import()`/inspection.
      if (typeof property === "symbol" || property === "then") return undefined;
      const actual = REAL[property];
      if (actual) return jest.requireActual(actual)[property];
      return hostStub(property);
    },
  },
);
