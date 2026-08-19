# 会话 Owner 定时提醒：每周多时间段限制设计

> 状态：方案已完成 grilling，待最终确认；本文只定设计，不包含实现
>
> 日期：2026-08-19
>
> 基线：`junsheng_main` @ `e9573b92`（包含 `b5ec5ade`、`e9573b92` 的现有 Owner 定时提醒能力）

---

## 0. 一句话结论

在每个机器人的“Bot 配置 → 机器人 → 高级 → 会话 Owner 定时提醒”中增加一份 **周一至周日、每天可配置多个时间段** 的周计划；提醒仍按原间隔累计，但只有当前本地挂钟时间落在允许范围内时才发送。

新配置默认：

- 周一至周五：`10:30–21:30`
- 周六、周日：当天不提醒
- 时区：复用全局“定时任务时区”

升级前已保存、没有周计划字段的旧配置继续按 **全天候允许** 运行，不做静默迁移。

---

## 1. 背景与现状

### 1.1 已有能力

现有 per-bot Owner 定时提醒已经具备完整链路：

- 配置：`enabled`、`intervalMinutes`、`text`、`states`
- Dashboard 编辑与热保存
- 每个 bot daemon 每 60 秒扫描一次活动会话
- 会话达到提醒间隔后，在飞书话题内提醒 `ownerOpenId ?? lastCallerOpenId`
- 发送成功、失败退避、daemon 重启后的等待状态均有持久化

核心位置：

| 职责 | 当前文件 |
|---|---|
| 配置、校验、状态投影、扫描算法 | `src/core/session-owner-reminder.ts` |
| 每 60 秒触发扫描 | `src/daemon.ts` |
| per-bot 配置写入与热更新 | `src/services/session-owner-reminder-config-store.ts` |
| 提醒运行态持久化 | `src/services/session-owner-reminder-store.ts` |
| daemon Dashboard 读写 API | `src/core/dashboard-ipc-server.ts` |
| Dashboard 代理 | `src/dashboard.ts` |
| Bot 配置表单 | `src/dashboard/web/bot-defaults-page.tsx` |
| 浏览器 DTO | `src/dashboard/web/bot-defaults.ts` |

### 1.2 当前缺口

当前扫描只比较绝对毫秒间隔，不感知：

- 星期几
- 每日允许提醒的时间范围
- 时区

结果是功能启用后可能在夜间或周末持续主动提醒。

### 1.3 设计目标

1. 每个机器人独立配置周一至周日。
2. 每天支持 0–24 个时间段。
3. 时间精确到分钟。
4. 周计划只控制“何时允许发送”，不篡改会话已经等待多久的事实。
5. 默认符合当前需求，但旧配置升级后不改变行为。
6. 配置热生效，保持现有每分钟扫描架构。
7. 在混合版本环境中不能出现“界面显示保存成功，旧 daemon 实际忽略时间范围”。

### 1.4 非目标

首版明确不做：

- 跨机器人批量应用
- 每个机器人独立时区
- 单个时间段跨午夜
- 独立 cron job 或接入通用 `/schedule` 调度器
- 窗口外暂停提醒间隔
- 窗口外错过提醒的逐条补发
- 自动合并、排序或去重重叠范围

---

## 2. 已确认的产品语义

### 2.1 每日时间范围

- 每天可配置多个时间段。
- 每天最多 24 段。
- 每段精确到分钟。
- 开始时间必须严格早于结束时间。
- 开始时间范围为 `00:00–23:59`。
- 结束时间范围为 `00:01–24:00`，其中 `24:00` 只允许作为结束时间。
- `00:00–24:00` 表示当天全天允许。
- 空数组表示当天不提醒。
- 启用总开关时，全周至少要有一个时间段；关闭时允许全周为空。

### 2.2 边界

时间段使用半开区间：

```text
[start, end)
```

例如 `10:30–21:30`：

- `10:30` 已允许发送；
- `21:29` 仍允许发送；
- `21:30` 起不允许发送。

扫描周期仍为约 60 秒，因此边界生效可能比挂钟边界晚最多约一分钟；系统不承诺秒级触发。

### 2.3 跨午夜

单段不允许跨午夜。

例如周一晚 22:00 到周二凌晨 02:00，配置为：

```text
周一 22:00–24:00
周二 00:00–02:00
```

这样每天的配置只解释当天，不引入“前一天溢出”和当天范围之间的优先级问题。

### 2.4 重叠范围

同一天允许重叠、包含或重复范围，持久化时保留用户输入顺序，不自动合并或排序。

运行时按所有范围的并集判断。例如：

```text
10:30–15:00
14:00–21:30
```

等效允许区间是 `10:30–21:30`，但配置仍保留两条原始范围。

首尾相接同样合法：

```text
10:30–12:00
12:00–14:00
```

### 2.5 默认值

全新配置的默认周计划：

