import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listDatabaseBackups,
  openDatabase,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from '../../src/storage/database.js';

const migrationNames = [
  'catalog',
  'release-rules',
  'watch-tasks',
  'persistent-jobs',
  'monitoring-events',
  'current-observation-status',
  'monitoring-baselines',
  'notification-outbox',
  'notification-deliveries',
  'schedule-presence-state',
  'notification-self-tests',
  'browser-agent-runtime',
  'source-runtime',
  'tongren-release-rule-seed',
  'browser-agent-admission-security',
  'migration-manifest-checksums',
] as const;

function currentVersion(path: string): number {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (
      database.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as {
        version: number;
      }
    ).version;
  } finally {
    database.close();
  }
}

function downgradeCurrentDatabase(path: string, version: 14 | 15): void {
  const current = openDatabase(path);
  current.close();

  const database = new Database(path);
  try {
    database.exec('DELETE FROM schema_migration WHERE version = 16;');
    database.exec('ALTER TABLE schema_migration DROP COLUMN checksum;');
    if (version === 14) {
      database.exec(`
        DROP INDEX browser_agent_request_accepted_idx;
        DROP TABLE browser_agent_request;
        ALTER TABLE browser_agent_runtime DROP COLUMN last_observed_at;
        DELETE FROM schema_migration WHERE version = 15;
      `);
    }
  } finally {
    database.close();
  }
}

