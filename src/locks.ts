import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface OwnerRecord {
  pid: number;
  hostname: string;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LockOwner {
  spawn(command: string, args: string[], options: SpawnOptions): Promise<{
    child: ChildProcess;
    completion: Promise<ChildExit>;
  }>;
}

function processState(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

async function readOwners(path: string): Promise<{ name: string; record: OwnerRecord }[] | undefined> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return undefined;
  }
  if (names.filter((name) => /^owner-[a-f0-9-]+\.json$/.test(name)).length !== 1) return undefined;
  const owners: { name: string; record: OwnerRecord }[] = [];
  for (const name of names) {
    if (!/^(owner|child)-[a-f0-9-]+\.json$/.test(name)) return undefined;
    try {
      const record: unknown = JSON.parse(await readFile(join(path, name), 'utf8'));
      if (!record || typeof record !== 'object' || !('pid' in record) ||
          !('hostname' in record) || record.hostname !== hostname() ||
          typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) ||
          record.pid <= 0 || record.pid > 2_147_483_647) return undefined;
      owners.push({ name, record: { pid: record.pid, hostname: record.hostname } });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return undefined;
    }
  }
  return owners;
}

function unknownOwner(path: string): Error {
  return new Error(`Lock ownership could not be verified: ${path}. Close all Codex sessions using this profile, then remove this lock directory manually and retry.`);
}

export async function isLockInUse(path: string): Promise<boolean> {
  const owners = await readOwners(path);
  return owners === undefined || owners.some((owner) => processState(owner.record.pid) !== 'dead');
}

async function publishOwner(path: string, record: OwnerRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withDirectoryLock<T>(path: string, action: (owner: LockOwner) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const candidate = join(dirname(path), `.${id}.pending`);
  const ownerName = `owner-${id}.json`;
  const children = new Map<string, number | null>();
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(join(candidate, ownerName), JSON.stringify({ pid: process.pid, hostname: hostname() }), {
      mode: 0o600, flag: 'wx',
    });
    let acquired = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const owners = await readOwners(path);
      if (owners === undefined) {
        if (attempt < 4) { await delay(25); continue; }
        throw unknownOwner(path);
      }
      for (const owner of owners) {
        const state = processState(owner.record.pid);
        if (state === 'alive') {
          throw new Error(`Profile or auth file is already in use by process ${owner.record.pid}: ${path}`);
        }
        if (state === 'unknown') throw unknownOwner(path);
      }
      for (const owner of owners) await rm(join(path, owner.name), { force: true });
      try {
        await rename(candidate, path);
        acquired = true;
        break;
      } catch (error: unknown) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    if (!acquired) throw new Error(`Lock changed while acquiring it. Retry: ${path}`);

    const owner: LockOwner = {
      async spawn(command, args, options) {
        const name = `child-${randomUUID()}.json`;
        const childPath = join(path, name);
        children.set(name, null);
        await writeFile(childPath, JSON.stringify({ pid: null, hostname: hostname() }), { mode: 0o600, flag: 'wx' });
        let child: ChildProcess;
        try {
          child = spawn(command, args, options);
        } catch (error: unknown) {
          children.delete(name);
          await rm(childPath, { force: true });
          throw error;
        }
        const completion = new Promise<ChildExit>((resolve, reject) => {
          let failure: Error | undefined;
          child.once('error', (error) => { failure = error; });
          child.once('close', (code, signal) => {
            if (failure) reject(failure);
            else resolve({ code, signal });
          });
        });
        void completion.catch(() => {});
        if (child.pid === undefined) {
          children.delete(name);
          await rm(childPath, { force: true });
          await completion;
          throw new Error('Child process did not start.');
        }
        children.set(name, child.pid);
        try {
          await publishOwner(childPath, { pid: child.pid, hostname: hostname() });
        } catch (error: unknown) {
          child.kill('SIGKILL');
          await completion.catch(() => {});
          throw error;
        }
        return { child, completion };
      },
    };
    try {
      return await action(owner);
    } finally {
      const childStillRunning = [...children.values()].some((pid) => pid === null || processState(pid) !== 'dead');
      if (!childStillRunning) {
        for (const name of [ownerName, ...children.keys()]) await rm(join(path, name), { force: true });
        await rmdir(path).catch((error: unknown) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        });
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}