```text
周一 10:30–21:30
周二 10:30–21:30
周三 10:30–21:30
周四 10:30–21:30
周五 10:30–21:30
周六 当天不提醒
周日 当天不提醒
```

### 2.6 提醒计时

窗口外继续累计等待时间，但不发送：

1. 会话进入可提醒状态后，沿用现有 `actionableSince` / `lastRemindedAt` 计算间隔。
2. 到期时若不在允许窗口，只抑制投递，不删除或暂停记录。
3. 下次进入允许窗口时，如果已经到期，立即发送一条。
4. 窗口外即使错过多个间隔，也只补一条，不追发历史轮次。
5. 补发成功后，从实际发送时间重新计算下一个提醒间隔。
6. 窗口外发生新消息或完整会话状态变化，仍按现有规则重置等待基线。

示例：

- 周一 21:20 会话进入待提醒状态；间隔 30 分钟；允许窗口到 21:30。
- 21:50 到期时窗口已关闭，不发送。
- 周二 10:30 窗口打开；若会话状态未恢复，下一次扫描立即提醒一条。
- 不补发夜间累计错过的其它轮次。

### 2.7 配置和开关热更新

- 修改时间范围：不重置会话等待计时，下一次扫描（最多约 60 秒）使用新配置。
- 修改提醒间隔：保留现有 due base；缩短后可能下一次扫描立即到期，延长后继续等待。
- 修改提醒文案：不重置，下一次实际发送使用新文案。
- 修改触发状态：若会话修改前后仍匹配至少一个选中状态则保留计时；不再匹配时按现有规则删除 record，后来重新获得资格时重新观察并计时。
- 扩大范围：当前时刻新变为允许且会话已到期时，可立即提醒一条。
- 缩小范围：下一次扫描立即抑制发送。
- 总开关关闭：保持“清空提醒运行态”的语义，但不能只依赖下一次 60 秒扫描观察到 disabled。配置服务在成功发生 `true → false` 后必须立即调用 daemon/controller 的 reset 通路。
- reset 与 in-flight scan 必须串行化，或使用 generation/token 使旧 scan 结果失效，防止 scan 在清空后重新保存旧 snapshot。
- 即使用户在一个扫描周期内快速完成“关闭 → 重新开启”，关闭动作也已经完成 reset；重新开启后所有会话从重新观察到可提醒状态开始，重新等待完整间隔。
- 总开关关闭期间仍可编辑、复制、保存周计划。

### 2.8 接收人

保持当前行为：

```ts
ownerOpenId ?? lastCallerOpenId
```

Dashboard 文案改准确：

> 通知会话 Owner；会话没有 Owner 时通知最近调用者。

### 2.9 机器人范围

- 周计划是 per-bot 配置。
- 首版只编辑当前选中的机器人。
- 不提供“应用到全部机器人”或跨机器人批量保存。
- `apiOnly` 机器人运行时无法发送飞书提醒，因此在其 Bot 配置中完全隐藏整个“会话 Owner 定时提醒”区块。

---

## 3. 配置模型

### 3.1 新类型

建议把配置相关的纯类型和校验从含 `node:crypto` 的 controller 文件拆到浏览器可安全引用的模块：

```text
src/core/session-owner-reminder-config.ts
```

该模块只包含类型、默认值、结构化校验、归一化和分钟解析，不依赖 `node:*`、`croner`、`global-config` 或 `src/utils/timezone.ts`。目标时区挂钟转换另放在纯 `Intl` 模块（见 §5.3），防止 Dashboard browser bundle 间接拉入 `node:fs`。

模型：

```ts
export const SESSION_OWNER_REMINDER_WEEKDAYS = [
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
] as const;

export type SessionOwnerReminderWeekday =
  typeof SESSION_OWNER_REMINDER_WEEKDAYS[number];

export interface SessionOwnerReminderTimeRange {
  start: string; // HH:mm；00:00–23:59
  end: string;   // HH:mm；00:01–24:00
}

export type SessionOwnerReminderWeeklyWindows = Record<
  SessionOwnerReminderWeekday,
  SessionOwnerReminderTimeRange[]
>;

export interface SessionOwnerReminderConfig {
  enabled: boolean;
  intervalMinutes: number;
  text: string;
  states: SessionOwnerReminderState[];

  /** 缺失只用于兼容旧配置，语义为七天全天允许。 */
  weeklyWindows?: SessionOwnerReminderWeeklyWindows;
}
```

使用 `mon`…`sun` 而不是 cron 的 `0`…`6`：

- JSON 可读；
- 不会混淆 `0 = Sunday`；
- 与 UI 的 Monday-first 顺序一致；
- 后续扩展 DTO 时不依赖本地化星期文本。

### 3.2 完整七天结构

`weeklyWindows` 一旦存在，必须完整包含七个键；某天关闭用空数组表达，不用省略键。

