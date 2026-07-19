import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { restrictPathPermissions } from '../../src/server/runtime.js';

describe('运行时秘密文件权限收紧', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('文件可收紧为 0600，目录可收紧为 0700（POSIX 平台）', async () => {
    if (process.platform === 'win32') return;
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-env-perm-'));
    const envFile = join(directory, '.env');
    await writeFile(envFile, 'SMTP_PASSWORD=dummy\n', { mode: 0o644 });

    expect(await restrictPathPermissions(envFile, 0o600)).toBe(true);
    expect(await restrictPathPermissions(directory, 0o700)).toBe(true);

    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('路径不存在或平台不支持时容错返回 false，不抛错', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-env-perm-'));
    const missing = join(directory, 'does-not-exist');
    await expect(restrictPathPermissions(missing, 0o600)).resolves.toBe(false);
  });
});
