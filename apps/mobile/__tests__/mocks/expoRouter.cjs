const React = require("react");
const { Text, View } = require("react-native");

const DEFAULT_SEARCH_PARAMS = {
  id: "11111111-1111-4111-8111-111111111111",
  q: "",
  purpose: "",
  state: "test-state",
  token: "test-token",
};

let searchParamOverrides = {};

const router = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  navigate: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};

function Navigator({ children }) {
  return React.createElement(View, { testID: "mock-navigator" }, children);
}
Navigator.Screen = function Screen() {
  return null;
};

function Redirect({ href }) {
  const value = typeof href === "string" ? href : JSON.stringify(href);
  return React.createElement(Text, { testID: "mock-redirect" }, value);
}

function Link({ children }) {
  return React.createElement(View, null, children);
}

module.exports = {
  Link,
  Redirect,
  Stack: Navigator,
  Tabs: Navigator,
  router,
  // Screens that gate polling/animation on focus (dashboard) call this; the
  // route smoke tests render one screen at a time, so it is always focused.
  useIsFocused: () => true,
  useFocusEffect: (effect) => {
    React.useEffect(() => effect(), [effect]);
  },
  useLocalSearchParams: () => ({ ...DEFAULT_SEARCH_PARAMS, ...searchParamOverrides }),
  // Per-test route params. `clearMocks`/`restoreMocks` reset jest.fn()s, not
  // module state, so a test that sets these MUST clear them in afterEach —
  // otherwise the next screen renders with another screen's params.
  __setSearchParamsForTests: (over) => {
    searchParamOverrides = over ?? {};
  },
  usePathname: () => "/(tabs)/dashboard",
};
