const request = jest.fn(async () => ({ data: {}, error: null }));

const client = new Proxy(
  { request },
  {
    get(target, property) {
      return property in target ? target[property] : jest.fn(async () => ({ data: {}, error: null }));
    },
  },
);

module.exports = new Proxy(
  {
    client,
    getClient: () => ({ client }),
    request,
  },
  {
    get(target, property) {
      return property in target ? target[property] : jest.fn(async () => ({ data: {}, error: null }));
    },
  },
);
