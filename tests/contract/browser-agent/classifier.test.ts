import { describe, expect, it } from 'vitest';

import { classifyVisiblePageState } from '../../../src/adapters/sources/local-browser-agent.js';

describe('classifyVisiblePageState', () => {
  it('classifies an explicit visible audited status as available', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['pumchapp.schedule-status'],
        statusTexts: ['可预约'],
        guardTexts: [],
      }),
    ).toEqual({
      availability: 'available',
      diagnosticCode: null,
    });
  });

  it('classifies only an explicit no-slot phrase as unavailable', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['pumchapp.schedule-status'],
        statusTexts: ['已约满'],
        guardTexts: [],
      }),
    ).toEqual({
      availability: 'unavailable',
      diagnosticCode: null,
    });
  });

  it('returns unknown when a visible verification challenge is present', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['pumchapp.schedule-status'],
        statusTexts: ['可预约'],
        guardTexts: ['请先完成人机验证'],
      }),
    ).toEqual({
      availability: 'unknown',
      diagnosticCode: 'VERIFICATION_REQUIRED',
    });
  });

  it('returns unknown when the visible page requires login', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: [],
        statusTexts: [],
        guardTexts: ['登录状态已失效，请重新登录'],
      }),
    ).toEqual({
      availability: 'unknown',
      diagnosticCode: 'AUTH_REQUIRED',
    });
  });

  it('returns unknown when no audited status selector matches', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: [],
        statusTexts: ['可预约'],
        guardTexts: [],
      }),
    ).toEqual({
      availability: 'unknown',
      diagnosticCode: 'SELECTOR_NOT_FOUND',
    });
  });

  it('returns unknown instead of choosing when visible statuses conflict', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['pumchapp.schedule-status'],
        statusTexts: ['可预约', '已约满'],
        guardTexts: [],
      }),
    ).toEqual({
      availability: 'unknown',
      diagnosticCode: 'AMBIGUOUS_STATUS',
    });
  });

  it('keeps an explicit waitlist state unknown rather than calling it unavailable', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['pumchapp.schedule-status'],
        statusTexts: ['可候补'],
        guardTexts: [],
      }),
    ).toEqual({
      availability: 'unknown',
      diagnosticCode: 'WAITLIST_ONLY',
    });
  });

  it('treats an explicit zero remaining count as unavailable', () => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['剩余 0 号'],
        guardTexts: [],
      }),
    ).toEqual({ availability: 'unavailable', diagnosticCode: null });
  });

  it.each([
    ['有号', 'available'],
    ['可挂号', 'available'],
    ['剩余 3 号', 'available'],
    ['无号', 'unavailable'],
    ['约满', 'unavailable'],
    ['暂无号源', 'unavailable'],
  ] as const)('recognizes the explicit audited phrase %s', (visibleText, availability) => {
    expect(
      classifyVisiblePageState({
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: [visibleText],
        guardTexts: [],
      }),
    ).toEqual({ availability, diagnosticCode: null });
  });
});
