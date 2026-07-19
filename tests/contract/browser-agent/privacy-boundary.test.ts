import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const extensionFile = (name: string): URL =>
  new URL(`../../../browser-extension/${name}`, import.meta.url);

const readExtensionFile = async (name: string): Promise<string> =>
  readFile(fileURLToPath(extensionFile(name)), 'utf8');

describe('Browser Agent privacy boundary', () => {
  it('contains no APIs for session export, full DOM capture, or automated interaction', async () => {
    const [shared, contentScript, popup, options] = await Promise.all(
      ['shared.js', 'content-script.js', 'popup.js', 'options.js'].map(readExtensionFile),
    );
    const joined = [shared, contentScript, popup, options].join('\n');

    for (const forbidden of [
      'document.cookie',
      'localStorage',
      'chrome.cookies',
      'webRequest',
      'innerHTML',
      'outerHTML',
      'XMLHttpRequest',
      'MutationObserver',
      'setInterval(',
      '.click(',
      'dispatchEvent(',
    ]) {
      expect(joined).not.toContain(forbidden);
    }

    expect(contentScript).toContain("message.type === 'GET_PAGE_ORIGIN_STATE'");
    expect(contentScript).toContain("message.type !== 'SCAN_VISIBLE_STATUS'");
    expect(popup).not.toContain('tab.url');
    expect(popup).toContain('submitObservationAfterServerProof');
    expect(popup).not.toContain('fetch(OBSERVATIONS_URL');
    expect(options).toContain('verifyLoopbackServerProof');
    expect(joined).toContain('chrome.storage.local');
    expect(joined).toContain(
      "http://127.0.0.1:3210/api/browser-agent/observations",
    );
    expect(joined).toContain("Authorization: `Bearer ${pairingToken}`");
  });
});