合法示例：

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "text": "该会话已等待处理，请继续跟进。",
  "states": ["idle", "dormant", "pending_repo", "tui_prompt", "agent_attention", "limited"],
  "weeklyWindows": {
    "mon": [{ "start": "10:30", "end": "21:30" }],
    "tue": [{ "start": "10:30", "end": "21:30" }],
    "wed": [{ "start": "10:30", "end": "21:30" }],
    "thu": [{ "start": "10:30", "end": "21:30" }],
    "fri": [{ "start": "10:30", "end": "21:30" }],
    "sat": [],
    "sun": []
  }
}
```

这种形态避免“某天键缺失到底代表全天、关闭还是继承默认”的歧义。

### 3.3 两套明确的周计划常量

需要同时存在两套常量，不能混用：

```ts
DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS
// 周一至周五 10:30–21:30，周末 []

LEGACY_ALL_DAY_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS
// 周一至周日均 [{ start: '00:00', end: '24:00' }]
```

- `DEFAULT_SESSION_OWNER_REMINDER` 使用第一套，用于从未配置过该功能的新机器人。
- 已持久化配置缺失 `weeklyWindows` 时，不补写字段，运行时按第二套解释。

所有常量对外提供深拷贝/工厂，避免 React 表单修改共享数组。

### 3.4 严格校验

在现有四字段校验基础上增加：

1. `weeklyWindows` 缺失：接受，视为 legacy 配置。
2. 字段存在：必须是普通对象且恰好提供七个 weekday 键。
3. 每个值必须是数组，长度 `0–24`。
4. 每一项必须提供字符串 `start`、`end`。
5. `start` 必须匹配 `00:00–23:59`。
6. `end` 必须匹配 `00:01–23:59` 或精确值 `24:00`。
7. 转成分钟后必须满足 `start < end`。
8. 不校验重叠、包含、重复或输入顺序。
9. `enabled === true` 且 `weeklyWindows` 存在时，全周范围总数必须大于 0。
10. `enabled === true` 且字段缺失时，legacy 全天语义仍合法。

后端仍是最终权威；浏览器用同一个纯模块提前展示精确错误。为支持定位到具体星期和第几段，纯模块不能只返回 `config | undefined`，需要提供结构化诊断：

```ts
type SessionOwnerReminderValidationResult =
  | { ok: true; config: SessionOwnerReminderConfig }
  | {
      ok: false;
      code: string;
      weekday?: SessionOwnerReminderWeekday;
      rangeIndex?: number;
      field?: 'start' | 'end';
    };
```

`normalizeSessionOwnerReminderConfig()` 可保留为兼容 wrapper；Dashboard 使用完整诊断自动展开并聚焦首个错误，后端把诊断映射为稳定错误码。

### 3.5 配置 schema 版本

新增常量：

```ts
export const SESSION_OWNER_REMINDER_SCHEMA_VERSION = 2;
```

版本只用于 Dashboard 与 daemon 能力协商，不要求写进每个 bot 的 `bots.json`。

---

## 4. 向后兼容与混合版本

### 4.1 新版本读取旧配置

旧配置示例：

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "text": "该会话已等待处理，请继续跟进。",
  "states": ["idle"]
}
```

缺失 `weeklyWindows` 时：

- 后端接受；
- 运行时七天全天允许；
- 不主动迁移或重写 `bots.json`；
- Dashboard 明确显示为七天 `00:00–24:00`；
- 显示“旧配置当前按全天运行”的提示；
- 提供“一键套用工作日默认值”。

用户首次从新 Dashboard 保存后，提交完整七天结构，配置从 legacy 语义转为显式 v2 语义。

### 4.2 新 Dashboard 连接旧 daemon

旧 daemon 的 normalizer 会忽略未知字段并可能仍返回成功，因此只依赖 HTTP 200 不安全。

每个 bot payload 增加能力信息。schema 协商只使用一个权威版本字段，避免版本号与布尔能力位互相矛盾：

```ts
interface SessionOwnerReminderCapability {
  schemaVersion: number; // v2 起支持 weeklyWindows
  effectiveTimeZone: string;
  timeZoneSource: 'environment' | 'settings' | 'host';
}
```

transport 元数据与 schema capability 分开，由 Dashboard 聚合层基于本机权威 bot registry 补充现有 `larkTransportEnabled` 事实：

- `larkTransportEnabled === false`：已知是 `apiOnly` bot，优先直接隐藏区块，即使目标是旧 daemon。
- transport 支持或未知，但 capability 缺失/`schemaVersion < 2`：把整个提醒表单置为只读，显示“目标机器人进程版本过旧，请升级后编辑时间范围”。

保存成功必须同时满足：

- PUT 响应回显相同的 `sessionOwnerReminderCapability.schemaVersion >= 2`；
- `sessionOwnerReminder.weeklyWindows` 存在；
- 回显配置通过共享 normalizer。

不满足时按“不支持新 schema”失败处理，不能显示保存成功，也不能用本地 payload 假装服务端已保存。

PUT 响应建议为：

