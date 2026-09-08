// Hand-rolled UTF-8 codec. WHY THIS EXISTS — do not "modernise" it away:
//
// Bare has NO TextEncoder and NO TextDecoder. Measured on bare v1.28.0:
//   $ bare -e 'console.log(typeof TextEncoder, typeof TextDecoder)'
//   undefined undefined
// (WebSocket, process and performance are absent too; only Buffer exists.)
// Every `new TextEncoder()` on a hot path was therefore a ReferenceError in
// the exact runtime this project is named for — `observe()` with no options
// threw synchronously via redactSource -> hashPeer -> registry fnv1a64.
//
// So: dependency-free, no `node:` imports, no Buffer, pure JS. Runs unchanged
// in Bare, Node and the browser — same precedent as this repo's hand-rolled
// CBOR (./cbor.ts) and length-prefix framing (bare-probe/transport/framing.ts).
//
// THESE BYTES ARE LOAD-BEARING TWICE OVER: they are the wire format AND the
// input to the FNV-1a hashes that produce peer handles (./registry.ts) and
// redaction digests. A subtly wrong encoder does not crash — it silently
// changes hashes and breaks cross-peer merge. Hence verification/utf8.test.mjs
// asserts byte-for-byte equality against the platform TextEncoder/TextDecoder.
//
// Semantics are deliberately WHATWG-identical, not "close enough":
//   - encode: unpaired surrogates become U+FFFD's bytes (EF BF BD), exactly
//     what TextEncoder emits.
//   - decode with { fatal: true }: THROWS a TypeError on malformed input,
//     matching `new TextDecoder('utf-8', { fatal: true })`. ./decode.ts and
//     ./cbor.ts depend on that throw to reject corrupt frames.
//   - decode without fatal: U+FFFD replacement, one per maximal subpart,
//     per the WHATWG UTF-8 decoder algorithm.

const REPLACEMENT = 0xfffd;

/** UTF-8 encode a JS string. Unpaired surrogates -> EF BF BD (U+FFFD), like TextEncoder. */
export function utf8Encode(str: string): Uint8Array {
  // 3 bytes per UTF-16 code unit is the exact worst case: a BMP char costs at
  // most 3, and an astral char costs 4 across TWO units (2 per unit).
  const out = new Uint8Array(str.length * 3);
  let p = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = REPLACEMENT; // lone high surrogate
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = REPLACEMENT; // lone low surrogate
    }

    if (cp < 0x80) {
      out[p++] = cp;
    } else if (cp < 0x800) {
      out[p++] = 0xc0 | (cp >> 6);
      out[p++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[p++] = 0xe0 | (cp >> 12);
      out[p++] = 0x80 | ((cp >> 6) & 0x3f);
      out[p++] = 0x80 | (cp & 0x3f);
    } else {
      out[p++] = 0xf0 | (cp >> 18);
      out[p++] = 0x80 | ((cp >> 12) & 0x3f);
      out[p++] = 0x80 | ((cp >> 6) & 0x3f);
      out[p++] = 0x80 | (cp & 0x3f);
    }
  }
  // Copy rather than subarray: callers hash these bytes and hand them to
  // DataView/framing code, so a view onto a larger buffer is a footgun.
  return p === out.length ? out : out.slice(0, p);
}

export interface Utf8DecodeOptions {
  /** true = throw TypeError on malformed input (TextDecoder's fatal mode). */
  fatal?: boolean;
}

/**
 * UTF-8 decode bytes to a string. The WHATWG decoder state machine, so
 * overlong encodings, surrogate encodings, > U+10FFFF, unexpected
 * continuation bytes and truncated sequences are all rejected — the same
 * inputs the platform decoder rejects, at the same granularity.
 */
export function utf8Decode(bytes: Uint8Array, opts: Utf8DecodeOptions = {}): string {
  const fatal = opts.fatal === true;
  const units: number[] = [];
  let out = '';

  // Flush in chunks so fromCharCode never sees an unbounded argument list.
  const push = (cp: number): void => {
    if (cp <= 0xffff) {
      units.push(cp);
    } else {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    if (units.length >= 4096) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  };
  const bad = (): void => {
    if (fatal) throw new TypeError('utf8Decode: malformed UTF-8 (fatal)');
    push(REPLACEMENT);
  };

  let needed = 0;   // continuation bytes still expected
  let seen = 0;     // continuation bytes consumed for the current code point
  let cp = 0;       // code point under construction
  let lower = 0x80; // valid range for the NEXT continuation byte
  let upper = 0xbf;

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) { push(b); continue; }
      if (b >= 0xc2 && b <= 0xdf) { needed = 1; cp = b & 0x1f; continue; }
      if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;  // reject overlong 3-byte forms
        if (b === 0xed) upper = 0x9f;  // reject encoded surrogates
        needed = 2; cp = b & 0x0f; continue;
      }
      if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;  // reject overlong 4-byte forms
        if (b === 0xf4) upper = 0x8f;  // reject > U+10FFFF
        needed = 3; cp = b & 0x07; continue;
      }
      bad(); // 0x80-0xC1 (continuation or overlong lead) and 0xF5-0xFF
      continue;
    }
    if (b < lower || b > upper) {
      // Reset and REPROCESS this byte as a fresh lead byte (WHATWG "prepend").
      needed = 0; seen = 0; cp = 0; lower = 0x80; upper = 0xbf;
      i--;
      bad();
      continue;
    }
    lower = 0x80; upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen === needed) {
      push(cp);
      needed = 0; seen = 0; cp = 0;
    }
  }
  if (needed !== 0) bad(); // truncated sequence at end of input

  if (units.length > 0) out += String.fromCharCode.apply(null, units);
  return out;
}
