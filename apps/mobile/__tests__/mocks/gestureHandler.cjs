const React = require("react");
const { View } = require("react-native");

function GestureHandlerRootView({ children, ...props }) {
  return React.createElement(View, props, children);
}

module.exports = {
  GestureHandlerRootView,
};
