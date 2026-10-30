/**
 * Babel config for the Moosewave mobile app.
 *
 * babel-preset-expo handles RN + Reanimated worklets + Hermes-friendly output.
 * NativeWind's jsxImportSource lets us use Tailwind classNames directly on
 * RN primitives without a wrapper layer.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
  };
};
