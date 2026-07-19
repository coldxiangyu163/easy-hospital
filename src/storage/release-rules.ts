import { randomUUID } from 'node:crypto';

import type { ReleaseRule, ReleaseRuleInput, ReleaseRulePatch } from '../core/release-rule.js';
import type { SqliteDatabase } from './database.js';

type ReleaseRuleRow = {
  id: string;
  hospital_id: string;
  campus_id: string;
  department_id: string;
  advance_days: number;
  release_time_local: string;
  same_day_policy: string;
  official_entry_url: string;
  source_url: string;
  verified_at: number;
  confidence: ReleaseRule['confidence'];
  enabled: 0 | 1;
  needs_reconfirmation: 0 | 1;
  created_at: number;
  updated_at: number;
};

function toReleaseRule(row: ReleaseRuleRow): ReleaseRule {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    campusId: row.campus_id,
    departmentId: row.department_id,
    advanceDays: row.advance_days,
    releaseTimeLocal: row.release_time_local,
    sameDayPolicy: row.same_day_policy,
    officialEntryUrl: row.official_entry_url,
    sourceUrl: row.source_url,
    verifiedAt: new Date(row.verified_at).toISOString(),
    confidence: row.confidence,
    needsReconfirmation: row.needs_reconfirmation === 1,
    enabled: row.enabled === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type DomainKind = 'official' | 'evidence';

function listHospitalDomains(
  database: SqliteDatabase,
  hospitalId: string,
  kind: DomainKind,
): string[] {
  return (
    database
      .prepare('SELECT domain FROM hospital_domain WHERE hospital_id = ? AND kind = ?')
      .all(hospitalId, kind) as Array<{ domain: string }>
  ).map((row) => row.domain);
}

function normalizeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// 官方域/证据域的单一事实源是 hospital_domain 表（migration 17）：
// officialEntryUrl 必须落在 official 域，sourceUrl 必须落在 evidence 域；
// 未登记任何域的医院一律拒绝（fail closed）。
export function hasOfficialRuleUrls(
  database: SqliteDatabase,
  input: Pick<ReleaseRuleInput, 'hospitalId' | 'officialEntryUrl' | 'sourceUrl'>,
): boolean {
  const officialHost = normalizeHostname(input.officialEntryUrl);
  const sourceHost = normalizeHostname(input.sourceUrl);
  if (!officialHost || !sourceHost) return false;

  const officialDomains = listHospitalDomains(database, input.hospitalId, 'official');
  const evidenceDomains = listHospitalDomains(database, input.hospitalId, 'evidence');
  return (
    officialDomains.some((domain) => hostnameMatchesDomain(officialHost, domain)) &&
    evidenceDomains.some((domain) => hostnameMatchesDomain(sourceHost, domain))
  );
}

export function createReleaseRule(
  database: SqliteDatabase,
  input: ReleaseRuleInput,
): ReleaseRule {
  const id = randomUUID();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO release_rule (
        id, hospital_id, campus_id, department_id, advance_days, release_time_local,
        same_day_policy, official_entry_url, source_url, verified_at, confidence,
        needs_reconfirmation, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.hospitalId,
      input.campusId,
      input.departmentId,
      input.advanceDays,
      input.releaseTimeLocal,
      input.sameDayPolicy,
      input.officialEntryUrl,
      input.sourceUrl,
      Date.parse(input.verifiedAt),
      input.confidence,
      input.needsReconfirmation ? 1 : 0,
      now,
      now,
    );

  return getReleaseRule(database, id)!;
}

export function getReleaseRule(database: SqliteDatabase, id: string): ReleaseRule | undefined {
  const row = database.prepare('SELECT * FROM release_rule WHERE id = ?').get(id) as
    | ReleaseRuleRow
    | undefined;
  return row ? toReleaseRule(row) : undefined;
}

export function listReleaseRules(database: SqliteDatabase): ReleaseRule[] {
  return (database.prepare('SELECT * FROM release_rule ORDER BY created_at, id').all() as ReleaseRuleRow[]).map(
    toReleaseRule,
  );
}

export function updateReleaseRule(
  database: SqliteDatabase,
  id: string,
  patch: ReleaseRulePatch,
): ReleaseRule | undefined {
  const current = getReleaseRule(database, id);
  if (!current) return undefined;

  const next = { ...current, ...patch };
  database
    .prepare(
      `UPDATE release_rule SET
        hospital_id = ?, campus_id = ?, department_id = ?, advance_days = ?,
        release_time_local = ?, same_day_policy = ?, official_entry_url = ?,
        source_url = ?, verified_at = ?, confidence = ?, needs_reconfirmation = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.hospitalId,
      next.campusId,
      next.departmentId,
      next.advanceDays,
      next.releaseTimeLocal,
      next.sameDayPolicy,
      next.officialEntryUrl,
      next.sourceUrl,
      Date.parse(next.verifiedAt),
      next.confidence,
      next.needsReconfirmation ? 1 : 0,
      next.enabled ? 1 : 0,
      Date.now(),
      id,
    );

  return getReleaseRule(database, id);
}

export function deleteReleaseRule(database: SqliteDatabase, id: string): boolean {
  return database.prepare('DELETE FROM release_rule WHERE id = ?').run(id).changes === 1;
}
