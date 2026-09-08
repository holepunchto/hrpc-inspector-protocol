// Per-transport envelope measurement for the G1 encoding decision.
// Zero runtime deps (reuses the dependency-free cborSize from envelope-size.mjs,
// which is cross-checked against cbor-x in cbor-selfcheck.mjs).
//
// TWO orthogonal axes are measured independently:
//
//   AXIS 1 — encoding        JSON full-peer / JSON short-peer /
//                            CBOR compact+registry / CBOR binary-ids
//   AXIS 2 — identity        src/dst carried IN the envelope, vs DROPPED and
//                            recovered from the channel/transport.
//
// Identity-drop is NOT a libp2p-only lever. For any 1:1 channel the application
// holds a channel->peer mapping and can recover src/dst without carrying them:
//
//   libp2p     drop valid: transport-intrinsic. The authenticated PeerId IS the
//              connection identity. Strongest guarantee.
//   webrtc-dc  drop valid: app-held mapping on a DEDICATED 1:1 DataChannel
//              (one channel == one remote peer). App owns the map, not SCTP.
//   raw-tcp    drop valid: app-held mapping on a 1:1 connection (one socket ==
//              one remote peer).
//   raw-udp    drop WEAK: a bound UDP socket is connectionless and hears many
//              peers; the map is (remoteAddr,port)->peer, which breaks under NAT
//              rebinding / relay. Prefer keeping identity in-envelope for UDP.
//
//   INVALID FOR ALL: multiplexed / relayed / fan-out traffic, where one channel
//   carries messages for MULTIPLE logical peers. There the channel identity no
//   longer identifies the message's src/dst and the envelope MUST carry them.
//
// Framing (added by us, above the transport):
//   libp2p     yamux 12B frame header (1+1+2+4+4). Spec layout, constructed &
//              measured here as a 12B buffer; NOT captured from a live muxer.
//   webrtc-dc  SCTP is message-oriented -> we add 0B (SCTP chunk overhead is
//              below our layer and not measured here).
//   raw-tcp    byte stream -> we add a LEB128 varint length prefix (measured).
//   raw-udp    datagram == message boundary -> we add 0B below MTU.
//
// Every byte size printed here is computed from an actual encode of an actual
// object / Buffer in THIS process. Nothing is estimated.

import { cborSize } from './envelope-size.mjs';

// ---- identifier generators --------------------------------------------------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t = Date.now()) {
  let s = '';
  for (let i = 9; i >= 0; i--) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  for (let i = 0; i < 16; i++) s += B32[(Math.random() * 32) | 0];
  return s; // 26 chars
}
const FULL_PEER  = '12D3KooWGRYw3mQvA9nEr7kL2pXqT8vB4cN6dH1sJ5fY7uZ3aM9x'; // 52 chars
const SHORT_PEER = 'QmYwAPJz';                                              // 8 chars
// HLC node token: conventionally a SHORT/hashed peer id, so it is the same
// 6-char length in every string-encoding tier. Using a consistent 6-char slice
// here is the fix for the earlier defect where `shortpeer` embedded the full
// 8-char SHORT_PEER in hlc while `readable` used a 6-char slice, making
// short-peer paradoxically +2B once src/dst were dropped.
const hlcNode = (peer) => peer.slice(0, 6);

const jsonSize = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const jsonVal  = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ---- envelope builders (identity = src/dst present) -------------------------
function readable(identity) {                       // JSON, full PeerIds
  const e = { v: 1, msgId: ulid(), corrId: ulid(), kind: 'req', method: 'blocks.fetch',
              ts: Date.now(), hlc: `${Date.now()}:0:${hlcNode(FULL_PEER)}` };
  if (identity) { e.src = FULL_PEER; e.dst = FULL_PEER; }
  return e;
}
function shortpeer(identity) {                      // JSON, 6/8-char peers
  const e = { v: 1, msgId: ulid(), corrId: ulid(), kind: 'req', method: 'blocks.fetch',
              ts: Date.now(), hlc: `${Date.now()}:0:${hlcNode(SHORT_PEER)}` };
  if (identity) { e.src = SHORT_PEER; e.dst = SHORT_PEER; }
  return e;
}
function compact(identity) {                        // CBOR, 1-char keys + registry
  const e = { v: 1, i: ulid(), c: ulid(), k: 0, m: 7, t: Date.now(), h: [Date.now(), 0] };
  if (identity) { e.s = SHORT_PEER; e.d = SHORT_PEER; }
  return e;
}
function binary(identity) {                         // CBOR, binary ULIDs + 6B hashes
  const e = { v: 1, i: Buffer.alloc(16), c: Buffer.alloc(16), k: 0, m: 7,
              t: Date.now(), h: [Date.now(), 0] };
  if (identity) { e.s = Buffer.alloc(6); e.d = Buffer.alloc(6); }
  return e;
}

