#!/usr/bin/env bash
# CI gate for hrpc-inspector-protocol. Non-zero exit blocks a release.
# Dependency-free: every suite is a standalone `node file.mjs`.
set -u
cd "$(dirname "$0")"
fail=0
run() { echo "--- $1"; if eval "$2"; then echo "    PASS"; else echo "    FAIL"; fail=1; fi; echo; }

echo "=== hrpc-inspector-protocol (L0 wire contract) ==="
echo "Node $(node --version)"
echo

run "protocol-package.test.mjs (public barrel + exports)"   "node protocol-package.test.mjs"
run "version-negotiate.test.mjs (adjacent-version interop)" "node version-negotiate.test.mjs"
run "utf8.test.mjs (codec == platform, byte for byte)"       "node utf8.test.mjs"
run "envelope-size.mjs (encoding cost measurement)"          "node envelope-size.mjs"
run "envelope-transport.mjs (per-transport envelope)"        "node envelope-transport.mjs"
run "cbor-selfcheck.mjs (optional cross-check vs cbor-x)"    "node cbor-selfcheck.mjs"

if [ $fail -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "VERIFICATION FAILED"; fi
exit $fail
