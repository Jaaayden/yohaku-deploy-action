import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync, existsSync, unlinkSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/cleanup-releases.sh');
function fixture(t, versions, active) {
  const temp = mkdtempSync(join(tmpdir(), 'yohaku-cleanup-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const base = join(temp, 'deployment with spaces');
  mkdirSync(base);
  for (const version of versions) {
    mkdirSync(join(base, version, 'standalone'), { recursive: true });
    writeFileSync(join(base, version, 'standalone/server.js'), '');
  }
  symlinkSync(`${active}/standalone/server.js`, join(base, 'server.js'));
  return { temp, base };
}
const run = (base, keep, env = process.env) => spawnSync('bash', [script, base, ...(keep === undefined ? [] : [keep])], { encoding: 'utf8', env });
const dirs = base => readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+$/.test(d.name)).map(d => d.name).sort();
function success(result) { assert.equal(result.status, 0, result.stderr); }

test('default retains five, uses numeric order, and is idempotent', t => {
  const { base } = fixture(t, ['1', '2', '3', '4', '9', '10', '11'], '11');
  success(run(base));
  assert.deepEqual(dirs(base), ['10', '11', '3', '4', '9']);
  success(run(base));
  assert.deepEqual(dirs(base), ['10', '11', '3', '4', '9']);
});
test('preserves an older current version with configurable retention', t => {
  const { base } = fixture(t, ['1', '2', '3', '4', '5', '6'], '1');
  success(run(base, '3'));
  assert.deepEqual(dirs(base), ['1', '5', '6']);
  success(run(base, '1'));
  assert.deepEqual(dirs(base), ['1']);
});
test('fewer releases and arbitrarily large positive limits do not delete', t => {
  const { base } = fixture(t, ['1', '2'], '2');
  success(run(base));
  success(run(base, '9999999999999999999999999999999'));
  assert.deepEqual(dirs(base), ['1', '2']);
});
test('protects shared files, directories and numeric symlinks, including nested cache links', t => {
  const { base, temp } = fixture(t, ['1', '2', '3'], '3');
  for (const name of ['.env', 'ecosystem.config.js', '123']) writeFileSync(join(base, name), 'keep');
  for (const name of ['.cache', 'uploads', 'v123']) {
    mkdirSync(join(base, name));
    writeFileSync(join(base, name, 'sentinel'), 'keep');
  }
  const outside = join(temp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'keep');
  symlinkSync(outside, join(base, '999'));
  symlinkSync('../.cache', join(base, '1/cache'));
  success(run(base, '1'));
  for (const path of ['.env', 'ecosystem.config.js', '123', '.cache/sentinel', 'uploads/sentinel', 'v123/sentinel', '999/sentinel']) assert.ok(existsSync(join(base, path)), path);
  assert.ok(existsSync(join(outside, 'sentinel')));
  assert.deepEqual(dirs(base), ['3']);
});
test('invalid parameters fail without deletion', t => {
  const { base } = fixture(t, ['1', '2'], '2');
  for (const keep of ['', '0', '-1', '1.5', 'abc', '03', '1\n2']) {
    assert.notEqual(run(base, keep).status, 0);
    const validation = spawnSync('bash', [script, '--validate', keep]);
    assert.notEqual(validation.status, 0);
    assert.deepEqual(dirs(base), ['1', '2']);
  }
  success(spawnSync('bash', [script, '--validate', '5'], { encoding: 'utf8' }));
});
test('missing, broken, non-symlink and external entries fail without deletion', t => {
  const { base, temp } = fixture(t, ['1', '2'], '2');
  const entry = join(base, 'server.js');
  unlinkSync(entry);
  assert.notEqual(run(base, '1').status, 0);
  symlinkSync('missing/server.js', entry);
  assert.notEqual(run(base, '1').status, 0);
  unlinkSync(entry);
  writeFileSync(entry, '');
  assert.notEqual(run(base, '1').status, 0);
  unlinkSync(entry);
  writeFileSync(join(temp, 'server.js'), '');
  symlinkSync(join(temp, 'server.js'), entry);
  assert.notEqual(run(base, '1').status, 0);
  assert.deepEqual(dirs(base), ['1', '2']);
});
test('absolute current entry is supported', t => {
  const { base } = fixture(t, ['1', '2'], '2');
  unlinkSync(join(base, 'server.js'));
  symlinkSync(join(base, '2/standalone/server.js'), join(base, 'server.js'));
  success(run(base, '1'));
  assert.deepEqual(dirs(base), ['2']);
});
test('deletion failures are reported and return nonzero', t => {
  const { base, temp } = fixture(t, ['1', '2'], '2');
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'rm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = run(base, '1', { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot delete release:/);
  assert.ok(result.stderr.includes(join(base, '1')));
  assert.deepEqual(dirs(base), ['1', '2']);
});

test('workflow cleanup only runs after successful PM2 start/reload and save', t => {
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  const block = workflow.match(/          script: \|\n([\s\S]*?)\n      - name: After deploy script/)[1];
  const remote = block.replace(/^            /gm, '');
  assert.ok(remote.startsWith('set -e\n'));
  const tail = remote.slice(remote.indexOf('if pm2 describe'));
  for (const mode of ['start', 'reload']) {
    for (const failure of ['none', mode, 'save']) {
      const { base, temp } = fixture(t, ['1', '2'], '2');
      copyFileSync(script, join(base, 'cleanup-releases.sh'));
      // This portion of the existing workflow uses unquoted workdir paths.
      const workdir = join(temp, 'workdir');
      mkdirSync(workdir);
      writeFileSync(join(workdir, 'release.zip'), '');
      const bin = join(temp, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pm2'), '#!/bin/sh\nif [ "$1" = describe ]; then [ "$PM2_MODE" = reload ]; exit $?; fi\n[ "$1" != "$PM2_FAILURE" ]\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', `set -e\n${tail}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, basedir: base, workdir, KEEP_RELEASES: '1', PM2_MODE: mode, PM2_FAILURE: failure },
      });
      if (failure === 'none') {
        success(result);
        assert.deepEqual(dirs(base), ['2']);
      } else {
        assert.notEqual(result.status, 0);
        assert.deepEqual(dirs(base), ['1', '2']);
        assert.ok(!result.stdout.includes('Deleting release:'));
      }
    }
  }
});
