const ReactNative = require("react-native");

const immediate = (value, _config, callback) => {
  callback?.(true);
  return value;
};

const evaluate = (factory) => {
  try {
    return factory();
  } catch {
    return {};
  }
};

const Animated = {
  Image: ReactNative.Image,
  ScrollView: ReactNative.ScrollView,
  Text: ReactNative.Text,
  View: ReactNative.View,
  createAnimatedComponent: (Component) => Component,
};

/**
 * LAYOUT-ANIMATION BUILDERS. `FadeIn.duration(200)` is a fluent builder in the
 * real library; components use it for entrance transitions (ErrorState,
 * EmptyState). Without these the property is `undefined` and every screen that
 * renders an empty or error state throws on `.duration` — a broken harness
 * reported as a broken screen. Each method returns the same object so any
 * chain length resolves, and the value is inert once it reaches the mocked
 * `Animated.View` (a plain RN View, which ignores the prop).
 */
function layoutBuilder() {
  const builder = {};
  for (const method of [
    "build",
    "delay",
    "duration",
    "easing",
    "randomDelay",
    "reduceMotion",
    "springify",
    "withCallback",
    "withInitialValues",
  ]) {
    builder[method] = () => builder;
  }
  return builder;
}

module.exports = {
  __esModule: true,
  default: Animated,
  FadeIn: layoutBuilder(),
  FadeInDown: layoutBuilder(),
  FadeInUp: layoutBuilder(),
  FadeOut: layoutBuilder(),
  LinearTransition: layoutBuilder(),
  Easing: new Proxy(
    { linear: (value) => value },
    { get: (target, property) => target[property] ?? (() => (value) => value) },
  ),
  cancelAnimation: jest.fn(),
  runOnJS: (callback) => callback,
  // `react-native-gesture-handler/ReanimatedSwipeable` is a SUBPATH import, so
  // the `^react-native-gesture-handler$` mapper never intercepts it and the
  // real component runs inside route tests. It reaches for these five on
  // render; without them any screen wrapping a row in SwipeableRow — the
  // roster screens where an admin gets swipe actions — throws before the first
  // frame, which is a broken test harness reported as a broken screen.
  useAnimatedRef: () => ({ current: null }),
  measure: () => null,
  runOnUI: (callback) => callback,
  // gesture-handler's `reanimatedWrapper` reaches for these two off the module
  // namespace when a GestureDetector mounts.
  useEvent: () => () => undefined,
  setGestureState: () => undefined,
  interpolate: (value, input = [], output = []) =>
    typeof value === "number" ? value : (output[0] ?? 0),
  useAnimatedProps: evaluate,
  useAnimatedStyle: evaluate,
  useSharedValue: (value) => ({ value }),
  // Default to motion ENABLED so route renders exercise the animated path
  // rather than the reduced-motion shortcut; a test that cares can override.
  useReducedMotion: () => false,
  // The real enum members are only compared for identity by our code, so
  // string values are sufficient and make failures readable.
  ReduceMotion: { System: "system", Always: "always", Never: "never" },
  withDelay: (_delay, value) => value,
  withRepeat: (value) => value,
  withSequence: (...values) => values.at(-1),
  withSpring: immediate,
  withTiming: immediate,
};
