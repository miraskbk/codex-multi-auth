import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAuthData } from '../dist/auth.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const token = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

async function fixture(t, data) {
  const home = await mkdtemp(join(tmpdir(), 'codex-auth-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, 'codex');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), data);
  return {
    profiles: join(home, '.codex-multi-auth'),
    run: () => spawnSync(process.execPath, [cli, 'add', 'personal'], {
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      encoding: 'utf8',
    }),
  };
}

test('rejects invalid JSON and credential shapes without echoing input', () => {
  for (const data of [
    'synthetic-secret-invalid-json', 'null', '[]', '42', '"text"', '{}',
    '{"tokens":[]}', '{"tokens":"secret"}', '{"tokens":{}}',
    '{"OPENAI_API_KEY":"  "}', '{"OPENAI_API_KEY":42}',
    '{"tokens":{"access_token":" "}}',
    '{"tokens":{"access_token":42}}',
    JSON.stringify({ tokens: { id_token: token({ email: 'person@example.com' }) } }),
  ]) {
    assert.throws(() => parseAuthData(data), (error) => {
      assert.match(error.message, /^Invalid auth file:/);
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
  }
});

test('invalid auth fails before printing account output or creating profiles', async (t) => {
  for (const data of ['null', '{}', '{"tokens":{"id_token":"identity-only"}}']) {
    const f = await fixture(t, data);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid auth file:/);
    await assert.rejects(access(f.profiles), { code: 'ENOENT' });
  }
});

test('saves ChatGPT credentials with email and preserves private file contents', async (t) => {
  const data = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      id_token: token({ email: 'person@example.com' }),
    },
    last_refresh: '2026-10-30T00:00:00Z',
  }, null, 2);
  const f = await fixture(t, data);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Saving account: person@example.com\nSaved profile: personal\n');
  const path = join(f.profiles, 'profiles', 'personal.json');
  assert.equal(await readFile(path, 'utf8'), data);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const duplicate = f.run();
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(await readFile(path, 'utf8'), data);
});

test('saves API keys and access tokens when email is unavailable', async (t) => {
  for (const auth of [
    { OPENAI_API_KEY: 'synthetic-api-key', tokens: null },
    { tokens: { access_token: 'synthetic-access' } },
    { tokens: { access_token: 'synthetic-access', id_token: 'malformed' } },
  ]) {
    const data = JSON.stringify(auth);
    const f = await fixture(t, data);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Saving account: email unavailable\nSaved profile: personal\n');
    assert.equal(await readFile(join(f.profiles, 'profiles', 'personal.json'), 'utf8'), data);
  }
});
