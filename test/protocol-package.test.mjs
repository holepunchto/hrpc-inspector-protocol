// Proves the @holepunchto/bare-protocol L0 package holds its contract:
//   (a) LOSSLESS encode->decode round-trip for all 4 encodings, with identity
//       carried AND dropped, PLUS a CONTROL: a corrupted buffer must FAIL decode.
//   (b) version negotiation picks the highest common version and refuses
//       incompatible ranges cleanly, with a CONTROL proving tolerance is
//       load-bearing (strict decode rejects what tolerant accepts).
//   (c) the identity-drop guard REFUSES fan-out / multiplexed / relayed / udp
//       channels, with a CONTROL proving a valid 1:1 channel is accepted.
//
// Node 24 strips TS types, so this .mjs imports the .ts sources directly. Every
// byte size printed is measured from an actual encode in THIS process; no size
// is asserted as a fixed constant (the G1 size authority is envelope-size.mjs /
// envelope-transport.mjs).

import {
  encode, decode, MethodRegistryImpl, PeerRegistry,
  negotiate, tolerantSelect, V1_FIELDS,
  checkIdentityDrop, canDropIdentity, ENCODING_IDS,
} from '../src/index.ts';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

// --- a real ULID generator (matches the verification scripts) ----------------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t = Date.now()) {
  let s = '';
  for (let i = 9; i >= 0; i--) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  for (let i = 0; i < 16; i++) s += B32[(Math.random() * 32) | 0];
  return s;
}
const FULL_PEER_A = '12D3KooWGRYw3mQvA9nEr7kL2pXqT8vB4cN6dH1sJ5fY7uZ3aM9x';
const FULL_PEER_B = '12D3KooWQzXcV8bN4mL9pR2sT6uW1yA3dF5gH7jK0lZ8xC4vB6nM';

function sampleEnvelope() {
  const now = Date.now();
  return {
    v: 1, msgId: ulid(now), corrId: ulid(now), causedBy: ulid(now),
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    kind: 'req', method: 'blocks.fetch',
    src: FULL_PEER_A, dst: FULL_PEER_B,
    ts: now, hlc: `${now}:3:${FULL_PEER_A.slice(0, 6)}`,
    ttl: 5,
    payload: { id: 'abc', blocks: [1, 2, 3], nested: { ok: true } },
  };
}

// Deep structural equality that treats byte arrays and plain objects correctly.
function eq(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => eq(a[k], b[k]));
}

console.log('protocol-package.test.mjs — L0 contract\n');

// =============================================================================
// (a) LOSSLESS ROUND-TRIP FOR ALL 4 ENCODINGS
// =============================================================================
console.log('(a) lossless round-trip — all encodings, identity carried:\n');
console.log(`  ${'encoding'.padEnd(14)} ${'bytes'.padStart(6)}   (MEASURED this run)`);
for (const encoding of ENCODING_IDS) {
  const env = sampleEnvelope();
  const methods = new MethodRegistryImpl(['presence.ping', 'crdt.sync', 'blocks.fetch']);
  const peers = new PeerRegistry();
  const bytes = encode(env, { encoding, methods, peers });
  const back = decode(bytes, { encoding, methods, peers });
  console.log(`  ${encoding.padEnd(14)} ${String(bytes.length).padStart(6)}`);
  ok(eq(env, back), `${encoding}: encode->decode is lossless (all fields recovered)`);
}

// Round-trip with identity DROPPED on a valid 1:1 binding.
console.log('\n(a) lossless round-trip — identity dropped on a 1:1 channel:\n');
for (const encoding of ENCODING_IDS) {
  const env = sampleEnvelope();
  const methods = new MethodRegistryImpl(['blocks.fetch']);
  const peers = new PeerRegistry();
  const binding = {
    topology: 'unicast-1to1', transport: 'webrtc-dc',
    resolveSrc: () => FULL_PEER_A, resolveDst: () => FULL_PEER_B,
  };
  const withId = encode(env, { encoding, methods, peers });
  const noId = encode(env, { encoding, methods, peers, dropIdentity: true, binding });
  const back = decode(noId, { encoding, methods, peers, binding });
  ok(eq(env, back), `${encoding}: identity-drop round-trip recovers src/dst from the binding`);
  ok(noId.length < withId.length, `${encoding}: dropping identity is strictly smaller (measured ${noId.length} < ${withId.length} B)`);
}

// CONTROL: a corrupted buffer MUST fail decode. Without this control, a decoder
// that silently returns garbage would pass the round-trip checks above.
console.log('\n(a) CONTROL — corrupted buffers must FAIL decode (not silently accept):\n');
for (const encoding of ENCODING_IDS) {
  const env = sampleEnvelope();
  const methods = new MethodRegistryImpl(['blocks.fetch']);
  const peers = new PeerRegistry();
  const good = encode(env, { encoding, methods, peers });
  // Truncate to half length — a classic partial-frame corruption.
  const truncated = good.slice(0, Math.max(1, Math.floor(good.length / 2)));
  let threw = false;
  try { decode(truncated, { encoding, methods, peers }); } catch { threw = true; }
  ok(threw, `${encoding}: truncated buffer is REJECTED (control proves round-trip isn't vacuous)`);
}

