const NullComponent = () => null;

module.exports = new Proxy(
  { __esModule: true, default: NullComponent },
  { get: (target, property) => property in target ? target[property] : NullComponent },
);
