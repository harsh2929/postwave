const values = new Map();

const storage = {
  clear: jest.fn(async () => values.clear()),
  getAllKeys: jest.fn(async () => Array.from(values.keys())),
  getItem: jest.fn(async (key) => values.get(key) ?? null),
  multiGet: jest.fn(async (keys) => keys.map((key) => [key, values.get(key) ?? null])),
  multiRemove: jest.fn(async (keys) => keys.forEach((key) => values.delete(key))),
  multiSet: jest.fn(async (entries) => entries.forEach(([key, value]) => values.set(key, value))),
  removeItem: jest.fn(async (key) => values.delete(key)),
  setItem: jest.fn(async (key, value) => values.set(key, value)),
};

module.exports = storage;
module.exports.default = storage;
