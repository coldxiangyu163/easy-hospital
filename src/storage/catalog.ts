import {
  normalizeTargetSupport,
  type TargetSupport,
  type TargetSupportMode,
} from '../core/target-support.js';
import type { SqliteDatabase } from './database.js';

export type CatalogDepartment = {
  id: string;
  name: string;
  targetId: string;
  support: TargetSupport;
};

export type Catalog = {
  hospitals: Array<{
    id: string;
    name: string;
    campuses: Array<{
      id: string;
      name: string;
      departments: CatalogDepartment[];
    }>;
  }>;
};

export type CatalogScope = {
  targetId: string;
  hospitalId: string;
  hospitalName: string;
  campusId: string;
  campusName: string;
  departmentId: string;
  departmentName: string;
  support: TargetSupport;
};

type CatalogRow = {
  hospital_id: string;
  hospital_name: string;
  campus_id: string;
  campus_name: string;
  department_id: string;
  department_name: string;
  target_id: string;
  active: 0 | 1;
  department_sort_order: number;
  support_mode: TargetSupportMode;
  can_create_watch_task: 0 | 1;
};

const catalogSelect = `SELECT
  h.id AS hospital_id,
  h.name AS hospital_name,
  c.id AS campus_id,
  c.name AS campus_name,
  d.id AS department_id,
  d.name AS department_name,
  d.target_id,
  d.active,
  d.sort_order AS department_sort_order,
  d.support_mode,
  d.can_create_watch_task
FROM department d
JOIN campus c ON c.id = d.campus_id
JOIN hospital h ON h.id = c.hospital_id`;

function supportFromRow(row: CatalogRow): TargetSupport {
  return normalizeTargetSupport({
    active: row.active === 1,
    sortOrder: row.department_sort_order,
    supportMode: row.support_mode,
    canCreateWatchTask: row.can_create_watch_task === 1,
  });
}

function scopeFromRow(row: CatalogRow): CatalogScope {
  return {
    targetId: row.target_id,
    hospitalId: row.hospital_id,
    hospitalName: row.hospital_name,
    campusId: row.campus_id,
    campusName: row.campus_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    support: supportFromRow(row),
  };
}

export function readCatalog(database: SqliteDatabase): Catalog {
  const rows = database
    .prepare(
      `${catalogSelect}
       ORDER BY h.sort_order, h.id, c.sort_order, c.id, d.sort_order, d.id`,
    )
    .all() as CatalogRow[];

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
    campus.departments.push({
      id: row.department_id,
      name: row.department_name,
      targetId: row.target_id,
      support: supportFromRow(row),
    });
  }

  return { hospitals: [...hospitals.values()] };
}

export function resolveCatalogScope(
  database: SqliteDatabase,
  input: { hospitalId: string; campusId: string | null; departmentId: string },
): CatalogScope | undefined {
  const row = database
    .prepare(
      `${catalogSelect}
       WHERE d.id = ?
         AND h.id = ?
         AND (? IS NULL OR c.id = ?)`,
    )
    .get(input.departmentId, input.hospitalId, input.campusId, input.campusId) as
    | CatalogRow
    | undefined;
  return row ? scopeFromRow(row) : undefined;
}

export function resolveCatalogTarget(
  database: SqliteDatabase,
  targetId: string,
): CatalogScope | undefined {
  const row = database
    .prepare(`${catalogSelect} WHERE d.target_id = ?`)
    .get(targetId) as CatalogRow | undefined;
  return row ? scopeFromRow(row) : undefined;
}