```json
{
  "ok": true,
  "sessionOwnerReminderCapability": { "schemaVersion": 2 },
  "sessionOwnerReminder": { "...": "...", "weeklyWindows": { "...": "..." } }
}
```

### 4.3 旧 Dashboard 写新 daemon

旧 Dashboard 只会发送四个旧字段。如果新 daemon 直接按请求整体覆盖，会删除已经存在的 `weeklyWindows`，使配置退化为全天提醒。

因此配置写入服务需要兼容合并规则，而且必须在 `rmwBotEntry` 的文件锁内，以最新磁盘快照构造最终 candidate 后再做最终校验：

1. 请求必须是普通对象。
2. 使用 `Object.prototype.hasOwnProperty.call(raw, 'weeklyWindows')` 区分“旧客户端确实缺字段”和“显式传了 `null`/非法值”；后两者必须拒绝。
3. 字段缺失且当前磁盘配置已有合法 `weeklyWindows` 时，candidate 保留当前周计划，只覆盖旧客户端提交的四个字段。
4. 对最终 candidate 运行严格 validator；例如当前配置是 `disabled + 全周空`，旧客户端试图只把 `enabled` 改为 `true`，合并结果非法，必须拒绝。
5. response 与 daemon 内存更新都使用锁内最终合并、校验后的对象。

新 Dashboard 总是显式提交完整七天结构，所以不会触发兼容合并分支。这样同时保证：

- “旧 UI + 新 daemon”不会意外清空时间限制；
- 并发写入时不使用过期内存配置覆盖最新磁盘值；
- legacy 全天请求与显式非法 `weeklyWindows` 不会混淆。

### 4.4 降级到旧 daemon

旧 daemon 读取带 `weeklyWindows` 的配置时会忽略该字段并恢复全天发送；旧 daemon 再保存该区块还可能从磁盘删除新字段。

该风险无法由新代码完全消除，需要：

- 发布说明明确标注；
- 不支持在依赖时间限制的场景中降级 daemon；
- 如发生降级，重新升级后检查并重新保存周计划。

---

## 5. 时区设计

### 5.1 时区来源

复用现有 `scheduleTimeZone()` 语义：

1. `BOTMUX_SCHEDULE_TIMEZONE`
2. `~/.botmux/config.json.scheduleTimeZone`
3. daemon 主机本地 IANA 时区
4. 无法解析时回退 `UTC`

周计划是 per-bot，但时区是当前 botmux 实例所有机器人共用的全局时区。

### 5.2 展示

周计划标题旁显示当前生效值，例如：

```text
提醒时间范围  ·  Asia/Shanghai
```

并提供“全局设置”入口。

为了避免环境变量覆盖全局设置时产生误导，建议把现有解析函数扩成：

```ts
resolveScheduleTimeZone(): {
  timeZone: string;
  source: 'environment' | 'settings' | 'host';
}
```

现有 `scheduleTimeZone()` 保留为兼容 façade，只返回 `timeZone`。

UI 根据来源提示：

- 环境变量：说明全局设置无法覆盖当前值；
- 全局设置：可直接跳转修改；
- 主机时区：说明当前未显式配置。

### 5.3 挂钟判定

新建独立 browser-safe 纯模块，例如：

```text
src/utils/zoned-wall-clock.ts
```

它只依赖标准 `Intl`，不导入现有 Node 侧 `timezone.ts`，把一个 UTC instant 转成目标时区下的：

```ts
{
  weekday: 'mon' | ... | 'sun';
  minuteOfDay: number; // 0–1439
}
```

实现使用 `Intl.DateTimeFormat(...).formatToParts()`：

- 固定 locale/calendar/numbering system，例如 `en-US-u-ca-gregory-nu-latn`；
- 明确指定 `hourCycle: 'h23'`，避免午夜格式化为 `24`；
- 从目标时区的年、月、日计算 weekday，不依赖本地化后的 `Mon` / `周一` 文本；
- 当前分钟满足任意 `startMinutes <= minuteOfDay < endMinutes` 即允许发送。

`weeklyWindows` 缺失时直接返回允许，不需要构造或持久化 legacy 七天对象。Dashboard 只导入纯配置/挂钟模块；Node 侧 `src/utils/timezone.ts` 继续负责 env/global config/host 的 effective timezone 解析。Dashboard bundle 构建需要有实际测试，锁定纯模块不会拉入 `node:fs` 或 `croner`。

### 5.4 DST

按 IANA 时区的真实本地挂钟处理：

- 春季跳时：不存在的本地分钟自然不会被扫描到；
- 秋季回拨：重复的一小时两次都属于对应窗口；
- 提醒间隔仍按 epoch milliseconds 计算，不按本地挂钟计算；
- 因此重复小时不会绕过 `intervalMinutes` 或额外补发。

### 5.5 时区热切换

全局时区变化后：

- 下一次扫描直接按新时区解释同一份周计划；
- 不重置现有等待计时；
- 新时区下若当前进入允许窗口且会话已到期，可以立即提醒一条。

---

