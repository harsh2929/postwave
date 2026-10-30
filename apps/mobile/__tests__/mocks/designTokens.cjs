const palette = ["#f97316", "#38bdf8", "#a78bfa"];

module.exports = {
  dark: {},
  light: {},
  motion: {
    confetti: {
      count: 3,
      flightMs: 0,
      paletteDark: palette,
      paletteLight: palette,
      staggerMs: 0,
    },
    durations: new Proxy({}, { get: () => 0 }),
    easing: new Proxy(
      {},
      { get: () => ({ bezier: [0, 0, 1, 1] }) },
    ),
  },
};
