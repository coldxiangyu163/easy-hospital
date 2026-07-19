import { describe, expect, it } from 'vitest';

import {
  buildBrowserAgentPayload,
  type BrowserAgentConfirmation,
} from '../../../src/adapters/sources/local-browser-agent.js';

const confirmation: BrowserAgentConfirmation = {
  confirmed: true,
  hospitalId: 'hospital-pumch',
  campusId: 'campus-pumch-dongdan',
  departmentId: 'department-pumch-dermatology',
  date: '2026-07-20',
  session: 'AM',
  doctorName: '医生甲',
  title: '',
};

describe('buildBrowserAgentPayload', () => {
  it('builds one minimal normalized observation only after explicit confirmation', () => {
    const payload = buildBrowserAgentPayload({
      sourceUrl: 'https://pumchapp.pumch.cn/pages/pc/home/index?token=must-not-leave#private',
      observedAt: '2026-07-19T00:00:00.000Z',
      classified: { availability: 'available', diagnosticCode: null },
      confirmation,
    });

    expect(payload).toEqual({
      sourceId: 'browser-agent-hospital-pumch',
      requestId: 'browser-agent-hospital-pumch:2026-07-19T00:00:00.000Z',
      observedAt: '2026-07-19T00:00:00.000Z',
      observations: [
        {
          slotKey:
            'browser-agent:hospital-pumch:campus-pumch-dongdan:department-pumch-dermatology:2026-07-20:AM:%E5%8C%BB%E7%94%9F%E7%94%B2:*',
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          date: '2026-07-20',
          session: 'AM',
          doctorName: '医生甲',
          title: null,
          availability: 'available',
          scheduleStatus: 'unknown',
          officialEntryUrl: 'https://pumchapp.pumch.cn/',
          evidence: 'explicit',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-leave');
  });

  it('rejects a submission that the user has not explicitly confirmed', () => {
    expect(() =>
      buildBrowserAgentPayload({
        sourceUrl: 'https://www.bjtrhos.cn/',
        observedAt: '2026-07-19T00:00:00.000Z',
        classified: { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' },
        confirmation: { ...confirmation, confirmed: false },
      }),
    ).toThrowError('USER_CONFIRMATION_REQUIRED');
  });

  it('rejects lookalike and non-official source domains', () => {
    expect(() =>
      buildBrowserAgentPayload({
        sourceUrl: 'https://pumch.cn.attacker.example/fake',
        observedAt: '2026-07-19T00:00:00.000Z',
        classified: { availability: 'available', diagnosticCode: null },
        confirmation,
      }),
    ).toThrowError('OFFICIAL_URL_NOT_ALLOWED');
  });

  it('rejects a mismatched hospital, campus, or department scope', () => {
    expect(() =>
      buildBrowserAgentPayload({
        sourceUrl: 'https://www.114yygh.com/',
        observedAt: '2026-07-19T00:00:00.000Z',
        classified: { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' },
        confirmation: {
          ...confirmation,
          campusId: 'campus-tongren-chongwenmen',
        },
      }),
    ).toThrowError('CONFIRMATION_FIELDS_INCOMPLETE');
  });

  it('rejects a hospital confirmation that conflicts with the official source domain', () => {
    expect(() =>
      buildBrowserAgentPayload({
        sourceUrl: 'https://pumchapp.pumch.cn/',
        observedAt: '2026-07-19T00:00:00.000Z',
        classified: { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' },
        confirmation: {
          ...confirmation,
          hospitalId: 'hospital-tongren',
          campusId: 'campus-tongren-chongwenmen',
          departmentId: 'department-tongren-rhinology',
        },
      }),
    ).toThrowError('OFFICIAL_SCOPE_MISMATCH');
  });

  it('fails closed to unknown when a caller supplies an invalid classified state', () => {
    const payload = buildBrowserAgentPayload({
      sourceUrl: 'https://www.114yygh.com/',
      observedAt: '2026-07-19T00:00:00.000Z',
      classified: {
        availability: 'maybe',
        diagnosticCode: null,
      } as unknown as { availability: 'available'; diagnosticCode: null },
      confirmation,
    });

    expect(payload.observations[0]).toMatchObject({
      availability: 'unknown',
      scheduleStatus: 'unknown',
    });
  });

  it('fails closed when a diagnostic error conflicts with definite availability', () => {
    const payload = buildBrowserAgentPayload({
      sourceUrl: 'https://pumch.cn/',
      observedAt: '2026-07-19T00:00:00.000Z',
      classified: { availability: 'available', diagnosticCode: 'AUTH_REQUIRED' },
      confirmation,
    });

    expect(payload.observations[0]).toMatchObject({
      availability: 'unknown',
      scheduleStatus: 'unknown',
    });
  });

  it('rejects a malformed observation timestamp', () => {
    expect(() =>
      buildBrowserAgentPayload({
        sourceUrl: 'https://www.114yygh.com/',
        observedAt: 'not-a-time',
        classified: { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' },
        confirmation,
      }),
    ).toThrowError('OBSERVED_AT_INVALID');
  });
});
