// @holepunchto/bare-protocol — L0 shared contract. Barrel for L1 probes, L2 collector, L4 panel.

export type {
  PeerId, Dst, Kind, P2PEnvelope, EncodingId, MethodRegistry,
} from './envelope.ts';
export { ENCODING_IDS, kindToInt, intToKind } from './envelope.ts';

export { encode } from './encode.ts';
export type { EncodeOptions } from './encode.ts';
export { decode } from './decode.ts';
export type { DecodeOptions } from './decode.ts';

export { MethodRegistryImpl, PeerRegistry } from './registry.ts';

export {
  PROTOCOL_VERSION, SUPPORTED_RANGE, negotiate, tolerantSelect,
  REQUIRED_FIELDS, V1_FIELDS,
} from './version.ts';
export type { VersionRange } from './version.ts';

export {
  checkIdentityDrop, canDropIdentity, assertIdentityDropAllowed,
} from './identity.ts';
export type {
  ChannelTopology, Transport, ChannelBinding, IdentityDropCheck,
} from './identity.ts';

export { encodeCbor, decodeCbor } from './cbor.ts';
export { ulidToBytes, bytesToUlid } from './ulid.ts';