## 6. 运行时方案

### 6.1 不接入通用 scheduler

继续使用 Owner reminder 自己的 60 秒 scan loop。

理由：

- 当前任务不是“在某一时刻启动一次 CLI 任务”，而是持续检查一组动态会话是否满足状态、间隔和投递条件；
- 通用 scheduler 的 cron job 模型与 per-session durable state 不同；
- 当前 controller 已经有正确的防重入、失败重试、幂等 UUID 和运行态持久化。

### 6.2 注入时区

保持 controller 可测试，不在核心循环深处直接读取全局配置。

选定通过 controller deps 注入可测试 clock 与必需的 timezone provider，避免 optional timezone 出现隐式默认：

```ts
interface SessionOwnerReminderControllerDeps {
  // 现有 load/save/send/canSend/onError...
  now(): number;
  timeZone(): string;
}

scan(
  sessions: Iterable<DaemonSession>,
  config: SessionOwnerReminderConfig,
): Promise<void>
```

daemon 的 `timeZone()` 每轮解析 `scheduleTimeZone()`，从而无需重启即可使用全局时区变更；测试固定 clock/timezone，不依赖测试主机环境。现有直接传 `now` 的单测可通过测试 deps 迁移。

### 6.3 门控位置

窗口检查必须放在：

1. 会话资格与状态匹配已确认之后；
2. 运行态记录已创建/更新之后；
3. 真正判断到期并发送之前。

因为现有循环逐条 `await send()`，一次 scan 可能跨过窗口结束边界。不能在整轮开始时只计算一次 boolean；必须在每次真正发起发送前确认当前分钟仍处于允许窗口。为避免重复构造 formatter，可在 scan 内按 `Math.floor(now / 60_000)` 缓存结果：同一分钟复用，分钟变化时重新读取 clock 并计算。

伪代码：

```ts
for (const ds of sessions) {
  // 现有 active/thread/recipient/transport/state 过滤

  seen.add(sessionId);

  // 现有 stateFingerprint / activityAt 变化处理
  // 即使窗口关闭，也照常创建或重置 record

  // 现有 interval due、retryAfterAt 判断

  const sendNow = deps.now();
  if (!windowCache.isOpenAt(sendNow, deps.timeZone(), config.weeklyWindows)) continue;

  // 发起 send；成功/失败更新使用实际 sendNow/完成时刻的既有约定
}
```

必须有测试让第一条 `send()` 延迟跨过结束边界，并确认第二条不会在闭窗后开始发送。

### 6.4 运行态模型

采用“窗口外仅抑制投递、继续计时”后，现有 record 已足够：

```ts
interface SessionOwnerReminderRecord {
  sessionId: string;
  stateFingerprint: string;
  actionableSince: number;
  lastObservedActivityAt: number;
  lastRemindedAt?: number;
  retryAfterAt?: number;
}
```

不需要增加：

- `pausedAt`
- `windowEnteredAt`
- missed count
- record schema version

也不需要迁移 `session-owner-reminders-<appId>.json`。

### 6.5 失败重试

保留当前失败退避：

```text
max(1 分钟, min(提醒间隔, 5 分钟))
```

若退避结束时窗口已关闭：

- 不发送；
- 记录保留；
- 下次开窗且 `retryAfterAt` 已过时再重试。

若退避跨越多个关闭窗口，也只重试一条。

---

## 7. Dashboard 交互

### 7.1 页面位置

不新增路由，扩展现有：

```text
Bot 配置
  → 选择机器人
  → 高级
  → 会话 Owner 定时提醒
```

时间范围放在“提醒间隔”和“提醒状态”之间，使阅读顺序成为：

1. 是否启用
2. 多久提醒一次
3. 哪些星期与时段允许提醒
4. 哪些会话状态触发
5. 提醒文案

### 7.2 周摘要

默认显示 Monday-first 的七行摘要，不把七天编辑器全部展开。

示意：

```text
提醒时间范围                 Asia/Shanghai  [全局设置]

周一   10:30–12:00、13:00–21:30       >
周二   10:30–21:30                     >
周三   10:30–21:30                     >
周四   10:30–21:30                     >
周五   10:30–21:30                     >
周六   当天不提醒                       >
周日   当天不提醒                       >
```

范围较多时显示前两段和“另有 N 段”，完整值在展开区可见，避免横向溢出。

### 7.3 单日展开编辑

点击某天后只展开该日：

```text
周一
  [10:30] 至 [12:00]   [删除]
  [13:00] 至 [21:30]   [删除]
  [+ 添加时段]
  [复制到其他日期]
```

规则：

