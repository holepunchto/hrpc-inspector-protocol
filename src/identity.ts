// Identity-drop: an ORTHOGONAL lever for envelope size.
//
// Dropping src/dst saves an identical amount at each encoding tier regardless of
// transport (it removes the same two field-values), so it is NOT a libp2p-only
// or encoding-specific optimisation. What varies per transport is only WHERE the
// channel->peer map lives.
//
// The boundary is a HARD correctness rule, not a comment: dropping identity is
// valid ONLY on a channel where one channel == one remote peer. On multiplexed /
// relayed / fan-out channels a single channel carries messages for MANY logical
// peers, so the channel no longer identifies src/dst and the envelope MUST carry
// them. This module encodes that boundary as a runtime guard the encoder calls.

import type { PeerId } from './envelope.ts';

export type ChannelTopology =
  | 'unicast-1to1' // one channel == exactly one remote peer
  | 'multiplexed'  // one channel carries many logical peers (yamux streams, etc.)
  | 'relayed'      // traffic transits a relay; channel peer != message peer
  | 'fanout';      // broadcast / gossip to many peers

export type Transport = 'libp2p' | 'webrtc-dc' | 'raw-tcp' | 'raw-udp';

export interface ChannelBinding {
  topology: ChannelTopology;
  transport: Transport;
  /** Recover src when identity was dropped (the channel->peer map). */
  resolveSrc?: () => PeerId;
  /** Recover dst when identity was dropped. */
  resolveDst?: () => PeerId;
}

export interface IdentityDropCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Pure predicate: may identity be dropped on this binding?
 * - Only 'unicast-1to1' topology qualifies.
 * - raw-udp is refused even for 1:1: a bound UDP socket is connectionless and
 *   its (addr,port)->peer map breaks under NAT rebinding / relay (C20).
 * - resolveSrc/resolveDst must be present, or decode cannot recover identity.
 */
export function checkIdentityDrop(binding: ChannelBinding): IdentityDropCheck {
  if (binding.topology !== 'unicast-1to1')
    return { ok: false, reason: `identity-drop invalid on '${binding.topology}' channel: one channel carries multiple logical peers; envelope must carry src/dst` };
  if (binding.transport === 'raw-udp')
    return { ok: false, reason: 'identity-drop refused on raw-udp: connectionless (addr,port)->peer map breaks under NAT rebinding/relay; keep identity in-envelope' };
  if (typeof binding.resolveSrc !== 'function' || typeof binding.resolveDst !== 'function')
    return { ok: false, reason: 'identity-drop requires resolveSrc and resolveDst (the channel->peer map) so decode can recover src/dst' };
  return { ok: true };
}

export function canDropIdentity(binding: ChannelBinding): boolean {
  return checkIdentityDrop(binding).ok;
}

/** Throwing form the encoder uses to refuse an unsafe drop. */
export function assertIdentityDropAllowed(binding: ChannelBinding): void {
  const r = checkIdentityDrop(binding);
  if (!r.ok) throw new Error('IDENTITY_DROP_REFUSED: ' + r.reason);
}