describe('SQLite 发布级硬化', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it.each([14, 15] as const)('兼容 migration %s 旧库，迁移前生成可验证且可重开的备份', (version) => {
    directory = join(tmpdir(), `easy-hospital-database-hardening-${process.pid}-${version}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, version);

    const upgraded = openDatabase(path);
    const rows = upgraded
      .prepare('SELECT version, name, checksum FROM schema_migration ORDER BY version')
      .all() as Array<{ version: number; name: string; checksum: string }>;
    upgraded.close();

    expect(rows).toHaveLength(16);
    expect(rows.map(({ name }) => name)).toEqual(migrationNames);
    expect(rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
    expect(rows[0]?.checksum).toBe(
      '4ac3fc83997895d4ca75376fd5995be314644244bd24035cd31733b745676f9f',
    );
    expect(rows[15]?.checksum).toBe(
      '273e015a473cb5f11c1d82e6029f02997b89615f488cd6be89e0d53319118974',
    );

    const backups = listDatabaseBackups(path);
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(
      new RegExp(
        `^data\\.sqlite3\\.migration-v${version}-to-v16\\.\\d{8}T\\d{9}Z(?:\\.\\d+)?\\.sqlite3$`,
      ),
    );
    const verification = verifyDatabaseBackup(backups[0].path);
    expect(verification).toMatchObject({ integrity: 'ok', schemaVersion: version });

    const reopenPath = join(directory, `reopen-v${version}.sqlite3`);
    copyFileSync(backups[0].path, reopenPath);
    const reopened = openDatabase(reopenPath);
    expect(
      (
        reopened.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as {
          version: number;
        }
      ).version,
    ).toBe(16);
    reopened.close();
  });

  it('新建磁盘库和 :memory: 数据库不创建迁移备份', () => {
    directory = join(tmpdir(), `easy-hospital-new-database-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    const disk = openDatabase(path);
    disk.close();
    expect(listDatabaseBackups(path)).toEqual([]);

    const memory = openDatabase(':memory:');
    memory.close();
    expect(listDatabaseBackups(':memory:')).toEqual([]);
  });

  it('schema_migration name 被篡改时 fail closed', () => {
    directory = join(tmpdir(), `easy-hospital-migration-name-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    const created = openDatabase(path);
    created.close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_migration SET name = 'tampered' WHERE version = 3").run();
    raw.close();

    expect(() => openDatabase(path)).toThrowError('数据库迁移清单校验失败');
  });

  it('schema_migration checksum 被篡改时 fail closed', () => {
    directory = join(tmpdir(), `easy-hospital-migration-checksum-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    const created = openDatabase(path);
    created.close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_migration SET checksum = ? WHERE version = 8").run('0'.repeat(64));
    raw.close();

    expect(() => openDatabase(path)).toThrowError('数据库迁移清单校验失败');
  });

  it('损坏主库抛稳定错误，保留原字节且不创建备份', () => {
    directory = join(tmpdir(), `easy-hospital-corrupt-main-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, Buffer.from('not-a-sqlite-database'));
    const before = readFileSync(path);

    expect(() => openDatabase(path)).toThrowError('数据库完整性检查失败，原数据库未被修改');
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(join(directory, 'backups'))).toBe(false);
  });

  it('能列出并验证有效备份，损坏备份稳定失败', () => {
    directory = join(tmpdir(), `easy-hospital-backup-validation-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const upgraded = openDatabase(path);
    upgraded.close();

    const [backup] = listDatabaseBackups(path);
    expect(verifyDatabaseBackup(backup.path)).toMatchObject({
      path: backup.path,
      integrity: 'ok',
      schemaVersion: 15,
    });

    const corruptBackup = join(directory, 'backups', 'corrupt.sqlite3');
    writeFileSync(corruptBackup, Buffer.from('broken-backup'));
    expect(() => verifyDatabaseBackup(corruptBackup)).toThrowError('数据库备份完整性检查失败');
  });

  it('显式 restore 先验证备份，保存 rollback 副本后原子替换主库', () => {
    directory = join(tmpdir(), `easy-hospital-restore-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const upgraded = openDatabase(path);
    upgraded.prepare("UPDATE hospital SET name = '恢复前改动' WHERE id = 'hospital-pumch'").run();
    upgraded.close();
    const [backup] = listDatabaseBackups(path);

    const result = restoreDatabaseBackup(path, backup.path);
    expect(result).toMatchObject({ databasePath: path, backupPath: backup.path });
    expect(result.rollbackPath).toContain(join(directory, 'corrupt'));
    expect(existsSync(result.rollbackPath)).toBe(true);

    const rollback = new Database(result.rollbackPath, { readonly: true, fileMustExist: true });
    expect(
      (
        rollback.prepare("SELECT name FROM hospital WHERE id = 'hospital-pumch'").get() as {
          name: string;
        }
      ).name,
    ).toBe('恢复前改动');
    rollback.close();

    const restored = openDatabase(path);
    expect(
      (
        restored.prepare("SELECT name FROM hospital WHERE id = 'hospital-pumch'").get() as {
          name: string;
        }
      ).name,
    ).toBe('北京协和医院');
    restored.close();
    expect(currentVersion(path)).toBe(16);
  });

  it('有效备份可显式恢复损坏主库，并保留损坏 rollback 原件', () => {
    directory = join(tmpdir(), `easy-hospital-restore-corrupt-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const upgraded = openDatabase(path);
    upgraded.close();
    const [backup] = listDatabaseBackups(path);
    const corruptBytes = Buffer.from('corrupt-current-database');
    writeFileSync(path, corruptBytes);

    const result = restoreDatabaseBackup(path, backup.path);
    expect(readFileSync(result.rollbackPath)).toEqual(corruptBytes);
    const restored = openDatabase(path);
    expect(
      (
        restored.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as {
          version: number;
        }
      ).version,
    ).toBe(16);
    restored.close();
  });

  it('损坏备份 restore 失败且不修改当前主库', () => {
    directory = join(tmpdir(), `easy-hospital-restore-invalid-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    const current = openDatabase(path);
    current.close();
    const before = readFileSync(path);
    const corruptBackup = join(directory, 'invalid-backup.sqlite3');
    writeFileSync(corruptBackup, Buffer.from('broken-backup'));

    expect(() => restoreDatabaseBackup(path, corruptBackup)).toThrowError(
      '数据库备份完整性检查失败',
    );
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(join(directory, 'corrupt'))).toBe(false);
  });

  it('迁移一致性备份只保留最近 5 份', () => {
    directory = join(tmpdir(), `easy-hospital-backup-retention-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      downgradeCurrentDatabase(path, 15);
      const upgraded = openDatabase(path);
      upgraded.close();
    }

    const backups = listDatabaseBackups(path);
    expect(backups).toHaveLength(5);
    expect(backups.every(({ path: backupPath }) => verifyDatabaseBackup(backupPath).integrity === 'ok')).toBe(
      true,
    );
  });
});
