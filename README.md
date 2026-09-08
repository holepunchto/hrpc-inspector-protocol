# hrpc-inspector-protocol

L0 wire contract for [`hrpc-inspector`](https://github.com/holepunchto/hrpc-inspector). Everything
that has to agree between a probe, a collector and a viewer lives here, so no layer above invents
its own framing.

```
npm i hrpc-inspector-protocol
```

```js
import { encode, decode, negotiate, PeerRegistry } from 'hrpc-inspector-protocol'
```

## What it holds

| Subpath | Contents |
| --- | --- |
| `.` | the barrel — everything below |
| `./envelope` | the frozen `P2PEnvelope`, the four `ENCODING_IDS`, kind codecs |
| `./encode`, `./decode` | the four selectable encodings: `json-full`, `json-short`, `cbor-compact`, `cbor-binary` |
| `./version` | `PROTOCOL_VERSION`, adjacent-version `negotiate()`, tolerant field filtering |
| `./identity` | the identity-drop guard — refuses to drop peer identity on a channel that cannot recover it |
| `./registry` | `PeerRegistry` (6-byte FNV handle, lossless reverse map), `MethodRegistryImpl` |
| `./cbor`, `./ulid` | the hand-rolled CBOR codec and the 16-byte ULID bijection |
| `./utf8` | `utf8Encode` / `utf8Decode` |

## Why the codec is hand-rolled

Bare has no `TextEncoder`. Measured on `bare` v1.28.0:

```
$ bare -e 'console.log(typeof TextEncoder, typeof TextDecoder)'
undefined undefined
```

Those bytes are both the wire format **and** the input to the FNV-1a hashes that produce peer
handles, so a subtly wrong encoder does not crash — it silently changes hashes and breaks
cross-peer merge. `test/utf8.test.mjs` therefore asserts byte-for-byte equality against the
platform codec over 20 strings and 17 malformed inputs, with controls that a naive latin1 or CESU-8
loop fails.

## Test

```
npm test
```

Dependency-free: every suite is a standalone `node` script. `cbor-selfcheck` skips unless `cbor-x`
is installed, which is a pass, not a gap.

## License

[Apache-2.0](LICENSE). Copyright notice in [NOTICE](NOTICE).
