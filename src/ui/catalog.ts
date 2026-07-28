import type {
  Catalog,
  CatalogDepartment,
  CatalogHospital,
  SourceCapability,
  TargetSupport,
} from './api.js';

export type CatalogTarget = {
  hospital: CatalogHospital;
  campus: CatalogHospital['campuses'][number];
  department: CatalogDepartment;
};

// 服务端当前 catalog 尚未下发 hospital.officialUrl。这里的 fallback 与 migration 18
// 的 hospital.official_url 种子保持一致，只用于打开医院官网，不参与来源能力判断。
const officialHospitalUrls: Readonly<Record<string, string>> = {
  'hospital-pumch': 'https://www.pumch.cn/',
  'hospital-tongren': 'https://www.trhos.com/',
  'hospital-pkuph': 'https://www.pkuph.cn/',
  'hospital-puh3': 'https://www.puh3.net.cn/',
  'hospital-jishuitan': 'https://www.jst-hosp.com.cn/',
  'hospital-fuwai': 'https://www.fuwaihospital.org/',
  'hospital-anzhen': 'https://www.anzhen.org/',
  'hospital-pkufh': 'https://www.pkufh.com/',
  'hospital-tiantan': 'https://www.bjtth.org/',
  'hospital-beijing-childrens': 'https://www.bch.com.cn/',
  'hospital-cicams': 'https://www.cicams.ac.cn/',
};

export function officialHospitalUrl(hospital: CatalogHospital): string | undefined {
  const value = hospital.officialUrl ?? officialHospitalUrls[hospital.id];
  if (!value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCatalogTarget(
  catalog: Catalog,
  hospitalId: string,
  campusId: string | null,
  departmentId: string,
): CatalogTarget | undefined {
  const hospital = catalog.hospitals.find((item) => item.id === hospitalId);
  if (!hospital) return undefined;
  const campus =
    hospital.campuses.find((item) => item.id === campusId) ??
    (campusId === null
      ? hospital.campuses.find((item) =>
          item.departments.some((department) => department.id === departmentId),
        )
      : undefined);
  const department = campus?.departments.find((item) => item.id === departmentId);
  return campus && department ? { hospital, campus, department } : undefined;
}

export function findTarget(
  catalog: Catalog,
  hospitalId: string,
  campusId: string | null,
  departmentId: string,
): { hospital: string; campus: string; department: string } {
  const target = resolveCatalogTarget(catalog, hospitalId, campusId, departmentId);
  return {
    hospital: target?.hospital.name ?? '未知医院',
    campus: target?.campus.name ?? '院区未指定',
    department: target?.department.name ?? '未知科室',
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

export function sourceCapabilityForTarget(
  target: CatalogTarget,
  adapters: SourceCapability[],
): SourceCapability | undefined {
  if (target.department.support.supportMode === 'rules-only') {
    return adapters.find(
      (adapter) =>
        adapter.transport === 'rules-only' && adapter.targetId === target.department.targetId,
    );
  }

  if (target.department.support.supportMode !== 'public-source') return undefined;
  return adapters.find((adapter) => {
    const binding = adapter.bindings?.find(
      (candidate) =>
        candidate.targetId === target.department.targetId &&
        candidate.hospitalId === target.hospital.id &&
        candidate.campusId === target.campus.id &&
        candidate.departmentId === target.department.id,
    );
    if (!binding) return false;
    const expectedSourceId = target.department.support.sourceId;
    return !expectedSourceId || adapter.sourceId === expectedSourceId;
  });
}

export function canCreateWatchTaskNow(
  target: CatalogTarget,
  capabilities: SourceCapability[],
): boolean {
  const support = target.department.support;
  if (!support.active || !support.canCreateWatchTask) return false;
  if (support.supportMode === 'directory-only') return false;
  if (support.supportMode === 'public-source' || support.supportMode === 'rules-only') {
    return Boolean(
      sourceCapabilityForTarget(
        target,
        capabilities.filter((capability) => capability.enabled),
      ),
    );
  }
  return true;
}

export function sourceBindingForTarget(
  target: CatalogTarget,
  adapter: SourceCapability | undefined,
) {
  return adapter?.bindings?.find(
    (binding) =>
      binding.targetId === target.department.targetId &&
      binding.hospitalId === target.hospital.id &&
      binding.campusId === target.campus.id &&
      binding.departmentId === target.department.id,
  );
}

export type SupportPresentation = {
  title: string;
  description: string;
  activityLabel: string;
  canCreateWatchTask: boolean;
  ruleOnly: boolean;
};

export function supportPresentation(
  support: TargetSupport | undefined,
  source?: SourceCapability,
): SupportPresentation {
  if (!support) {
    return {
      title: '暂不支持提醒',
      description: '目录没有返回可核验的提醒能力。为避免误报，不能创建或恢复提醒。',
      activityLabel: '提醒能力未知',
      canCreateWatchTask: false,
      ruleOnly: false,
    };
  }
  if (!support.active) {
    return {
      title: '暂不支持提醒',
      description: '这个科室的提醒能力已经停用，仅可读取既有记录，当前不能创建或恢复提醒。',
      activityLabel: '提醒能力已停用',
      canCreateWatchTask: false,
      ruleOnly: support.supportMode === 'rules-only',
    };
  }
  if (support.supportMode === 'directory-only') {
    return {
      title: '暂不支持提醒',
      description: '可以查看院区、科室和医院官网，但当前没有可以可靠检查的公开排班或已确认规则。',
      activityLabel: '仅供目录浏览',
      canCreateWatchTask: false,
      ruleOnly: false,
    };
  }
  if (support.supportMode === 'rules-only') {
    return {
      title: '仅规则提醒',
      description: '只按已记录且可复核的规则安排提醒，并提供官方说明；不读取实时余号，也不推断退号。',
      activityLabel: '仅规则提醒已启用',
      canCreateWatchTask: support.canCreateWatchTask,
      ruleOnly: true,
    };
  }
  if (support.supportMode === 'browser-agent') {
    return {
      title: '实验支持',
      description: '只表示用户主动读取时页面可见的脱敏状态，可能立即失效，不是后台实时监控。',
      activityLabel: '实验支持已启用',
      canCreateWatchTask: support.canCreateWatchTask,
      ruleOnly: false,
    };
  }

  const stability = support.stability ?? source?.stability;
  if (stability === 'experimental') {
    return {
      title: '实验支持',
      description: '这个公开排班来源仍在实验阶段。只识别官方公开排班，不代表实时余号，也不推断退号。',
      activityLabel: '实验支持已启用',
      canCreateWatchTask: support.canCreateWatchTask,
      ruleOnly: false,
    };
  }
  if (stability === 'stable') {
    return {
      title: '可关注公开排班',
      description: '只识别官方公开页面中的新排班发布。排班不等于实时余号，也不推断退号。',
      activityLabel: '公开排班关注已启用',
      canCreateWatchTask: support.canCreateWatchTask,
      ruleOnly: false,
    };
  }
  return {
    title: '公开来源支持',
    description: '当前只确认已接入公开来源，尚未提供稳定性标签。排班不等于实时余号，也不推断退号。',
    activityLabel: '公开来源支持已启用',
    canCreateWatchTask: support.canCreateWatchTask,
    ruleOnly: false,
  };
}
