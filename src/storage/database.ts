import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  acquireDatabaseLock,
  DatabaseLockUnavailableError,
} from './database-lock.js';

export type SqliteDatabase = Database.Database;

type MigrationDefinition = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const declaredMigrationChecksums = {
  1: '4ac3fc83997895d4ca75376fd5995be314644244bd24035cd31733b745676f9f',
  2: '71a1062f1d6e395b0112d48de15a40e23e039cb72f0abaec71b148e51fe2e781',
  3: '2b9020f229e773324c550a569c5264c128fef73f7be9c6b46670e103486899b4',
  4: '7ffe1a98a082c727f675aed8078b6a16424cacdbc9ae2f2d648f0da5ac90fbb4',
  5: 'c4ae6a099216f9e6174ea38e19f63040115ecb12fd52ca33970d2cc47653c4f1',
  6: '8f3a3c4a9847fc135ab5fc670b989505cde94238bf868e20b0a1130df5a09014',
  7: 'b6aa7f89b64710644d6d81909e1da1e1fcc5aa8c27902893abf5d967557eb68a',
  8: '60028cee39dced104b4e8d13f8cd7d4904829c868562b8aaa6f0806e222693a0',
  9: 'e767f6eab2583071eb658c8f55e5a3f1a9dd3d41d1e95e355aa35ace4a63b47f',
  10: 'dc6d55e9ea58ea2c15f771b1e752f227d8f5add272c691008b4569380ea7a15b',
  11: '362606e78a27fd038c8f8c9c5eff99f7cc24be21d26516b6b3060386c60e233f',
  12: 'ee252b000af509b42b981c836f01f5b11c1154e1c2dbfa8d07059d766b1809a3',
  13: '54f55bbe9b559fb65b34f2b0ce57e809118893f80acdfc6b214d02f641d5e740',
  14: 'c50f6edb771ad46db76e7a1cd4d131adc5abbe8baf6c8f93797102b09a829535',
  15: '253d9150aa1eb4a48a64f98e60f67a034797666c232235bd085b71c44d3ba855',
  16: '273e015a473cb5f11c1d82e6029f02997b89615f488cd6be89e0d53319118974',
  17: '81ae9076e3d0813d6bdb183fb22387c776c51ec39154de695e616cb095679d2e',
} as const;

function migrationChecksum(migration: MigrationDefinition): string {
  return createHash('sha256')
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest('hex');
}

