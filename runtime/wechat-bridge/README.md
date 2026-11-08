# wechat-bridge —— 微信 ↔ DSH 桥接（M6）

把微信消息接进 **DSH 会话**（SurfCore 那套智能），回复走**后台发送**（不抢焦点）。

```
微信 ──UIA/DB──> work/wechat-adapter (:8823) ──HTTP──> 本进程 ──JSON-RPC──> DSH(wechat-chat preset)
```

## 状态：✅ 端到端跑通（2026-11-07）

```
20:12:34 [boot] LIVE  adapter=http://127.0.0.1:8823 poll=3000ms
20:12:35 [dsh] http://127.0.0.1:60931 preset=wechat-chat 可用
20:12:35 [session] wxid_b3k1wg7… -> session-c8623995…
20:12:35 [prompt] 文浩 <- 5 条…
20:12:40 [send] 文浩: 不是我摆架子呀，我这边说话只会出现在和你的私聊里…… -> ok=true
```

收件方数据库回读确认，消息真的发出去了。

## 前置：装 `wechat-chat` preset（一次性）

```powershell
cd "D:\WorkPlace\OiJJ agent\work\wechat-bridge"
node install-preset.mjs            # 写入 profile 的 cordis.patch.yml（自动备份）
node probe.mjs                     # 应该看到 wechat-chat 在 preset 列表里
```

原理：DSH 0.1.7+ **不再扫 `~/.dsh/.agent-presets/`**，preset 是一条
`@deepseek-ai/dsh-agent-preset` loader 行，`config.plugins` 是内联行列表，
只能插进 profile 的 patch 层。`install-preset.mjs` 做的就是这件事（照 SurfCore 的
`build-agent-preset-patches.mjs` 的做法）。

preset 本体在 `preset/wechat-chat/agent.cordis.yml`：**没有任何本地工具**
（无 bash / 无文件读写 / 无子代理），只有 ask-user / todo / compaction。

## 跑

```powershell
# 1) 适配层（微信侧，只读+发送）
cd "D:\WorkPlace\OiJJ agent\work\wechat-adapter"
.venv\Scripts\python.exe adapter.py --account wxid_fe6o50p32c3v22_4258 --port 8823 --allow-send

# 2) 桥接
cd "D:\WorkPlace\OiJJ agent\work\wechat-bridge"
node bridge.mjs            # 真跑
node bridge.mjs --dry-run  # 只打印 prompt，不建会话、不发送
```

`node` 用 `D:\else_\nodejs\node.exe`（DSH 自带的 node 也行）。

## config.json

| 键 | 说明 |
|---|---|
| `adapter.baseUrl` | 适配层地址（默认 `http://127.0.0.1:8823`） |
| `dsh.baseUrl` | 留空 = 自动发现（`discoverDshBaseUrl()`，桌面端端口每次启动会变） |
| `dsh.agentPreset` | 必须是 DSH 里真实存在的 preset；不存在就**拒绝启动**（fail-closed） |
| `dsh.workspaceTitle` | DSH 里这个 workspace 的名字 |
| `allow.groups` / `allow.private` | 白名单，按**昵称**或 wxid 匹配；**空 = 谁都不回** |
| `pollMs` | 轮询间隔 |
| `replyTimeoutMs` | 等模型回复的超时 |
| `maxReplyChars` | 单条回复字数上限 |

状态存在 `state.json`：每个会话的 `seq` 游标 + 微信会话 → DSH sessionId 映射。

## 群聊（M6.5）

白名单里加群名即可（`allow.groups`），默认**只回应 @ 我 的消息**（`botAliases` 里任意别名命中 `@别名`），
其余消息只推进游标、不触发会话。群里被叫到时，prompt 会带**最近 12 条**对话做上下文，并用 `★` 标出叫你那条。

实测（塔p 群）：

```
20:20:07 [prompt] 塔p <- 1 条…
20:20:11 [send] 塔p: 第二次测试收到，我在 -> ok=true
```

数据库回读：`第二次测试收到，我在` 已在群里。

### 群的发送确认改成读库

输入框校验在群里不可靠（用户可能同时在打字、草稿会被还原）。adapter 现在发完会**回读数据库**
确认这条消息真的出现了（`verified` 字段），`ok = 输入框校验成功 or 数据库确认`。

## 已知限制 / 踩过的坑

1. **回复必须是单行**：微信输入框是单行语义，`\n` 会被 Qt 当成 Enter（可能提前发送）。
   `cleanReply()` 会把换行压成空格 —— 第一版就是漏了这一步，结果 adapter 报 `ok=false`。
2. **别用 PowerShell 改 `state.json`**：PS 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM，
   Node 的 `JSON.parse` 直接抛错，桥接会把状态当空的（表现：重复建会话）。
3. **没有 @ 过滤**：白名单里的会话，任何新文本消息都会触发回复。群里要不要"只回 @ 我"，
   等 M7 面板里给开关。
4. **一次回复只发一条**：不拆气泡、不发表情包（微信侧能力后续再做）。
5. `sessions.list` 在探针里返回 0 条，是因为桌面端会话按 workspace 分组；不影响桥接。

## 与 SurfCore / 鲸鲸的关系

| 借用 | 来源 |
|---|---|
| `lib/dsh-client.js`（会话/prompt/事件流/turn collector） | SurfCore `src/dsh-client.js`（MIT），原样拷贝 |
| `lib/dsh-port.js`（端口漂移发现） | SurfCore `src/dsh-port.js`（MIT），原样拷贝 |
| preset 的安全设计（无本地工具 + fail-closed） | SurfCore `dsh/agent-presets/qq-chat/` |
| 后台发送/切会话的 Win32 手法 | 参考鲸鲸 `bridge/bg_sender.py` 的**行为**，代码独立实现（AGPL 不传染） |