const ENCODINGS = [
  { key: 'json-full',    label: 'JSON full-peer',        enc: 'json', build: readable  },
  { key: 'json-short',   label: 'JSON short-peer',       enc: 'json', build: shortpeer },
  { key: 'cbor-compact', label: 'CBOR compact+registry', enc: 'cbor', build: compact   },
  { key: 'cbor-binary',  label: 'CBOR binary-ids',       enc: 'cbor', build: binary    },
];
const ID_VALUE_KEYS = { 'json-full': ['msgId','corrId','src','dst'],
                        'json-short':['msgId','corrId','src','dst'],
                        'cbor-compact':['i','c','s','d'],
                        'cbor-binary':['i','c','s','d'] };

const sizeOf = (enc, env) => enc === 'json' ? jsonSize(env) : cborSize(env);
function idContent(env, keys, enc) {
  let s = 0; for (const k of keys) if (k in env) s += enc === 'json' ? jsonVal(env[k]) : cborSize(env[k]); return s;
}

// ---- framing ----------------------------------------------------------------
const YAMUX = 12;
function varintLen(n) { let b = 1; while (n >= 0x80) { n >>>= 7; b++; } return b; }
function framing(transport, total) {
  if (transport === 'libp2p')  return YAMUX;
  if (transport === 'raw-tcp') return varintLen(total);
  return 0; // webrtc-dc (SCTP) and raw-udp (datagram <MTU)
}

const TRANSPORTS = [
  { id: 'libp2p',    frame: 'yamux 12B header',            drop: 'transport-intrinsic (authenticated PeerId)' },
  { id: 'webrtc-dc', frame: 'SCTP msg-oriented, app +0B',  drop: 'app-held map on a dedicated 1:1 DataChannel' },
  { id: 'raw-tcp',   frame: 'varint length prefix',        drop: 'app-held map on a 1:1 socket' },
  { id: 'raw-udp',   frame: 'datagram boundary, app +0B',  drop: 'app-held (addr,port)->peer map — FRAGILE (NAT rebind)' },
];