const legacyMigrations = [
  {
    version: 1,
    name: 'catalog',
    sql: `
      CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE hospital (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        official_url TEXT NOT NULL
      ) STRICT;

      CREATE TABLE campus (
        id TEXT PRIMARY KEY,
        hospital_id TEXT NOT NULL REFERENCES hospital(id),
        name TEXT NOT NULL,
        UNIQUE (hospital_id, name)
      ) STRICT;

      CREATE TABLE department (
        id TEXT PRIMARY KEY,
        hospital_id TEXT NOT NULL REFERENCES hospital(id),
        campus_id TEXT NOT NULL REFERENCES campus(id),
        name TEXT NOT NULL,
        UNIQUE (campus_id, name)
      ) STRICT;

      INSERT INTO hospital (id, name, official_url) VALUES
        ('hospital-pumch', '北京协和医院', 'https://www.pumch.cn/'),
        ('hospital-tongren', '北京同仁医院', 'https://www.trhos.com/');

      INSERT INTO campus (id, hospital_id, name) VALUES
        ('campus-pumch-dongdan', 'hospital-pumch', '东单院区'),
        ('campus-tongren-chongwenmen', 'hospital-tongren', '崇文门院区');

      INSERT INTO department (id, hospital_id, campus_id, name) VALUES
        ('department-pumch-dermatology', 'hospital-pumch', 'campus-pumch-dongdan', '皮肤科'),
        ('department-tongren-rhinology', 'hospital-tongren', 'campus-tongren-chongwenmen', '鼻科');
    `,
  },
  {
    version: 2,
    name: 'release-rules',
    sql: `
      CREATE TABLE release_rule (
        id TEXT PRIMARY KEY,
        hospital_id TEXT NOT NULL REFERENCES hospital(id),
        campus_id TEXT NOT NULL REFERENCES campus(id),
        department_id TEXT NOT NULL REFERENCES department(id),
        advance_days INTEGER NOT NULL CHECK (advance_days BETWEEN 0 AND 60),
        release_time_local TEXT NOT NULL,
        same_day_policy TEXT NOT NULL,
        official_entry_url TEXT NOT NULL,
        source_url TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'watch-tasks',
    sql: `
      CREATE TABLE watch_task (
        id TEXT PRIMARY KEY,
        hospital_id TEXT NOT NULL REFERENCES hospital(id),
        campus_id TEXT REFERENCES campus(id),
        department_id TEXT NOT NULL REFERENCES department(id),
        match_mode TEXT NOT NULL CHECK (match_mode IN ('any_expert', 'title', 'doctor')),
        doctor_name TEXT,
        titles_json TEXT NOT NULL CHECK (json_valid(titles_json)),
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        session TEXT NOT NULL CHECK (session IN ('ANY', 'AM', 'PM')),
        event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
        remind_before_minutes INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: 'persistent-jobs',
    sql: `
      CREATE TABLE job (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        run_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        last_error_code TEXT,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX job_due_idx ON job (state, run_at);
    `,
  },
  {
    version: 5,
    name: 'monitoring-events',
    sql: `
      CREATE TABLE check_run (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE availability_snapshot (
        id TEXT PRIMARY KEY,
        check_run_id TEXT NOT NULL REFERENCES check_run(id),
        source_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
        content_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE availability_state (
        source_id TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        schedule_status TEXT NOT NULL CHECK (schedule_status IN ('absent', 'present', 'unknown')),
        availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (source_id, slot_key)
      ) STRICT;

      CREATE TABLE detected_event (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES watch_task(id),
        source_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'schedule_released',
          'availability_changed_to_available',
          'cancellation_slot_detected'
        )),
        slot_key TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK (evidence IN ('explicit', 'inferred')),
        detected_at INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: 'current-observation-status',
    sql: `
      ALTER TABLE availability_state
        ADD COLUMN current_availability TEXT CHECK (current_availability IN ('available', 'unavailable', 'unknown'));
      ALTER TABLE availability_state ADD COLUMN last_checked_at INTEGER;
      UPDATE availability_state
        SET current_availability = availability, last_checked_at = last_seen_at;
    `,
  },
  {
    version: 7,
    name: 'monitoring-baselines',
    sql: `
      CREATE TABLE monitoring_baseline (
        source_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        established_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, scope_key)
      ) STRICT;
    `,
  },
  {
    version: 8,
    name: 'notification-outbox',
    sql: `
      CREATE TABLE notification_batch (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES watch_task(id),
        state TEXT NOT NULL CHECK (state IN (
          'collecting', 'pending', 'sending', 'sent', 'failed', 'delivery_unknown'
        )),
        opens_at INTEGER NOT NULL,
        closes_at INTEGER NOT NULL,
        event_tags_json TEXT NOT NULL CHECK (json_valid(event_tags_json)),
        event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
        official_entry_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX notification_batch_collecting_idx
        ON notification_batch (task_id, state, closes_at);
    `,
  },
  {
    version: 9,
    name: 'notification-deliveries',
    sql: `
      CREATE TABLE notification_delivery (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES notification_batch(id),
        channel_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'sending', 'sent', 'failed', 'delivery_unknown'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        message_id TEXT NOT NULL,
        provider_message_id TEXT,
        last_error_code TEXT,
        sent_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (batch_id, channel_key)
      ) STRICT;
    `,
  },
  {
    version: 10,
    name: 'schedule-presence-state',
    sql: `
      CREATE TABLE schedule_state (
        source_id TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        schedule_status TEXT NOT NULL CHECK (schedule_status IN ('absent', 'present')),
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (source_id, slot_key)
      ) STRICT;
    `,
  },
  {
    version: 11,
    name: 'notification-self-tests',
    sql: `
      CREATE TABLE notification_self_test (
        id TEXT PRIMARY KEY,
        channel_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'unknown')),
        provider_message_id TEXT,
        error_code TEXT,
        tested_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX notification_self_test_latest_idx
        ON notification_self_test (channel_key, tested_at DESC);
    `,
  },
  {
    version: 12,
    name: 'browser-agent-runtime',
    sql: `
      CREATE TABLE browser_agent_runtime (
        source_id TEXT PRIMARY KEY,
        last_ingest_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 13,
    name: 'source-runtime',
    sql: `
      CREATE TABLE source_runtime (
        adapter_key TEXT PRIMARY KEY,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        next_allowed_at INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error_code TEXT
      ) STRICT;
    `,
  },
  {
    version: 14,
    name: 'tongren-release-rule-seed',
    sql: `
      ALTER TABLE release_rule
        ADD COLUMN needs_reconfirmation INTEGER NOT NULL DEFAULT 0 CHECK (needs_reconfirmation IN (0, 1));

      INSERT INTO release_rule (
        id, hospital_id, campus_id, department_id, advance_days,
        release_time_local, same_day_policy, official_entry_url, source_url,
        verified_at, confidence, enabled, created_at, updated_at, needs_reconfirmation
      ) VALUES (
        'rule-tongren-rhinology-daily-1500',
        'hospital-tongren',
        'campus-tongren-chongwenmen',
        'department-tongren-rhinology',
        7,
        '15:00',
        '研究结论为每日 15:00 发布第 8 天号源、每日 07:00 发布当日号源；当前缺少医院官网同口径原文，使用前需人工复核。',
        'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
        'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
        1784419200000,
        'medium',
        1,
        1784419200000,
        1784419200000,
        1
      );
    `,
  },
  {
    version: 15,
    name: 'browser-agent-admission-security',
    sql: `
      ALTER TABLE browser_agent_runtime ADD COLUMN last_observed_at INTEGER;

      CREATE TABLE browser_agent_request (
        request_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX browser_agent_request_accepted_idx
        ON browser_agent_request (accepted_at);
    `,
  },
] as const satisfies readonly MigrationDefinition[];

const migration16ChecksumCases = legacyMigrations
  .map(
    ({ version }) =>
      `          WHEN ${version} THEN '${declaredMigrationChecksums[version]}'`,
  )
  .join('\n');

const migration16Sql = `
      ALTER TABLE schema_migration RENAME TO schema_migration_legacy;

      CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO schema_migration (version, name, checksum, applied_at)
      SELECT
        version,
        name,
        CASE version
${migration16ChecksumCases}
          ELSE NULL
        END,
        applied_at
      FROM schema_migration_legacy;

      DROP TABLE schema_migration_legacy;
    `;

// migration 17 把“医院官方域/证据域”收敛为数据库单一事实源：
// officialEntryUrl 只允许 official 域，sourceUrl 允许 official + evidence 域。
const migration17Sql = `
      CREATE TABLE hospital_domain (
        hospital_id TEXT NOT NULL REFERENCES hospital(id),
        domain TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('official', 'evidence')),
        PRIMARY KEY (hospital_id, domain, kind)
      ) STRICT;

      INSERT INTO hospital_domain (hospital_id, domain, kind) VALUES
        ('hospital-pumch', 'pumch.cn', 'official'),
        ('hospital-pumch', 'pumch.cn', 'evidence'),
        ('hospital-tongren', 'trhos.com', 'official'),
        ('hospital-tongren', 'trhos.com', 'evidence'),
        ('hospital-tongren', 'bjtrhos.cn', 'official'),
        ('hospital-tongren', 'bjtrhos.cn', 'evidence'),
        ('hospital-tongren', 'news.bjd.com.cn', 'evidence');
    `;

const migrations = [
  ...legacyMigrations,
  {
    version: 16,
    name: 'migration-manifest-checksums',
    sql: migration16Sql,
  },
  {
    version: 17,
    name: 'hospital-domain-policy',
    sql: migration17Sql,
  },
] as const satisfies readonly MigrationDefinition[];

export class DatabaseMigrationManifestError extends Error {
  readonly code = 'SQLITE_MIGRATION_MANIFEST_INVALID';

  constructor(cause?: unknown) {
    super('数据库迁移清单校验失败', cause === undefined ? undefined : { cause });
    this.name = 'DatabaseMigrationManifestError';
  }
}

export class DatabaseIntegrityError extends Error {
  readonly code = 'SQLITE_DATABASE_INTEGRITY_FAILED';

  constructor(message = '数据库完整性检查失败，原数据库未被修改', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseIntegrityError';
  }
}

export class DatabaseBackupIntegrityError extends Error {
  readonly code = 'SQLITE_BACKUP_INTEGRITY_FAILED';

  constructor(cause?: unknown) {
    super('数据库备份完整性检查失败', cause === undefined ? undefined : { cause });
    this.name = 'DatabaseBackupIntegrityError';
  }
}

export class DatabaseRestoreError extends Error {
  readonly code = 'SQLITE_RESTORE_FAILED';

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseRestoreError';
  }
}

