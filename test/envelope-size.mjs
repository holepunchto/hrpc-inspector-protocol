// Measures envelope overhead. Zero dependencies by design — a verification suite
// that needs `npm install` is one more thing that can rot.
// The minimal CBOR encoder below is cross-checked against the cbor-x library in
// cbor-selfcheck.mjs; run that if you modify it.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(t = Date.now()) {
  let s = '';
  for (let i = 9; i >= 0; i--) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  for (let i = 0; i < 16; i++) s += B32[(Math.random() * 32) | 0];
  return s; // 26 chars, timestamp-prefixed
}

// --- Minimal CBOR size calculator: maps, strings, ints, arrays, byte strings ---
export function cborSize(v) {
  const head = (n) => n < 24 ? 1 : n < 256 ? 2 : n < 65536 ? 3 : n < 4294967296 ? 5 : 9;
  if (v === null || v === undefined) return 1;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return 9;
    return head(v < 0 ? -v - 1 : v);
  }
  if (typeof v === 'string') { const b = Buffer.byteLength(v, 'utf8'); return head(b) + b; }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return head(v.length) + v.length;
  if (Array.isArray(v)) return head(v.length) + v.reduce((a, x) => a + cborSize(x), 0);
  if (typeof v === 'object') {
    const ks = Object.keys(v);
    return head(ks.length) + ks.reduce((a, k) => a + cborSize(k) + cborSize(v[k]), 0);
  }
  throw new Error('unsupported type: ' + typeof v);
}

const jsonSize = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

const FULL_PEER  = '12D3KooWGRYw3mQvA9nEr7kL2pXqT8vB4cN6dH1sJ5fY7uZ3aM9x'; // libp2p PeerId, 52 chars
const SHORT_PEER = 'QmYwAPJz';                                              // truncated, 8 chars

export const readable = (src, dst) => ({
  v: 1, msgId: ulid(), corrId: ulid(), kind: 'req', method: 'blocks.fetch',
  src, dst, ts: Date.now(), hlc: `${Date.now()}:0:${src.slice(0, 6)}`,
});
export const compact = (src, dst) => ({
  v: 1, i: ulid(), c: ulid(), k: 0, m: 7, s: src, d: dst,
  t: Date.now(), h: [Date.now(), 0],
});
export const binary = () => ({
  v: 1, i: Buffer.alloc(16), c: Buffer.alloc(16), k: 0, m: 7,
  s: Buffer.alloc(6), d: Buffer.alloc(6), t: Date.now(), h: [Date.now(), 0],
});
export const PEERS = { FULL_PEER, SHORT_PEER };

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [
    ['JSON, full PeerIds',                      jsonSize(readable(FULL_PEER, FULL_PEER))],
    ['JSON, short PeerIds',                     jsonSize(readable(SHORT_PEER, SHORT_PEER))],
    ['CBOR, full PeerIds',                      cborSize(readable(FULL_PEER, FULL_PEER))],
    ['CBOR, short PeerIds',                     cborSize(readable(SHORT_PEER, SHORT_PEER))],
    ['CBOR, compact keys + method registry',    cborSize(compact(SHORT_PEER, SHORT_PEER))],
    ['CBOR, binary ULIDs + 6-byte peer hashes', cborSize(binary())],
  ];
  const w = Math.max(...rows.map(r => r[0].length));
  console.log('Envelope overhead per message (payload excluded)\n');
  for (const [l, b] of rows) console.log(`  ${l.padEnd(w)}  ${String(b).padStart(4)} bytes`);

  console.log('\nWhere the cost actually is:\n');
  console.log(`  2 x ULID as 26-char base32   ${2*26} bytes of string`);
  console.log(`  2 x full libp2p PeerId       ${2*52} bytes of string`);
  console.log(`  => ${2*26+2*52} of ${rows[0][1]} bytes is identifier encoding, not container format.`);
  console.log('  This is why switching JSON -> CBOR alone saves little.');

  console.log('\nOverhead cost at sustained message rates:\n');
  const worst = rows[0][1], best = rows[rows.length-1][1];
  for (const r of [10,100,500,2000])
    console.log(`  ${String(r).padStart(4)} msg/s   worst ${(worst*r/1024).toFixed(1).padStart(6)} KB/s   best ${(best*r/1024).toFixed(1).padStart(6)} KB/s`);

  console.log('\nNOTE: re-measure for your own field set. These numbers show');
  console.log('where cost hides; they are not a universal constant.');
}
