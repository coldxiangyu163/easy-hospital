import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const sharedUrl = new URL('../../../browser-extension/shared.js', import.meta.url);
const contentScriptUrl = new URL(
  '../../../browser-extension/content-script.js',
  import.meta.url,
);

const confirmation = {
  confirmed: true,
  hospitalId: 'hospital-pumch',
  campusId: 'campus-pumch-dongdan',
  departmentId: 'department-pumch-dermatology',
  date: '2026-07-20',
  session: 'AM',
  doctorName: '',
  title: '',
};

const scan = async (html: string, url: string): Promise<Record<string, unknown>> => {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const window = dom.window as any;
  Object.defineProperties(window, {
    innerHeight: { value: 900 },
    innerWidth: { value: 1_200 },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent ?? '';
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 20,
    top: 10,
    left: 10,
    bottom: 30,
    right: 110,
  });
  window.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
  });

  let listener: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => void) | undefined;
  window.chrome = {
    runtime: {
      onMessage: {
        addListener(value: typeof listener) {
          listener = value;
        },
      },
    },
  };
  window.eval(await readFile(fileURLToPath(sharedUrl), 'utf8'));
  window.eval(await readFile(fileURLToPath(contentScriptUrl), 'utf8'));

  let response: unknown;
  listener?.(
    { type: 'SCAN_VISIBLE_STATUS', confirmation },
    {},
    (value) => {
      response = value;
    },
  );
  dom.window.close();
  return response as Record<string, unknown>;
};

describe('Browser Agent content-script fail-closed boundary', () => {
  it('returns unknown when an unrecognized verification overlay is visible', async () => {
    const result = await scan(
      `
        <div class="geetest_panel">请完成人机验证</div>
        <div class="schedule-item">
          北京协和医院 东单院区 皮肤科 2026-07-20 上午
          <span class="status">可预约</span>
        </div>
      `,
      'https://pumchapp.pumch.cn/schedule?token=must-not-leave#private',
    );

    expect(result).toMatchObject({
      ok: true,
      scan: {
        sourceUrl: 'https://pumchapp.pumch.cn',
        classified: {
          availability: 'unknown',
          diagnosticCode: 'VERIFICATION_REQUIRED',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leave');
  });

  it('does not attribute another hospital row on 114 to the confirmed scope', async () => {
    const result = await scan(
      `
        <div class="schedule-item">
          北京天坛医院 神经外科 2026-07-20 上午
          <span class="status">可预约</span>
        </div>
      `,
      'https://www.114yygh.com/schedule',
    );

    expect(result).toMatchObject({
      ok: true,
      scan: {
        classified: {
          availability: 'unknown',
          diagnosticCode: 'SELECTOR_NOT_FOUND',
        },
      },
    });
  });
});