for (const migration of migrations) {
  const expected = declaredMigrationChecksums[migration.version];
  if (migrationChecksum(migration) !== expected) {
    throw new DatabaseMigrationManifestError();
  }
}

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string | null;
};

type AppliedMigrationState = {
  rows: AppliedMigration[];
  hasChecksum: boolean;
};

export type DatabaseBackupInfo = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type VerifiedDatabaseBackup = DatabaseBackupInfo & {
  integrity: 'ok';
  schemaVersion: number;
};

export type DatabaseRestoreResult = {
  databasePath: string;
  backupPath: string;
  rollbackPath: string;
};

function assertIntegrity(database: SqliteDatabase): void {
  const rows = database.pragma('integrity_check') as Array<Record<string, unknown>>;
  const values = rows[0] ? Object.values(rows[0]) : [];
  if (rows.length !== 1 || values.length !== 1 || values[0] !== 'ok') {
    throw new Error('integrity_check did not return ok');
  }
}

function readAndValidateAppliedMigrations(database: SqliteDatabase): AppliedMigrationState {
  try {
    const hasMigrationTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
      .get();
    if (!hasMigrationTable) {
      const hasApplicationObjects = database
        .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
        .get();
      if (hasApplicationObjects) throw new DatabaseMigrationManifestError();
      return { rows: [], hasChecksum: false };
    }

    const columns = database.pragma('table_info(schema_migration)') as Array<{ name: string }>;
    const columnNames = columns.map(({ name }) => name).sort();
    const legacyColumns = ['applied_at', 'name', 'version'];
    const checksumColumns = ['applied_at', 'checksum', 'name', 'version'];
    const hasChecksum = columnNames.includes('checksum');
    const expectedColumns = hasChecksum ? checksumColumns : legacyColumns;
    if (
      columnNames.length !== expectedColumns.length ||
      columnNames.some((name, index) => name !== expectedColumns[index])
    ) {
      throw new DatabaseMigrationManifestError();
    }

    const rows = (hasChecksum
      ? database
          .prepare('SELECT version, name, checksum FROM schema_migration ORDER BY version')
          .all()
      : database
          .prepare('SELECT version, name, NULL AS checksum FROM schema_migration ORDER BY version')
          .all()) as AppliedMigration[];
    if (rows.length === 0) throw new DatabaseMigrationManifestError();
    if (hasChecksum && (rows.at(-1)?.version ?? 0) < 16) {
      throw new DatabaseMigrationManifestError();
    }

    for (const [index, row] of rows.entries()) {
      const expected = migrations[index];
      if (
        !expected ||
        row.version !== index + 1 ||
        row.version !== expected.version ||
        row.name !== expected.name
      ) {
        throw new DatabaseMigrationManifestError();
      }
      if (hasChecksum && row.checksum !== declaredMigrationChecksums[expected.version]) {
        throw new DatabaseMigrationManifestError();
      }
      if (!hasChecksum && row.version >= 16) throw new DatabaseMigrationManifestError();
    }

    return { rows, hasChecksum };
  } catch (error) {
    if (error instanceof DatabaseMigrationManifestError) throw error;
    throw new DatabaseMigrationManifestError(error);
  }
}

