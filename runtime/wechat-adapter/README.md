# wechat-adapter —— 微信 4.x 适配层（P1.5）

把本机微信的会话/消息以 JSON 暴露出来，供 SurfCore 桥接转换成 DSH 会话输入；
发送走「绑定账号窗口 → UIA → 回读数据库确认」。**默认只读**，`--allow-send` 才启用发送。

## 状态（2026-11-07 实测）

| 能力 | 状态 | 证据 |
|---|---|---|
| 定位账号 + 解密数据库 | ✅ | 1.2s 内返回，账号可显式指定 |
| 列会话 | ✅ | 200 个会话，其中 16 个群 |
| 读群消息 | ✅ | `get_messages` 0.11s，发送者解析成 wxid |
| **多账号绑定** | ✅ | 两个微信号同时在线，能按账号找到各自的窗口 |
| 发送（UIA 通道） | ✅ | 抬窗发送，7.2s，回读确认 |
| **发送（后台通道）** | ✅ | **前台窗口未变化**，1.7–3.0s，回读确认 |
| 实时监听 | ⛔ 未接 | 先用轮询（桥接本来就是轮询语义） |

## 本机的两个微信号（重要）

| 角色 | 账号目录 | 昵称 | 主窗口 HWND | PID |
|---|---|---|---|---|
| **宿主号（agent 用这个）** | `wxid_fe6o50p32c3v22_4258` | Oi鲸鲸🐳 | `8130394` | 65752 |
| 主人号（测试对话用这个） | `wxid_b3k1wg7ebzox12_78f0` | 文浩 | `199156` | 53192 |

> HWND 每次重启微信都会变。**不要写死**，用 `GET /windows` 现查（适配层内部就是靠
> 「进程打开了哪个 `db_storage`」来把窗口和账号对上号的）。

## 环境事实

| 项 | 值 |
|---|---|
| 微信版本 | **4.1.15.56**（`D:\else_\Tencent\Weixin\Weixin.exe`；注册表里的 4.1.10.31 是过期值） |
| 数据目录 | `D:\else_\Documents\xwechat_files`（**不在**默认 Documents 下） |
| 数据库 | `db_storage/message/message_*.db`，SQLCipher，被运行中的微信独占打开 |
| 解密 | 库扫 `Weixin.exe` 进程内存取 key，解密到临时目录（只读，不改微信） |
| 权限 | 当前进程 **Medium**，未提权即可读库、可发送（UIA 热激活也成功） |
| Python | DSH 自带 3.12.14 + venv（`.venv`，已被 .gitignore 排除） |

### 发送通道与 `charMode`

本机 4.1.x → `WM_CHAR` 按 **GBK 字节**语义（4.2+ 才是 UTF-16 码元）。
但**同版本号也可能被腾讯热更新换成语义**，所以后续接鲸鲸那套后台发送时，配置用 `auto`
（运行时打探针字读回自判），别写死。

## 后台发送（B 方案，不抢焦点）

`bg_send.py`：不调用 `SetForegroundWindow` / `SetFocus` / `SendInput` / `mouse_event`，
全程只用 `PostMessage`：

| 步骤 | 做法 |
|---|---|
| 定位 | UIA 只读控件矩形（不点击） |
| 聚焦输入框 | `PostMessage` 鼠标消息（`WM_MOUSEMOVE` → `WM_LBUTTONDOWN` → `WM_LBUTTONUP`） |
| 写字 | `WM_SETFOCUS` + 逐字 `WM_CHAR`（本机实测 **UTF-16 码元**） |
| 发送 | `PostMessage` 点「发送」按钮 |
| 清空 | `WM_KEYDOWN/WM_KEYUP` 的 `VK_BACK`（`WM_CHAR 8` 本机不认） |

**实测（2026-11-07）**

```
[ok] bound hwnd=8130394 chat='文浩' (0.4s)
[..] result: {'composer': '后台发送实测 #1（应不抢焦点）', 'stage': 'sent', 'composer_after': ''}
[..] foreground: 1248258 -> 1248258   changed=False   took=1.7s
收件方库回读：'后台发送实测 #1（应不抢焦点）'
```

HTTP 通道同样验证过：`foreground 1248258 -> 1248258`，3.0s，`ok=true`。

### 三个坑（都是实机踩出来的）

1. **编码语义要看实测，不看版本号。** 本机是 4.1.15.56，按理该用 GBK 字节，
   但实测 `WM_CHAR` 收的是 **UTF-16 码元**：发 GBK 会变成 `±àÂëÌ½Õë`。
   → 默认 `--char-mode utf16`，别按版本号猜。
2. **`WeChatUIA.ensure_window()` 会把微信抬到前台**（内部调 `_activate()`）。
   实测它把前台从 66886 换成了 8130394。→ 只用 `_find_main()` + 直接赋 `_win`，绝不调用 `ensure_window`。
