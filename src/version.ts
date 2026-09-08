// Protocol version negotiation + forward/backward-tolerant decode.
// Reuses the design proven in verification/version-negotiate.test.mjs:
//   1. Carry `v` in the envelope.
//   2. Decode by IGNORING unknown fields and DEFAULTING absent ones.
//   3. Handshake advertises [vmin,vmax]; peers use the highest common version,
//      or refuse CLEANLY (null) when ranges are disjoint.
//
// A P2P mesh has no central control, so peers on adjacent versions MUST interop
// or the envelope can never be rolled out.

export const PROTOCOL_VERSION = 1 as const;

export interface VersionRange {
  vmin: number;
  vmax: number;
}

/** This build's advertised range. Widen vmax when adding an additive version. */
export const SUPPORTED_RANGE: VersionRange = { vmin: 1, vmax: 1 };

/**
 * Highest common version, or null if the inclusive ranges do not overlap.
 * null means "refuse the connection", never "guess and mis-decode".
 */
export function negotiate(a: VersionRange, b: VersionRange): number | null {
  const lo = Math.max(a.vmin, b.vmin);
  const hi = Math.min(a.vmax, b.vmax);
  return hi >= lo ? hi : null;
}

// The load-bearing fields: whatever the version, these must survive decode or
// the timeline breaks. A decoder that loses these has silently corrupted, which
// is worse than refusing.
export const REQUIRED_FIELDS = ['corrId', 'method'] as const;

/**
 * Forward/backward-tolerant field filter. Keeps every field this build knows,
 * silently drops unknown (newer) fields, and throws if a required correlation
 * field is missing (a genuine break, e.g. a breaking future version forced onto
 * an old peer). `knownFields` is the set of keys THIS build understands.
 */
export function tolerantSelect<T extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  knownFields: Set<string>,
): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) if (knownFields.has(k)) out[k] = raw[k];
  for (const req of REQUIRED_FIELDS)
    if (out[req] === undefined || out[req] === null)
      throw new Error(`version: lost required field '${req}' — timeline would break`);
  return out as T;
}

/** The v1 field set (used as the tolerant decoder's known-field allowlist). */
export const V1_FIELDS = new Set<string>([
  'v', 'msgId', 'corrId', 'causedBy', 'traceparent',
  'kind', 'method', 'src', 'dst', 'ts', 'hlc', 'ttl', 'payload',
]);
