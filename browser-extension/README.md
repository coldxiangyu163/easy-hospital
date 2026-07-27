# 本机 Browser Agent（Chrome / Edge MV3）

这是默认关闭、尚待真实会话验证的 B 级实验性扩展。只有用户打开 popup 并点击“读取可见状态”后才执行一次扫描。它只处理 allowlist 官方页面当前视口内实验性 selector allowlist 的可见文字；页面地址只保留 origin，归一化后只向 `127.0.0.1:3210` 提交结果，不提交原始文字或完整 DOM/HTML。

**它是用户主动的单次读取工具，不是后台监控。** 扩展没有定时器、不会自动扫描页面、不会持续上报；只有每次人工点击“读取可见状态”才产生一次观察。没有新观察期间，主进程不会推断号源变化；观察结果只代表读取瞬间的可见状态，可能立即失效。

## 本地加载

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录 `browser-extension/`。
4. 启动本机服务前设置随机配对值：`EASY_HOSPITAL_BROWSER_AGENT_TOKEN=<随机长 token>`；扩展设置中保存相同 token。
5. 打开扩展“详细信息”，进入“扩展程序选项”，执行连接自检；只有 HMAC-SHA256 proof 匹配才算配对就绪。
6. 在 allowlist 官方页面人工登录并定位到目标号源行，将该行滚动到当前视口。
7. 打开扩展 popup，确认医院、院区、科室、日期、AM/PM、医生/职称，勾选确认后点击“读取可见状态”。
8. 复核脱敏结果，再点击提交到本机服务。

challenge 只发送至少 16 字节随机数编码成的 base64url nonce，token 不进入 challenge query、header 或 body；每次 observation Bearer 提交前都会重新验证 proof。错误 proof 时不会发送 observation。

## 当前任务与目录边界

截至 2026-07-27，主 UI 不再为新任务提供 B 级“实时余号/退号”事件开关。这样可以避免把实验性单次读取写成稳定监控：

- 新建 `public-source` 任务只订阅 `schedule_released`；同仁 `rules-only` 任务只创建规则提醒。
- 编辑历史上已经包含 `availability_changed_to_available` 或 `cancellation_slot_detected` 的任务时，UI 会原样保留后端值，避免静默破坏既有配置，但不会把它展示成新的稳定承诺。
- 观察提交成功只表示本机接受了一次脱敏快照，不表示任务一定订阅事件，也不表示页面状态仍然有效。

migration 18 增加的人民、北医三院、积水潭、阜外、安贞、北大一院、天坛、北京儿童、医科院肿瘤目录**不会**扩大本扩展的 `manifest.json` matches、服务端 Browser Agent scope 或 parser。尤其 directory-only target 即使官网可打开，也必须被扩展和服务端 payload 契约拒绝。若未来扩大范围，必须单独修改权限、scope、解析与负向测试，并完成用户确认和隐私评审。

登录墙、验证码、候补、上下文不完整、冲突文字、未识别状态或 selector 失效均返回 `unknown`。扩展不会自动点击、预约、提交、付款或绕过验证码。启用前仍需真实会话 PoC 与低频观察。
