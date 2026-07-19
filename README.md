# 北京挂号雷达

北京挂号雷达是一个单用户、本地运行的北京医院放号规则与新排班发布提醒工具。应用只监听本机地址，使用 Node.js 24、npm、`better-sqlite3` 和单个 Node.js 进程，不需要 Docker、PostgreSQL、Redis 或项目自有云服务。

> `0.1.0` 是首个稳定 MVP。它只在下述已验证边界内工作；不要把公开排班、规则提醒或实验性 Browser Agent 当作医院实时号源或预约保证。

## 当前承诺

首版只承诺两条真实能力：

| 目标 | 当前能力 | 不承诺 |
|---|---|---|
| 北京协和医院公开皮肤科排班 | 读取无需登录的官方公开排班，仅识别新排班发布并产生 `schedule_released` 类提醒 | 排班移除或取消、实时余号、可预约数量、从无号变有号、退号 |
| 北京同仁医院崇文门院区鼻科 | 保存一条研究所得、标记为需人工复核的放号规则，在预计时间前提醒，并提供官方预约或候补入口 | 把该规则当作医院当前承诺、自动读取小程序号源、实时有号、退号监控 |

排班不等于号源。看到医生有出诊安排，只能说明官方页面公开了排班，不能推断当前可以预约。

测试夹具可以演示“有号”“无号”和“疑似退号回流”的状态机，但夹具只用于测试。界面、通知和文档不得把测试结果写成真实医院状态。

## 能做什么

- 查看医院、院区、科室的放号规则、官方来源、核验时间和可信度。
- 创建连续最多 14 天的关注任务；协和公开排班可按医生、日期、时段和院区筛选，当前不支持按职称筛选。
- 在已核验的常规放号时间前 5 分钟提醒。
- 低频检查受支持的官方公开排班页，识别新排班发布并记录来源健康状态。
- 通过当前生产装配的 macOS 本机通知、Bark 和 SMTP 发送提醒；同时启用多个渠道时，每个渠道都会发送，不是主备切换。
- 跳转到经过白名单校验的官方入口，由用户继续操作。

## 不做什么

- 不自动抢号、预约、取号、确认或付款。
- 不识别或绕过验证码，不规避 WAF、登录限制和频率限制。
- 不使用多账号、代理池、IP 轮换或高频并发请求。
- 不逆向微信、支付宝、抖音小程序的私有接口。
- 不保存医院账号、Cookie、Token、身份证、医保卡、病历或支付信息。
- 不提供公网部署、多用户 SaaS、云同步、远程控制面或遥测。
- 不保证排班、号源、规则或通知始终准确，也不保证预约成功。

## 运行结构

```text
浏览器
  │ 仅访问 127.0.0.1
  ▼
单个 Node.js 24 进程
  ├─ 本地 Web/API
  ├─ Scheduler 与 Durable Job Runner
  ├─ SourceAdapter 与变化判断
  └─ Notifier
       │
       ├─ better-sqlite3 本地文件
       ├─ 医院官方公开来源
       └─ 用户配置的通知渠道
```

SQLite 中保存规则、任务、脱敏快照、持久任务、事件和通知状态。内存定时器只负责唤醒，不能作为业务事实来源。应用停止、电脑休眠或网络中断期间不会继续监测；恢复后先建立新基线，不推断离线期间发生过的变化。

## 安装

### 前置条件

- Git
- Node.js 24，仓库根目录的 `.nvmrc` 固定大版本
- Node.js 自带的 npm
- 可以访问医院官方页面和所选通知渠道的本机网络

不需要 Docker，也不需要安装或启动外部数据库、缓存、队列或 Worker。

### 获取并安装依赖

从 GitHub 的 `easy-hospital` 仓库页面复制 clone 地址，然后进入仓库目录：

```bash
cd easy-hospital
nvm use
npm ci
```

需要运行协和公开排班适配器或端到端测试时，安装项目锁定版本对应的 Chromium：

```bash
npx playwright install chromium
```

稳定版本必须保证 `npm ci` 能从锁文件安装 `better-sqlite3`。如果安装原生模块失败，请先确认 Node.js 为 24，并查看 [`docs/configuration.md`](docs/configuration.md) 的排障部分。

## 配置

复制示例配置：

```bash
cp .env.example .env
```

至少检查以下项目：

```dotenv
RADAR_HOST=127.0.0.1
RADAR_PORT=3210
RADAR_DATA_DIR=./data
RADAR_TIMEZONE=Asia/Shanghai
```

`RADAR_HOST` 必须保持为回环地址，`RADAR_TIMEZONE` 必须保持为 `Asia/Shanghai`。实验性 Browser Agent 默认关闭；如需评估，先阅读 [`browser-extension/README.md`](browser-extension/README.md)，生成至少 32 字节随机值写入 `EASY_HOSPITAL_BROWSER_AGENT_TOKEN`，再在扩展选项页保存同一配对 token。它不是医院凭证，不能复用医院密码或会话 Token。

生产运行时会装配 macOS 本机通知、Bark 和 SMTP：macOS 且 `/usr/bin/osascript` 可用时自动启用本机通知，填写 Bark 设备 Key 后启用 Bark，SMTP 配置完整后启用邮件；多个渠道同时可用时都会发送。完整字段、密钥处理、测试隔离、备份与恢复说明见 [`docs/configuration.md`](docs/configuration.md)。

`.env`、SQLite 文件、日志和运行数据已被 `.gitignore` 排除。不要把这些文件添加到 Git，也不要在公开 Issue 中粘贴原文。

