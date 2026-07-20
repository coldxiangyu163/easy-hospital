# 配置说明

北京挂号雷达只在本机运行。配置控制本地监听地址、SQLite 数据目录、北京时间和通知渠道，不提供 Docker、外部数据库、外部队列、云同步或遥测开关。

## 配置流程

在仓库根目录复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env` 后启动：

```bash
npm start
```

稳定版本必须在 `npm start` 时读取仓库根目录的 `.env` 和当前进程环境变量。不要把 `.env` 提交到 Git。

macOS 和 Linux 可以限制文件权限：

```bash
chmod 600 .env
```

## 运行配置

| 变量 | 默认值 | 是否必需 | 规则 |
|---|---|---:|---|
| `RADAR_HOST` | `127.0.0.1` | 是 | 只允许 loopback。稳定版不支持 `0.0.0.0`、局域网 IP、公网 IP 或反向代理模式 |
| `RADAR_PORT` | `3210` | 是 | 本机未占用端口，建议使用 1024 到 65535 |
| `RADAR_DATA_DIR` | 平台数据目录（见下） | 是 | 本机文件系统目录，保存 SQLite、WAL、备份、锁和脱敏日志 |
| `RADAR_TIMEZONE` | `Asia/Shanghai` | 是 | 固定为北京时间，当前不支持其他时区 |
| `EASY_HOSPITAL_DISABLE_LIVE_SOURCES` | `0` | 仅测试/CI | 只有精确值 `1` 会让生产 runtime 注入空来源适配器，禁止真实医院来源请求 |
| `EASY_HOSPITAL_BROWSER_AGENT_TOKEN` | 空 | 可选、实验性 | 至少 32 字节随机配对值；不是医院凭证。为空时 B 级 Browser Agent 完全关闭 |

### 监听地址

应用应只接受：

```dotenv
RADAR_HOST=127.0.0.1
```

不要改成：

```dotenv
RADAR_HOST=0.0.0.0
```

本地-only 不等于允许局域网访问。恶意网页仍可能尝试请求 localhost，因此服务端还需要校验 Host、Origin 和 CSRF，不能只依赖监听地址。

### 端口

默认管理端地址：

```text
http://127.0.0.1:3210
```

如果 3210 已被占用，可以改为另一个本机端口：

```dotenv
RADAR_PORT=4321
```

修改后访问对应地址。不要通过端口映射、隧道或反向代理把管理端暴露出去。

### 数据目录

`.env.example` 显式提供开发默认值：

```dotenv
RADAR_DATA_DIR=./data
```

注意：`./data` 只是 `.env.example` 的显式配置，不是应用内建默认值。如果完全没有设置
`RADAR_DATA_DIR`（包括没有 `.env` 就直接 `npm start`），应用会使用平台数据目录——
macOS 为 `~/Library/Application Support/easy-hospital`，Linux 为
`${XDG_DATA_HOME:-~/.local/share}/easy-hospital`——而不是仓库内的 `./data`。

长期使用建议改成仓库外的绝对路径，避免切换分支、清理工作树或误删仓库时影响数据。目录必须位于本机磁盘，不能放在 NFS、SMB、NAS、iCloud Drive、Dropbox、OneDrive 或其他多机同步目录。

示例：

```dotenv
RADAR_DATA_DIR=/Users/your-account/Library/Application Support/easy-hospital
```

路径中的账户名属于本机信息，不要粘贴到公开 Issue。诊断信息应在分享前移除用户目录部分。

应用使用 `better-sqlite3`。数据库写入采用短事务，网络请求和 Playwright 操作不能占用写事务。SQLite、WAL、SHM、备份和锁文件均属于运行数据，不得提交 Git。在支持 POSIX 权限位的平台，应用会把数据目录与备份/rollback 目录收紧为 `0700`，把数据库、WAL/SHM、迁移备份、恢复临时文件和 rollback 文件收紧为 `0600`；不支持 POSIX 权限位的平台会保留平台原生 ACL 行为。

### 时区

```dotenv
RADAR_TIMEZONE=Asia/Shanghai
```

放号时间、就诊日期、监测窗口和通知都按北京时间解释。修改为其他时区会造成提醒偏移，稳定版应拒绝启动，而不是静默换算。

### 本机 HTTP 与任务契约

管理端仍是本机 Web 应用，不是可暴露到公网的通用 API：

- 带 `Origin` 的普通 `POST`、`PATCH`、`DELETE` 等写请求，`Origin` 必须是 loopback Web Origin，并必须携带 `x-easy-hospital-client: web`。缺失或取值错误返回 `403 CLIENT_HEADER_REQUIRED`；跨站 Origin 返回 `403 LOCAL_ORIGIN_REQUIRED`。
- 无 `Origin` 的本机 CLI 请求保留给 `curl` 等非浏览器客户端，但仍受 loopback Host、输入 schema、catalog 和来源政策校验；这不代表可以通过反向代理暴露服务。
- Browser Agent observation 使用独立的 `chrome-extension://` Origin、nonce/HMAC 和 Bearer 配对契约，不使用 `x-easy-hospital-client: web` 代替扩展认证。
- 创建任务，以及修改日期或重新启用任务时，`dateFrom`/`dateTo` 必须落在**北京时间今天到今天加 14 天（含两端）**；非法范围返回 `400 VALIDATION_ERROR`。
- 同仁崇文门鼻科是 C 级规则提醒。管理端提交前会规范化为 `matchMode=any_expert`、`doctorName=null`、空职称、`session=ANY`、仅 `schedule_released`，并要求非空的 `remindBeforeMinutes`。API 不会替第三方调用者静默改写：创建或编辑结果不符合上述规范时返回 `400 SOURCE_POLICY_VIOLATION`。

