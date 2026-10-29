"""Remove the vulnerable bundled fast-uri from a verified upstream release.

Usage: python3 scripts/vendor-agenticreplay.py /path/to/agenticreplay-0.1.11.tgz
Only the archive's package.json and bundled fast-uri are changed.
"""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

UPSTREAM_SHA512 = 'XqU1OJUAuoR35YmrtSZzbXeHup9tPGFxicpmCcx+p8nW9KRSc9qeSCXOuuQ51mStMWA/Vcbs2+6WFt8ALQy9/w=='


def repack(source, destination):
    data = source.read_bytes()
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != UPSTREAM_SHA512:
        raise ValueError('Upstream AgenticReplay archive integrity mismatch')
    # Fixed gzip metadata makes regeneration byte-identical on the same Python/zlib.
    with destination.open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as upstream:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    for entry in upstream:
                        if entry.name == 'package/node_modules/fast-uri' or entry.name.startswith('package/node_modules/fast-uri/'):
                            continue
                        content = upstream.extractfile(entry).read() if entry.isfile() else None
                        if entry.name == 'package/package.json':
                            manifest = json.loads(content)
                            manifest['bundleDependencies'] = list(manifest['dependencies'])
                            manifest['dependencies']['fast-uri'] = '^3.1.9'
                            content = (json.dumps(manifest, indent=2) + '\n').encode()
                            entry.size = len(content)
                        archive.addfile(entry, io.BytesIO(content) if content is not None else None)


if __name__ == '__main__':
    target = Path(__file__).resolve().parents[1] / 'vendor/agenticreplay-0.1.11.tgz'
    repack(Path(sys.argv[1]), target)
    print(hashlib.sha256(target.read_bytes()).hexdigest(), target)
