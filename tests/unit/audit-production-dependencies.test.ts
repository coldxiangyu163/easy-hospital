import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assessAuditReport,
  assertSpaRouterBoundary,
  parseAuditJson,
} from '../../scripts/audit-production-dependencies.mjs';

const allowedAdvisory = {
  source: 1,
  name: 'react-router',
  dependency: 'react-router',
  title: 'React Router RSC CSRF',
  url: 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
  severity: 'high',
  range: '7.12.0 - 8.2.0',
};

function allowedReport() {
  return {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 2,
        critical: 0,
        total: 2,
      },
    },
    vulnerabilities: {
      'react-router': {
        name: 'react-router',
        severity: 'high',
        isDirect: false,
        via: [allowedAdvisory],
        effects: ['react-router-dom'],
        nodes: ['node_modules/react-router'],
      },
      'react-router-dom': {
        name: 'react-router-dom',
        severity: 'high',
        isDirect: true,
        via: ['react-router'],
        effects: [],
        nodes: ['node_modules/react-router-dom'],
      },
    },
  };
}

describe('production dependency audit 临时豁免', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('递归展开 via，仅接受指定 GHSA 及 react-router 包集合', () => {
    expect(assessAuditReport(allowedReport())).toEqual({
      waivedAdvisories: ['GHSA-qwww-vcr4-c8h2'],
      affectedPackages: ['react-router', 'react-router-dom'],
      unwaivedCount: 0,
    });
  });

  it('临时伪 audit JSON 新增任意 high 时 fail closed', () => {
    const report = allowedReport();
    report.metadata.vulnerabilities.high = 3;
    report.metadata.vulnerabilities.total = 3;
    Object.assign(report.vulnerabilities, {
      'find-my-way': {
        name: 'find-my-way',
        severity: 'high',
        isDirect: false,
        via: [
          {
            ...allowedAdvisory,
            name: 'find-my-way',
            dependency: 'find-my-way',
            url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
          },
        ],
        effects: ['fastify'],
        nodes: ['node_modules/find-my-way'],
      },
    });

    expect(() => assessAuditReport(report)).toThrow(/未豁免.*find-my-way/u);
  });

  it('未知 via 和非法 audit JSON 均 fail closed', () => {
    const report = allowedReport();
    report.vulnerabilities['react-router-dom'].via = ['unknown-package'];
    expect(() => assessAuditReport(report)).toThrow(/未知 via/u);
    expect(() => parseAuditJson('not-json')).toThrow(/JSON/u);
  });

  it('当前源码只使用明确允许的 react-router-dom SPA API', async () => {
    await expect(assertSpaRouterBoundary(join(process.cwd(), 'src'))).resolves.toBeUndefined();
  });

  it('RSC marker 或 react-router 直接导入时 fail closed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-audit-boundary-'));
    const entry = join(directory, 'entry.tsx');
    await writeFile(entry, '"use server";\n', 'utf8');
    await expect(assertSpaRouterBoundary(directory)).rejects.toThrow(/RSC|Server Action/u);

    await writeFile(entry, "import { Route } from 'react-router';\n", 'utf8');
    await expect(assertSpaRouterBoundary(directory)).rejects.toThrow(/直接或服务端导入/u);
  });
});
