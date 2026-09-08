// Encode a P2PEnvelope to bytes in any of the FOUR measured encodings, selected
// by config — never one hardcoded choice. The encoding point on the
// bandwidth-vs-debuggability curve is a human call at gate G1; this module ships
// all four and leaves selection to the caller.
//
// Byte SIZES for the G1 decision are measured by verification/envelope-size.mjs
// and verification/envelope-transport.mjs (the canonical authority). This module
// reproduces the same representations (short keys, method->int, 6-byte peer
// hashes, binary ULIDs) and is proven LOSSLESS by verification/protocol-package.test.mjs.

import type { EncodingId, P2PEnvelope, MethodRegistry, Kind } from './envelope.ts';
import { kindToInt } from './envelope.ts';
import type { PeerRegistry } from './registry.ts';
import type { ChannelBinding } from './identity.ts';
import { assertIdentityDropAllowed } from './identity.ts';
import { encodeCbor } from './cbor.ts';
import { ulidToBytes } from './ulid.ts';
import { utf8Encode } from './utf8.ts';

export interface EncodeOptions {
  encoding: EncodingId;
  /** Required for cbor-compact and cbor-binary (method string -> int). */
  methods?: MethodRegistry;
  /** Required for json-short (handles), cbor-compact (handles), cbor-binary (hashes). */
  peers?: PeerRegistry;
  /** Drop src/dst from the wire. Requires a valid 1:1 binding (see identity.ts). */
  dropIdentity?: boolean;
  /** The channel binding — mandatory when dropIdentity is set; guards the drop. */
  binding?: ChannelBinding;
}

function splitHlc(hlc: string): [number, number, string] {
  const i = hlc.indexOf(':');
  const j = hlc.indexOf(':', i + 1);
  if (i < 0 || j < 0) throw new Error(`encode: malformed hlc '${hlc}' (want phys:ctr:node)`);
  return [Number(hlc.slice(0, i)), Number(hlc.slice(i + 1, j)), hlc.slice(j + 1)];
}

function resolveDrop(opts: EncodeOptions): boolean {
  if (!opts.dropIdentity) return false;
  if (!opts.binding) throw new Error('encode: dropIdentity requires a channel binding to guard it');
  assertIdentityDropAllowed(opts.binding); // throws IDENTITY_DROP_REFUSED if unsafe
  return true;
}

export function encode<T>(env: P2PEnvelope<T>, opts: EncodeOptions): Uint8Array {
  const drop = resolveDrop(opts);
  switch (opts.encoding) {
    case 'json-full':    return encodeJson(env, false, undefined, drop);
    case 'json-short':   return encodeJson(env, true, requirePeers(opts), drop);
    case 'cbor-compact': return encodeCborTier(env, 'compact', opts, drop);
    case 'cbor-binary':  return encodeCborTier(env, 'binary', opts, drop);
    default: throw new Error(`encode: unknown encoding '${opts.encoding as string}'`);
  }
}

function requirePeers(opts: EncodeOptions): PeerRegistry {
  if (!opts.peers) throw new Error(`encode: encoding '${opts.encoding}' requires a PeerRegistry`);
  return opts.peers;
}
function requireMethods(opts: EncodeOptions): MethodRegistry {
  if (!opts.methods) throw new Error(`encode: encoding '${opts.encoding}' requires a MethodRegistry`);
  return opts.methods;
}

// ---- JSON tiers -------------------------------------------------------------
function encodeJson<T>(env: P2PEnvelope<T>, shortPeers: boolean, peers: PeerRegistry | undefined, drop: boolean): Uint8Array {
  const o: Record<string, unknown> = {
    v: env.v, msgId: env.msgId, corrId: env.corrId,
    kind: env.kind, method: env.method, ts: env.ts, hlc: env.hlc,
  };
  if (env.causedBy !== undefined) o.causedBy = env.causedBy;
  if (env.traceparent !== undefined) o.traceparent = env.traceparent;
  if (env.ttl !== undefined) o.ttl = env.ttl;
  if (env.payload !== undefined) o.payload = env.payload;
  if (!drop) {
    o.src = shortPeers ? peers!.handleFor(env.src) : env.src;
    o.dst = shortPeers ? peers!.handleFor(env.dst) : env.dst;
  }
  return utf8Encode(JSON.stringify(o));
}

// ---- CBOR tiers -------------------------------------------------------------
function encodeCborTier<T>(env: P2PEnvelope<T>, tier: 'compact' | 'binary', opts: EncodeOptions, drop: boolean): Uint8Array {
  const methods = requireMethods(opts);
  const peers = requirePeers(opts);
  const [phys, ctr, node] = splitHlc(env.hlc);

  const m: Record<string, unknown> = {
    v: env.v,
    i: tier === 'binary' ? ulidToBytes(env.msgId) : env.msgId,
    c: tier === 'binary' ? ulidToBytes(env.corrId) : env.corrId,
    k: kindToInt(env.kind),
    m: methods.intern(env.method),
    t: env.ts,
    h: [phys, ctr, node],
  };
  if (env.causedBy !== undefined) m.b = tier === 'binary' ? ulidToBytes(env.causedBy) : env.causedBy;
  if (env.traceparent !== undefined) m.r = env.traceparent;
  if (env.ttl !== undefined) m.l = env.ttl;
  if (env.payload !== undefined) m.p = env.payload as unknown;
  if (!drop) {
    m.s = tier === 'binary' ? peers.hashFor(env.src) : peers.handleFor(env.src);
    m.d = tier === 'binary' ? peers.hashFor(env.dst) : peers.handleFor(env.dst);
  }
  return encodeCbor(m as never);
}

export type { Kind };
