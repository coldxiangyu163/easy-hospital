import { describe, expect, it } from 'vitest';

import { buildBrowserAgentPayload } from '../../../src/adapters/sources/local-browser-agent.js';
import { browserAgentIngestSchema } from '../../../src/core/browser-agent.js';

describe('Browser Agent local ingest compatibility', () => {
  it('builds the strict normalized Observation accepted by the loopback endpoint', () => {
    const payload = buildBrowserAgentPayload({
      sourceUrl: 'https://pumchapp.pumch.cn/pages/pc/home/index?private=removed',
      observedAt: '2026-07-19T00:00:00.000Z',
      classified: { availability: 'available', diagnosticCode: null },
      confirmation: {
        confirmed: true,
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        date: '2026-07-20',
        session: 'AM',
        doctorName: '医生甲',
        title: '',
      },
    });

    expect(browserAgentIngestSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      sourceId: 'browser-agent-hospital-pumch',
      observedAt: '2026-07-19T00:00:00.000Z',
      observations: [
        {
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          date: '2026-07-20',
          session: 'AM',
          doctorName: '医生甲',
          title: null,
          scheduleStatus: 'unknown',
          availability: 'available',
          officialEntryUrl: 'https://pumchapp.pumch.cn/',
          evidence: 'explicit',
        },
      ],
    });
  });
});
