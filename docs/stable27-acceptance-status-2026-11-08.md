# stable27 至 stable30 验收记录

stable35 本机版本已安装：owner discovery 等待 native 10 秒窗口，已连接总线后的超时、断连或协议错误不再触发未知 owner 的竞争恢复；明确无 owner 和桌面离线路径保留，旧 recovery 锁不变。61 项定向回归通过，安装文件 hash 与源码一致。真实随机不存在聊天只读查询约 10006 ms 返回 `no-client-found`，pending=0。礼品卡实测也收到 `no-client-found` 而非 5 秒超时，但仍 locked、未实时连接，历史草稿可编辑不等于可发送。随后 D 约 300 ms 实时连接、551 ms 输入可用；不能扩展为全列表通过。

stable34 礼品卡复测：2026-11-09 02:35:50 UTC 选择后 20 秒未实时连接，旧 recovery 仍 locked；历史草稿输入框曾可编辑，这不是实时连接或消息可发送的证明。匿名 stream ID `c71624ea-4dc0-4e34-89f4-d481972fe823`，本机日志反复出现 `thread-owner-discovery timed out`。独立只读 IPC 探测显示原生 client 定向查询 2 ms 返回 no-client-found，而全 client 查询约 10008 ms 才返回 no-client-found；助手默认等待 5 秒。已知至少一个候选没有及时回应，但未能确定其身份。此结果不能证明旧未知 resume 已结束，也不能安全清锁。

stable34 已于 2026-11-09 发布连接诊断：服务器事务返回 FULL_DEPLOYED，配对数据库未替换，服务已重启；本机助手候选包已安装并重新连接，原生桌面进程保持运行。公网 HTML SHA-256 `cc6c8cd2bd2bc864f3aadac1cd0a3836f13c2c62b4d191c9b4b8a9683466b2da`，JS `a19b540f31c06dc35061d6a9f163a8cbbd4a4c6e37b54600776a0eb45ebaa837`。服务器备份 `/opt/codex-hub-paired/backups/stable34-20261109-100824-2000741`，本机旧包 `/Applications/codex手机助手-stable33-backup-20261109.app`。最初静态发布因只更新根目录、实际读取 release 目录而校验失败并回滚，后改为双目录事务成功。

发布后专用 D H5 只读连接实测：页面从选择至 live connected 约 295 ms、输入可编辑约 302 ms；同一匿名 stream ID `a9920dd1-8b17-4fb6-9371-5dcc95d1d8f1` 在本机日志记录 first-ready 12.33 ms、first-encoded 20.08 ms，服务器日志记录 first-received 35.46 ms、first-written 35.63 ms。各端时间为各自进程内耗时；这是一次热连接，不能代表全部聊天或解决旧慢样本原因。未读蓝点与礼品卡锁仍未解决。

原生归档入口复核：专用 B 的原生日志显示 `source=recent_tasks_menu` 归档在 08:41:26 UTC 返回 `-32600`，10:08:34 同入口成功，10:09:40 桌面删除工具成功。专用 E 在 13:52:38 归档返回 `-32600`，13:54:27 成功，后续数据库 archived=1、H5 列表移除；E 两次归档入口均为 `source=dynamic_tool`，不能表述为侧栏按钮验收。两者均不证明助手仍持有 writer 时原生归档或删除成功。日志 `/Users/lijiahao/Library/Logs/com.openai.codex/2026/11/08/codex-desktop-ff9f4375-ae77-4f49-9fbe-b4caec6018c0-40360-t0-i1-064950-0.log`，对应 B 2592、3599、3651 行和 E 7610、7637 行。

stable33 运行状态补验：2026-11-09 侧栏滚动到主任务后，其 DOM 为 `data-status=active`，转圈标记 `aria-label=进行中` 且未 hidden；同一轮原生 `read_thread` 为 active/inProgress。屏幕外未订阅时曾显示 unknown，滚入可见区域后恢复 active；本次仅验证运行中显示，尚未连续观察该回合结束后的 idle。