- “添加时段”追加一行空 draft，用户必须补齐合法开始/结束时间才能保存；
- 达到 24 段后禁用添加按钮并说明上限；
- 删除最后一段后，摘要显示“当天不提醒”；
- 重叠不标错、不自动合并；
- 输入顺序就是保存顺序；
- 编辑区使用原生 `input type="time"` 处理 `00:00–23:59`；
- 结束时间的 UI draft 使用显式 union：普通时间由 time input 承载；`24:00` 使用独立 sentinel/pill 显示“24:00（当天结束）”，绝不把非法的 `value="24:00"` 绑定给原生 time input；
- “当天结束”快捷项切到 sentinel；从 sentinel 切回普通时间时恢复 time input；
- legacy 全天行 `00:00–24:00` 展开、不修改、保存必须无损 round-trip；
- 总开关关闭时编辑器仍可操作，顶部显示“当前未启用，配置保存后不会发送”。

### 7.4 复制到所选日期

点击“复制到其他日期”打开 React modal：

- 使用星期 chip 多选目标日期；
- 源日期不作为目标；
- 提交语义是 **覆盖** 目标日期的全部时间段，不是追加；
- 目标日已有任意范围时，在确认区明确列出将被覆盖的日期；
- 复制只修改当前表单 draft，最终仍由本区块的统一“保存”按钮提交；
- 取消不修改 draft。

不新增 imperative DOM modal，遵循 Dashboard React UI baseline。

### 7.5 Legacy 配置提示

配置缺少 `weeklyWindows` 时：

```text
此机器人使用升级前配置，当前按周一至周日全天允许提醒。
[套用工作日默认值]
```

编辑器内部把七天展示为 `00:00–24:00`，用户可直接逐天修改。

“套用工作日默认值”只修改当前 draft 为周一至周五 `10:30–21:30`、周末空，不自动保存。

### 7.6 保存与错误

保存前依次校验：

- 原有 interval、text、states；
- 七天对象完整；
- 每天不超过 24 段；
- 每段起止格式合法且 `start < end`；
- 开启状态下全周至少一段。

错误定位到具体星期和第几段，并自动展开首个错误日期。

保存期间：

- 禁用总保存按钮和会改变 payload 的控件；
- 成功后只采用服务端回显配置；
- schema/version 或 `weeklyWindows` 未回显时显示升级错误；
- 切换 bot 时沿用现有表单重置逻辑，不能把 A bot 的 draft 带到 B bot。

### 7.7 响应式和可访问性

- 桌面：星期、摘要、chevron 同行；展开范围一行展示。
- 移动端：摘要可换行，单段编辑改为两列时间 + 独立操作行，不横向滚动。
- 展开按钮具有 `aria-expanded`、`aria-controls`。
- 时间输入有可访问 label，不能只依赖“至”作为语义。
- 删除、复制、全天结束快捷项均提供清晰可访问名称。
- 动效只用于单日展开/收起，并尊重 `prefers-reduced-motion`。

---

## 8. API 与数据流

### 8.1 读取

现有 Bot Defaults GET payload 增加：

```ts
{
  sessionOwnerReminder: SessionOwnerReminderConfig;
  sessionOwnerReminderCapability: {
    schemaVersion: number;
    effectiveTimeZone: string;
    timeZoneSource: 'environment' | 'settings' | 'host';
  };
  larkTransportEnabled?: boolean;
}
```

- schema capability 和 effective timezone 由目标 daemon 返回，准确反映其代码版本与环境。
- Dashboard 聚合层透传 schema capability；`larkTransportEnabled` 则基于聚合进程已有的本机权威 bot registry 事实补充，而不是从 capability 猜测。
- 已知 `larkTransportEnabled === false` 时隐藏提醒区块；transport 未知且 capability 缺失时才展示旧 daemon 只读提示。

### 8.2 写入

外部 Dashboard 路由保持：

```text
PUT /api/bots/:appId/session-owner-reminder
```

内部 daemon 路由保持：

```text
PUT /api/bot-session-owner-reminder
```

请求发送完整 `SessionOwnerReminderConfig`，新 UI 总是显式包含 `weeklyWindows`。

### 8.3 热更新

沿用现有 store 流程：

1. 严格 normalizer 校验。
2. 在文件锁内读改写对应 appId 的 `bots.json` 条目。
3. 原子写磁盘。
4. 成功后更新该 daemon 内存中的 `bot.config.sessionOwnerReminder`。
5. 下一次 scan 使用新配置，无需重启。

---

## 9. 代码组织与改动面

### 9.1 新增/重构模块

| 文件 | 设计改动 |
|---|---|
| `src/core/session-owner-reminder-config.ts` | 新建 browser-safe 配置模块：类型、默认周计划、legacy 周计划、schema version、结构化 validator/normalizer、分钟解析；不依赖 Node/timezone |
| `src/utils/zoned-wall-clock.ts` | 新建纯 `Intl` 挂钟模块：UTC instant → 目标时区 weekday/minute；可被 browser bundle 安全导入 |
| `src/core/session-owner-reminder.ts` | 保留 controller、状态投影、幂等 UUID；导入纯配置/挂钟模块；发送前按分钟重新确认窗口；支持 reset generation |
| `src/utils/timezone.ts` | 增加带 source 的全局时区解析结果，保留现有 `scheduleTimeZone()` façade |
| `src/daemon.ts` | 注入 clock/timezone provider，协调 scan 与配置关闭 reset |
| `src/services/session-owner-reminder-config-store.ts` | 锁内合并旧客户端 payload、最终校验；`true → false` 成功后触发串行化 reset |

