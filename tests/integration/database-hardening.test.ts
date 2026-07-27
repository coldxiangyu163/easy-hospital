import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
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
import { createSourceScopeKey } from '../../src/storage/scheduling.js';
import {
  sourceRetryAfterMs,
  sourceScopeNeedsRebaseline,
} from '../../src/storage/source-runtime.js';

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
  'hospital-domain-policy',
  'beijing-hospital-directory',
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

function downgradeCurrentDatabase(path: string, version: 14 | 15 | 16 | 17): void {
  const current = openDatabase(path);
  current.close();

  const database = new Database(path);
  try {
    database.exec(`
      DROP TABLE source_scope_runtime;
      DELETE FROM hospital_domain WHERE hospital_id NOT IN ('hospital-pumch', 'hospital-tongren');
      DELETE FROM department WHERE hospital_id NOT IN ('hospital-pumch', 'hospital-tongren');
      DELETE FROM campus WHERE hospital_id NOT IN ('hospital-pumch', 'hospital-tongren');
      DELETE FROM hospital WHERE id NOT IN ('hospital-pumch', 'hospital-tongren');
      DROP INDEX department_target_id_unique;
      ALTER TABLE department DROP COLUMN can_create_watch_task;
      ALTER TABLE department DROP COLUMN support_mode;
      ALTER TABLE department DROP COLUMN sort_order;
      ALTER TABLE department DROP COLUMN active;
      ALTER TABLE department DROP COLUMN target_id;
      ALTER TABLE campus DROP COLUMN sort_order;
      ALTER TABLE hospital DROP COLUMN sort_order;
      DELETE FROM schema_migration WHERE version = 18;
    `);
    if (version === 17) return;
    database.exec('DROP TABLE hospital_domain;');
    database.exec('DELETE FROM schema_migration WHERE version = 17;');
    if (version === 16) return;
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

    expect(rows).toHaveLength(18);
    expect(rows.map(({ name }) => name)).toEqual(migrationNames);
    expect(rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
    expect(rows[0]?.checksum).toBe(
      '4ac3fc83997895d4ca75376fd5995be314644244bd24035cd31733b745676f9f',
    );
    expect(rows[15]?.checksum).toBe(
      '273e015a473cb5f11c1d82e6029f02997b89615f488cd6be89e0d53319118974',
    );
    expect(rows[16]?.checksum).toBe(
      '81ae9076e3d0813d6bdb183fb22387c776c51ec39154de695e616cb095679d2e',
    );
    expect(rows[17]?.checksum).toBe(
      'df7c02872c152e26e3298c6f1d26dc0792c0f66f56bd031d26e04d10fd03c5e7',
    );

    const backups = listDatabaseBackups(path);
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(
      new RegExp(
        `^data\\.sqlite3\\.migration-v${version}-to-v18\\.\\d{8}T\\d{9}Z(?:\\.\\d+)?\\.sqlite3$`,
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
    ).toBe(18);
    reopened.close();
  });

  it.each([16, 17] as const)(
    'checksum-bearing migration %s 库自动迁移到 18 并保留数据与可验证备份',
    (sourceVersion) => {
      directory = join(
        tmpdir(),
        `easy-hospital-migration-${sourceVersion}-${process.pid}-${Date.now()}`,
      );
      const path = join(directory, 'data.sqlite3');
      const sentinel = `migration-${sourceVersion}-sentinel`;
      downgradeCurrentDatabase(path, sourceVersion);

      const oldDatabase = new Database(path);
      const migration16 = oldDatabase
        .prepare('SELECT version, name, checksum FROM schema_migration WHERE version = 16')
        .get();
      oldDatabase
        .prepare("UPDATE hospital SET name = ? WHERE id = 'hospital-pumch'")
        .run(sentinel);
      oldDatabase.close();
      expect(migration16).toEqual({
        version: 16,
        name: 'migration-manifest-checksums',
        checksum: '273e015a473cb5f11c1d82e6029f02997b89615f488cd6be89e0d53319118974',
      });

      const upgraded = openDatabase(path);
      const schemaVersion = (
        upgraded.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as {
          version: number;
        }
      ).version;
      const migration17 = upgraded
        .prepare('SELECT name, checksum FROM schema_migration WHERE version = 17')
        .get();
      const persistedSentinel = (
        upgraded.prepare("SELECT name FROM hospital WHERE id = 'hospital-pumch'").get() as {
          name: string;
        }
      ).name;
      const domains = upgraded
        .prepare(
          'SELECT hospital_id, domain, kind FROM hospital_domain ORDER BY hospital_id, domain, kind',
        )
        .all();
      upgraded.close();

      expect(schemaVersion).toBe(18);
      expect(persistedSentinel).toBe(sentinel);
      expect(migration17).toEqual({
        name: 'hospital-domain-policy',
        checksum: '81ae9076e3d0813d6bdb183fb22387c776c51ec39154de695e616cb095679d2e',
      });
      expect(domains).toEqual(
        expect.arrayContaining([
          { hospital_id: 'hospital-pumch', domain: 'pumch.cn', kind: 'evidence' },
          { hospital_id: 'hospital-pumch', domain: 'pumch.cn', kind: 'official' },
          { hospital_id: 'hospital-tongren', domain: 'news.bjd.com.cn', kind: 'evidence' },
          { hospital_id: 'hospital-tongren', domain: 'trhos.com', kind: 'official' },
          { hospital_id: 'hospital-pkuph', domain: 'pkuph.cn', kind: 'official' },
          { hospital_id: 'hospital-pkufh', domain: 'pkufh.91health.net', kind: 'official' },
          { hospital_id: 'hospital-fuwai', domain: 'fuwai.com', kind: 'official' },
        ]),
      );

      const backups = listDatabaseBackups(path);
      expect(backups).toHaveLength(1);
      expect(backups[0].name).toMatch(
        new RegExp(
          `^data\\.sqlite3\\.migration-v${sourceVersion}-to-v18\\.\\d{8}T\\d{9}Z(?:\\.\\d+)?\\.sqlite3$`,
        ),
      );
      expect(verifyDatabaseBackup(backups[0].path)).toMatchObject({
        path: backups[0].path,
        integrity: 'ok',
        schemaVersion: sourceVersion,
      });
      const backup = new Database(backups[0].path, { readonly: true, fileMustExist: true });
      expect(
        (
          backup.prepare("SELECT name FROM hospital WHERE id = 'hospital-pumch'").get() as {
            name: string;
          }
        ).name,
      ).toBe(sentinel);
      backup.close();

      const reopenPath = join(directory, `reopen-v${sourceVersion}.sqlite3`);
      copyFileSync(backups[0].path, reopenPath);
      const reopened = openDatabase(reopenPath);
      expect(
        (
          reopened.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as {
            version: number;
          }
        ).version,
      ).toBe(18);
      reopened.close();
    },
  );

  it('v17→v18 保留 PUMCH 域级 cooldown，并用旧 attempt 初始化精确 scope 空窗时钟', () => {
    directory = join(
      tmpdir(),
      `easy-hospital-migration-runtime-${process.pid}-${Date.now()}`,
    );
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 17);

    const now = Date.parse('2026-07-27T00:00:00.000Z');
    const lastAttemptAt = now - 5 * 7_200_000;
    const nextAllowedAt = now + 86_400_000;
    const scopeKey = createSourceScopeKey({
      adapterKey: 'pumch-public-dermatology-schedule',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
    });
    const oldDatabase = new Database(path);
    oldDatabase
      .prepare(
        `INSERT INTO source_runtime (
          adapter_key, last_attempt_at, last_success_at, next_allowed_at,
          last_status, last_error_code
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'pumch-public-dermatology-schedule',
        lastAttemptAt,
        lastAttemptAt - 1_000,
        nextAllowedAt,
        'TEMPORARY_FAILURE',
        'LEGACY_SENTINEL',
      );
    oldDatabase
      .prepare(
        `INSERT INTO monitoring_baseline (source_id, scope_key, established_at)
         VALUES (?, ?, ?)`,
      )
      .run('source-pumch-public-schedule', scopeKey, 1_234_567);
    oldDatabase.close();

    const upgraded = openDatabase(path);
    expect(
      upgraded
        .prepare('SELECT * FROM source_runtime WHERE adapter_key = ?')
        .get('official-html:pumch.cn'),
    ).toEqual({
      adapter_key: 'official-html:pumch.cn',
      last_attempt_at: lastAttemptAt,
      last_success_at: lastAttemptAt - 1_000,
      next_allowed_at: nextAllowedAt,
      last_status: 'TEMPORARY_FAILURE',
      last_error_code: 'LEGACY_SENTINEL',
    });
    expect(
      upgraded
        .prepare('SELECT 1 FROM source_runtime WHERE adapter_key = ?')
        .get('pumch-public-dermatology-schedule'),
    ).toBeUndefined();
    expect(sourceRetryAfterMs(upgraded, 'official-html:pumch.cn', now)).toBe(86_400_000);
    expect(
      upgraded
        .prepare('SELECT * FROM source_scope_runtime WHERE scope_key = ?')
        .get(scopeKey),
    ).toEqual({
      scope_key: scopeKey,
      adapter_key: 'pumch-public-dermatology-schedule',
      source_id: 'source-pumch-public-schedule',
      last_attempt_at: lastAttemptAt,
    });
    expect(sourceScopeNeedsRebaseline(upgraded, scopeKey, now, 7_200_000)).toBe(true);
    expect(
      upgraded
        .prepare(
          'SELECT established_at FROM monitoring_baseline WHERE source_id = ? AND scope_key = ?',
        )
        .get('source-pumch-public-schedule', scopeKey),
    ).toEqual({ established_at: 1_234_567 });
    upgraded.close();
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
    expect(currentVersion(path)).toBe(18);
  });

  it('dead PID 遗留锁可安全回收，restore 成功后释放实例锁', () => {
    directory = join(tmpdir(), `easy-hospital-restore-stale-lock-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const current = openDatabase(path);
    current.prepare("UPDATE hospital SET name = '恢复前改动' WHERE id = 'hospital-pumch'").run();
    current.close();
    const [backup] = listDatabaseBackups(path);
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, startedAt: '2026-07-19T00:00:00.000Z' }),
    );

    restoreDatabaseBackup(path, backup.path);

    expect(existsSync(lockPath)).toBe(false);
    const restored = new Database(path, { readonly: true, fileMustExist: true });
    expect(
      (
        restored.prepare("SELECT name FROM hospital WHERE id = 'hospital-pumch'").get() as {
          name: string;
        }
      ).name,
    ).toBe('北京协和医院');
    restored.close();
  });

  it.each([
    [
      'live PID',
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    ],
    ['缺失 owner', undefined],
    ['malformed owner', '{"pid":'],
  ] as const)('%s 锁使 restore fail closed 且不修改主库', (_case, owner) => {
    directory = join(tmpdir(), `easy-hospital-restore-locked-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const current = openDatabase(path);
    current.prepare("UPDATE hospital SET name = '不可修改' WHERE id = 'hospital-pumch'").run();
    current.close();
    const [backup] = listDatabaseBackups(path);
    const before = readFileSync(path);
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    if (owner !== undefined) writeFileSync(join(lockPath, 'owner.json'), owner);

    expect(() => restoreDatabaseBackup(path, backup.path)).toThrowError(
      '数据库仍在运行，停止应用后才能恢复',
    );

    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(lockPath)).toBe(true);
    if (owner === undefined) {
      expect(existsSync(join(lockPath, 'owner.json'))).toBe(false);
    } else {
      expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toBe(owner);
    }
    expect(existsSync(join(directory, 'corrupt'))).toBe(false);
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
    ).toBe(18);
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

  it('数据目录 0700，主库/WAL/SHM 0600（POSIX 平台）', () => {
    if (process.platform === 'win32') return;
    directory = join(tmpdir(), `easy-hospital-perms-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    const database = openDatabase(path);
    database.close();

    const mode = (target: string): number => statSync(target).mode & 0o777;
    expect(mode(directory)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    if (existsSync(`${path}-wal`)) expect(mode(`${path}-wal`)).toBe(0o600);
    if (existsSync(`${path}-shm`)) expect(mode(`${path}-shm`)).toBe(0o600);
  });

  it('迁移备份目录 0700、备份文件 0600（POSIX 平台）', () => {
    if (process.platform === 'win32') return;
    directory = join(tmpdir(), `easy-hospital-backup-perms-${process.pid}-${Date.now()}`);
    const path = join(directory, 'data.sqlite3');
    downgradeCurrentDatabase(path, 15);
    const upgraded = openDatabase(path);
    upgraded.close();

    const mode = (target: string): number => statSync(target).mode & 0o777;
    expect(mode(join(directory, 'backups'))).toBe(0o700);
    const [backup] = listDatabaseBackups(path);
    expect(mode(backup.path)).toBe(0o600);
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
