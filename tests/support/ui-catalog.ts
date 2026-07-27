import type { Catalog, CatalogDepartment, TargetSupportMode } from '../../src/ui/api.js';

export function catalogDepartment(
  id: string,
  name: string,
  targetId: string,
  supportMode: TargetSupportMode,
  canCreateWatchTask: boolean,
  sortOrder = 10,
): CatalogDepartment {
  return {
    id,
    name,
    targetId,
    support: { active: true, sortOrder, supportMode, canCreateWatchTask },
  };
}

export const pumchDepartment = catalogDepartment(
  'department-pumch-dermatology',
  '皮肤科',
  'target-pumch-dermatology',
  'public-source',
  true,
);

export const tongrenDepartment = catalogDepartment(
  'department-tongren-rhinology',
  '鼻科',
  'target-tongren-rhinology',
  'rules-only',
  true,
);

export const pumchCatalog: Catalog = {
  hospitals: [
    {
      id: 'hospital-pumch',
      name: '北京协和医院',
      campuses: [
        {
          id: 'campus-pumch-dongdan',
          name: '东单院区',
          departments: [pumchDepartment],
        },
      ],
    },
  ],
};

export const supportedCatalog: Catalog = {
  hospitals: [
    ...pumchCatalog.hospitals,
    {
      id: 'hospital-tongren',
      name: '北京同仁医院',
      campuses: [
        {
          id: 'campus-tongren-chongwenmen',
          name: '崇文门院区',
          departments: [tongrenDepartment],
        },
      ],
    },
  ],
};