stable33 同版本列表复验：53 个既有聊天逐条执行，每条等待最多 15 秒，51 个实时连接且输入可用；主任务在该窗口未连接，礼品卡已实时连接但 recovery locked、输入禁用。51 个成功项等待中位数 894 ms，最大 13603 ms，选中 ID 错位 0。最初有分组未展开，展开后对遗漏条目补测，结果分批取得而非一次连续遍历；原始记录 `/private/tmp/codex-stable33-all53-retest.json`。复验结束时助手和桌面进程均存在；结束时 RSS 不是过程峰值，也不能据此证明所有历史路径无内存问题。

该记录的 `project` 只读取按钮文本，未检查控件可见性：其中 21 条无项目的最近聊天读取到了隐藏控件中的首个项目名称“清禾画画”，不能据此判断项目显示或项目归属。真实页面抽查无项目聊天时，项目 select 和按钮均为 hidden，按钮 CSS 为 `display:none`。模型/等级对照了各聊天最新 rollout 上下文，52 条已连接项一致；这不代替同时刻独立读取的 live snapshot 权威核验。

礼品卡锁的并发审查发现可达反例：原生 follower handler 入口校验 owner 后会异步等待设置；若此时角色变成 follower、后续转发收到 `no-client-found`，原生代码会调用 `resumeConversationForUnavailableOwner`。当前原生代码的隔离 VM 复现了该路径，尚未证明礼品卡现网发生。助手侧 session/owner/revision 的写前校验不能约束原生后续自动 resume，且模型写入 journal 还与 recovery 锁互斥。因此未实施绕过锁的方案；需要原生提供禁止自动 resume 的执行期保护，或取得旧 attempt 已结束的权威证据。

stable33 补充复验：2026-11-09 00:55（北京时间）运行中的新助手下，一次全局未知聊天 IPC discovery 以 4.99 ms 返回 `no-client-found`；此前独立样本约 10008 ms。C/D 各一次新物理 IPC 连接到 fresh snapshot 为 2.93/2.89 ms，这是 IPC 样本，不等于 H5 冷连接。此前超时的 9 个聊天在 H5 各等待最多 15 秒复验：7 个输入可用，耗时 591 至 4259 ms；主任务 15 秒内未连接，礼品卡实时连接但旧 recovery 锁使输入禁用。不能由此声称全部聊天或全局延迟通过。

随后重新选择主任务，一次实测在 12.302 秒后实时连接且输入可用，模型 Terra/high；这是另一轮选择，不更改上一次 15 秒超时记录。礼品卡在同日重新选择后约 708 ms 显示实时 Sol/high，但恢复锁仍在、输入仍禁用。

主任务后续只读诊断：新建独立 H5 events 流一次，2026-11-08 17:38:46.260 UTC 发起，约 36 ms 收到 headers、328 ms 收到 preview、400 ms 收到 state；该结果不包含 UI 渲染，也不能代表此前慢样本。另一次本地新 IPC snapshot 约 134 ms、原始约 6.9 MB，窗口化后约 99 KB；既有慢样本缺少请求起始时间及关联标识，无法据此确认 12 至 15 秒的具体瓶颈。

专用 C 两次重复最终回复已核对原生 rollout 和 `~/.codex/logs_2.sqlite`：两个 turn 各只有一次用户输入，原生 Responses 流超时或在 `response.completed` 前断开后触发 sampling 重试，随后生成不同 message ID 的第二条 final。日志 ID 分别为 81243061、81243234、81268186。这排除了本次 H5 重复渲染和重复提交；现有证据无法区分 provider、代理和网络导致的流中断。

本机更新（2026-11-09，stable33）：只读 IPC follower 现在明确回复 discovery `canHandle:false`，不改变 owner、fresh snapshot 或恢复锁。独立真实 socket A/B 中，不回复的定向发现约 10001.62 ms 才失败，回复 false 约 0.81 ms 失败；原生路由还有其他连接，本结果不等于全局连接速度改善。相关 IPC、pool、owner-router、恢复连接共 53/53 测试通过。签名校验通过的新包已安装，源码与安装文件 SHA-256 均为 `18f71cb7e18a38aa45427357ec4a88793897f3c53eafd089b71c050469ff264d`，旧包保留在 `/Applications/codex手机助手-stable31-backup-20261109.app`。公网 H5 仍为 stable32。重启后 C 切换到输入可用约 389 ms，仅为本次热切换；H5 发出的 `H5_DISCOVERY_FIX_20261109_C` 消息与回复已出现在原生回合 `01a1bc0a-01fa-7923-918f-f6f6966260bd`。该原生回合又出现两条同内容最终回复，仍须独立排查，不能判定为此修复所致。