### 测试与 CI 来源隔离

普通运行保持：

```dotenv
EASY_HOSPITAL_DISABLE_LIVE_SOURCES=0
```

Playwright 和 production start smoke 使用：

```dotenv
EASY_HOSPITAL_DISABLE_LIVE_SOURCES=1
```

只有值精确为 `1` 时，生产 runtime 才会注入空的真实来源适配器列表；`true`、`yes` 或其他值都不会禁用真实来源。该开关只用于测试与 CI，不是日常运行的故障恢复选项，也不改变通知渠道配置。

## 实验性 Browser Agent 配对

Browser Agent 默认关闭，尚未完成真实医院会话的长期 selector 验证。只有准备进行本机实验时才配置：

```bash
openssl rand -base64 32
```

把输出分别保存到 `.env` 的 `EASY_HOSPITAL_BROWSER_AGENT_TOKEN` 和扩展选项页。不要复用医院密码、医院 Cookie、医院会话 Token 或其他账号密钥。扩展每次提交前先通过 nonce + HMAC-SHA256 验证 `127.0.0.1:3210` 服务身份，proof 不匹配时不会发送 observation；配对 token 只会在 proof 成功后作为 Bearer 发给固定本机 observation 端点，且不会写入 SQLite 或日志。

安装、允许域名和 fail-closed 行为见 [`../browser-extension/README.md`](../browser-extension/README.md)。

## Bark 通知

生产 runtime 当前会装配 Bark。设备 Key 非空且服务地址有效时启用：

| 变量 | 默认值 | 是否必需 | 说明 |
|---|---|---:|---|
| `BARK_BASE_URL` | `https://api.day.app` | 使用 Bark 时必需 | Bark 服务地址，只允许 HTTPS |
| `BARK_DEVICE_KEY` | 空 | 使用 Bark 时必需 | Bark App 提供的设备 Key，按秘密处理 |

不得在截图、日志、Issue 或测试 Fixture 中公开完整设备 Key。自托管 Bark 服务的信任、可用性和消息处理由用户自行评估。启用后应先从本机设置页发送测试通知，并在设备上确认真实到达。

## macOS 本机通知

在 macOS 上且 `/usr/bin/osascript` 可执行时，生产 runtime 会自动启用本机通知，不需要环境变量。其他操作系统或 `osascript` 不可用时该渠道保持禁用。本机通知由当前登录用户的系统权限和通知设置控制，启用后应先确认一条测试通知真实显示。

## SMTP 通知

| 变量 | 默认值 | 是否必需 | 说明 |
|---|---|---:|---|
| `SMTP_HOST` | 空 | 使用 SMTP 时必需 | 邮件服务器主机名 |
| `SMTP_PORT` | `465` | 使用 SMTP 时必需 | SMTP 端口 |
| `SMTP_SECURE` | `true` | 使用 SMTP 时必需 | `true` 表示连接开始即使用 TLS |
| `SMTP_USER` | 空 | 由服务商决定 | SMTP 用户名 |
| `SMTP_PASSWORD` | 空 | 由服务商决定 | SMTP 密码或应用专用密码，按秘密处理 |
| `SMTP_FROM` | 空 | 使用 SMTP 时必需 | 发件人地址，需满足服务商规则 |
| `SMTP_TO` | 空 | 使用 SMTP 时必需 | 接收提醒的地址 |

