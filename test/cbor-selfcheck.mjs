// Cross-checks the dependency-free cborSize() against the real cbor-x library.
//
// FINDING (2026-08-11): the two differ by exactly 2 bytes per map, always.
// cbor-x emits `b9 XXXX` — a map header with a 16-bit length field — where
// canonical CBOR uses the compact `a2` form (1 byte). Verified by hexdump:
//
//   encode({v:1})       -> b90001617601      (6 bytes)
//   canonical minimal   -> a1  617601        (4 bytes)
//
// cbor-x does this so it never has to backtrack to patch a length it didn't
// know upfront. Both encodings are valid CBOR and decode identically.
//
// Consequence: cborSize() reports the CANONICAL FLOOR. Real cbor-x output is
// +2 bytes per map. If you pick an encoder that streams like cbor-x, budget
// the extra. This is asserted below so the delta can't drift unnoticed.
import { cborSize, readable, compact, binary, PEERS } from './envelope-size.mjs';

let encode;
try { ({ encode } = await import('cbor-x')); }
catch { console.log('  SKIP: cbor-x not installed (npm i cbor-x to run this cross-check)'); process.exit(0); }

const EXPECTED_DELTA = 2; // one top-level map per envelope

const cases = [
  ['readable/full',  readable(PEERS.FULL_PEER, PEERS.FULL_PEER)],
  ['readable/short', readable(PEERS.SHORT_PEER, PEERS.SHORT_PEER)],
  ['compact',        compact(PEERS.SHORT_PEER, PEERS.SHORT_PEER)],
  ['binary',         binary()],
];

let fail = 0;
for (const [name, obj] of cases) {
  const mine = cborSize(obj), real = encode(obj).length, delta = real - mine;
  const ok = delta === EXPECTED_DELTA;
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} canonical=${mine} cbor-x=${real} delta=${delta}`);
}
console.log(fail === 0
  ? `\n  Delta is exactly ${EXPECTED_DELTA}B/map as documented — canonical floor confirmed.`
  : `\n  ${fail} case(s) deviate from the documented delta. Re-derive before trusting sizes.`);
process.exit(fail ? 1 : 0);