补充实测（2026-11-09）：专用 D 在真实桌面输入框中提交任务并用 Cmd+Enter 入队，原生 UI 明确出现 `Preview queued message 1` 和队列操作；前一回合完成后，跟进作为新回合自动执行一次，最终队列清空、输入框为空、聊天 idle。两组跟进消息及回复各出现一次，H5 收到第二组跟进和回复。证据 `/private/tmp/codex-native-queue-ui-20261109-receipt.json`、`/private/tmp/codex-native-queue-final-thread-20261109.json`。为补采队列卡片做了两组实测；不能将此项扩展为真实审批或问答通过。

补充实测（2026-11-08）：专用 D 在 H5 连续提交两条不同消息，第二条曾显示“待送达”，随后两条按顺序各一次出现在 H5 和原生聊天的同一回合，原生回合完成并回复第二条；这验证 H5 待送达及运行中追加，不代表原生 follow-up 队列已验收。原生记录线程 `01a1ba11-4241-7c41-96f6-657e277f16cc`，回合 `01a1bbce-1847-7a92-ac5e-4ff812c3efd3`。

专用 C 通过 H5 发起真实 `apply_patch` 创建单行验收文件，H5 逐层展开“已编辑文件”和“查看差异”后显示 `H5_DIFF_OK_20261108_C`，与实际文件内容一致；验收后已删除该临时文件。原生回合 `01a1bbb1-483a-7110-b407-b6936e12469a` 显示文件变更成功，并包含两条相同最终回复；H5 同时显示 `Reconnecting... 1/5` 和 `2/5`。重复回复也存在于原生记录，不能归因于 H5；本次出现过重连，尚不能将此回合记为无异常。问答未重新测试。

连接优化候选暂未发布：真实只读探测表明定向 `thread-owner-discovery` 可在专用 C 上快速取得正确 owner 的响应，错误 owner、聊天和 host 均被拒绝；但原生代码中 renderer 删除 owner role 与主进程异步清除 ownership 记录之间存在窗口，清除失败也只记日志。此时定向 discovery 仍可能成功，而原有 fresh snapshot 因角色不再是 owner 而无法产生；这是代码可达的反例，尚未确认现网发生。故不能将 discovery 直接替代 fresh snapshot 作为恢复路由判活，保留原实现，继续寻找既能验证基线又能避免大快照的方案。

当前更新（stable32）：公网根 HTML/JS 已发布并核验 HTTP 200、no-store。根 HTML SHA-256 `ec059f857fa75d7ede01e6bfaedeab4bdb5a82e49ee94522014de56af654af1f`，JS SHA-256 `2bf30ecc384ea226301952aae39bdf9be92d6791ae5621692bc524f7270f13b2`，回执 `/private/tmp/codex-stable32-public-check.json`。本机仍为 stable31 运行包，此次仅前端修复，未重启助手。

youzan-toolkit 的旧本地 unknown 请求在服务端不存在：前端先以同请求号原子取消，查询明确 cancelled/unlocked 后才清本地并走新 route；迟到旧请求被 tombstone 拒绝。取消后的短暂确认或 readiness 网络失败可继续只读确认，不重复取消或发消息。74 项相关定向回归通过（含重叠，不加总为独立测试数），日志 `/private/tmp/codex-stable32-missing-confirmation-tests.log`。实机已恢复 connected=true、输入可用、GPT-5.6-Sol/xhigh、恢复 clear，证据 `/private/tmp/codex-stable32-toolkit-live.json`。

礼品卡聊天只读打开原生页面后，H5 已显示实时内容和 Sol/high，但 recovery-status 仍 locked，输入禁用；不能记为完整 ready，也未清除旧未知锁。证据 `/private/tmp/codex-stable31-gift-native-follow-live.json`。因此原有 53 条中累计 52 条曾完成实时连接且输入可用（分轮、不同版本，不代表 stable32 同轮 53 条全通过），剩余 gift 输入阻塞及未读跨端同步尚未解决。

