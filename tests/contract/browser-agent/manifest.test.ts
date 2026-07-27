import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Manifest = {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
  background?: unknown;
};

const manifestUrl = new URL('../../../browser-extension/manifest.json', import.meta.url);

describe('Browser Agent MV3 manifest', () => {
  it('grants network access only to loopback and limits content scripts to official sites', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(manifestUrl), 'utf8'),
    ) as Manifest;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.toSorted()).toEqual(['activeTab', 'storage']);
    expect(manifest.permissions).not.toEqual(
      expect.arrayContaining(['cookies', 'webRequest', 'webRequestBlocking', 'scripting', 'tabs']),
    );
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:3210/*']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0]?.matches.toSorted()).toEqual(
      [
        'https://*.114yygh.com/*',
        'https://*.bjtrhos.cn/*',
        'https://*.pumch.cn/*',
        'https://*.pumchapp.pumch.cn/*',
        'https://*.trhos.com/*',
        'https://114yygh.com/*',
        'https://bjtrhos.cn/*',
        'https://pumch.cn/*',
        'https://pumchapp.pumch.cn/*',
        'https://trhos.com/*',
      ].toSorted(),
    );
    expect(manifest.content_scripts[0]?.matches).not.toEqual(
      expect.arrayContaining([
        'https://*.pkuph.cn/*',
        'https://*.puh3.net.cn/*',
        'https://*.jst-hosp.com.cn/*',
        'https://*.fuwaihospital.org/*',
        'https://*.anzhen.org/*',
        'https://*.pkufh.com/*',
        'https://*.bjtth.org/*',
        'https://*.bch.com.cn/*',
        'https://*.cicams.ac.cn/*',
      ]),
    );
  });
});
