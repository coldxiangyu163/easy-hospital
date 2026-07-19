import type { Catalog } from './api.js';

export function findTarget(
  catalog: Catalog,
  hospitalId: string,
  campusId: string | null,
  departmentId: string,
): { hospital: string; campus: string; department: string } {
  const hospital = catalog.hospitals.find((item) => item.id === hospitalId);
  const campus = hospital?.campuses.find((item) => item.id === campusId);
  const department = campus?.departments.find((item) => item.id === departmentId);
  return {
    hospital: hospital?.name ?? '未知医院',
    campus: campus?.name ?? '院区未指定',
    department: department?.name ?? '未知科室',
  };
}

export function targetLabel(
  catalog: Catalog,
  hospitalId: string,
  campusId: string | null,
  departmentId: string,
): string {
  const target = findTarget(catalog, hospitalId, campusId, departmentId);
  return `${target.hospital} · ${target.campus} · ${target.department}`;
}

export function accessPolicy(hospitalId: string): {
  level: 'A' | 'C';
  title: string;
  description: string;
} {
  if (hospitalId === 'hospital-pumch') {
    return {
      level: 'A',
      title: 'A 级公开排班',
      description: '只关注公开排班发布。A 级不等于实时有号，也不推断退号。',
    };
  }
  return {
    level: 'C',
    title: 'C 级规则提醒',
    description: '只按已记录规则提醒并提供官方入口；标记需复核的规则不能当作医院当前承诺。',
  };
}
