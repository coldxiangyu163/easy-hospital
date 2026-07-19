import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePumchSchedule } from '../../src/adapters/sources/pumch-schedule.js';

const fixtureUrl = new URL('../fixtures/pumch/skin-schedule.fragment.html', import.meta.url);
const metadataUrl = new URL('../fixtures/pumch/skin-schedule.fragment.meta.json', import.meta.url);

describe('parsePumchSchedule fixture contract', () => {
  it('parses only published doctor sessions without inventing availability', async () => {
    const [html, metadataText] = await Promise.all([
      readFile(fileURLToPath(fixtureUrl), 'utf8'),
      readFile(fileURLToPath(metadataUrl), 'utf8'),
    ]);
    const metadata = JSON.parse(metadataText) as {
      adapterKey: string;
      adapterVersion: string;
      collectedDate: string;
      contentSha256: string;
      sanitized: boolean;
      sourceUrl: string;
    };

    expect(metadata).toMatchObject({
      adapterKey: 'pumch-public-dermatology-schedule',
      adapterVersion: '1.0.0',
      collectedDate: '2026-07-19',
      sanitized: true,
    });
    expect(metadata.sourceUrl).toBe(
      'https://www.pumch.cn/expert_chuzhen_week/%E7%9A%AE%E8%82%A4%E7%A7%91/3/1.html?linkage=990473',
    );
    expect(createHash('sha256').update(html).digest('hex')).toBe(metadata.contentSha256);

    expect(parsePumchSchedule(html)).toEqual({
      range: {
        start: '2026-07-20',
        end: '2026-07-21',
      },
      sessions: [
        {
          date: '2026-07-20',
          period: 'morning',
          doctors: ['医生甲', '医生乙'],
        },
        {
          date: '2026-07-20',
          period: 'afternoon',
          doctors: ['医生丙'],
        },
        {
          date: '2026-07-21',
          period: 'afternoon',
          doctors: ['医生丁'],
        },
      ],
    });
  });

  it('accepts a legitimate partial date row when the page contains multiple schedule tables', () => {
    const html = `
      <table><tr><td>上午</td><td>非排班说明行</td></tr></table>
      <table>
        <tr><th class="th3">2026.07.20</th><th class="th3">2026.07.21</th></tr>
        <tr><td>上午</td><td class="tdh3"><span><a href="/detail/123.html">医生甲</a></span></td></tr>
      </table>
    `;

    expect(parsePumchSchedule(html).sessions).toEqual([
      { date: '2026-07-20', period: 'morning', doctors: ['医生甲'] },
    ]);
  });

  it.each([
    ['CTA link', '<span><a href="/detail/123.html">预约</a></span>'],
    ['descriptive CTA link', '<span><a href="/detail/123.html">专家介绍</a></span>'],
  ])('ignores a non-doctor %s without creating a schedule observation', (_label, linkHtml) => {
    const html = `
      <table>
        <tr><th class="th3">2026.07.20</th></tr>
        <tr><td>上午</td><td class="tdh3">${linkHtml}</td></tr>
      </table>
    `;

    expect(parsePumchSchedule(html).sessions).toEqual([]);
  });

  it('uses doctor text inside an audited date cell without trusting or emitting the link target', () => {
    const html = `
      <table>
        <tr><th class="th3">2026.07.20</th></tr>
        <tr><td>上午</td><td class="tdh3"><span><a href="/profiles/example">医生甲</a></span></td></tr>
      </table>
    `;

    expect(parsePumchSchedule(html).sessions).toEqual([
      { date: '2026-07-20', period: 'morning', doctors: ['医生甲'] },
    ]);
  });
});
