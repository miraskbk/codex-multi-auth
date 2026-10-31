import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import type { LockOwner } from './locks.js';
import {
  emailFromIdToken,
  parseAuthData,
  prepareProfileHome,
  readProfileAuth,
  syncProfileHome,
  withProfileLock,
} from './auth.js';

export function profileEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };

  for (const key of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
    'OPENAI_FEDERATION_RULE_ID', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  ]) {
    delete env[key];
  }
  return env;
}

function codexError(error: Error): Error {
  return new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'Codex CLI was not found. Install it and ensure codex is on PATH.'
    : 'Unable to start Codex CLI.');
}

export async function runProfile(name: string, args: string[]): Promise<number> {
  if (args[0] === '--') args = args.slice(1);
  if (args.some((arg) => arg === '--remote' || arg.startsWith('--remote=') || /cli_auth_credentials_store\s*=/.test(arg))) {
    throw new Error('Profile runs require local Codex with file-based credential storage.');
  }
  return withProfileLock(name, async (owner) => {
    const home = await prepareProfileHome(name);
    try {
      const { child, completion } = await owner.spawn('codex', ['-c', 'cli_auth_credentials_store="file"', ...args], {
        env: profileEnvironment(home),
        stdio: 'inherit',
      }).catch((error: Error) => { throw codexError(error); });
      const interrupt = () => { child.kill('SIGINT'); };
      const terminate = () => { child.kill('SIGTERM'); };
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      try {
        const { code, signal } = await completion;
        return code ?? (signal ? 128 + constants.signals[signal] : 1);
      } catch (error: unknown) {
        throw codexError(error as Error);
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      }
    } finally {
      await syncProfileHome(name);
    }
  });
}

export interface ProfileCheck {
  email: string | undefined;
  method: 'API key' | 'ChatGPT';
  status: string;
  expired: boolean;
}

export function inspectAuth(data: string, now = Date.now()): ProfileCheck {
  const auth = parseAuthData(data);
  const idToken = auth.tokens?.id_token;
  const email = typeof idToken === 'string' ? emailFromIdToken(idToken) : undefined;
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
    return { email, method: 'API key', status: 'Credentials present; not verified online.', expired: false };
  }
  let expiry: number | undefined;
  const accessToken = auth.tokens?.access_token;
  if (typeof accessToken === 'string') {
    try {
      const parts = accessToken.split('.');
      const claims: unknown = parts.length === 3
        ? JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
        : undefined;
      if (claims && typeof claims === 'object' && 'exp' in claims &&
          typeof claims.exp === 'number' && Number.isFinite(claims.exp) &&
          Math.abs(claims.exp * 1000) <= 8.64e15) expiry = claims.exp;
    } catch { }
  }
  const expired = expiry !== undefined && expiry * 1000 <= now;
  const status = expiry === undefined
    ? 'Expiry unavailable; not verified online.'
    : `${expired ? 'Access token expired' : 'Access token expires'} at ${new Date(expiry * 1000).toISOString()}; not verified online.`;
  return { email, method: 'ChatGPT', status, expired };
}

export async function verifyApiKey(key: string, request: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await request('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch {
    throw new Error('Could not verify API key: network request failed or timed out.');
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'API key was rejected. Sign in again with a valid key.'
      : `API key could not be verified (HTTP ${response.status}); check permissions or try again later.`);
  }
}


async function refreshChatGPT(home: string, owner: LockOwner): Promise<void> {
  const { child, completion } = await owner.spawn('codex', ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    env: profileEnvironment(home),
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: home,
  }).catch((error: Error) => { throw codexError(error); });
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    let finished = false;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish(new Error('Account verification timed out. Try again later.')), 30_000);
    const interrupted = () => finish(new Error('Account verification interrupted.'));
    process.on('SIGINT', interrupted);
    process.on('SIGTERM', interrupted);

    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      failure = error;
      clearTimeout(timeout);
      lines.close();
      child.stdin!.end();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    }

    function send(message: unknown): void {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    }

    child.stdin!.on('error', () => finish(new Error('Codex closed the verification connection.')));
    const closed = () => {
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
      clearTimeout(timeout);
      clearTimeout(killTimer);
      lines.close();
      if (!finished) reject(new Error('Codex exited before verifying the account.'));
      else if (failure) reject(failure);
      else resolve();
    };
    void completion.then(closed, (error: Error) => {
      if (!finished) { finished = true; failure = codexError(error); }
      closed();
    });
    lines.on('line', (line) => {
      if (finished) return;
      let message: { id?: unknown; error?: unknown; result?: { account?: { type?: unknown } } };
      try { message = JSON.parse(line); } catch {
        finish(new Error('Unexpected response from Codex app-server.'));
        return;
      }
      if (!message || typeof message !== 'object') {
        finish(new Error('Unexpected response from Codex app-server.'));
        return;
      }
      if (message.id !== 0 && message.id !== 1) return;
      if (message.error) {
        finish(new Error('Codex could not refresh the account. Check your connection or sign in again.'));
      } else if (message.id === 0) {
        send({ method: 'initialized', params: {} });
        send({ id: 1, method: 'account/read', params: { refreshToken: true } });
      } else if (message.result?.account?.type === 'chatgpt') {
        finish();
      } else {
        finish(new Error('Codex did not report a managed ChatGPT account. Sign in again.'));
      }
    });
    send({ id: 0, method: 'initialize', params: {
      clientInfo: { name: 'codex_multi_auth', title: 'Codex Multi Auth', version: '0.1.0' },
    } });
  });
}

export async function checkProfile(name: string, online: boolean): Promise<ProfileCheck> {
  return withProfileLock(name, async (owner) => {
    const data = await readProfileAuth(name);
    const result = inspectAuth(data);
    if (!online) return result;
    const auth = parseAuthData(data);
    if (result.method === 'API key') {
      await verifyApiKey(auth.OPENAI_API_KEY as string);
      return { ...result, status: 'Verified online: API key accepted by the models endpoint.', expired: false };
    }
    if (typeof auth.tokens?.refresh_token !== 'string' || !auth.tokens.refresh_token.trim()) {
      throw new Error(`Profile "${name}" has no refresh token. Run: codex-multi-auth run ${name} -- login`);
    }
    const home = await prepareProfileHome(name);
    try {
      await refreshChatGPT(home, owner);
    } finally {
      await syncProfileHome(name);
    }
    const refreshed = inspectAuth(await readProfileAuth(name));
    if (refreshed.expired) {
      throw new Error('Codex returned an expired access token after refresh. Sign in again.');
    }
    return {
      ...refreshed,
      status: 'Verified online: ChatGPT session refreshed by Codex.',
      expired: false,
    };
  });
}