### 9.2 Dashboard 与 API

| 文件 | 设计改动 |
|---|---|
| `src/core/dashboard-ipc-server.ts` | GET 回显 capability/timezone；PUT 回显 schema version；标记 apiOnly transport unsupported |
| `src/dashboard/bot-payload.ts` | 透传 capability |
| `src/dashboard.ts` | 保持代理流，补齐响应类型/透传检查 |
| `src/dashboard/web/bot-defaults.ts` | 复用或声明新 DTO 与 capability |
| `src/dashboard/web/bot-defaults-page.tsx` | 周摘要、单日编辑、复制 modal、legacy/旧 daemon 状态、保存校验 |
| `src/dashboard/web/i18n.ts` | 中英文星期、时间范围、时区、复制、legacy、校验和升级提示；同时把全局 `scheduleTimeZone` 帮助更新为“定时任务及会话 Owner 提醒时间范围所用时区”，保留环境变量覆盖说明 |
| `src/dashboard/web/style.css` | 周摘要、展开编辑、time input、移动端布局 |

### 9.3 配置读取

| 文件 | 设计改动 |
|---|---|
| `src/bot-registry.ts` | 类型改从纯配置模块导入，读取旧/新配置均走更新后的 normalizer |

### 9.4 用户文档

实现时同步补：

- `docs-site/docs/zh/bots-json.md`
- `docs-site/docs/en/bots-json.md`
- `docs-site/docs/zh/dashboard.md`
- `docs-site/docs/en/dashboard.md`

内容至少包括：

- JSON 示例；
- 默认值；
- 空数组、全天、半开区间、跨午夜拆分规则；
- 重叠范围按并集运行；
- 全局时区入口和 DST；
- legacy 缺字段全天兼容；
- 窗口外继续计时、开窗只补一条；
- 仅 thread/Lark transport 生效；
- Owner 缺失时通知最近调用者。

---

## 10. 测试方案

### 10.1 配置纯函数

新增表驱动测试：

1. 新默认值是工作日 `10:30–21:30`、周末空。
2. legacy 缺字段合法，effective behavior 是七天全天。
3. 七个 weekday 必须完整。
4. 每天 0、1、24 段合法，25 段非法。
5. `00:00–24:00` 合法。
6. start 为 `24:00` 非法。
7. end 为 `24:01`、`24:30` 非法。
8. `start === end` 非法。
9. start 晚于 end 非法。
10. 重叠、包含、重复、首尾相接均合法，顺序被保留。
11. enabled + 全周空非法；disabled + 全周空合法。

### 10.2 时间窗口

覆盖：

- Monday-first 映射，特别是 Sunday。
- start inclusive / end exclusive。
- `00:00–24:00`。
- 当天空数组。
- 任一重叠范围命中即 true。
- `weeklyWindows === undefined` 始终 true。
- `Asia/Shanghai` 与 `America/Los_Angeles`。
- DST spring-forward 和 fall-back。
- 午夜不会被解析成 hour 24。
- 固定 Gregorian/Latin digits，不受进程默认 locale/日历/数字系统影响。
- Dashboard browser bundle 实际构建成功，纯配置/挂钟模块不拉入 `node:fs` 或 `croner`。

### 10.3 Controller

在现有 `test/session-owner-reminder.test.ts` 增加：

1. 窗口内保持原发送行为。
2. 到期但窗口外不发送，record 保留。
3. 窗口打开后 overdue 立即发送一条。
4. 窗口外错过多个 interval 仍只发一条。
5. 窗口外状态变化重置 `actionableSince`。
6. 窗口外新消息重置等待基线。
7. 修改范围、时区、文案不重置 record；新文案用于下一次发送。
8. 缩短/延长 interval 保留 due base，并分别表现为可能立即到期/继续等待。
9. 修改 states 后仍匹配则保留；失去资格则删除，重新获得资格后重新计时。
10. 关闭总开关清空 record；重新开启重新计时。
11. 关闭与 in-flight scan 竞态时，旧 scan 结果不能复活 record。
12. 第一条发送延迟跨过窗口结束边界，第二条不再开始发送。
13. 失败退避跨出窗口后，等下次窗口再重试。
14. 两个 bot 的配置和状态互不影响。

### 10.4 配置持久化与兼容

