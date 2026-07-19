import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const readExtensionFile = (name: string): Promise<string> =>
  readFile(
    fileURLToPath(new URL(`../../../browser-extension/${name}`, import.meta.url)),
    'utf8',
  );

describe('Browser Agent popup and options disclosure', () => {
  it('requires all user-confirmed scope fields and states the privacy and automation boundaries', async () => {
    const [popup, options, readme] = await Promise.all([
      readExtensionFile('popup.html'),
      readExtensionFile('options.html'),
      readExtensionFile('README.md'),
    ]);

    for (const id of [
      'hospital-id',
      'campus-id',
      'department-id',
      'date',
      'session',
      'doctor-name',
      'title',
      'confirmed',
      'scan',
      'submit',
    ]) {
      expect(popup).toContain(`id="${id}"`);
    }

    expect(popup).toContain('实验性');
    expect(popup).toContain('只有点击下方“读取可见状态”后才扫描一次');
    expect(popup).toContain('不会自动预约、点击号源、提交、付款或处理验证码');
    expect(popup).toContain('完整 DOM/HTML');
    expect(options).toContain('默认关闭');
    expect(options).toContain('尚待真实会话验证');
    expect(options).toContain('chrome.storage.local');
    expect(options).toContain('HMAC-SHA256');
    expect(options).toContain('challenge 只发送随机 nonce');
    expect(popup).toContain('每次提交前');
    expect(readme).toContain('HMAC-SHA256');
    expect(options).toContain('unknown');
    expect(options).toContain('绝不会发往医院域名');
    expect(options).toContain('不存在隶属、授权、合作或代理关系');
    expect(readme).toContain('实验性');
    expect(`${popup}\n${options}\n${readme}`).not.toContain('已审计 selector');
    expect(popup).not.toContain('不读取或发送医院 Cookie、会话 Token');
  });
});
