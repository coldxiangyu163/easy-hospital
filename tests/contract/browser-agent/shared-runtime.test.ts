import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  buildBrowserAgentPayload,
  classifyVisiblePageState,
  isBrowserAgentOfficialSourceCompatible,
  type BrowserAgentPayloadInput,
  type ClassifiedVisiblePageState,
  type VisiblePageSignals,
} from '../../../src/adapters/sources/local-browser-agent.js';

type ExtensionRuntime = {
  classifyVisiblePageState(input: VisiblePageSignals): ClassifiedVisiblePageState;
  isOfficialSourceCompatible(sourceUrl: string, hospitalId: string): boolean;
  buildPayload(input: BrowserAgentPayloadInput): unknown;
};

const sharedUrl = new URL('../../../browser-extension/shared.js', import.meta.url);

const loadExtensionRuntime = async (): Promise<ExtensionRuntime> => {
  const context: Record<string, unknown> = { URL };
  runInNewContext(await readFile(fileURLToPath(sharedUrl), 'utf8'), context);
  return context.EasyHospitalBrowserAgent as ExtensionRuntime;
};

describe('Browser Agent extension shared runtime', () => {
  it('keeps the unpacked-extension classifier and payload behavior aligned with the typed seam', async () => {
    const runtime = await loadExtensionRuntime();
    const signalCases: VisiblePageSignals[] = [
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['可预约'],
        guardTexts: [],
      },
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['已约满'],
        guardTexts: [],
      },
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['可预约'],
        guardTexts: ['请完成人机验证'],
      },
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['可预约'],
        guardTexts: ['请重新登录'],
      },
      { matchedSelectorIds: [], statusTexts: [], guardTexts: [] },
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['可候补'],
        guardTexts: [],
      },
      {
        matchedSelectorIds: ['official.schedule-status'],
        statusTexts: ['剩余 0 号'],
        guardTexts: [],
      },
    ];
    const input: BrowserAgentPayloadInput = {
      sourceUrl: 'https://pumchapp.pumch.cn/path?private=removed',
      observedAt: '2026-07-19T00:00:00.000Z',
      classified: classifyVisiblePageState(signalCases[0]!),
      confirmation: {
        confirmed: true,
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        date: '2026-07-20',
        session: 'AM',
        doctorName: '',
        title: '',
      },
    };

    for (const signals of signalCases) {
      expect(runtime.classifyVisiblePageState(signals)).toEqual(
        classifyVisiblePageState(signals),
      );
    }
    expect(
      runtime.isOfficialSourceCompatible(input.sourceUrl, input.confirmation.hospitalId),
    ).toBe(
      isBrowserAgentOfficialSourceCompatible(
        input.sourceUrl,
        input.confirmation.hospitalId,
      ),
    );
    expect(runtime.buildPayload(input)).toEqual(buildBrowserAgentPayload(input));
  });
});
