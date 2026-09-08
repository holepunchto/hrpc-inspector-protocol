// Proves peers on ADJACENT protocol versions interoperate, which is the
// precondition for shipping the envelope at all: a P2P mesh has no central
// control, so you can never upgrade every peer at once.
//
// The design under test has two rules:
//   1. Carry `v` in the envelope.
//   2. Decode by IGNORING unknown fields (forward compatible) and DEFAULTING
//      absent fields (backward compatible).
//   3. Connection handshake advertises [vmin,vmax]; the pair uses the highest
//      common version, or refuses cleanly if the ranges do not overlap.
//
// Includes the required CONTROL: a STRICT decoder that rejects unknown fields.
// It must FAIL the exact case the tolerant decoder passes — otherwise the
// tolerant decoder's success is vacuous (it would pass even if tolerance did
// nothing).

let pass = 0, fail = 0;
const ok  = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

// ---- schemas ----------------------------------------------------------------
// v1 known fields. v2 is ADDITIVE: it adds an optional `prio`. That is what
// "adjacent" means here — a minor, additive bump, the common rollout case.
const V1_FIELDS = new Set(['v', 'msgId', 'corrId', 'kind', 'method', 'src', 'dst', 'ts', 'hlc']);
const V2_FIELDS = new Set([...V1_FIELDS, 'prio']);

// ---- encoders (peers emit their own version) --------------------------------
const encodeV1 = () => ({
  v: 1, msgId: 'M1', corrId: 'C1', kind: 'req', method: 'blocks.fetch',
  src: 'A', dst: 'B', ts: 1000, hlc: '1000:0:A',
});
const encodeV2 = () => ({
  v: 2, msgId: 'M2', corrId: 'C2', kind: 'req', method: 'blocks.fetch',
  src: 'A', dst: 'B', ts: 1000, hlc: '1000:0:A',
  prio: 5, // the new-in-v2 field an older peer has never heard of
});

// ---- tolerant decoder (the design) ------------------------------------------
// Extracts every field it knows; silently ignores the rest; defaults absentees.
function decodeTolerant(env, myFields) {
  const out = {};
  for (const k of Object.keys(env)) if (myFields.has(k)) out[k] = env[k];
  if (!('prio' in out) && myFields.has('prio')) out.prio = 0; // v2 default
  // The load-bearing invariant: correlation fields survive regardless of version.
  if (out.corrId == null || out.method == null)
    throw new Error('lost correlation fields — timeline would break');
  return out;
}

// ---- strict decoder (the CONTROL — NOT the design) --------------------------
// Rejects any field it does not recognise. Represents the naive implementation
// that would make cross-version interop impossible.
function decodeStrict(env, myFields) {
  for (const k of Object.keys(env))
    if (!myFields.has(k)) throw new Error(`unknown field '${k}' — strict decode rejects`);
  return decodeTolerant(env, myFields);
}

// ---- version negotiation over a handshake -----------------------------------
// Each peer advertises the inclusive range it can speak. Result is the highest
// common version, or null (refuse) when ranges are disjoint.
//
// Imported from the package rather than reimplemented here: this suite used to carry its own
// identical copy of negotiate(), which meant it proved the algorithm but never tested src/version.ts
// — a divergence in the real implementation would have kept passing.
import { negotiate } from '../src/version.ts';

console.log('version-negotiate.test.mjs — adjacent-version interop\n');

// 1. v1 peer receives a v2 message (contains unknown `prio`) -----------------
{
  const decoded = decodeTolerant(encodeV2(), V1_FIELDS);
  ok(decoded.corrId === 'C2' && decoded.method === 'blocks.fetch' && !('prio' in decoded),
     'v1 peer decodes v2 message: correlation intact, unknown `prio` ignored');
}

// 2. v2 peer receives a v1 message (missing `prio`) --------------------------
{
  const decoded = decodeTolerant(encodeV1(), V2_FIELDS);
  ok(decoded.corrId === 'C1' && decoded.prio === 0,
     'v2 peer decodes v1 message: correlation intact, `prio` defaults to 0');
}

// 3. CONTROL: strict decoder must FAIL the exact case tolerant PASSED --------
//    If this does NOT throw, tolerance is vacuous and the test proves nothing.
{
  let threw = false;
  try { decodeStrict(encodeV2(), V1_FIELDS); } catch { threw = true; }
  ok(threw,
     'CONTROL: strict decoder REJECTS the v2 message a v1 peer must accept ' +
     '(proves tolerance is load-bearing, not vacuous)');
}

// 4. Negotiation picks the highest common version between adjacent peers -----
{
  const chosen = negotiate({ vmin: 1, vmax: 1 }, { vmin: 1, vmax: 2 });
  ok(chosen === 1, 'negotiate(v1-only, v1..v2) -> speaks v1 (highest common)');
  const chosen2 = negotiate({ vmin: 1, vmax: 2 }, { vmin: 2, vmax: 2 });
  ok(chosen2 === 2, 'negotiate(v1..v2, v2-only) -> speaks v2 (highest common)');
}

// 5. Disjoint ranges refuse CLEANLY, not silently corrupt --------------------
//    A v1-only peer meeting a v3-only peer (breaking change at v3) must get a
//    clean null, not a mis-decoded envelope.
{
  const chosen = negotiate({ vmin: 1, vmax: 1 }, { vmin: 3, vmax: 3 });
  ok(chosen === null,
     'negotiate(v1-only, v3-only) -> refuses cleanly (null), no silent corruption');
}

// 6. CONTROL for #5: prove the failure mode is real without negotiation ------
//    If a v3 breaking envelope were force-decoded on a v1 peer, correlation
//    would be lost. This shows negotiation is preventing a genuine break.
{
  const v3Breaking = { v: 3, id: 'M3', cid: 'C3', method: 'blocks.fetch' }; // renamed keys
  let broke = false;
  try { decodeTolerant(v3Breaking, V1_FIELDS); } catch { broke = true; }
  ok(broke,
     'CONTROL: force-decoding a v3 breaking envelope on v1 loses correlation ' +
     '(proves negotiation in #5 prevents a real break)');
}

console.log(`\n${fail === 0 ? 'All version-negotiation claims verified.' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