本轮 24 次真实快速切换在约 2.7 秒内完成，最终 C 的模型 Terra/medium、选中与输入状态正确，助手和原生桌面仍运行；证据 `/private/tmp/codex-stable31-rapid24.json`。专用 D 实际执行 pwd，exitCode=0，H5 收到目录输出和 `TOOL_PWD_OK_20261108_D`；证据 `/private/tmp/codex-stable31-tool-live.json`。问答表单已真实出现，但用户明确说明流程由其手动中断；本次归类为用户中断，既不记产品故障，也不记完整问答闭环通过。不再重复发起该问答。


最新进度（stable30）：公网根页面和 JS 已切换到 `20261108-stable30`，均 HTTP 200、`cache-control: no-store`；回执 `/private/tmp/codex-stable30-public-check.json`。根 HTML SHA-256 为 `54e11eb624e179c601fd46bb230b557af41aab7f8f2a57e300037d4d2592acb0`，JS 为 `632e0aa5f4b2f0ee39e59f1e2d2a81ed34b5aa60b1ee3f74af897c138d72f5a3`。本机安装包来自 `/private/tmp/codex-phone-stable29-bounded.noindex/codex手机助手.app`，构建签名记录为 `/private/tmp/codex-stable29-bounded-build.log`。目录名 stable29 与公网 static30 是不同组件的版本记录，不将本机包改称 stable30。

专用 D 已在同一网页文档内通过助手正常退出、重新打开后的自动恢复：connected=true、输入可用、`GPT-6.1-Sol · low`、恢复记录 clear；回执 `/private/tmp/codex-stable30-restart-recovery-live.json`。这覆盖 D 的同页重启路径，未证明所有旧 accepted 或 unknown 记录均已恢复。

转圈已补两处有复现的修复：前端不再因后台保留任务使状态数超过 4 就丢弃整份 sidebar-status；新列表明确确认 active/idle 后取消旧交接超时，避免 1.5 秒后将刚确认的 active 隐藏。主代理实机确认主任务和新绘画聊天 active 显示转圈，C/D idle 隐藏。侧栏关闭且未选聊天时 snapshot 为空属于没有可见订阅目标；打开侧栏后已有状态事件到达，不将关闭侧栏时没有事件记为失败。

全部分组展开后实际有 53 个聊天，先前 24 条来自未全部展开的 DOM，不能称为完整列表。stable30 首轮全部执行：44 条在各自等待窗口内 ready，9 条超时，选中错位 0；前 8 条等待 12 秒，其余 45 条等待 25 秒，不能混写成同一个超时标准。已就绪聊天的等待时长中位数为 11.23 秒。原始记录 `/private/tmp/codex-stable30-all53.json`，汇总 `/private/tmp/codex-stable30-all53-summary.json`。这仍未满足全 53 条均连接成功。

同轮 900 个进程采样中，助手 Node PID 3002 与 Desktop PID 40360 均全程存在。分别测得 Node RSS 峰值 217.95 MiB、Desktop 主进程峰值 313.36 MiB。采样没有包含助手自己启动的 app-server RSS，不能声称整个助手总内存峰值仅 218 MiB。收尾 ps 看到助手 app-server PID 3003 约 84 MiB，只能作为末值。进程原始采样为 `/private/tmp/codex-stable30-process.jsonl`。

9 条超时中存在无 execution 归属的已确认 accepted 记录。后续候选已增加一次有限重试。它要求服务端满足 `status==='accepted' && locked===false && executionTracked===false`。客户端还必须仍选中同设备历史聊天且持续 30 秒未 live。满足后才清除本地已确认请求号并先检查 readiness，再以新请求号走现有 owner 路由。保留当前连接，不重发消息；每设备每聊天只允许一次，只有真实 live 状态重置额度。此候选与下方 70 项隔离测试尚不能代替超时 9 条的实机复验。未读跨端闭环和持有 writer 时原生归档也仍未通过，当前不认定稳定版验收完成。

本次定向自动化证据如下。各组存在重叠，不能相加为互不重复的总测试数。这些结果不代表当前全量测试。