// 跨平台容错：Windows 或部分文件系统不支持 POSIX 权限位时 chmod 可能失败，
// 保持可用优先，静默跳过（调用方均为本机私有路径）。
function restrictPermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // 忽略不支持权限位的平台
  }
}

function configureDatabase(database: SqliteDatabase): void {
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('busy_timeout = 5000');
}

function migrate(database: SqliteDatabase, appliedCount: number): void {
  const pending = migrations.slice(appliedCount);
  if (pending.length === 0) return;

  database.transaction(() => {
    for (const migration of pending) {
      database.exec(migration.sql);
      if (migration.version >= 16) {
        database
          .prepare(
            'INSERT INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(
            migration.version,
            migration.name,
            declaredMigrationChecksums[migration.version],
            Date.now(),
          );
      } else {
        database
          .prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      }
    }
  })();
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function uniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath;
  const extension = basePath.endsWith('.sqlite3') ? '.sqlite3' : '';
  const stem = extension ? basePath.slice(0, -extension.length) : basePath;
  let suffix = 1;
  while (existsSync(`${stem}.${suffix}${extension}`)) suffix += 1;
  return `${stem}.${suffix}${extension}`;
}

function backupDirectory(databasePath: string): string {
  return join(dirname(databasePath), 'backups');
}

