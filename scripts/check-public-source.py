#!/usr/bin/env python3
"""Fail closed if private/runtime material enters the public Git tree."""
from pathlib import Path
import re
import json
import hashlib
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
paths = [p.decode() for p in subprocess.check_output(
    ['git', 'ls-files', '-z'], cwd=root).split(b'\0') if p]
forbidden_dirs = {'proprietary', 'node_modules', '.auth', 'backups', 'output', '.playwright-mcp'}
forbidden_suffixes = {'.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.sqlite', '.sqlite3', '.tfstate', '.tfplan', '.har', '.log'}
errors = []
blocked_hashes = set(json.loads((root / 'config/private-asset-fingerprints.json').read_text())['blocked_sha256'])

def check_content(data, label):
    digests = (hashlib.sha256(data).hexdigest(), hashlib.sha256(re.sub(rb'\s+', b'', data)).hexdigest())
    if any(digest in blocked_hashes for digest in digests):
        errors.append((label, 'excluded private asset content'))

env_secret = re.compile(r'^(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PEPPER|DSN|CLIENT_ID))=(.*)$')
for name in paths:
    rel = Path(name)
    path = root / rel
    check_content(path.read_bytes(), name)
    if any(part in forbidden_dirs for part in rel.parts) or rel.suffix.lower() in forbidden_suffixes or '.tfstate.' in rel.name:
        errors.append((name, 'private/runtime path'))
    if path.is_symlink():
        errors.append((name, 'symlink'))
    if rel.name.startswith('.env'):
        if not rel.name.endswith(('.example', '.template')):
            errors.append((name, 'local environment file'))
        for number, line in enumerate(path.read_text().splitlines(), 1):
            match = env_secret.match(line)
            if match and match[2].split('#', 1)[0].strip().strip('"\''):
                errors.append((name, 'assigned credential in environment example at line ' + str(number)))
if '--history' in sys.argv:
    object_ids = sorted(set(line.split()[0] for line in subprocess.check_output(
        ['git', 'rev-list', '--objects', '--all'], cwd=root, text=True).splitlines()))
    process = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=root,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for object_id in object_ids:
        process.stdin.write((object_id + '\n').encode())
        process.stdin.flush()
        header = process.stdout.readline().split()
        if len(header) != 3 or not header[2].isdigit():
            raise RuntimeError('Cannot read Git object: ' + object_id)
        data = process.stdout.read(int(header[2]))
        if process.stdout.read(1) != b'\n':
            raise RuntimeError('Incomplete Git object: ' + object_id)
        if header[1] == b'blob':
            check_content(data, 'git-object:' + object_id)
    process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError('Git object inspection failed')

for name, reason in errors:
    print(name + ': ' + reason)
if errors:
    sys.exit(1)
print('Public-source boundary OK (' + str(len(paths)) + ' tracked files)')
