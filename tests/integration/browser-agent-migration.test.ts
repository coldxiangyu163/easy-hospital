import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/database.js';

describe('Browser Agent admission migration', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('从 migration 14 既有库追加安全字段与 request 去重表并保留 runtime', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-migration-'));
    const path = join(directory, 'data.sqlite3');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE browser_agent_runtime (
        source_id TEXT PRIMARY KEY,
        last_ingest_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE source_runtime (
        adapter_key TEXT PRIMARY KEY,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        next_allowed_at INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error_code TEXT
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
      INSERT INTO browser_agent_runtime (source_id, last_ingest_at, last_seen_at)
      VALUES ('legacy-source', 1000, 1000);
    `);
    const insertMigration = legacy.prepare(
      'INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)',
    );
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
    ];
    for (let version = 1; version <= 14; version += 1) {
      insertMigration.run(version, migrationNames[version - 1], 1000);
    }
    legacy.close();

    const upgraded = openDatabase(path);
    const runtimeColumns = upgraded
      .prepare('PRAGMA table_info(browser_agent_runtime)')
      .all() as Array<{ name: string }>;
    expect(runtimeColumns.map(({ name }) => name)).toContain('last_observed_at');
    expect(
      upgraded
        .prepare(
          'SELECT source_id, last_ingest_at, last_seen_at, last_observed_at FROM browser_agent_runtime',
        )
        .get(),
    ).toEqual({
      source_id: 'legacy-source',
      last_ingest_at: 1000,
      last_seen_at: 1000,
      last_observed_at: null,
    });
    expect(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_agent_request'")
        .get(),
    ).toEqual({ name: 'browser_agent_request' });
    upgraded.close();
  });
});
