// Registries that make the compact encodings lossless.
//
// Compacting an identifier is only lossless if you can recover the original.
// - method string -> int : recoverable via MethodRegistryImpl
// - full PeerId -> short handle / 6-byte hash : recoverable via PeerRegistry
//
// These tables are exactly the "you cannot read a capture without the registry"
// cost that gate G1 weighs. They are session/dynamic (like an HPACK dynamic
// table): entries are added on first sight during encode and looked up on decode.

import type { MethodRegistry, PeerId } from './envelope.ts';
import { utf8Encode } from './utf8.ts';

export class MethodRegistryImpl implements MethodRegistry {
  private s2i = new Map<string, number>();
  private i2s: string[] = [];

  /** Seed with well-known methods so their ints are stable across a fleet. */
  constructor(seed: string[] = []) {
    for (const m of seed) this.intern(m);
  }

  intern(method: string): number {
    let id = this.s2i.get(method);
    if (id === undefined) {
      id = this.i2s.length;
      this.s2i.set(method, id);
      this.i2s.push(method);
    }
    return id;
  }

  lookup(id: number): string {
    const m = this.i2s[id];
    if (m === undefined) throw new Error(`method registry: no entry for int ${id}`);
    return m;
  }
}

// FNV-1a 64-bit over UTF-8, returned as 8 bytes big-endian. Deterministic and
// dependency-free; we take the low 6 for the on-wire hash to match the measured
// 6-byte peer-hash field, and store the reverse mapping so decode is lossless.
function fnv1a64(s: string): Uint8Array {
  let hi = 0xcbf2_9ce4 >>> 0;
  let lo = 0x8422_2325 >>> 0;
  const PRIME_LO = 0x1b3;
  const bytes = utf8Encode(s);
  for (const b of bytes) {
    lo ^= b;
    // 64-bit multiply by FNV prime (0x100000001b3) using 32-bit halves.
    const loMul = lo * PRIME_LO;
    const hiMul = hi * PRIME_LO + lo * 0x100; // 0x100000000 * lo contributes to hi
    lo = loMul >>> 0;
    const carry = Math.floor(loMul / 0x100000000);
    hi = (hiMul + carry) >>> 0;
  }
  const out = new Uint8Array(8);
  out[0] = (hi >>> 24) & 0xff; out[1] = (hi >>> 16) & 0xff; out[2] = (hi >>> 8) & 0xff; out[3] = hi & 0xff;
  out[4] = (lo >>> 24) & 0xff; out[5] = (lo >>> 16) & 0xff; out[6] = (lo >>> 8) & 0xff; out[7] = lo & 0xff;
  return out;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function toBase32(bytes: Uint8Array, chars: number): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < chars; i++) { s = CROCKFORD[Number(v & 0x1fn)] + s; v >>= 5n; }
  return s;
}

/**
 * Full PeerId <-> compact representation. Two on-wire forms share one table:
 *   - handle : 8-char base32 (used by json-short)
 *   - hash   : 6 bytes       (used by cbor-binary)
 * Both derive deterministically from the full PeerId; the reverse maps make
 * decode lossless. Special value '*' (broadcast) is passed through untouched.
 */
export class PeerRegistry {
  private byHandle = new Map<string, PeerId>();
  private byHash = new Map<string, PeerId>();

  handleFor(peer: PeerId): string {
    if (peer === '*') return '*';
    const handle = toBase32(fnv1a64(peer).slice(2), 8); // 6 bytes -> 8 base32 chars
    const prev = this.byHandle.get(handle);
    if (prev !== undefined && prev !== peer)
      throw new Error(`peer registry: handle collision '${handle}' (${prev} vs ${peer})`);
    this.byHandle.set(handle, peer);
    return handle;
  }

  hashFor(peer: PeerId): Uint8Array {
    if (peer === '*') return new Uint8Array(0); // sentinel: broadcast
    const hash = fnv1a64(peer).slice(2); // low 6 bytes
    const key = keyOf(hash);
    const prev = this.byHash.get(key);
    if (prev !== undefined && prev !== peer)
      throw new Error(`peer registry: hash collision (${prev} vs ${peer})`);
    this.byHash.set(key, peer);
    return hash;
  }

  peerFromHandle(handle: string): PeerId {
    if (handle === '*') return '*';
    const p = this.byHandle.get(handle);
    if (p === undefined) throw new Error(`peer registry: no full PeerId for handle '${handle}'`);
    return p;
  }

  peerFromHash(hash: Uint8Array): PeerId {
    if (hash.length === 0) return '*';
    const p = this.byHash.get(keyOf(hash));
    if (p === undefined) throw new Error('peer registry: no full PeerId for hash');
    return p;
  }
}

function keyOf(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