| 检查组 | 结果 | 范围与证据 |
| --- | --- | --- |
| 恢复、消息队列、历史 UI | 46/46 PASS | `node --test test/history-auto-recovery-ui.test.mjs test/optimistic-send.test.mjs test/recorded-history-ui.test.mjs`；包含至少 3 次 accepted 轮询保持同一连接、live 才清记录、严格 unlocked released、新请求 ID、转圈容量和交接顺序；本代理执行回执。消息 outcome unknown 仍阻塞队列后继，不自动重发 |
| execution 退出与恢复隔离 | 19/19 PASS | `/private/tmp/codex-recovery-execution-tests-20261108.log`；真实子执行退出才结算对应 attempt，旧执行不得清替代 attempt，旧记录无 execution 证据继续保护 |
| 有限历史集成 | 68/68 PASS | `/private/tmp/codex-bounded-owner-integrated-tests-20261108.log`；1 GiB 标记场景先读有限权威页、显式完整读取、设置与 live 更新、native 审批及排队消息；隔离测试不等于真实 1 GiB 聊天连接成功 |
| 审批、问答及活动展示补测 | 9/9 PASS，其中新增 UI 4 项 | `/private/tmp/codex-stable30-pending-controls-ui-tests.log`；审批待回执禁止重复决策，历史不暴露审批按钮，两类问答必填和 unknown 后重绘不重发，恢复未知时禁写；同时复验审批/问答 guard、agent-history 和 summary 的工具失败状态、文件差异及摘要 |
| 无 execution 归属的已确认 route 候选 | 70/70 PASS | `/private/tmp/codex-stable30-unbound-route-tests.log`；含真实 WebSocket 元数据回执、按设备/聊天查询隔离、后端 accepted 原记录不变；UI 严格状态矩阵、一次重试额度及 live 重置，query/清理/readiness/reservation 四阶段共 20 种撤选、换设备、换 scope、换 stream、live 到达的竞态均不错误发起恢复；包含前述部分测试，不能另行相加 |

审批和问答的新增回归执行实际 DOM 事件处理器和请求计数，网络端为隔离 fixture。工具及差异检查覆盖投影和可折叠展示，队列检查覆盖前端顺序及不确定结果保护；这些都不补写成真实桌面审批弹窗、模型发问、原生排队和工具执行的实机 PASS。后续仍需在专用聊天触发这些真实流程，并确认失败/拒绝/中断没有被写成完成。本轮不重复已通过的附件、停止、模型等级和 C 模式路径。

以下保留 stable26 至 stable28 的历史结论和证据；与上方最新复验有差异时，不将旧结果冒称当前结果。

后续更新（stable28）：公网已更新至 `20261108-stable28`，根 HTML/JS/CSS 均 HTTP 200、no-store，与该次源码一致；回执 `/private/tmp/codex-stable28-public-check.json`。已修复 accepted 恢复结果反复查询时每 5 秒取消当前连接的回归，相关 UI 检查 41/41 PASS。真实 java 观察 55 秒仍未就绪。请求监测显示首次确认后未再反复建立 events stream，但它仍等待旧 accepted 恢复结果，不能记连接 PASS。记录 `/private/tmp/codex-stable28-java-live.json`。

stable27 的同页重启恢复已实际通过专用 D：H5 未刷新，正常退出并重新打开助手后恢复 ready、Sol/low、输入可用；证据 `/private/tmp/codex-stable27-before-restart-live.json`、`/private/tmp/codex-stable27-after-restart-live.json`。该结果只覆盖这个专用聊天，不能覆盖遗留未知或 accepted 记录。

Mac 已安装带异常退出诊断的 `codex-phone-stable27-diagnostics.noindex` 包并通过签名校验。stderr 只保留最多 64 KiB 的内存尾部，非授权退出才记录 exit status/reason/time；正常 quit/open 不产生异常记录。后续单独打开 java 的 65 秒采样中助手和 Desktop 均保留，RSS 峰值分别为 139.6 MiB 和 242.4 MiB。该聊天未完成实时连接，不能代替大历史成功验收。

stable27 阶段未作为稳定版通过。当时公网 H5 为 `20261108-stable27`，本机同步程序包含等级同步和 socket 退订修复，但之前的列表连接检查曾中途退出。未读跨端闭环、持有 writer 时的原生归档、大历史连接和资源占用当时仍未通过。

