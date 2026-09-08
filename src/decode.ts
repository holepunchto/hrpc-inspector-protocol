// Decode bytes back to a P2PEnvelope for any of the four encodings. Round-trip
// (encode -> decode) is LOSSLESS for every encoding; see the assertion in
// verification/protocol-package.test.mjs.
//
// Version tolerance is applied here: unknown (newer) fields are ignored and
// required correlation fields are enforced, so a peer on an adjacent version
// decodes successfully instead of failing the whole connection.

import type { EncodingId, P2PEnvelope, MethodRegistry, Dst, PeerId } from './envelope.ts';
import { intToKind } from './envelope.ts';
import type { PeerRegistry } from './registry.ts';
import type { ChannelBinding } from './identity.ts';
import { decodeCbor } from './cbor.ts';
import { bytesToUlid } from './ulid.ts';
import { tolerantSelect, V1_FIELDS } from './version.ts';
import { utf8Decode } from './utf8.ts';

export interface DecodeOptions {
  encoding: EncodingId;
  methods?: MethodRegistry;
  peers?: PeerRegistry;
  /** When identity was dropped, this recovers src/dst from the channel->peer map. */
  binding?: ChannelBinding;
}

function recoverIdentity(binding: ChannelBinding | undefined): { src: PeerId; dst: Dst } {
  if (!binding || !binding.resolveSrc || !binding.resolveDst)
    throw new Error('decode: identity was dropped but no binding.resolveSrc/resolveDst to recover it');
  return { src: binding.resolveSrc(), dst: binding.resolveDst() };
}

export function decode<T = unknown>(bytes: Uint8Array, opts: DecodeOptions): P2PEnvelope<T> {
  switch (opts.encoding) {
    case 'json-full':    return decodeJson<T>(bytes, false, opts);
    case 'json-short':   return decodeJson<T>(bytes, true, opts);
    case 'cbor-compact': return decodeCborTier<T>(bytes, 'compact', opts);
    case 'cbor-binary':  return decodeCborTier<T>(bytes, 'binary', opts);
    default: throw new Error(`decode: unknown encoding '${opts.encoding as string}'`);
  }
}

function requirePeers(opts: DecodeOptions): PeerRegistry {
  if (!opts.peers) throw new Error(`decode: encoding '${opts.encoding}' requires a PeerRegistry`);
  return opts.peers;
}
function requireMethods(opts: DecodeOptions): MethodRegistry {
  if (!opts.methods) throw new Error(`decode: encoding '${opts.encoding}' requires a MethodRegistry`);
  return opts.methods;
}

// ---- JSON -------------------------------------------------------------------
function decodeJson<T>(bytes: Uint8Array, shortPeers: boolean, opts: DecodeOptions): P2PEnvelope<T> {
  const raw = JSON.parse(utf8Decode(bytes, { fatal: true })) as Record<string, unknown>;
  const sel = tolerantSelect<Record<string, unknown>>(raw, V1_FIELDS);

  let src: PeerId; let dst: Dst;
  if ('src' in sel && 'dst' in sel) {
    if (shortPeers) {
      const peers = requirePeers(opts);
      src = peers.peerFromHandle(sel.src as string);
      dst = peers.peerFromHandle(sel.dst as string) as Dst;
    } else {
      src = sel.src as PeerId;
      dst = sel.dst as Dst;
    }
  } else {
    ({ src, dst } = recoverIdentity(opts.binding));
  }

  return assemble<T>(sel, src, dst, sel.method as string, sel.kind as string);
}

// ---- CBOR -------------------------------------------------------------------
function decodeCborTier<T>(bytes: Uint8Array, tier: 'compact' | 'binary', opts: DecodeOptions): P2PEnvelope<T> {
  const methods = requireMethods(opts);
  const peers = requirePeers(opts);
  const m = decodeCbor(bytes) as Record<string, unknown>;

  const hlcArr = m.h as [number, number, string];
  const hlc = `${hlcArr[0]}:${hlcArr[1]}:${hlcArr[2]}`;
  const method = methods.lookup(m.m as number);
  const kind = intToKind(m.k as number);

  let src: PeerId; let dst: Dst;
  if ('s' in m && 'd' in m) {
    if (tier === 'binary') {
      src = peers.peerFromHash(m.s as Uint8Array);
      dst = peers.peerFromHash(m.d as Uint8Array) as Dst;
    } else {
      src = peers.peerFromHandle(m.s as string);
      dst = peers.peerFromHandle(m.d as string) as Dst;
    }
  } else {
    ({ src, dst } = recoverIdentity(opts.binding));
  }

  const env: P2PEnvelope<T> = {
    v: 1,
    msgId: tier === 'binary' ? bytesToUlid(m.i as Uint8Array) : (m.i as string),
    corrId: tier === 'binary' ? bytesToUlid(m.c as Uint8Array) : (m.c as string),
    kind, method, src, dst,
    ts: m.t as number,
    hlc,
    payload: (m.p as T),
  };
  if ('b' in m) env.causedBy = tier === 'binary' ? bytesToUlid(m.b as Uint8Array) : (m.b as string);
  if ('r' in m) env.traceparent = m.r as string;
  if ('l' in m) env.ttl = m.l as number;
  return env;
}

// ---- shared assembly (JSON path) --------------------------------------------
function assemble<T>(sel: Record<string, unknown>, src: PeerId, dst: Dst, method: string, kind: string): P2PEnvelope<T> {
  const env: P2PEnvelope<T> = {
    v: 1,
    msgId: sel.msgId as string,
    corrId: sel.corrId as string,
    kind: kind as P2PEnvelope['kind'],
    method,
    src, dst,
    ts: sel.ts as number,
    hlc: sel.hlc as string,
    payload: (sel.payload as T),
  };
  if ('causedBy' in sel) env.causedBy = sel.causedBy as string;
  if ('traceparent' in sel) env.traceparent = sel.traceparent as string;
  if ('ttl' in sel) env.ttl = sel.ttl as number;
  return env;
}