端口 465 的常见配置：

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=local-user@example.com
SMTP_PASSWORD=应用专用密码
SMTP_FROM=local-user@example.com
SMTP_TO=alert-recipient@example.com
```

端口 587 通常使用：

```dotenv
SMTP_PORT=587
SMTP_SECURE=false
```

`SMTP_SECURE=false` 表示连接后使用 STARTTLS；应用会强制 `requireTLS=true`，服务器不支持 TLS 时必须失败，不允许降级到明文 SMTP。具体要求以邮件服务商文档为准。优先使用应用专用密码，不要使用邮箱主密码。应用不得把 SMTP 密码写入 SQLite、日志、健康接口或浏览器端。

## 通知渠道选择

生产 runtime 当前同时装配 macOS 本机通知、Bark 和 SMTP。满足各自启用条件的渠道都会收到每一条提醒；这是多渠道并发投递，不是按顺序回退，也没有“一个成功后跳过其他渠道”的主备语义。

没有任何外部渠道可用时，应用仍可保存规则、任务和站内通知记录，但不能声称外部提醒可用。真实提醒启用前，应分别执行每个已启用渠道的测试通知，并在对应设备或邮箱确认真实到达。测试通知必须明确标注“测试”，避免被误解为真实排班或号源变化。

## 数据与秘密

以下内容属于秘密或敏感数据：

- `BARK_DEVICE_KEY`
- `SMTP_PASSWORD`
- 可能用于认证的 `SMTP_USER`
- 医院、科室、医生和日期偏好
- SQLite 主库、WAL、SHM 和备份
- 通知正文和诊断日志

保护要求：

- `.env` 权限只给当前用户；生产启动在支持 POSIX 权限位的平台会尝试收紧为 `0600`。
- 不在 shell 历史中直接导出秘密。
- 不把 `.env`、数据目录或备份放入仓库。
- 不在公开 Issue 中粘贴完整环境变量或诊断包。
- 启用 FileVault、BitLocker 或 Linux 全盘加密。
- 共享诊断前移除通知地址、设备 Key、用户目录和任务条件。

项目默认无遥测、崩溃上报和云同步。允许的出站连接只有医院官方来源、用户配置的通知渠道，以及用户主动打开的 GitHub 页面。

## Playwright

协和公开排班页面需要浏览器渲染时，安装 Chromium：

```bash
npx playwright install chromium
```

Playwright 只按需启动，不是常驻服务。A 级公开来源使用临时、无登录 Context，不保存 Cookie、storage state、截图或 Trace。

浏览器未安装时，依赖 Playwright 的来源必须显示不可用或 `unknown`，规则提醒和其他来源仍可运行。应用不得为了恢复来源而下载未知浏览器、切换私有接口或提高访问频率。

## 启动检查

运行：

```bash
npm start
```

启动成功应满足：

- 只出现一个生产 Node.js 主进程。
- Web/API、Scheduler、Durable Job Runner 和 Notifier 一起就绪。
- `better-sqlite3` 可以打开数据目录中的真实磁盘数据库。
- 服务只监听 `127.0.0.1`。
- 终端显示本地 URL，不显示通知秘密。
- 第二个实例指向同一数据目录时安全退出，不发起来源请求。

应用启动不需要 Docker、PostgreSQL、Redis、独立 Worker 或第二条服务命令。

## 人工备份与恢复

### 启动与迁移保护

打开已有磁盘数据库时，应用按以下顺序执行：

1. 在任何 migration 前运行 SQLite `integrity_check`。失败时抛出稳定错误“数据库完整性检查失败，原数据库未被修改”，关闭连接并保留原文件，不创建替代库，也不自动恢复。
2. 验证全部已应用 migration 的连续 version、固定 name 和 SHA-256 checksum。migration 16 为 1–15 建立 checksum 基线，migration 17 `hospital-domain-policy` 新增 `hospital_domain` 作为域政策单一事实源：`officialEntryUrl` 只允许该医院登记的 `official` kind，`sourceUrl` 只允许登记的 `evidence` kind；同一官方域如也作为证据来源，会分别登记两种 kind。未登记域的医院或 URL fail closed。之后历史 migration SQL 被改写，或 `schema_migration` 的 name/checksum 被篡改，都会 fail closed。
3. 若已有磁盘库存在 pending migration，使用同步 `VACUUM INTO` 在 `<RADAR_DATA_DIR>/backups/` 创建迁移前一致性备份，重新以只读方式打开备份并通过 `integrity_check` 与 migration manifest 验证后才迁移。v0.1.1 候选至少演练一次 v16 → v17 的备份、迁移、重启与恢复。
4. 所有 pending migration 在同一事务中执行，完成后再次运行 `integrity_check`。

新建数据库和 `:memory:` 数据库不创建迁移备份。自动迁移备份按修改时间只保留最近 5 份；它们是升级保护，不代替独立的长期停机备份。

### 日常停机备份

1. 按 `Ctrl+C` 正常停止应用，并确认 Node.js 进程退出。
2. 复制整个 `RADAR_DATA_DIR` 到受控目录，不要遗漏 SQLite 主库、WAL、SHM、`backups/` 或 `corrupt/`。
3. 不要把备份提交 Git、附到公开 Issue 或放入公开云盘链接。
4. 在副本上核验，不要拿唯一备份做恢复演练。

### 列出和验证迁移备份

先构建 storage helper：

```bash
npm run build
```

停止应用后，用实际绝对路径替换示例值：

```bash
DATABASE_PATH='/absolute/path/to/data.sqlite3' \
node --input-type=module <<'NODE'
import {
  listDatabaseBackups,
  verifyDatabaseBackup,
} from './dist/server/storage/database.js';