## 运行

完成一次安装和配置后，只需要一条命令：

```bash
npm start
```

`prestart` 会先构建服务端和前端，随后单个 Node.js 进程启动 Web/API、调度、来源检查和通知。默认地址：

```text
http://127.0.0.1:3210
```

请保持终端进程、本机和网络处于可用状态。按 `Ctrl+C` 停止应用后，监测同时停止。

开发模式使用：

```bash
npm run dev
```

开发模式可以启动构建工具的辅助进程，不改变稳定运行时的单进程约束。

## SQLite 完整性、迁移备份与恢复

打开已有磁盘数据库时，应用会先执行 SQLite `integrity_check`，再验证 migration 1–16 的版本、名称和 checksum；数据库损坏、迁移记录被篡改或历史 migration 被改写时会 fail closed，不会自动覆盖或恢复原库。存在待执行 migration 时，应用先通过 `VACUUM INTO` 在数据目录的 `backups/` 下创建一致性备份并验证，只保留最近 5 份；新库和 `:memory:` 数据库不创建迁移备份。

恢复永远是停机后的人工操作。公开 storage helper 会先验证所选备份，把当前主库及现存 WAL/SHM 另存到 `corrupt/`，再以同目录原子替换方式恢复；它不会在启动失败时自动恢复。完整命令和核验步骤见 [`docs/configuration.md`](docs/configuration.md#人工备份与恢复)。

## 测试

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

真实来源检查和真实通知不应在普通 CI 或外部贡献者的 Fork 中运行。Playwright webServer 固定设置 `EASY_HOSPITAL_DISABLE_LIVE_SOURCES=1`，生产 runtime 只在该值精确为 `1` 时注入空来源适配器；E2E 还会阻断并断言浏览器没有非 loopback 请求。Fixture 测试证明解析和数据流可以重复执行，不证明医院页面当前可访问，也不证明当前有号。

每次稳定 Release 前，上述命令都必须在全新 checkout 中通过；普通 E2E 截图写入被忽略的 Playwright 输出目录，不改动仓库。只有维护者明确执行 `UPDATE_UI_ARTIFACTS=1 npm run test:e2e` 才刷新 `artifacts/ui/`。真实来源 live probe 只能由维护者显式执行，且受持久化两小时冷却限制。

测试证据等级和发布验收要求见 [`docs/test-strategy.md`](docs/test-strategy.md)。

## 数据来源与准确性

真实适配器必须访问官方顶层公开页面，声明允许域名、支持范围、最小访问间隔和失败行为。出现登录墙、验证码、403、418、429、空异常页或页面结构变化时，适配器返回 `unknown` 并退避，不能把失败写成“无号”。

当前真实来源边界、访问频率和适配器贡献门槛见 [`docs/data-source-policy.md`](docs/data-source-policy.md)。研究证据与官方链接见 [`docs/source-research.md`](docs/source-research.md)。

## 隐私

应用默认无遥测、无崩溃上报、无云同步，也没有项目自有后端。运行数据保存在 `RADAR_DATA_DIR` 指定的本机目录中。

医院、科室和医生偏好可能反映健康需求，应按敏感偏好处理：

- 只保存完成提醒所需的规范化字段和内容哈希。
- 不保存原始 HTML、完整响应头、截图、Trace 或浏览器资料。
- 通知密钥只从本机环境读取，不写入 SQLite、日志或前端 Bundle。
- 建议启用 FileVault、BitLocker 或 Linux 全盘加密。
- 备份前停止应用，复制整个数据目录，并把备份保存在受控位置。

详细安全边界见 [`SECURITY.md`](SECURITY.md)。

## 官方预约边界

本项目与北京协和医院、北京同仁医院、北京 114、京通及其技术服务商不存在隶属、授权、合作或代理关系。医院、平台名称及商标归各权利人所有，仅用于标识公开信息来源。

通知中的“新排班已发布”只表示官方公开页面出现了新的医生排班，不代表仍可预约；首版不会把排班移除解释为停诊或退号。实验性 Browser Agent 的任何“有号”状态也只能代表页面在用户主动读取时的可见结果，可能立即失效。最终信息和预约结果以医院、北京 114 或京通官方渠道为准。

用户离开本项目后，必须在官方渠道自行完成登录、验证码、实名、医保、确认和付款。本项目不会代替这些步骤，也不提供医疗建议。急症请联系急救服务或直接前往医院急诊。

## 文档

- [产品需求](docs/PRD.md)
- [架构提案](docs/architecture-proposal.md)
- [配置说明](docs/configuration.md)
- [数据来源政策](docs/data-source-policy.md)
- [来源研究](docs/source-research.md)
- [测试与验收](docs/test-strategy.md)
- [UX 流程](docs/ux-flows.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [变更记录](CHANGELOG.md)
- [实验性 Browser Agent](browser-extension/README.md)

## 参与贡献

普通缺陷和功能建议可以提交公开 Issue，但必须先移除密钥、医院会话、个人信息、完整来源响应和本机绝对路径。真实适配器有单独的来源、隐私和频率门槛，详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

安全问题不要提交公开 Issue，请按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 许可证与分发

本仓库采用 [MIT License](LICENSE)，版权归 `coldxiangyu163` 所有。

这是从 GitHub 源码或 GitHub Releases 安装和运行的本地应用，`package.json` 固定为 `private: true`，不发布到 npm Registry，也不提供可导入的 npm 库入口。