| 用户要求 | 当前结论 | 证据与边界 |
| --- | --- | --- |
| 加号、模型、发送按钮对齐及间距 | 已有实机 PASS | 375×812 页面三个中心均为 y=771，模型文字到发送图标间距 14 px；stable27 沿用相同 CSS，SHA-256 为 `990d074d0fcb520a32fdfeb6ae85360ec8598d1cdec374bbb4beec71caa2c23a` |
| 模型与思考等级 | 已确认路径 PASS，完整范围未通过 | 购物金与 cli 开放实机均为 Terra/high，专用 C 为 Terra/medium、D 为 Sol/low；恢复响应等级漏读和 partial settings 竞态已修复。native 已有 owner 的快照读取仍需补充核验，不能把全部聊天记 PASS |
| 四聊天快速连续切换 | 局部 PASS | 80 次选中 ID 无错位、列表保留；后 32 次列表接口最大在途数 1。其他接口出现过 503；不能扩写为所有请求零错误 |
| 全部聊天逐条连接 | 场景 FAIL | 24 条均已执行，每条等待实时状态及输入可用至多 25 秒，3 条就绪、21 条超时，列表始终 24 项且选中无错位。同步进程中途退出，后半超时含离线影响，不能推断 21 条各自有独立故障 |
| 本机性能与存活 | FAIL | 516 个进程采样中 Desktop 全程存在；助手 runtime 仅前 295 个存在，最后见于 11:29:13 UTC。Desktop RSS 峰值 2705.2 MiB、CPU 127.3%；助手 RSS 峰值 4390.0 MiB、CPU 155.1%。退出原因尚无 stderr/exit code 证据，不直接断言 OOM |
| 冷连接与加载表现 | FAIL | 已有小聊天热切换约 0.3 秒；本轮一个旧聊天耗时 20.344 秒就绪，多条超过 25 秒。共享 IPC 出现 frame-too-large 后重连；不能用热切换数字代表全部聊天 |
| 助手重启后无需刷新继续恢复 | 补丁已上线，实机复验待完成 | 旧恢复预算终身累计，成功后不重置，第 6 次恢复的定向回归已复现。stable27 按设备与聊天计数，仅实时状态成功后重置；相关 UI 回归 39/39 PASS，不等于公网重启闭环已通过 |
| H5 发消息、新聊天立即出现在桌面 | 已有专用聊天 PASS | C/D 在原生侧栏出现；D 已验证 H5 消息在桌面可见。仅操作专用聊天 |
| 原生桌面真实输入框发送，H5 接收 | PASS | D 真实 Send 按钮发出并收到 `DESKTOP_TO_H5_OK_20261108_D`；不要求用户重复发送已存在的验收消息 |
| 转圈和完成后的未读小蓝点 | 未读 FAIL | 后台完成未通过桌面持久化闭环；工具手动标未读可让 H5 立即显示蓝点，但不能代替自动完成验证。H5 选中后的本地去点也不能证明跨端已读清除 |
| H5 创建聊天在原生归档与删除 | 条件 PASS，完整要求 FAIL | writer 释放后，原生侧栏归档 B 成功、桌面删除工具成功且数据库行移除；助手仍持有 writer 时原生归档失败。B 已删除，不再复用 |
| 计划模式、等级修改、附件、图片预览、停止 | 已有专用路径 PASS | C 默认→计划→默认；D low→high→low；文本文件和 PNG 一起发送成功并准确回复；图片预览加载原始 160×100；active 时停止后 interrupted/idle、输入可用 |
| 复杂审批、问答、队列、工具及文件差异 | 部分自动化，实机覆盖未完成 | 不把 fixture、模拟模型和契约检查扩写成真实桌面 UI 全覆盖 |
| 真实手机与 Windows | 未验 | 本轮浏览器为手机视口；不声称真实 iPhone 键盘、安全区、扫码和 Windows 已通过 |

全列表检查原始记录为 `/private/tmp/codex-stable26-all24-verified.json`，进程原始采样为 `/private/tmp/codex-stable26-all24-verified-process.json`，进程存活审计为 `/private/tmp/codex-stable26-all24-presence-audit.json`。这些文件名保留实际受测的 stable26 版本；不能当成 stable27 复验。

