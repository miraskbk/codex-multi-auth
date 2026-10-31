import { mkdir, writeFile, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isLockInUse, withDirectoryLock, type LockOwner } from './locks.js';



interface AuthData {
  OPENAI_API_KEY?: unknown;
  tokens?: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseAuthData(authData: string): AuthData {
  let auth: unknown;
  try {
    auth = JSON.parse(authData);
  } catch {
    throw new Error('Invalid auth file: expected valid JSON.');
  }

  if (!isRecord(auth)) {
    throw new Error('Invalid auth file: expected a JSON object.');
  }

  const tokens = auth.tokens;
  if (tokens !== undefined && tokens !== null && !isRecord(tokens)) {
    throw new Error('Invalid auth file: tokens must be an object.');
  }

  if (
    !isNonEmptyString(auth.OPENAI_API_KEY) &&
    !(isRecord(tokens) && isNonEmptyString(tokens.access_token))
  ) {
    throw new Error('Invalid auth file: expected a non-empty API key or access token.');
  }

  return auth as AuthData;
}

export async function readCurrentAuth(): Promise<string> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const authPath = join(codexHome, 'auth.json');

  try {
    return await readFile(authPath, 'utf8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      throw new Error(
        `No auth file found at ${authPath}. Sign in with Codex or check whether it uses keyring storage.`,
      );
    }

    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Permission denied reading ${authPath}.`);
    }

    throw error;
  }
}


export function emailFromIdToken(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;

    const payload: unknown = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    );

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('email' in payload)
    ) {
      return undefined;
    }

    return typeof payload.email === 'string'
      ? payload.email
      : undefined;
  } catch {
    return undefined;
  }
}





export async function saveProfile(
  name: string,
  authData: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error('Invalid profile name.');
  }

  parseAuthData(authData);

  const profilesDir = join(homedir(), '.codex-multi-auth', 'profiles');
  const profilePath = join(profilesDir, `${name}.json`);

  await mkdir(profilesDir, {
    recursive: true,
    mode: 0o700,
  });

  try {
    await writeFile(profilePath, authData, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Profile "${name}" already exists.`);
    }

    throw error;
  }
}




export interface ProfileSummary {
  name: string;
  email: string | undefined;
  status: 'saved' | 'in use' | 'signed out' | 'invalid' | 'unreadable';
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const root = join(homedir(), '.codex-multi-auth');
  const readEntries = (path: string) => readdir(path, { withFileTypes: true })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });

  const [savedEntries, homeEntries] = await Promise.all([
    readEntries(join(root, 'profiles')),
    readEntries(join(root, 'homes')),
  ]);

  const names = new Set([
    ...savedEntries
      .filter((entry) => entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -5)),
    ...homeEntries
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name))
      .map((entry) => entry.name),
  ]);

  const profiles: ProfileSummary[] = [];

  for (const name of [...names].sort()) {
    let data: string | undefined;
    let inUse: boolean;
    try {
      inUse = await isLockInUse(join(root, 'locks', name));
      const home = profileHome(name);
      data = await readOptional(join(home, 'auth.json'));
      if (data === undefined) {
        if (await exists(home)) {
          profiles.push({ name, email: undefined, status: 'signed out' });
          continue;
        }
        data = await readOptional(profilePath(name));
      }
    } catch {
      profiles.push({ name, email: undefined, status: 'unreadable' });
      continue;
    }

    if (data === undefined) continue;

    try {
      const auth = parseAuthData(data);
      const token = auth.tokens?.id_token;
      const email = typeof token === 'string' ? emailFromIdToken(token) : undefined;
      profiles.push({ name, email, status: inUse ? 'in use' : 'saved' });
    } catch {
      profiles.push({ name, email: undefined, status: 'invalid' });
    }
  }

  return profiles;
}


export function profileHome(name: string): string {
  validateProfileName(name);
  return join(homedir(), '.codex-multi-auth', 'homes', name);
}

function validateProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error('Invalid profile name.');
  }
}





function profilePath(name: string): string {
  validateProfileName(name);
  return join(homedir(), '.codex-multi-auth', 'profiles', `${name}.json`);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}




async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}




export async function writeAuthAtomically(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}



export async function readProfileAuth(name: string): Promise<string> {
  const home = profileHome(name);
  let data = await readOptional(join(home, 'auth.json'));
  if (data === undefined) {
    
    if (await exists(home)) {
      throw new Error(`Profile "${name}" is signed out. Run: codex-multi-auth run ${name} -- login`);
    }
    data = await readOptional(profilePath(name));
  }
  if (data === undefined) throw new Error(`Profile "${name}" does not exist.`);
  parseAuthData(data);
  return data;
}