// =============================================================================
// (b) VERSION NEGOTIATION
// =============================================================================
console.log('\n(b) version negotiation — highest common + clean refusal:\n');
ok(negotiate({ vmin: 1, vmax: 1 }, { vmin: 1, vmax: 2 }) === 1, 'negotiate(v1-only, v1..v2) -> 1 (highest common)');
ok(negotiate({ vmin: 1, vmax: 2 }, { vmin: 2, vmax: 2 }) === 2, 'negotiate(v1..v2, v2-only) -> 2 (highest common)');
ok(negotiate({ vmin: 1, vmax: 1 }, { vmin: 3, vmax: 3 }) === null, 'negotiate(v1-only, v3-only) -> null (refuses cleanly)');

// Adjacent-version decode tolerance: a v2 message with an unknown `prio` field
// must decode on a v1 peer (unknown field ignored), and required fields survive.
{
  const v2raw = {
    v: 2, msgId: 'M2', corrId: 'C2', kind: 'req', method: 'blocks.fetch',
    src: 'A', dst: 'B', ts: 1000, hlc: '1000:0:A', prio: 5,
  };
  const sel = tolerantSelect(v2raw, V1_FIELDS);
  ok(sel.corrId === 'C2' && sel.method === 'blocks.fetch' && !('prio' in sel),
     'v1 peer tolerantly decodes v2 message: correlation intact, unknown `prio` dropped');
}
// CONTROL: a strict allowlist would reject the same message — proves tolerance
// is load-bearing, not vacuous.
{
  const strict = (raw, known) => {
    for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error('strict: unknown ' + k);
    return raw;
  };
  let threw = false;
  try { strict({ v: 2, corrId: 'C2', method: 'm', prio: 5 }, V1_FIELDS); } catch { threw = true; }
  ok(threw, 'CONTROL: strict decoder REJECTS the v2 message a v1 peer must accept');
}
// CONTROL: a breaking future version (renamed correlation keys) must FAIL, so we
// know negotiation's clean refusal is preventing a genuine break.
{
  let broke = false;
  try { tolerantSelect({ v: 3, id: 'M3', cid: 'C3', method: 'm' }, V1_FIELDS); } catch { broke = true; }
  ok(broke, 'CONTROL: force-decoding a v3 breaking envelope loses correlation (throws)');
}

// =============================================================================
// (c) IDENTITY-DROP GUARD
// =============================================================================
console.log('\n(c) identity-drop guard — refuses non-1:1 channels:\n');
const R = { resolveSrc: () => FULL_PEER_A, resolveDst: () => FULL_PEER_B };
ok(canDropIdentity({ topology: 'unicast-1to1', transport: 'webrtc-dc', ...R }),
   'ACCEPTS drop on a 1:1 webrtc-dc channel (control: the valid case)');
ok(canDropIdentity({ topology: 'unicast-1to1', transport: 'libp2p', ...R }),
   'ACCEPTS drop on a 1:1 libp2p channel (transport-intrinsic identity)');
ok(!checkIdentityDrop({ topology: 'fanout', transport: 'webrtc-dc', ...R }).ok,
   'REFUSES drop on a fan-out channel (one channel -> many logical peers)');
ok(!checkIdentityDrop({ topology: 'multiplexed', transport: 'libp2p', ...R }).ok,
   'REFUSES drop on a multiplexed channel');
ok(!checkIdentityDrop({ topology: 'relayed', transport: 'libp2p', ...R }).ok,
   'REFUSES drop on a relayed channel (channel peer != message peer)');
ok(!checkIdentityDrop({ topology: 'unicast-1to1', transport: 'raw-udp', ...R }).ok,
   'REFUSES drop on raw-udp even 1:1 ((addr,port)->peer map breaks under NAT rebind)');
ok(!checkIdentityDrop({ topology: 'unicast-1to1', transport: 'webrtc-dc' }).ok,
   'REFUSES drop when no resolveSrc/resolveDst map is supplied (decode couldn\'t recover)');

// The encoder itself must throw when asked to drop on an invalid channel.
{
  const env = sampleEnvelope();
  const methods = new MethodRegistryImpl(['blocks.fetch']);
  const peers = new PeerRegistry();
  let threw = false;
  try {
    encode(env, { encoding: 'cbor-binary', methods, peers, dropIdentity: true,
      binding: { topology: 'fanout', transport: 'webrtc-dc', ...R } });
  } catch (e) { threw = /IDENTITY_DROP_REFUSED/.test(String(e)); }
  ok(threw, 'encode() THROWS IDENTITY_DROP_REFUSED when dropping identity on a fan-out channel');
}

console.log(`\n${fail === 0 ? 'All protocol-package claims verified.' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
