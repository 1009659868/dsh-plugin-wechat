# dsh-plugin-wechat

把**微信**接进 DeepSeek Harness：后台读消息、后台发消息（不抢宿主焦点）、@/别名触发、一键启停。

> 这是从 [SurfCore](https://github.com/Mieksido/surfcore) 的「微信」tab 里拆出来的独立插件，
> 不依赖 QQ / B站 任何状态，可以单独安装、单独发布。

## 它由三块组成

```
DSH  ── dsh-plugin-wechat（本插件：设置页 + 宿主路由）
              │
              ├─ wechat-adapter（Python，只读微信数据库 + 后台发送）
              └─ wechat-bridge （Node，微信会话 ⇄ DSH 会话）
```

本插件只负责**UI 与进程管理**：配置白名单/别名、选微信号、一键启停、查状态。
真正收发在 adapter / bridge 两个外部进程里（Windows + 微信 4.x）。

## 可选：装一份「全局人格」（dsh-agent-md）

本插件**不自带人格**。想让鲸鲸有人设，推荐配合 [dsh-agent-md](https://github.com/wwsmiler1-bit/dsh-agent-md)
使用——它把人格写成 Markdown，注入到**所有 DSH 会话**（桌面聊天和微信共用同一份）：

```powershell
dsh plugin --profile desktop add github:wwsmiler1-bit/dsh-agent-md
# 重启 DSH → 设置 → 人格 → 全局人格，写你的人设
```

> 装不装由你决定：不装就是通用助手口吻；装了之后记得在它的设置里**关掉「项目人格」**，
> 否则微信会话的 cwd 可能命中某个项目的 `AGENT.md`，把全局人设覆盖掉。

## 安装

```powershell
dsh plugin --profile desktop add "D:\path\to\dsh-plugin-wechat"
# 重启 DSH（或让 profile 重载）后，设置里出现「微信」一节
```

然后在「微信」页把**桥接目录**指到 `wechat-bridge` 所在目录（含 `bridge.mjs` 与 `config.json`），
点「一键启动」即可。

## 依赖

| 组件 | 要求 |
|---|---|
| 系统 | Windows 10/11 |
| 微信 | 4.x（读库 + UIA 均按 4.x 适配；3.9 不支持） |
| Python | 3.12（adapter 的 venv） |
| Node | ≥22（bridge；DSH 自带运行时即可） |
| DSH | 0.2.x，`wechat-chat` preset 已装（bridge 侧 fail-closed 校验） |

## 配置

插件配置在 `~/.dsh/wechat/config.json`，桥接自己的配置在 `<桥接目录>/config.json`。
面板可改：桥接目录、微信号、群/私聊白名单、@ 别名。

## 安全边界

- 只接受**回环**访问；写操作要求同源 + `application/json`；
- 不代登录微信、不打包微信运行时；
- agent 侧 preset（`wechat-chat`）**不挂任何本地工具**——群里任何人都无法借它操作本机；
- 桥接启动时校验 preset 存在，不存在就拒绝建会话（fail-closed）。

## 发布到自己的仓库

```powershell
cd dsh-plugin-wechat
git init
git add .
git commit -m "feat: dsh-plugin-wechat 0.1.0"
git remote add origin <你的仓库>
git push -u origin main
```

别人安装：

```powershell
dsh plugin --profile desktop add github:<你>/<仓库>
```

## Roadmap

- [ ] 语音：收（SILK → ASR，本地/云端可选）、发（需前台，计划放虚拟机）
- [ ] 引用消息识别（引用鲸鲸 = 点名）
- [ ] 图片/文件发送
