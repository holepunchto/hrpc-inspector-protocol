// L0 wire contract. Every downstream layer (L1 probes, L2 collector, L4 panel)
// imports THIS file. Field names are frozen — three other build agents build
// against them.

export type PeerId = string;

/** '*' = broadcast / gossip fan-out target. */
export type Dst = PeerId | '*';

export type Kind = 'req' | 'res' | 'event' | 'ack' | 'err';

export interface P2PEnvelope<T = unknown> {
  /** Protocol major version. Carried on the wire so adjacent versions interop. */
  v: 1;
  /** ULID — timestamp-prefixed, lexicographically sortable, unique per message. */
  msgId: string;
  /** Request and its response(s) share this. Without it there is no timeline. */
  corrId: string;
  /** Parent msgId — builds the causality tree for fan-out. Not optional in spirit. */
  causedBy?: string;
  /** W3C Trace Context (see §2.2). */
  traceparent?: string;
  kind: Kind;
  /** Pseudo-URL, e.g. 'blocks.fetch'. The field that makes the waterfall legible. */
  method: string;
  src: PeerId;
  dst: Dst;
  /** Sender wall clock (epoch ms). Untrusted — see §8. */
  ts: number;
  /** Hybrid logical clock string "phys:ctr:node". Trusted causal ordering. */
  hlc: string;
  ttl?: number;
  payload: T;
}

/** Stable encoder identifiers. Do NOT rename — downstream agents key off these. */
export type EncodingId = 'json-full' | 'json-short' | 'cbor-compact' | 'cbor-binary';

export const ENCODING_IDS: readonly EncodingId[] = [
  'json-full',
  'json-short',
  'cbor-compact',
  'cbor-binary',
] as const;

/**
 * Bidirectional method string<->int registry contract (used by cbor-compact and
 * cbor-binary). Interning a method returns a small int; the int is meaningless
 * on the wire without this table — that is the debuggability cost of the compact
 * tiers, and it is a deliberate, human-gated (G1) tradeoff.
 */
export interface MethodRegistry {
  /** Return the int id for a method, assigning a new one if unseen. */
  intern(method: string): number;
  /** Recover the method string for an int id, or throw if unknown. */
  lookup(id: number): string;
}

const KIND_TO_INT: Record<Kind, number> = { req: 0, res: 1, event: 2, ack: 3, err: 4 };
const INT_TO_KIND: Kind[] = ['req', 'res', 'event', 'ack', 'err'];

export function kindToInt(k: Kind): number {
  const n = KIND_TO_INT[k];
  if (n === undefined) throw new Error(`unknown kind '${k}'`);
  return n;
}

export function intToKind(n: number): Kind {
  const k = INT_TO_KIND[n];
  if (k === undefined) throw new Error(`unknown kind int ${n}`);
  return k;
}
