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

## 虚拟机模式安装（Hyper-V）

> 目标是：微信和适配层都跑在虚拟机里，**主机完全不抢焦点**。
> 这一节按顺序做完，插件里切一下「运行位置」就能用。

### 0. 前置条件

- Windows 11/10 **专业版**（家庭版没有 Hyper-V）
- 管理员权限
- 约 20 GB 磁盘给虚拟机，4 核 CPU，8 GB 内存（宿主 16 GB 以上更稳）

### 1. 启用 Hyper-V（管理员 PowerShell，需重启）

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All
```

图形界面也行：控制面板 → 程序 → 启用或关闭 Windows 功能 → 勾 **Hyper-V**。

### 2. 把当前账号加入「Hyper-V Administrators」

```powershell
net localgroup "Hyper-V Administrators" "$env:USERNAME" /add
```

⚠️ **必须注销并重新登录**（或重启）才生效，否则 `Get-VM` 会报“你没有完成此任务所需的权限”。

验证：

```powershell
whoami /groups | Select-String "Hyper-V"
```

### 3. 创建虚拟机

仓库里带了脚本（管理员运行）：

```powershell
# 需要先准备好 Windows 11 安装 ISO
powershell -ExecutionPolicy Bypass -File .\scripts\new-vm.ps1 `
  -Name dsh-wechat -IsoPath "D:\iso\Win11.iso" -VmRoot "D:\Hyper-V"
```

它做的事：Gen2 + Secure Boot + vTPM、4 vCPU、8 GB 内存（动态 2–8G）、64 GB 动态磁盘、
Default Switch 网卡、自动检查点。

手动创建的关键参数：

| 项 | 建议值 | 说明 |
|---|---|---|
| 代 | 第 2 代 | 支持 UEFI/Secure Boot |
| vCPU | 4 | 微信单线程为主，4 够了 |
| 内存 | 8 GB（动态） | 最低 2 GB，峰值 8 GB |
| 磁盘 | 64 GB **动态扩展** | 实际占用随使用增长，不会立刻占 64 GB |
| 网络 | Default Switch | NAT，主机可直连 VM |
| 检查点 | 开 | 装完微信先打一个，出问题能回滚 |

### 4. 装系统与软件（都在 VM 里做）

1. 装 Windows 11（ISO 引导），进入桌面；
2. **装微信**：从 [官网](https://weixin.qq.com/) 下载 PC 版，建议 **4.1.x**（适配层按 4.x 验证过），装完**扫码登录并保持登录**；
3. 装 Python 3.12，建 venv，把 `wechat-adapter` 目录拷贝进去；
4. 放行端口：

   ```powershell
   New-NetFirewallRule -DisplayName "wechat-adapter" -Direction Inbound -Protocol TCP -LocalPort 8823 -Action Allow
   ```

5. 注册开机自启的计划任务（登录时运行）：

   ```powershell
   $py = "C:\wechat-adapter\.venv\Scripts\python.exe"
   $args = "adapter.py --host 0.0.0.0 --port 8823 --account <你的账号目录> --token <令牌> --allow-send"
   schtasks /Create /TN "wechat-adapter" /SC ONLOGON /RL HIGHEST /TR "`"$py`" $args" /F
   ```

6. **电源与锁屏**（必做，否则 UIA 会失效）：

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change monitor-timeout-ac 0
   # 设置 → 账户 → 登录选项 → 关闭「需要登录」，并关闭屏保
   ```

### 5. 在插件里切换

设置 → Wechat 鲸鲸 → **运行位置** → 「虚拟机（微信在 Hyper-V 里）」，
把虚拟机名称填成你创建的名字（默认 `dsh-wechat`），点「一键启动」。

插件会：`Start-VM` → 等启动 + 读 IP → 把 `http://<ip>:8823` 和令牌写进桥接配置 → 启动桥接。

### 6. 验收

- 面板显示「虚拟机：Running · IP 172.x.x.x」
- 微信里 @ 一下，能收到回复
- 让它发表情包，图能到 —— **此时主机焦点不会被抢**

### 常见问题

| 现象 | 原因 |
|---|---|
| `Get-VM` 权限不足 | 没重新登录，或不在 Hyper-V Administrators 组 |
| 虚拟机起了但没 IP | 集成服务没开 / 网卡没连 Default Switch |
| 适配层连不上 | VM 防火墙没放行 8823 / 计划任务没跑 / token 不一致 |
| 能收不能发 | 微信窗口被最小化或锁屏（UIA 树塌了） |

## 本机模式 vs 虚拟机模式

设置页「运行位置」可以切换：

| | 本机（默认） | 虚拟机（Hyper-V） |
|---|---|---|
| 微信装在哪 | 这台电脑 | 虚拟机里 |
| 适配层 | 本机进程 | 虚拟机进程（带 token，走 HTTP） |
| 主机焦点 | **发图片/表情包时会短暂抢占** | **完全不抢** |
| 依赖 | Python venv | 需先装好 Hyper-V + VM 镜像 |

### 哪些功能会抢焦点（本机模式）

| 功能 | 抢焦点？ | 原因 |
|---|---|---|
| 收消息（读数据库） | ❌ 不抢 | 只读文件 |
| 发**文字**（含 @、引用） | ❌ 不抢 | `WM_CHAR` 后台通道 |
| 发**图片 / 表情包** | ✅ **会抢**（1–3 秒） | 剪贴板粘贴必须前台 |
| 记忆 / 人格 / 梗 | ❌ 不抢 | 纯文本注入 |

想让主机一秒都不被抢，就把微信和适配层放进虚拟机（模式切到「虚拟机」，填 VM 名称）。

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
# 1. 装插件（从 GitHub 或本地目录）
dsh plugin --profile desktop add github:1009659868/dsh-plugin-wechat

# 2. 准备运行环境（建 Python venv、装依赖、npm install）
cd "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-wechat"
powershell -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1

# 3. 重启 DSH → 设置 →「Wechat 鲸鲸」→ 一键启动
```

插件**自带运行时**（`runtime/wechat-adapter` + `runtime/wechat-bridge`），所以：

- **不需要**手填桥接目录，默认就是插件自带的 `runtime/wechat-bridge`；
- 第一次「一键启动」时若还没有 `config.json`，桥接会自动生成一份默认配置；
- 白名单、别名、API Key 都在设置页里改，保存后下一轮生效。

> 如果 `setup-runtime.ps1` 报“找不到 python”：装 Python 3.10+ 并勾选 Add to PATH，或用
> `-Python "C:\Path\To\python.exe"` 指定。
> 桥接那步需要 Node 20+ 与 npm；没有 npm 时可加 `-SkipNode`，但桥接将无法启动。

## 依赖

| 组件 | 要求 |
|---|---|
| 系统 | Windows 10/11 |
| 微信 | 4.x（读库 + UIA 均按 4.x 适配；3.9 不支持） |
| Python | 3.10+（脚本自动建 venv；3.12 验证过） |
| Node | 20+ 与 npm（仅安装桥接依赖时用） |

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