export async function withProfileLock<T>(name: string, action: (owner: LockOwner) => Promise<T>): Promise<T> {
  validateProfileName(name);
  const locks = join(homedir(), '.codex-multi-auth', 'locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  return withDirectoryLock(join(locks, name), action);
}





export async function prepareProfileHome(name: string): Promise<string> {
  const home = profileHome(name);
  if (await exists(home)) return home;
  const data = await readProfileAuth(name);
  await mkdir(join(homedir(), '.codex-multi-auth', 'homes'), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  try {
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' });
    await writeAuthAtomically(join(home, 'auth.json'), data);
  } catch (error: unknown) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

export async function syncProfileHome(name: string): Promise<void> {
  const data = await readOptional(join(profileHome(name), 'auth.json'));
  if (data === undefined) return; 
  parseAuthData(data);
  await writeAuthAtomically(profilePath(name), data);
}

function digest(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function authIdentity(data: string): string | null {
  const auth = parseAuthData(data);
  if (isNonEmptyString(auth.OPENAI_API_KEY)) return digest(auth.OPENAI_API_KEY);
  const accountId = auth.tokens?.account_id;
  const token = auth.tokens?.id_token;
  let subject: unknown;
  if (typeof token === 'string') {
    try {
      const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (isRecord(payload)) subject = payload.sub;
    } catch { }
  }
  if (!isNonEmptyString(accountId) && !isNonEmptyString(subject)) return null;
  return digest(JSON.stringify([accountId ?? null, subject ?? null]));
}

interface ActiveProfile {
  name: string;
  identity: string | null;
  hash: string;
}

async function readActiveProfile(path: string): Promise<ActiveProfile | undefined> {
  const data = await readOptional(path);
  if (data === undefined) return undefined;
  let active: unknown;
  try { active = JSON.parse(data); } catch { throw new Error('Invalid active-profile metadata.'); }
  if (!isRecord(active) || typeof active.name !== 'string' ||
      typeof active.hash !== 'string' || !(active.identity === null || typeof active.identity === 'string')) {
    throw new Error('Invalid active-profile metadata.');
  }
  validateProfileName(active.name);
  return { name: active.name, identity: active.identity, hash: active.hash };
}

export async function useProfile(
  name: string,
): Promise<{ email: string | undefined; backupPath: string | undefined }> {
  await readProfileAuth(name);
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const authPath = join(codexHome, 'auth.json');
  const activePath = join(codexHome, '.codex-multi-auth-active.json');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });

  return withDirectoryLock(join(codexHome, '.codex-multi-auth-switch.lock'), async () => {
    const active = await readActiveProfile(activePath);
    const names = [...new Set([name, ...(active ? [active.name] : [])])].sort();
    async function lockProfiles(index: number): Promise<{ email: string | undefined; backupPath: string | undefined }> {
      const next = names[index];
      if (next !== undefined) return withProfileLock(next, () => lockProfiles(index + 1));

      const current = await readOptional(authPath);
      const activeExists = active !== undefined && (
      await exists(profilePath(active.name)) ||
      await exists(profileHome(active.name))
);

if (
  active &&
  activeExists &&
  current !== undefined &&
  digest(current) !== active.hash
) {

        let matches = false;
        if (active.identity !== null) {
          try { matches = authIdentity(current) === active.identity; } catch {  }
        }
        if (matches) {
          parseAuthData(current);
          const saved = await readProfileAuth(active.name);
          if (digest(saved) !== active.hash && saved !== current) {
            throw new Error(`Credentials for "${active.name}" changed in both the default and isolated homes. Resolve the two logins before switching; neither copy was overwritten.`);
          }
          await writeAuthAtomically(profilePath(active.name), current);
          const home = profileHome(active.name);
          if (await exists(home)) await writeAuthAtomically(join(home, 'auth.json'), current);
        }
      }

      const data = await readProfileAuth(name);
      const auth = parseAuthData(data);
      const token = auth.tokens?.id_token;
      const email = typeof token === 'string' ? emailFromIdToken(token) : undefined;
      let backupPath: string | undefined;
      if (current !== undefined) {
        backupPath = join(codexHome, `auth.json.backup-${randomUUID()}`);
        await writeFile(backupPath, current, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
      await writeAuthAtomically(authPath, data);
      await writeAuthAtomically(activePath, JSON.stringify({ name, identity: authIdentity(data), hash: digest(data) }));
      return { email, backupPath };
    }
    return lockProfiles(0);
  });
}




export async function removeProfile(
  name: string,
  force = false,
): Promise<void> {
  await withProfileLock(name, async () => {
    const savedPath = profilePath(name);
    const home = profileHome(name);

    const hasSavedProfile = await exists(savedPath);
    const hasHome = await exists(home);

    if (!hasSavedProfile && !hasHome) {
      throw new Error(`Profile "${name}" does not exist.`);
    }


    if (hasHome && !force) {
      throw new Error(
        `Profile "${name}" has an isolated Codex home containing ` +
        'credentials, session history, and configuration. ' +
        'Use --force to delete it.',
      );
    }

    if (hasHome) {
      await rm(home, { recursive: true });
    }

    await rm(savedPath, { force: true });
  });
}
