const React = require("react");

module.exports = {
  TourProvider: ({ children }) => React.createElement(React.Fragment, null, children),
  useTour: () => ({
    active: false,
    complete: jest.fn(),
    dismiss: jest.fn(),
    next: jest.fn(),
    start: jest.fn(),
  }),
  useTourTarget: jest.fn(),
};
