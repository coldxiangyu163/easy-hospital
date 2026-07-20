import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export class DatabaseLockUnavailableError extends Error {
  readonly code = 'SQLITE_DATABASE_LOCK_UNAVAILABLE';

  constructor(cause?: unknown) {
    super('数据库实例锁已被占用或无法安全回收', cause === undefined ? undefined : { cause });
    this.name = 'DatabaseLockUnavailableError';
  }
}

export type DatabaseLock = {
  readonly path: string;
  release(): void;
};

type LockOwnerSnapshot = {
  raw: string;
  pid: number;
  token?: string;
  device: number;
  inode: number;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readOwnerSnapshot(path: string): LockOwnerSnapshot {
  const descriptor = openSync(path, 'r');
  try {
    const raw = readFileSync(descriptor, 'utf8');
    const stats = fstatSync(descriptor);
    const owner = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (
      owner === null ||
      typeof owner !== 'object' ||
      !Number.isInteger(owner.pid) ||
      Number(owner.pid) <= 0 ||
      (owner.token !== undefined &&
        (typeof owner.token !== 'string' || owner.token.length === 0))
    ) {
      throw new Error('invalid database lock owner');
    }
    return {
      raw,
      pid: Number(owner.pid),
      token: typeof owner.token === 'string' ? owner.token : undefined,
      device: stats.dev,
      inode: stats.ino,
    };
  } finally {
    closeSync(descriptor);
  }
}

function isSameOwner(left: LockOwnerSnapshot, right: LockOwnerSnapshot): boolean {
  return (
    left.raw === right.raw &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function restoreClaimedOwner(claimedOwnerPath: string, ownerPath: string): void {
  try {
    renameSync(claimedOwnerPath, ownerPath);
  } catch {
    // 无法确认目录身份时保留 fail-closed 状态，绝不删除可能属于其他进程的锁。
  }
}

function createLockHandle(lockPath: string, ownerPath: string, token: string): DatabaseLock {
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      const claimedOwnerPath = join(lockPath, `.owner.release-${token}.json`);
      try {
        renameSync(ownerPath, claimedOwnerPath);
        const owner = readOwnerSnapshot(claimedOwnerPath);
        if (owner.pid !== process.pid || owner.token !== token) {
          restoreClaimedOwner(claimedOwnerPath, ownerPath);
          return;
        }
        rmSync(lockPath, { recursive: true, force: true });
        released = true;
      } catch {
        restoreClaimedOwner(claimedOwnerPath, ownerPath);
      }
    },
  };
}

export function acquireDatabaseLock(databasePath: string): DatabaseLock {
  const lockPath = `${databasePath}.lock`;
  const ownerPath = join(lockPath, 'owner.json');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(
          ownerPath,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }),
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return createLockHandle(lockPath, ownerPath, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      let staleOwner: LockOwnerSnapshot;
      try {
        staleOwner = readOwnerSnapshot(ownerPath);
      } catch (ownerError) {
        throw new DatabaseLockUnavailableError(ownerError);
      }
      if (isProcessAlive(staleOwner.pid)) {
        throw new DatabaseLockUnavailableError(error);
      }

      const claimedOwnerPath = join(lockPath, `.owner.reclaim-${token}.json`);
      try {
        renameSync(ownerPath, claimedOwnerPath);
      } catch (claimError) {
        if ((claimError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new DatabaseLockUnavailableError(claimError);
      }

      let claimedOwner: LockOwnerSnapshot;
      try {
        claimedOwner = readOwnerSnapshot(claimedOwnerPath);
      } catch (claimError) {
        restoreClaimedOwner(claimedOwnerPath, ownerPath);
        throw new DatabaseLockUnavailableError(claimError);
      }
      if (!isSameOwner(staleOwner, claimedOwner) || isProcessAlive(claimedOwner.pid)) {
        restoreClaimedOwner(claimedOwnerPath, ownerPath);
        continue;
      }

      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  throw new DatabaseLockUnavailableError();
}