function backupPrefix(databasePath: string): string {
  return `${basename(databasePath)}.migration-`;
}

export function listDatabaseBackups(databasePath: string): DatabaseBackupInfo[] {
  if (databasePath === ':memory:') return [];
  const directory = backupDirectory(databasePath);
  if (!existsSync(directory)) return [];
  const prefix = backupPrefix(databasePath);

  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.sqlite3'),
    )
    .map((entry) => {
      const path = join(directory, entry.name);
      const stats = statSync(path);
      return {
        backup: {
          path,
          name: entry.name,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        },
        modifiedAtMs: stats.mtimeMs,
      };
    })
    .sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        right.backup.name.localeCompare(left.backup.name),
    )
    .map(({ backup }) => backup);
}

export function verifyDatabaseBackup(path: string): VerifiedDatabaseBackup {
  let database: SqliteDatabase | undefined;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error('backup is not a regular file');
    database = new Database(path, { readonly: true, fileMustExist: true });
    assertIntegrity(database);
    const applied = readAndValidateAppliedMigrations(database).rows;
    if (applied.length === 0) throw new Error('backup does not contain a migration manifest');
    return {
      path,
      name: basename(path),
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      integrity: 'ok',
      schemaVersion: applied.at(-1)?.version ?? 0,
    };
  } catch (error) {
    throw new DatabaseBackupIntegrityError(error);
  } finally {
    database?.close();
  }
}

function createMigrationBackup(
  database: SqliteDatabase,
  databasePath: string,
  fromVersion: number,
): DatabaseBackupInfo {
  const directory = backupDirectory(databasePath);
  mkdirSync(directory, { recursive: true });
  restrictPermissions(directory, 0o700);
  const targetVersion = migrations.at(-1)?.version ?? fromVersion;
  const filename = `${backupPrefix(databasePath)}v${fromVersion}-to-v${targetVersion}.${timestampForFilename()}.sqlite3`;
  const path = uniquePath(join(directory, filename));

  database.prepare('VACUUM INTO ?').run(path);
  restrictPermissions(path, 0o600);
  verifyDatabaseBackup(path);
  const backups = listDatabaseBackups(databasePath);
  for (const expired of backups.slice(5)) unlinkSync(expired.path);
  return listDatabaseBackups(databasePath).find((backup) => backup.path === path) ?? {
    path,
    name: basename(path),
    sizeBytes: statSync(path).size,
    modifiedAt: statSync(path).mtime.toISOString(),
  };
}

