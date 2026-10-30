import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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