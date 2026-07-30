import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let encoded = "";
  for (let index = 0; index < length; index++) {
    encoded = CROCKFORD_BASE32[Number(value & BigInt(31))] + encoded;
    value >>= BigInt(5);
  }
  return encoded;
}

/** Generate a lexicographically sortable 26-character ULID. */
export function createUlid(now = Date.now()): string {
  const timestamp = BigInt(now);
  const random = randomBytes(10);
  let randomValue = BigInt(0);
  for (const byte of random) randomValue = (randomValue << BigInt(8)) | BigInt(byte);
  return `${encodeBase32(timestamp, 10)}${encodeBase32(randomValue, 16)}`;
}
