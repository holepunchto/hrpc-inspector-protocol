// ULID <-> 16-byte binary, a pure bijection (no registry needed).
//
// A ULID is 26 Crockford-base32 chars encoding a 128-bit value (48-bit ms
// timestamp + 80-bit randomness), with the first char <= 7 so the value stays
// below 2^128. That means ulid -> 16 bytes -> ulid is exactly reversible, which
// is the whole reason the `cbor-binary` encoding can shrink two 26-char strings
// to two 16-byte fields WITHOUT losing information (unlike peer hashing, which
// requires a registry).

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE_MAP: Record<string, number> = {};
for (let i = 0; i < CROCKFORD.length; i++) DECODE_MAP[CROCKFORD[i]] = i;

export function ulidToBytes(ulid: string): Uint8Array {
  if (ulid.length !== 26) throw new Error(`ulid: expected 26 chars, got ${ulid.length}`);
  let v = 0n;
  for (const ch of ulid) {
    const d = DECODE_MAP[ch];
    if (d === undefined) throw new Error(`ulid: invalid Crockford char '${ch}'`);
    v = (v << 5n) | BigInt(d);
  }
  if (v >= 1n << 128n) throw new Error('ulid: value exceeds 128 bits');
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export function bytesToUlid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error(`ulid: expected 16 bytes, got ${bytes.length}`);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 26; i++) { s = CROCKFORD[Number(v & 0x1fn)] + s; v >>= 5n; }
  return s;
}