3. **`WM_CHAR 8` 清不掉输入框**，必须发 `WM_KEYDOWN/WM_KEYUP` 的 `VK_BACK`。

## 后台切会话（M5）

会话列表在 UIA 树里非常规整：

```
ListControl  aid=session_list
└─ ListItemControl aid=session_item_<显示名>   ← 每行都带 BoundingRectangle
```

切会话 = 找到目标行 → `PostMessage` 点一下 → **重新绑定控件树** → 用 `current_chat()` 校验。
找不到就滚轮（`WM_MOUSEWHEEL`，lParam 用屏幕坐标）翻页再找，先向下再向上。

**实测**

```
[ok] bound hwnd=8130394 chat='塔p'
[..] result: {'ok': True, 'stage': 'post-click', 'current': '文浩', 'tries': 1}
[..] foreground: 5376596 -> 5376596   changed=False   took=1.8s
```

带自动切换的完整发送（塔p → 文浩）：

```
SEND in 3.4s: {"ok":true,"mode":"bg","detail":{"chat":"文浩","stage":"sent","composer_after":""}}
fg after = 5376596（全程未变）
```

群消息发出后回读确认：`47633131873@chatroom` 里查到 `后台切会话+发送实测 M5`。

### 两条纪律（踩出来的）

1. **不要用 UIA 的 `Invoke` / `SelectionItem` 切会话。**
   本机实测：调用不报错，但**会话根本没切过去**；而且它会让微信**激活到前台**（前台从别的窗口变成 8130394）。
   唯一有效且不抢焦点的方式是 `PostMessage` 点击。
2. **点完会话行，控件树会被重建**（输入框、列表节点短暂消失，`current_chat()` 返回 `None`）。
   必须重新 `_find_main()` 绑定，再轮询校验；否则会误判成“切换失败”。

## 装依赖

```powershell
$py = "C:\Users\Allmight\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m venv "D:\WorkPlace\OiJJ agent\work\wechat-adapter\.venv"
& "...\.venv\Scripts\python.exe" -m pip install -r requirements.txt
```

`wechatauto-replica` 是 **Apache-2.0**（我们只用这个上游库，不复制鲸鲸的 AGPL 代码）。

## 跑

```powershell
# 只读
.venv\Scripts\python.exe adapter.py --account wxid_fe6o50p32c3v22_4258 --port 8823

# 允许发送（会驱动微信窗口）
.venv\Scripts\python.exe adapter.py --account wxid_fe6o50p32c3v22_4258 --port 8823 --allow-send
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, account, nick, hwnd, allow_send, uptime_s}` |
| GET | `/accounts` | 本机所有微信账号目录 |
| GET | `/windows` | `[{account, hwnd, pid, title, cls}]` 账号↔窗口映射 |
| GET | `/sessions?limit=50` | `{sessions:[{username, nick, kind: group\|private, unread}]}` |
| GET | `/messages?chat=<username>&limit=20&after=<seq>` | 按 `seq` 升序；`after` 走增量 |
| POST | `/send` | `{chat, text}`；需 `--allow-send`，否则 403。默认走后台通道（不抢焦点），内部串行 |

启动参数补充：`--send-mode bg|uia`（默认 `bg`）、`--char-mode utf16|gbk`（默认 `utf16`）。

消息形状：

```json
{"seq": 1794048810000, "local_id": 650, "shard": "message_0.db",
 "ts": 1794048810, "type": "text", "from": "wxid_b3k1wg…", "text": "我单人和它一起爬塔响应是挺快的"}
```

## 实测记录

**发送（宿主号 → 文浩）**

```
[ok] bound hwnd=8130394 pid=65752  (4.7s，含首次布局校准)
[..] send_msg 返回 in 7.2s: {'status': '成功', 'message': '消息已发送并确认：…'}
收件方库回读：文本 from=wxid_fe6o50p32c3v22  'SurfCore 微信适配层测试 #1'
```

**HTTP 通道**

```
POST /send {"chat":"文浩","text":"SurfCore 微信适配层测试 #2（HTTP 通道）"}
→ 4.4s，ok=true，took_s=3.0
```

## 安全约束

1. 只监听 `127.0.0.1`，无鉴权 —— **不要改成 0.0.0.0**。
2. 默认只读；发送必须显式 `--allow-send`。
3. 发送串行（微信只有一个前台会话，并发会串话）。
4. 不返回数据库密钥。

## 下一步

1. 把 `/messages` 接进 SurfCore 的 `handleIncoming`（见 `docs/01-qq-chain.md` ①③）。
2. 后台发送（不抢焦点）——参考 `refs/whale_girl/bridge/bg_sender.py` 的 `WM_CHAR` 通道，
   比 UIA 点击更温和，且能穿透被遮挡窗口。
3. 群聊并发：一个群一个游标，发送队列按会话串行。
