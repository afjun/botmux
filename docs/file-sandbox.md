# 文件沙盒（oncall 安全共享）

把某个 bot 的 CLI 会话关进一个**按会话隔离的文件沙盒**，让你能把机器人放心分享给半受信任的人（oncall）：对方只能操作 agent + 一份项目副本，**碰不到你磁盘上的真实文件、密钥、别的会话数据**。

> 调研与威胁模型见 [`sandbox-oncall-research-20260605.md`](./sandbox-oncall-research-20260605.md)。
> 当前 scope = **只隔离文件**（Linux）。网络**不**隔离（`npm install` / `git fetch` 照常）；不防内核级容器逃逸——面向半受信任用户，不是面向恶意攻击者。

## 启用

- **dashboard（推荐）**：bot 默认设置面板（「默认进入 oncall 模式」那块）里的「**文件沙盒**」开关，一键开关、即时落 `bots.json`、下个新会话生效。配 oncall bot 时顺手勾上。
- per-bot 手动：`bots.json` 里给该 bot 加 `"sandbox": true`
- 临时/测试：环境变量 `BOTMUX_SANDBOX=1`（对该 daemon 的所有会话强制开）

Linux 依赖 bubblewrap（bwrap），macOS 用同一份 policy 经 Seatbelt（`sandbox-exec`）落地；两平台统一走 fs-policy 三档白名单。除 riff 外的本地后端（pty/tmux/zellij…）都会包裹。

### owner 凭证隔离（Linux）

需要让同一台 Botmux 上的不同使用者复用各自登录态时，可在单个 bot 上增加：

```json
{
  "credentialIsolation": {
    "enabled": true,
    "presets": {
      "bytedcli": true,
      "bytecloud": true,
      "devflow": true,
      "playwright": true
    },
    "mounts": []
  }
}
```

- 新会话通过发起人的飞书 Open ID 查询邮箱，并以邮箱前缀作为共享 key；凭证落在 `~/.botmux/owners/<邮箱前缀>/`，因此同一 owner 可跨 bot 复用。
- 内置 preset 覆盖 BytedCLI、ByteCloud CLI、DevFlow 的登录状态和 Playwright MCP 浏览器 profile。缺少登录态时 Botmux 在同一个 bwrap 中自动执行登录命令，首条业务 prompt 在登录成功前不会发送；登录 URL/设备码会回传到话题，检测到二维码时还会上传当时的终端截图。Playwright 没有通用登录命令，访问具体站点时产生的 profile 会直接持久化。
- `mounts` 支持按 `id` 覆盖/关闭 preset，或增加 `{id, kind, target, ownerSubdir, bootstrap}` 自定义映射。`target` 必须位于 `$HOME` 下，`ownerSubdir` 必须是 owner 根目录下的相对路径；配置在会话创建时冻结，所以修改后只影响新会话。
- 开启后会话自动冻结 `sandbox: true`，当前仅支持 Linux bwrap 的 PTY/Tmux 会话。拿不到邮箱、挂载/登录失败、采用其他 backend 或 adopt 已运行进程时都会 fail-closed；未开启的 bot 完全沿用宿主机登录态。
- 会话绑定唯一 credential principal。普通消息、Webhook 和会驱动 CLI 的卡片操作都要求操作者 Open ID 与 principal 一致；登录链接/二维码按本需求仍允许话题内所有成员看见。

Webhook Connector 需要声明 owner 提取规则，例如 Meego payload：

```json
{
  "credentialOwner": {
    "path": "$.meego.owners",
    "openIdPath": "open_id",
    "emailPath": "email"
  }
}
```

候选人按 payload 顺序处理。目标 bot 会用通讯录 API 重新校验 Open ID 对应邮箱，只有邮箱前缀与 payload 一致的第一个候选人能成为 owner；机器人需具备用户基础信息和邮箱读取权限。飞书 Open ID 是应用维度的，因此 payload 必须携带目标 bot 能查询的 Open ID；来自其他应用且不可解析的 Open ID 会 fail-closed。

## 工作原理

```
worker spawnCli
  └─ buildFsPolicy(cliId)                   adapters/cli/fs-policy.ts（单一真源，Linux+macOS 共用）
       ├─ baseline 预设（平台）+ 适配器声明的 authPaths/execPaths + botmux 内部注入 + 用户 sandboxPaths
       └─ 产出 deny-by-default 三档白名单：readWrite / readOnly / deny
  └─ prepareDirectSandbox(policy)           adapters/backend/sandbox.ts
       ├─ compileToBwrap()                  白名单编译成 bwrap argv
       ├─ 每会话目录 <dataDir>/sandboxes/<sid>/{outbox,shimbin,empties,empty}
       ├─ 写 botmux shim → /run/sbxbin（PATH 头，让沙盒内 botmux 走本 build 的 relay）
       └─ 预建 deny-mask 挂载点 + 持久化 cleanup manifest（fail-closed）
  └─ bwrap … -- <cli> <原 args>             把 CLI 关进沙盒
  └─ startOutboxWatcher()                   daemon 侧代投递（持凭证）
```

**沙盒模型**（2026-07-16「文件沙盒重构」，取代旧的 overlayfs+landing 模型）：