const databasePath = process.env.DATABASE_PATH;
const backups = listDatabaseBackups(databasePath);
console.table(backups);
for (const backup of backups) console.log(verifyDatabaseBackup(backup.path));
NODE
```

`verifyDatabaseBackup` 必须同时通过 SQLite 完整性和 migration manifest 校验。不要选择无法验证、来源不明或从运行中数据库直接复制出的单文件。

### 显式恢复

恢复不会自动发生，必须由用户在应用完全停止后明确调用。`restoreDatabaseBackup` 会先获取与生产启动相同的 `<database>.lock` 原子实例锁：运行中的实例会让恢复 fail closed；已退出进程留下且所有权可确认的 stale lock 可安全回收；锁内容损坏或所有权无法确认时拒绝恢复。helper 获锁后才验证备份；验证失败时不会创建 rollback，也不会修改主库，并在结束时释放自己持有的锁。验证成功后，它会：

1. 把当前主库及现存 WAL/SHM 保存到 `<RADAR_DATA_DIR>/corrupt/` 的时间戳 rollback 副本；
2. 把已验证备份复制到主库同目录的临时文件并再次验证、同步落盘；
3. 使用同目录原子替换恢复主库，并清理旧 WAL/SHM；
4. 返回主库、备份和 rollback 路径。它不会删除 rollback，也不会自动启动应用。

执行：

```bash
DATABASE_PATH='/absolute/path/to/data.sqlite3' \
BACKUP_PATH='/absolute/path/to/backups/data.sqlite3.migration-v16-to-v17.TIMESTAMP.sqlite3' \
node --input-type=module <<'NODE'
import { restoreDatabaseBackup } from './dist/server/storage/database.js';

const result = restoreDatabaseBackup(
  process.env.DATABASE_PATH,
  process.env.BACKUP_PATH,
);
console.log(result);
NODE
```

然后执行 `npm start`。旧版本备份如果低于当前 schema，会再次按上述流程创建一致性备份并迁移。确认任务、规则、来源状态、通知记录和下一次提醒时间正确前，不要删除 `corrupt/` rollback。不要让旧版本应用直接打开已经被新版本迁移的数据库；回退应用时使用与该旧版本匹配的迁移前备份。

## 常见问题

### Node.js 版本不正确

```bash
node --version
cat .nvmrc
nvm use
```

必须使用 Node.js 24。切换大版本后重新执行 `npm ci`，让 `better-sqlite3` 原生模块与当前 Node.js 匹配。

### `better-sqlite3` 安装失败

先确认 Node.js 为 24，删除由其他 Node.js 大版本生成的 `node_modules`，然后重新运行：

```bash
npm ci
```

不要改用全局 SQLite 服务、PostgreSQL 或 Redis 绕过问题。若仍失败，提交不含用户名、路径秘密和环境变量值的安装错误摘要。

### 端口被占用

修改 `RADAR_PORT`，不要同时启动第二份应用共用同一数据目录。

### 提示「数据目录已有 easy-hospital 实例运行」

应用用 `<RADAR_DATA_DIR>/data.sqlite3.lock` 目录防止多实例写同一数据库。正常停止时锁
会自动清除；进程被 `SIGKILL`、断电或崩溃杀死会留下锁，但下次启动检测到锁内 PID 已
不存在时会自动回收，无需人工处理。

需要人工介入的唯一情况：旧进程退出后其 PID 被系统复用给了无关进程，应用 fail closed
拒绝启动。此时：

1. 确认没有正在运行的 easy-hospital 进程（macOS 用活动监视器，或 `pgrep -fl 'easy-hospital|dist/server/server/main.js'`）。
2. 确认后删除锁目录：`rm -rf "<RADAR_DATA_DIR>/data.sqlite3.lock"`。
3. 重新 `npm start`。

不要为了绕过检查而共享数据目录给第二个实例，也不要在应用运行中删除锁目录。

### 数据目录不可写

把 `RADAR_DATA_DIR` 改到当前用户拥有的本机目录。不要使用系统目录、网络盘或同步盘，也不要为了运行应用开放整个磁盘权限。

### 来源显示未知

查看来源健康状态和最后成功时间。登录墙、验证码、限流、页面改版和网络失败都应返回 `unknown`。不要连续点击重试，也不要把未知理解为无号。

### 没收到通知

分别检查配置完整性、服务连通性、服务是否接受和用户是否实际收到。应用记录“已发送”不等于接收端已经送达，最终以设备或邮箱实际收到为准。
