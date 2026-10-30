class PostwaveClient {
  constructor() {
    return new Proxy(this, {
      get: (target, property) =>
        property in target
          ? target[property]
          : jest.fn(async () => ({ data: {}, error: null })),
    });
  }
}

const emptyCopy = { body: "Nothing here yet.", title: "No items" };

module.exports = new Proxy(
  {
    EMPTY_STATES: new Proxy({}, { get: () => emptyCopy }),
    EVENTS: new Proxy({}, { get: (_target, property) => String(property) }),
    PostwaveClient,
  },
  { get: (target, property) => property in target ? target[property] : jest.fn() },
);