export function openDatabase(path = ':memory:'): SqliteDatabase {
  const inMemory = path === ':memory:';
  const existed = !inMemory && existsSync(path);
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
    restrictPermissions(dirname(path), 0o700);
  }

  let database: SqliteDatabase;
  try {
    database = new Database(path);
  } catch (error) {
    if (existed) throw new DatabaseIntegrityError(undefined, error);
    throw error;
  }

  try {
    if (existed) {
      try {
        assertIntegrity(database);
      } catch (error) {
        throw new DatabaseIntegrityError(undefined, error);
      }
    }

    const applied = readAndValidateAppliedMigrations(database).rows;
    configureDatabase(database);
    if (!inMemory && existed && applied.length > 0 && applied.length < migrations.length) {
      createMigrationBackup(database, path, applied.at(-1)?.version ?? 0);
    }
    migrate(database, applied.length);
    readAndValidateAppliedMigrations(database);

    try {
      assertIntegrity(database);
    } catch (error) {
      throw new DatabaseIntegrityError('数据库迁移后完整性检查失败', error);
    }
    if (!inMemory) {
      restrictPermissions(path, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) restrictPermissions(`${path}${suffix}`, 0o600);
      }
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function restoreDatabaseBackup(
  databasePath: string,
  backupPath: string,
): DatabaseRestoreResult {
  if (databasePath === ':memory:') throw new DatabaseRestoreError('内存数据库不支持恢复');
  if (resolve(databasePath) === resolve(backupPath)) {
    throw new DatabaseRestoreError('备份路径不能与当前数据库相同');
  }
  if (!existsSync(databasePath)) throw new DatabaseRestoreError('当前数据库不存在，无法恢复');

  let databaseLock;
  try {
    databaseLock = acquireDatabaseLock(databasePath);
  } catch (error) {
    if (error instanceof DatabaseLockUnavailableError) {
      throw new DatabaseRestoreError('数据库仍在运行，停止应用后才能恢复', error);
    }
    throw error;
  }

  try {
    if (!existsSync(databasePath)) {
      throw new DatabaseRestoreError('当前数据库不存在，无法恢复');
    }
    const verified = verifyDatabaseBackup(backupPath);
    const directory = dirname(databasePath);
    const rollbackDirectory = join(directory, 'corrupt');
    mkdirSync(rollbackDirectory, { recursive: true });
    restrictPermissions(rollbackDirectory, 0o700);
    const rollbackPath = uniquePath(
      join(
        rollbackDirectory,
        `${basename(databasePath)}.rollback-${timestampForFilename()}.sqlite3`,
      ),
    );
    const temporaryPath = join(directory, `.${basename(databasePath)}.restore-${randomUUID()}.tmp`);

    try {
      copyFileSync(databasePath, rollbackPath, constants.COPYFILE_EXCL);
      restrictPermissions(rollbackPath, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${databasePath}${suffix}`;
        if (existsSync(sidecar)) {
          copyFileSync(sidecar, `${rollbackPath}${suffix}`, constants.COPYFILE_EXCL);
          restrictPermissions(`${rollbackPath}${suffix}`, 0o600);
        }
      }

      copyFileSync(verified.path, temporaryPath, constants.COPYFILE_EXCL);
      restrictPermissions(temporaryPath, 0o600);
      fsyncFile(temporaryPath);
      verifyDatabaseBackup(temporaryPath);
      renameSync(temporaryPath, databasePath);
      restrictPermissions(databasePath, 0o600);
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      fsyncDirectory(directory);
      return { databasePath, backupPath: verified.path, rollbackPath };
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if (error instanceof DatabaseRestoreError) throw error;
      throw new DatabaseRestoreError('数据库恢复失败', error);
    }
  } finally {
    databaseLock.release();
  }
}

export type Catalog = {
  hospitals: Array<{
    id: string;
    name: string;
    campuses: Array<{
      id: string;
      name: string;
      departments: Array<{ id: string; name: string }>;
    }>;
  }>;
};

export function readCatalog(database: SqliteDatabase): Catalog {
  const rows = database
    .prepare(
      `SELECT
        h.id AS hospital_id,
        h.name AS hospital_name,
        c.id AS campus_id,
        c.name AS campus_name,
        d.id AS department_id,
        d.name AS department_name
      FROM hospital h
      JOIN campus c ON c.hospital_id = h.id
      JOIN department d ON d.campus_id = c.id
      ORDER BY h.name, c.name, d.name`,
    )
    .all() as Array<{
    hospital_id: string;
    hospital_name: string;
    campus_id: string;
    campus_name: string;
    department_id: string;
    department_name: string;
  }>;

  const hospitals = new Map<string, Catalog['hospitals'][number]>();
  for (const row of rows) {
    let hospital = hospitals.get(row.hospital_id);
    if (!hospital) {
      hospital = { id: row.hospital_id, name: row.hospital_name, campuses: [] };
      hospitals.set(row.hospital_id, hospital);
    }

    let campus = hospital.campuses.find(({ id }) => id === row.campus_id);
    if (!campus) {
      campus = { id: row.campus_id, name: row.campus_name, departments: [] };
      hospital.campuses.push(campus);
    }
    campus.departments.push({ id: row.department_id, name: row.department_name });
  }

  return { hospitals: [...hospitals.values()] };
}
