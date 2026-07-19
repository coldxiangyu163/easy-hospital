import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const root = new URL('../', import.meta.url);
const readText = (path) => readFile(new URL(path, root), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));

const [manifest, lockfile, license, readme] = await Promise.all([
  readJson('package.json'),
  readJson('package-lock.json'),
  readText('LICENSE'),
  readText('README.md'),
]);

assert.equal(manifest.private, true, 'package.json 的 private 必须是 boolean true');
assert.equal(manifest.license, 'MIT', 'package.json 的 license 必须是 MIT');
assert.equal('main' in manifest, false, '私有应用不得声明不存在的 main 入口');
assert.equal(lockfile.packages?.['']?.license, 'MIT', 'package-lock.json 根包许可证必须是 MIT');
assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 coldxiangyu163\n/);
assert.match(readme, /本仓库采用 \[MIT License\]\(LICENSE\)/);
assert.match(readme, /不发布到 npm Registry/);

globalThis.console.log('发布元数据检查通过：private=true，MIT 许可证一致，未声明 npm 入口。');