- 沙盒根是**全新 tmpfs**（`--tmpfs /`），`/tmp` `/run` `/var/tmp` `/dev/shm` 同为全新 tmpfs，`/dev` `/proc` 走 bwrap 原语——**不再把 `$HOME` 整体 overlay 挂回**。
- 只有白名单里的规则路径被 bind 进来：`readWrite` → `--bind`（真实读写直达宿主），`readOnly` → `--ro-bind`。白名单**之外**的一切在沙盒里不存在。
- CLI **直接写宿主真实路径**（在 readWrite 区内），没有 upper changeset、不需要 landing、没有 bridge 重定向——CLI 的 data dir 就是真实宿主路径。
- `deny` 规则用 mode-000 空源 `--ro-bind` 遮罩（真实内容不可读、只读）；outbox 这类「deny 内部的更深 readWrite carve-out」用一层每会话 `--tmpfs` 遮罩承接嵌套 `--bind` 再 `--remount-ro` 收口（tmpfs 写在内存、绝不落宿主）。
- `--unshare-user/pid/ipc/uts`，默认保留网络。

**per-CLI authPaths**：每个适配器用 `authPaths` 声明自己的认证/登录状态目录，沙盒把它们真实 `--bind` 进来，token refresh / login 直接持久化到宿主。默认窄（仅 auth）；CLI 若在 `$HOME` 下放 SQLite DB（codex 系），把整个状态目录加进 `authPaths`（否则该路径不在白名单 → 沙盒里不存在 → DB 打不开或拿不到 fcntl 锁）。macOS 用同一份 policy 经 Seatbelt（`compileToSeatbelt`）落地。

**角色库子树**：开沙盒的 bot 还会拿到 `<角色库根>/<自己 appId>/` 的 `readWrite`。`workingDir` 只覆盖**当前**角色目录，而角色系统要越过它：「有哪些角色 / 切换角色」枚举兄弟角色目录并读各自 `.botmux-dir.json`，「新建角色」写 `users/<openId>/<slug>/` 并复制库根的 `_role-protocol.md`，切换后「沉淀知识」写的是**新**角色目录下的 `knowledge/`。给 `readWrite` 而非 `readOnly` 正是因为最后一条——只读的话枚举和切换都正常，等到写知识才 EPERM。按 appId 限定（不是整个角色库根）：别的 bot 的角色目录、以及其中别的用户的私有角色，仍在白名单外。两道收口：① `botmux-roles` 与 `<appId>` 这**最后两段各自必须是真目录**，任一段是符号链接就不产生规则——否则被预先摆成指向 `~/.ssh` 或别的 bot 角色库的链接时，跟随解析会把链接目标当成本 bot 的子树授 rw（更上层如 `$HOME` 允许是链接，且必须 realpath，否则 canonical 匹配会 fail-open）；② 任何 deny（baseline / 机主 `sandboxPaths.deny` / mandatory）覆盖该子树时这条规则**整条不产生**——source rank 只裁同路径冲突，否则更深的 internal rw 会在被 deny 的库根上重新开个洞。

两件明确不在射程内、也不该只为这条规则加固的：**TOCTOU**（校验后到 spawn/bind 前把目录换成链接）与**挂载点**（末段是 bind/FUSE 挂载点仍算真目录）。两者都需要宿主级写权限，而拿到宿主级写权限的人本来就能改 `bots.json` 关掉沙盒；且策略里每条路径规则（`workingDir`、`botHome`、`cliDataPaths`…）都在同一时点做一次性检查，同样成立。

## botmux send 中转（关键）

`botmux send` 原本**直连飞书**（读 `bots.json` 拿密钥）。沙盒里没有 `bots.json`，所以：

1. 沙盒内 `botmux send` 检测到 `BOTMUX_SEND_RELAY`，把请求（argv + 内容文件 + 附件）写进 `outbox`，**不直连飞书**
2. daemon 侧 `startOutboxWatcher` 拾取请求，在**沙盒外**用真实凭证重跑 `send` 投递，结果写回
3. 附件被拷进 `outbox`（共享路径）后路径改写，host 侧才读得到

→ **所有飞书密钥全程不进沙盒**。

## 落盘（改动去向）

fs-policy 模型下 agent 在 **readWrite 白名单区（含 workingDir）直接写宿主真实文件**——改动即时落盘，不再是「副本 + 补丁交回」。沙盒的作用是把可写面收敛到白名单：项目目录可写、认证目录可写，白名单之外（别的项目、别的会话、`~/.ssh`/`~/.aws`、`bots.json`、各类密钥）一律读不到写不了。

## 已验证（本机实测）

- 文件隔离：白名单之外的宿主密钥/家目录读不到，未授权路径不存在
- authPaths：codex `~/.codex`（含 SQLite DB）真实 `--bind` 进得去、能起；未授权的兄弟会话/项目进不去
- send 中转：沙盒内 `botmux send`（含文件附件）→ outbox → daemon 代投 → 真实到达飞书，全程零凭证入沙盒
- 真实 worker：codex 经 worker spawn 钩子在 bwrap 内正常启动运行
- macOS：同一份 policy 经 Seatbelt（`sandbox-exec -f <profile>`）落地，deny 路径被挡、正常路径可跑

## 后续

- 沙盒目录 GC / 生命周期
- 出口网络管控（升级到「不止隔离文件」时）
