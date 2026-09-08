// Minimal, dependency-free CBOR encoder/decoder.
//
// Scope: the exact value shapes the envelope encoders produce — unsigned/negative
// integers, byte strings (Uint8Array), text strings, arrays, string-keyed maps,
// booleans, null, and non-integer numbers (float64). This is NOT a general CBOR
// library; it is the smallest codec that makes the four envelope encodings
// LOSSLESS round-trippable with zero npm dependencies.
//
// The SIZE authority for the G1 decision remains verification/envelope-size.mjs
// and verification/envelope-transport.mjs (canonical `cborSize`). This codec
// emits the same canonical head forms, so its output length matches that floor.
// cbor-x, if used in production instead, adds +2 B/map (see cbor-selfcheck.mjs).

import { utf8Encode, utf8Decode } from './utf8.ts';

type Cbor =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Cbor[]
  | { [k: string]: Cbor };

function writeHead(out: number[], major: number, n: number): void {
  const m = major << 5;
  if (n < 24) {
    out.push(m | n);
  } else if (n < 0x100) {
    out.push(m | 24, n);
  } else if (n < 0x10000) {
    out.push(m | 25, (n >>> 8) & 0xff, n & 0xff);
  } else if (n < 0x100000000) {
    out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  } else {
    // 64-bit: split into hi/lo 32-bit halves (safe for Number.MAX_SAFE_INTEGER).
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    out.push(
      m | 27,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

function encodeItem(v: Cbor, out: number[]): void {
  if (v === null || v === undefined) { out.push(0xf6); return; }
  if (typeof v === 'boolean') { out.push(v ? 0xf5 : 0xf4); return; }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (v >= 0) writeHead(out, 0, v);
      else writeHead(out, 1, -v - 1);
      return;
    }
    // float64 (major 7, additional 27)
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, false);
    out.push(0xfb, ...new Uint8Array(buf));
    return;
  }
  if (typeof v === 'string') {
    const bytes = utf8Encode(v);
    writeHead(out, 3, bytes.length);
    for (const b of bytes) out.push(b);
    return;
  }
  if (v instanceof Uint8Array) {
    writeHead(out, 2, v.length);
    for (const b of v) out.push(b);
    return;
  }
  if (Array.isArray(v)) {
    writeHead(out, 4, v.length);
    for (const item of v) encodeItem(item, out);
    return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    writeHead(out, 5, keys.length);
    for (const k of keys) { encodeItem(k, out); encodeItem(v[k], out); }
    return;
  }
  throw new Error('cbor: unsupported type ' + typeof v);
}

export function encodeCbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  encodeItem(v, out);
  return Uint8Array.from(out);
}

// --- decode ------------------------------------------------------------------

function readLen(buf: Uint8Array, ai: number, p: number): [number, number] {
  if (ai < 24) return [ai, p];
  if (ai === 24) return [buf[p], p + 1];
  if (ai === 25) return [(buf[p] << 8) | buf[p + 1], p + 2];
  if (ai === 26) return [((buf[p] * 0x1000000) + (buf[p + 1] << 16) + (buf[p + 2] << 8) + buf[p + 3]) >>> 0, p + 4];
  if (ai === 27) {
    const hi = (buf[p] * 0x1000000) + (buf[p + 1] << 16) + (buf[p + 2] << 8) + buf[p + 3];
    const lo = (buf[p + 4] * 0x1000000) + (buf[p + 5] << 16) + (buf[p + 6] << 8) + buf[p + 7];
    return [hi * 0x100000000 + lo, p + 8];
  }
  throw new Error('cbor: bad additional-info ' + ai);
}

function decodeItem(buf: Uint8Array, p: number): [Cbor, number] {
  if (p >= buf.length) throw new Error('cbor: unexpected end of buffer');
  const ib = buf[p++];
  const major = ib >> 5;
  const ai = ib & 0x1f;

  if (major === 0) { const [n, np] = readLen(buf, ai, p); return [n, np]; }
  if (major === 1) { const [n, np] = readLen(buf, ai, p); return [-1 - n, np]; }
  if (major === 2) {
    const [len, np] = readLen(buf, ai, p);
    if (np + len > buf.length) throw new Error('cbor: byte-string overruns buffer');
    return [buf.slice(np, np + len), np + len];
  }
  if (major === 3) {
    const [len, np] = readLen(buf, ai, p);
    if (np + len > buf.length) throw new Error('cbor: text-string overruns buffer');
    return [utf8Decode(buf.slice(np, np + len), { fatal: true }), np + len];
  }
  if (major === 4) {
    const [len, np] = readLen(buf, ai, p);
    let cur = np; const arr: Cbor[] = [];
    for (let i = 0; i < len; i++) { const [item, ncur] = decodeItem(buf, cur); arr.push(item); cur = ncur; }
    return [arr, cur];
  }
  if (major === 5) {
    const [len, np] = readLen(buf, ai, p);
    let cur = np; const obj: { [k: string]: Cbor } = {};
    for (let i = 0; i < len; i++) {
      const [k, kc] = decodeItem(buf, cur);
      if (typeof k !== 'string') throw new Error('cbor: non-string map key not supported');
      const [val, vc] = decodeItem(buf, kc);
      obj[k] = val; cur = vc;
    }
    return [obj, cur];
  }
  if (major === 7) {
    if (ai === 20) return [false, p];
    if (ai === 21) return [true, p];
    if (ai === 22 || ai === 23) return [null, p];
    if (ai === 27) {
      const dv = new DataView(buf.buffer, buf.byteOffset + p, 8);
      return [dv.getFloat64(0, false), p + 8];
    }
    throw new Error('cbor: unsupported simple/float ' + ai);
  }
  throw new Error('cbor: unsupported major type ' + major);
}

export function decodeCbor(buf: Uint8Array): Cbor {
  const [v, end] = decodeItem(buf, 0);
  if (end !== buf.length) throw new Error('cbor: trailing bytes after top-level item');
  return v;
}

export type { Cbor };
