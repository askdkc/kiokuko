# AgenticReplay security repack

`agenticreplay-0.1.11.tgz` is a development-only repack of the official npm
release, licensed Apache-2.0. The archive retains the upstream license and notices.
The CLI and all other files are unchanged. This is not a new upstream release.

Upstream: https://registry.npmjs.org/agenticreplay/-/agenticreplay-0.1.11.tgz

The upstream archive bundles `fast-uri@3.1.8`. Even a clean npm install ignores
overrides for that bundled copy. It is affected by GHSA-w74x-v6f9-j3xg,
GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr and GHSA-333x-w4r6-6crp.

The repack removes only `node_modules/fast-uri` and changes the root manifest
to declare `fast-uri: ^3.1.9` as an ordinary, unbundled dependency. All original
internal packages remain bundled because they are not separately published.
Their Ajv dependency resolves the patched fast-uri through normal Node resolution.
The lockfile records the repacked archive integrity and the patched dependency.
There is no postinstall patch or audit suppression.

Regenerate from the verified official release:

```sh
npm pack agenticreplay@0.1.11 --ignore-scripts --pack-destination /tmp
python3 scripts/vendor-agenticreplay.py /tmp/agenticreplay-0.1.11.tgz
npm install --ignore-scripts
npm ci
npm audit
npm run verify
```

The script rejects any upstream archive with a different SHA-512. Keep the
compatibility policy in `config.agenticreplayCompatibility`; the managed-recorder
checks still reject incompatible versions and lock/installation mismatches.
Once upstream ships a safe bundle, restore the registry compatibility range in
`devDependencies.agenticreplay`, remove the config override and this vendored
archive, refresh the lock, then run audit and full verification.

The archive is included in the Kiokuko package because npm resolves local dev
dependency specifications even during the optional semantic-runtime installation.
AgenticReplay itself remains a dev dependency and is not installed for end users.
