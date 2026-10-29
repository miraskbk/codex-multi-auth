import { readFile } from 'node:fs/promises';
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