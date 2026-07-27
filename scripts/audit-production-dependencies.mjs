import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const WAIVED_GHSA = 'GHSA-qwww-vcr4-c8h2';
const WAIVED_PACKAGES = new Set(['react-router', 'react-router-dom']);
const BLOCKING_SEVERITIES = new Set(['moderate', 'high', 'critical']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const ALLOWED_SPA_APIS = new Set([
  'BrowserRouter',
  'Link',
  'NavLink',
  'Route',
  'Routes',
  'useLocation',
  'useNavigate',
  'useParams',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ghsaFromUrl(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/\/advisories\/(GHSA-[a-z0-9-]+)\/?$/iu)?.[1];
  return match ? `GHSA-${match.slice(5).toLowerCase()}` : undefined;
}

export function parseAuditJson(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new Error('npm audit 未返回合法 JSON，拒绝应用临时豁免', { cause: error });
  }
  if (!isObject(report) || report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) {
    throw new Error('npm audit JSON 结构未知，拒绝应用临时豁免');
  }
  if (isObject(report.error)) {
    throw new Error('npm audit 返回 registry 错误，拒绝应用临时豁免');
  }
  return report;
}

export function assessAuditReport(report) {
  if (!isObject(report) || report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) {
    throw new Error('npm audit JSON 结构未知，拒绝应用临时豁免');
  }

  const vulnerabilities = report.vulnerabilities;
  const memo = new Map();
  const visiting = new Set();

  const expandVia = (packageName) => {
    if (memo.has(packageName)) return memo.get(packageName);
    if (visiting.has(packageName)) {
      throw new Error(`npm audit via 出现循环：${packageName}`);
    }
    const vulnerability = vulnerabilities[packageName];
    if (!isObject(vulnerability) || !Array.isArray(vulnerability.via)) {
      throw new Error(`npm audit 存在未知 via：${packageName}`);
    }

    visiting.add(packageName);
    const advisories = [];
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        if (!isObject(vulnerabilities[via])) {
          throw new Error(`npm audit 存在未知 via：${packageName} → ${via}`);
        }
        advisories.push(...expandVia(via));
        continue;
      }
      if (!isObject(via) || typeof via.severity !== 'string') {
        throw new Error(`npm audit 存在未知 via：${packageName}`);
      }
      if (BLOCKING_SEVERITIES.has(via.severity)) advisories.push(via);
    }
    visiting.delete(packageName);
    memo.set(packageName, advisories);
    return advisories;
  };

  const waivedAdvisories = new Set();
  const affectedPackages = new Set();
  const unwaived = [];
  let blockingPackageCount = 0;

  for (const [packageKey, vulnerability] of Object.entries(vulnerabilities)) {
    if (!isObject(vulnerability) || typeof vulnerability.severity !== 'string') {
      throw new Error(`npm audit vulnerability 结构未知：${packageKey}`);
    }
    const advisories = expandVia(packageKey);
    const rootIsBlocking = BLOCKING_SEVERITIES.has(vulnerability.severity);
    if (rootIsBlocking) blockingPackageCount += 1;

    for (const advisory of advisories) {
      const ghsa = ghsaFromUrl(advisory.url);
      const advisoryPackages = [packageKey, advisory.name, advisory.dependency].filter(
        (value) => typeof value === 'string',
      );
      const allowedPackages = advisoryPackages.every((name) => WAIVED_PACKAGES.has(name));
      if (ghsa === WAIVED_GHSA && allowedPackages) {
        waivedAdvisories.add(ghsa);
        for (const name of advisoryPackages) affectedPackages.add(name);
      } else {
        unwaived.push(`${packageKey}:${ghsa ?? '未知 advisory'}`);
      }
    }

    if (rootIsBlocking && advisories.length === 0) {
      unwaived.push(`${packageKey}:未知 via`);
    }
    if (rootIsBlocking && !WAIVED_PACKAGES.has(packageKey)) {
      unwaived.push(`${packageKey}:package 不在豁免集合`);
    }
    if (rootIsBlocking && advisories.some((advisory) => ghsaFromUrl(advisory.url) === WAIVED_GHSA)) {
      affectedPackages.add(packageKey);
    }
  }

  const metadata = report.metadata?.vulnerabilities;
  if (!isObject(metadata)) {
    throw new Error('npm audit metadata 缺失，拒绝应用临时豁免');
  }
  const metadataBlockingCount = ['moderate', 'high', 'critical'].reduce((total, severity) => {
    const count = metadata[severity];
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`npm audit metadata.${severity} 无效`);
    }
    return total + count;
  }, 0);
  if (metadataBlockingCount !== blockingPackageCount) {
    throw new Error(
      `npm audit blocking 计数不一致：metadata=${metadataBlockingCount}，展开结果=${blockingPackageCount}`,
    );
  }

  if (unwaived.length > 0) {
    throw new Error(`发现未豁免的 moderate/high/critical：${[...new Set(unwaived)].join(', ')}`);
  }

  return {
    waivedAdvisories: [...waivedAdvisories].sort(),
    affectedPackages: [...affectedPackages].sort(),
    unwaivedCount: 0,
  };
}