大历史问题已有两个不同层面的证据。产品代码在收到超过 64 MiB 的 IPC frame header 时直接断开共享连接；隔离测试确认它会同时关闭正常任务的租约。实机日志确有该错误，但未记录当时的 frame 长度和路由。后续各一次只读 raw socket 检查显示 C 当前快照 24,799 字节、主任务当前快照 3,859,044 字节；均未超限，不能据此猜测之前的超限来源。另一个普通聊天的 rollout 文件体积达 1.18 GiB。当时 LocalOwner.resume 仍请求完整历史，需要按 app-server 已公开的分页契约继续定位；不通过提高 frame 上限掩盖问题。

stable27 公网核验：根 HTML、JS、CSS 均 HTTP 200、`cache-control: no-store`、与工作树逐字节一致。HTML SHA-256 为 `ebd0998f2cded461746063a6f70b7aab58fa454f981a781e4bbcf889956f247a`；JS 为 `98ca62ff6d025846d73e2762174d3ec551232df7842395730d68908bc6f1043a`。回执 `/private/tmp/codex-stable27-public-check.json`，服务器静态备份 `/opt/codex-hub-paired/backups/static27-20261108-195315`。本次仅更新静态资源，未修改配对数据库。



最新 stable31 复验：公网根 HTML/JS 已切换到 `20261108-stable31`，HTTP 200、`no-store`；回执 `/private/tmp/codex-stable31-public-check.json`，HTML SHA-256 `e43ef21a3e06d73aeaa63317aa2470ffe1b4754aad76b5e31db61669227fab4e`，JS SHA-256 `2d489fe035c869a5c19b2beeee27884eb574acaf4a0539e0cdb37332612f1b38`。旧记录候选复验已完成 7/9 条 ready；`富贵打通项目-礼品卡` 与 `youzan-toolkit` 在 65 秒窗口结束时仍为仅查看历史，不能记为通过。记录 `/private/tmp/codex-stable31-retest9.json`。新建 E 的原生归档最终成功且 H5 列表移除，数据库 `archived=1`；助手 PID 未重启。

本机当前安装包为 `/private/tmp/codex-phone-stable31-idle-release.noindex/codex手机助手.app`，构建 `/private/tmp/codex-stable31-build.log`。
## 未读跨端对照与原生入口边界（2026-11-08）

未读同步仍为 FAIL。仅对专用 C/D 做对照：原生 `set_thread_read_state(read=false)` 能将 C 的持久化未读状态置为 true；独立 IPC 客户端随后用相同账号及执行主机上下文发送 v3 已读广播，约 28 秒后的持久化状态仍为未读。监听客户端也未观察到原生工具置未读时的同名广播，不能据此认定原生工具和助手广播经过同一路径。C/D 最终均已还原已读。对照记录为 `/private/tmp/codex-native-read-state-comparison-20261108.json`；只读原生入口探针为 `/private/tmp/codex-native-tools-list-probe-20261108.mjs`，IPC 对照探针为 `/private/tmp/codex-native-read-probe-20261108.mjs`。

原生工具存在本机请求入口：随应用提供的 `codex-app-tools/server.mjs` 将 MCP 调用转到 native pipe，再由原生主进程转发至 renderer 工具处理器。但实际已安装助手的 `Contents/Resources/node` 仅发起只读 `tools/list` 即被关闭连接；原生日志明确记录 `2026-11-08T13:44:04.584Z ... dynamic_app_tools_peer_rejected reason=missing-code-signing-identity`。精确来源为 `/Users/lijiahao/Library/Logs/com.openai.codex/2026/11/08/codex-desktop-ff9f4375-ae77-4f49-9fbe-b4caec6018c0-40360-t0-i1-064950-0.log:7448`。助手 Node 为 ad hoc 签名，无 TeamIdentifier，当前身份没有通过该入口授权。

因此，原生 agent 工具可改读状态，不代表助手产品已经支持双端同步。后续需要官方支持的集成入口或合法获准的签名身份；本轮未替换签名运行时绕过校验，未修改原生应用或上游，也未直接写磁盘全局读状态。此前未通过实机的广播方案仍保留为未通过，不再继续同类广播探索。
