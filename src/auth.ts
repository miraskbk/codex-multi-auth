import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