function routerModule(specifier) {
  return (
    specifier === 'react-router' ||
    specifier.startsWith('react-router/') ||
    specifier === 'react-router-dom' ||
    specifier.startsWith('react-router-dom/') ||
    specifier.startsWith('@react-router/')
  );
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`src 包含符号链接，无法完成 fail-closed 路径检查：${path}`);
    }
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function assertSpaRouterBoundary(sourceDirectory) {
  const rscMarkers = [
    /['"]use server['"]/u,
    /\breact-server-dom-/u,
    /\b(?:RSC|RSCHydratedRouter|RSCStaticRouter|ServerRouter|HydratedRouter)\b/u,
    /\bserver(?:Action|Actions|Component|Components)\b/iu,
    /\bunstable_[A-Za-z0-9_]*(?:RSC|Server|Action)[A-Za-z0-9_]*\b/u,
  ];
  const modulePattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu;
  const namedDomImportPattern = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s*['"]react-router-dom['"]/gsu;

  for (const path of await sourceFiles(sourceDirectory)) {
    const source = await readFile(path, 'utf8');
    if (rscMarkers.some((marker) => marker.test(source))) {
      throw new Error(`检测到 RSC/Server Action marker，不能应用 GHSA 临时豁免：${path}`);
    }

    const routerReferences = [...source.matchAll(modulePattern)]
      .map((match) => match[1])
      .filter((specifier) => typeof specifier === 'string' && routerModule(specifier));
    for (const specifier of routerReferences) {
      if (specifier !== 'react-router-dom') {
        throw new Error(`检测到 react-router 直接或服务端导入 ${specifier}：${path}`);
      }
    }

    const namedImports = [...source.matchAll(namedDomImportPattern)];
    const domReferenceCount = routerReferences.filter(
      (specifier) => specifier === 'react-router-dom',
    ).length;
    if (namedImports.length !== domReferenceCount) {
      throw new Error(`react-router-dom 只允许命名导入当前 SPA API：${path}`);
    }
    for (const match of namedImports) {
      const imported = match[1]
        .split(',')
        .map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0])
        .filter(Boolean);
      const unsupported = imported.filter((name) => !ALLOWED_SPA_APIS.has(name));
      if (unsupported.length > 0) {
        throw new Error(`react-router-dom 出现未评估 API ${unsupported.join(', ')}：${path}`);
      }
    }
  }
}

export function runNpmAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error('npm audit 执行或网络请求失败，拒绝应用临时豁免', {
      cause: result.error,
    });
  }
  return parseAuditJson(result.stdout);
}

export async function main() {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  await assertSpaRouterBoundary(resolve(root, 'src'));
  const result = assessAuditReport(runNpmAudit());
  const waiverCount = result.waivedAdvisories.length;
  globalThis.console.log(
    `生产依赖 audit 通过：${waiverCount} 个已评估 GHSA 临时豁免，0 个未豁免 moderate/high/critical。`,
  );
  if (waiverCount > 0) {
    globalThis.console.log(
      `临时豁免 ${result.waivedAdvisories.join(', ')}，仅限 ${result.affectedPackages.join(', ')}：项目只使用 react-router-dom 客户端 SPA API，不包含 RSC、React Server Components 或 Server Actions 路径；兼容 react-router-dom 8.3.0+ 后立即移除。`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    globalThis.console.error(
      `生产依赖 audit 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
