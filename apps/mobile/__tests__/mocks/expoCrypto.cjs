// expo-crypto's AES module subclasses a native class at import time, which
// throws under the jest routes runner (no native bridge). Node's crypto covers
// the calls the app makes: random ids/bytes and SHA digests.
const nodeCrypto = require("node:crypto");
const ALGO = { SHA256: "SHA-256", SHA1: "SHA-1", SHA384: "SHA-384", SHA512: "SHA-512", MD5: "MD5" };
const toNode = (a) => String(a).replace("-", "").toLowerCase();
module.exports = {
  randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  getRandomBytes: jest.fn((n) => new Uint8Array(nodeCrypto.randomBytes(n))),
  getRandomBytesAsync: jest.fn(async (n) => new Uint8Array(nodeCrypto.randomBytes(n))),
  getRandomValues: jest.fn((arr) => nodeCrypto.getRandomValues(arr)),
  digestStringAsync: jest.fn(async (algorithm, data, options) => {
    const h = nodeCrypto.createHash(toNode(algorithm)).update(data);
    return options && options.encoding === "base64" ? h.digest("base64") : h.digest("hex");
  }),
  digest: jest.fn(async (algorithm, data) => {
    const buf = nodeCrypto.createHash(toNode(algorithm)).update(Buffer.from(data)).digest();
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }),
  CryptoDigestAlgorithm: ALGO,
  CryptoEncoding: { HEX: "hex", BASE64: "base64" },
};
