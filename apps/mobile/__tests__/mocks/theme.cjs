const React = require("react");

const colors = new Proxy(
  {},
  { get: () => "#777777" },
);

module.exports = {
  ThemeProvider: ({ children }) => React.createElement(React.Fragment, null, children),
  useTheme: () => ({
    // Shape must match the real ThemeContextValue. `hydrated` is always true
    // inside the provider — children are not rendered until it is.
    hydrated: true,
    preference: "system",
    setPreference: jest.fn(async () => undefined),
    t: colors,
    theme: "dark",
  }),
};