- 新周计划 round-trip 到 `bots.json`。
- 旧配置加载不被自动改写。
- 新 UI payload 保存完整七天。
- 旧客户端 PUT 不带 own-property `weeklyWindows` 时，已有新周计划被保留；显式 `null`/非法值被拒绝。
- 当前是 `disabled + 全周空` 时，旧客户端尝试只开启功能，锁内合并后的最终 candidate 被拒绝。
- 并发写入以锁内最新磁盘值为准，不以过期 daemon 内存值覆盖。
- 两次 PUT 在一个 scan 周期内完成“关闭 → 开启”，仍已清空旧 record。
- in-flight scan 与关闭 reset 竞态下，旧 scan 不会把已清空状态写回。
- 新 Dashboard 遇到无 capability 的旧 daemon 时不可保存。
- 新 Dashboard + 旧 apiOnly daemon 仍基于聚合层 transport 事实隐藏区块。
- PUT 200 但未回显 schema/weeklyWindows 时前端按失败处理。
- 降级风险在文档中有明确说明。

### 10.5 Dashboard

- 七天摘要与默认值。
- 单日展开只影响当前日期。
- 添加、删除范围。
- 24 段上限。
- 重叠范围不报错。
- 非法起止定位到具体日期/行。
- enabled + 全周空阻止保存。
- disabled + 全周空允许保存。
- 复制覆盖目标日期，取消不修改。
- legacy 全天展示和“一键套用工作日默认”。
- 切换 bot 清理旧 draft。
- apiOnly 隐藏区块。
- 旧 daemon 显示只读升级提示。
- 当前时区与来源展示正确。
- 中英文文案完整。
- 桌面和移动端均无横向溢出。

### 10.6 验证命令与真实流程

实现阶段至少执行：

```bash
pnpm build
pnpm test
```

并按仓库规范做真实 Dashboard/飞书验证：

1. 部署当前 checkout 到 live daemon。
2. 在 Dashboard 对一个测试 bot 配置短时间窗口。
3. 构造已到期的 thread session。
4. 窗口外确认不发。
5. 开窗后确认只发一条。
6. 确认 owner 缺失时仍通知最近调用者。
7. 修改范围与全局时区，确认最多约 60 秒热生效。
8. 关闭再开启，确认重新等待完整 interval。
9. 附桌面与移动端截图。

---

## 11. 影响范围评估

### 11.1 CLI 与后端

- controller 位于公共 core，但只依赖 `DaemonSession` 状态，不区分具体 CLI。
- PTY/TMUX、Claude/Codex/其它 CLI 均继续走相同提醒状态投影。
- 新逻辑只增加发送许可门控，不改变 worker 生命周期或 CLI adapter。

实现后至少在两个不同 CLI 或现有跨 CLI 单测组合上确认无回归。

### 11.2 会话类型

继续仅支持：

- `status === active`
- 非 queued
- `scope === thread`
- 有 Owner 或最近调用者
- Lark transport 可发送

群会话、p2p chat scope、HTTP 虚拟会话、apiOnly bot 仍不发送。

### 11.3 多 bot

- 配置仍在 `bots.json` 的单个 appId 条目中。
- scan 仍由每个 bot daemon 扫自己的 `activeSessions`。
- runtime record 文件仍按 appId 隔离。
- 时区是全局共享，这是本设计唯一刻意的跨 bot 共享维度。

### 11.4 性能

- scan 内复用单个 zoned formatter，并按 epoch minute 缓存窗口判定；只有逐条发送跨分钟时才重新计算。
- 每天最多 24 段，线性扫描上限固定。
- session 循环不创建 per-session `Intl.DateTimeFormat`。
- 不新增 timer、cron job 或状态文件。

---

## 12. 验收标准

满足以下条件即认为功能完成：

1. 新机器人默认显示周一至周五 `10:30–21:30`、周末不提醒。
2. 每天可增删最多 24 个分钟级时间段。
3. 空日、全天、重叠、半开区间和跨午夜拆分规则与本文一致。
4. 窗口外不发但继续计时；开窗后 overdue 只发一条。
5. 修改周计划或全局时区不重置等待计时，最多约 60 秒热生效。
6. 关闭总开关清状态，重新开启重新等待完整 interval。
7. 旧配置升级后保持全天行为，不被静默迁移。
8. 旧 Dashboard 不会清除新 daemon 上已有的周计划。
9. 新 Dashboard 不会对旧 daemon 显示虚假保存成功。
10. apiOnly bot 不展示该区块。
11. UI 在桌面和移动端均可完整操作，无横向溢出。
12. 中英文用户文档、单元测试、构建与真实飞书验证齐全。

---

## 13. 实施拆分建议

建议单个 feature PR 内按以下顺序实施，避免前端先于兼容门控上线：

1. **纯配置模型与时间判定**：新 browser-safe 模块、默认/legacy、校验、timezone parts。
2. **运行时门控**：controller 注入 timezone，窗口外保留 record。
3. **配置兼容**：旧客户端写保护、schema capability、PUT 回显。
4. **Dashboard**：摘要、编辑、复制、legacy/旧 daemon/apiOnly 状态。
5. **文档与 E2E 验证**：中英文文档、桌面/移动端截图、真实开窗流程。

任何阶段都不改变现有提醒运行态文件格式。