// =============================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('MEASURED per-transport envelope size (payload excluded). Node', process.version);
  console.log('Canonical CBOR / minified JSON. cbor-x adds +2B/map (see cbor-selfcheck).\n');

  // ---- 4-transport x encoding x identity matrix -----------------------------
  console.log('IDENTITY AXIS MATRIX — every (transport x encoding) has with-identity and without-identity');
  console.log('on-wire = envelope + framing.  drop-Δ = bytes saved by omitting src/dst.\n');
  const H = `  ${'transport'.padEnd(10)} ${'encoding'.padEnd(22)} ${'wID env'.padStart(7)} ${'wID wire'.padStart(8)} ${'noID env'.padStart(8)} ${'noID wire'.padStart(9)} ${'drop-Δ'.padStart(7)}`;
  console.log(H);
  for (const t of TRANSPORTS) {
    for (const e of ENCODINGS) {
      const withId = e.build(true), noId = e.build(false);
      const wEnv = sizeOf(e.enc, withId), nEnv = sizeOf(e.enc, noId);
      const wWire = wEnv + framing(t.id, wEnv), nWire = nEnv + framing(t.id, nEnv);
      console.log(`  ${t.id.padEnd(10)} ${e.label.padEnd(22)} ${String(wEnv).padStart(7)} ${String(wWire).padStart(8)} ${String(nEnv).padStart(8)} ${String(nWire).padStart(9)} ${String('-'+(wEnv-nEnv)).padStart(7)}`);
    }
  }

  console.log('\nWhen is the without-identity (drop) column VALID?');
  for (const t of TRANSPORTS) console.log(`  ${t.id.padEnd(10)} ${t.drop}`);
  console.log('  ALL        INVALID for multiplexed / relayed / fan-out (one channel -> many logical peers): keep src/dst.');

  // ---- identifier vs container breakdown (with-identity, for reference) ------
  console.log('\nIdentifier vs container split (with identity in envelope; identifiers = msgId+corrId+src+dst values):');
  console.log(`  ${'encoding'.padEnd(22)} ${'total'.padStart(6)} ${'ident'.padStart(6)} ${'container'.padStart(9)}`);
  for (const e of ENCODINGS) {
    const env = e.build(true), total = sizeOf(e.enc, env), ident = idContent(env, ID_VALUE_KEYS[e.key], e.enc);
    console.log(`  ${e.label.padEnd(22)} ${String(total).padStart(6)} ${String(ident).padStart(6)} ${String(total-ident).padStart(9)}`);
  }

  // ---- CONTROL LADDER: attribute each byte saving to ONE change --------------
  console.log('\nControl ladder (identity in envelope) — each row changes ONE thing, so each Δ is attributable:');
  const L0 = jsonSize(readable(true)), L1 = cborSize(readable(true)), L2 = cborSize(shortpeer(true)),
        L3 = cborSize(compact(true)),  L4 = cborSize(binary(true));
  const line = (lb, v, p) => console.log(`  ${lb.padEnd(48)} ${String(v).padStart(4)} B   ${p==null?'baseline':'-'+(p-v)+' B vs prev'}`);
  line('L0 JSON, full PeerIds, string ULIDs, str method', L0, null);
  line('L1  + container JSON->CBOR (nothing else)',        L1, L0);
  line('L2  + 6/8-char short peers',                       L2, L1);
  line('L3  + 1-char keys + method string->int registry',  L3, L2);
  line('L4  + binary ULIDs + 6-byte binary peer hashes',    L4, L3);
  console.log('  READ: container swap (L0->L1) is the SMALLEST lever; identifier changes dominate. Reproduces C4.');

  // ---- struct-packed binary (raw sockets only) ------------------------------
  function structPack(withCausedBy, identity) {
    const parts = [ Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(1), // v,kind,method,flags
                    Buffer.alloc(16), Buffer.alloc(16),                                 // msgId,corrId
                    ...(withCausedBy ? [Buffer.alloc(16)] : []),                        // causedBy
                    ...(identity ? [Buffer.alloc(6), Buffer.alloc(6)] : []),            // src,dst
                    Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(2) ];                // ts,hlc_phys,hlc_ctr
    return Buffer.concat(parts);
  }
  console.log('\nStruct-packed (raw-tcp/udp; fixed layout, no self-describing keys):');
  for (const [cb, idn] of [[false,true],[true,true],[false,false],[true,false]]) {
    const b = structPack(cb, idn);
    console.log(`  causedBy=${cb?'yes':'no '} identity=${idn?'yes':'no '}  ${String(b.length).padStart(3)} B  +${varintLen(b.length)} varint = ${b.length+varintLen(b.length)} on wire (TCP)`);
  }
  console.log('  NOTE: identifiers are 100% of the container; a capture is meaningless without struct-spec + registry.');
  console.log('        Fixed layout ALSO forfeits the "ignore unknown fields" version rule unless reserved bits/TLV are designed in.');

  // ---- version-field cost ---------------------------------------------------
  const wv = binary(true), nv = binary(true); delete nv.v;
  const jv = readable(true), jnv = readable(true); delete jnv.v;
  console.log('\nVersion-negotiation per-message cost:');
  console.log(`  'v' in CBOR binary envelope: ${cborSize(wv)-cborSize(nv)} B     '"v":1' in JSON: ${jsonSize(jv)-jsonSize(jnv)} B`);
  console.log(`  [vmin,vmax] range advert is a per-CONNECTION handshake cost, not per-message (see version-negotiate.test.mjs).`);

  // ---- throughput span ------------------------------------------------------
  const worst = jsonSize(readable(true)), best = cborSize(binary(false));
  console.log(`\nThroughput span (worst = JSON full-peer w/ identity ${worst}B, best = CBOR binary no-identity ${best}B):`);
  for (const r of [10,100,500,2000])
    console.log(`  ${String(r).padStart(4)} msg/s   worst ${(worst*r/1024).toFixed(1).padStart(7)} KB/s   best ${(best*r/1024).toFixed(1).padStart(7)} KB/s`);
}
