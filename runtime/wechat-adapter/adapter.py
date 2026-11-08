"""微信适配层（P1.5）—— 只读默认，可选发送。

把本机微信 4.x 的会话/消息以 JSON 暴露给 SurfCore 桥接，供其转换成 DSH 会话输入。
本机同时登录了多个微信号，因此**必须按账号绑定**：
  · 读：WeChatDB(account=...)
  · 写：先按账号找到主窗口 HWND，再 WeChatGUI(hwnd=...) 绑定后发送

依赖：wechatauto-replica（Apache-2.0），见 requirements.txt。

运行：
    .venv\\Scripts\\python.exe adapter.py --account wxid_fe6o50p32c3v22_4258 --port 8823
    .venv\\Scripts\\python.exe adapter.py --account ... --allow-send   # 允许发送

接口：
    GET  /health
    GET  /accounts
    GET  /windows                    账号 ↔ 窗口映射
    GET  /sessions?limit=50
    GET  /messages?chat=<username>&limit=20&after=<sort_seq>
    POST /send   {"chat": "...", "text": "..."}      # 需 --allow-send
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TYPE_MAP = {
    "文本": "text",
    "图片": "image",
    "语音": "voice",
    "视频": "video",
    "文件": "file",
    "文件/链接/卡片": "card",
    "系统": "system",
    "位置": "location",
    "动画表情": "sticker",
    "引用消息": "quote",
}
MAX_LIMIT = 200

_user32 = ctypes.windll.user32
_EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _visible_windows() -> list[dict]:
    out: list[dict] = []

    def cb(hwnd, _lparam):
        if not _user32.IsWindowVisible(hwnd):
            return True
        n = _user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        _user32.GetWindowTextW(hwnd, buf, n + 1)
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        cls = ctypes.create_unicode_buffer(256)
        _user32.GetClassNameW(hwnd, cls, 256)
        out.append({"hwnd": int(hwnd), "pid": int(pid.value), "title": buf.value, "cls": cls.value})
        return True

    _user32.EnumWindows(_EnumWindowsProc(cb), 0)
    return out


def _account_of_pid(pid: int) -> str:
    """从进程打开的文件反推账号目录（db_storage 的上一级）。"""
    try:
        import psutil

        for f in psutil.Process(pid).open_files():
            parts = f.path.split(os.sep)
            if "db_storage" in parts:
                i = parts.index("db_storage")
                if i >= 1:
                    return parts[i - 1]
    except Exception:
        pass
    return ""


def account_windows() -> list[dict]:
    """返回 [{account, hwnd, pid, title, cls}]，只含 Weixin.exe 的可见主窗口。"""
    try:
        import psutil
    except Exception:
        return []
    pids = {p.info["pid"] for p in psutil.process_iter(["pid", "name"])
            if (p.info.get("name") or "").lower() == "weixin.exe"}
    accounts = {pid: _account_of_pid(pid) for pid in pids}
    rows = []
    for w in _visible_windows():
        if w["pid"] in pids and "QWindow" in w["cls"]:
            rows.append({"account": accounts.get(w["pid"], ""), **w})
    return rows


class WechatStore:
    def __init__(self, account: str | None = None, send_mode: str = "bg",
                 char_mode: str = "utf16") -> None:
        self.account = account
        self.send_mode = send_mode
        self.char_mode = char_mode
        self._db = None
        self._gui = None
        self._gui_account = None
        self._bg = None
        self._bg_account = None
        self._lock = threading.Lock()          # 保护 DB
        self._send_lock = threading.Lock()     # 发送必须串行（微信只有一个前台会话）
        self._started_at = time.time()

    # ---- DB ----
    def db(self):
        if self._db is None:
            from wechatauto import WeChatDB

            self._db = WeChatDB(account=self.account) if self.account else WeChatDB()
            self.account = self._db.account
        return self._db

    def self_info(self) -> dict:
        with self._lock:
            return self.db().get_self_info()

    def sessions(self, limit: int) -> list[dict]:
        with self._lock:
            db = self.db()
            out = []
            for s in db.get_sessions(limit=limit):
                username = str(s.get("username") or "")
                nick = ""
                try:
                    nick = db.get_nickname(username)
                except Exception:
                    pass
                out.append({
                    "username": username,
                    "nick": nick,
                    "kind": "group" if username.endswith("@chatroom") else "private",
                    "unread": s.get("unread"),
                })
            return out

    def messages(self, chat: str, limit: int, after: int | None) -> list[dict]:
        with self._lock:
            db = self.db()
            want = MAX_LIMIT if after is not None else limit
            rows = db.get_messages(chat, limit=want)
            items = [self._norm(m) for m in rows]
            # 补显示名（群友昵称/备注），失败就用 wxid —— 提示词里可读性差很多
            names: dict[str, str] = {}
            for it in items:
                src = it.get("from") or ""
                if not src or src in names:
                    continue
                try:
                    names[src] = db.get_nickname(src) or ""
                except Exception:
                    names[src] = ""
            for it in items:
                it["from_name"] = names.get(it.get("from") or "", "") or it.get("from") or ""
        items.sort(key=lambda m: m["seq"])
        if after is not None:
            items = [m for m in items if m["seq"] > after]
        return items[-limit:]

    @staticmethod
    def _norm(m: dict) -> dict:
        raw_type = str(m.get("type") or "")
        sender = str(m.get("sender_username") or "")
        content = str(m.get("content") or "")
        text = content
        if sender and text.startswith(sender + ":"):
            text = text[len(sender) + 1:].lstrip("\n ")
        return {
            "seq": m.get("sort_seq") or 0,
            "local_id": m.get("local_id"),
            "shard": m.get("shard"),
            "ts": m.get("create_time"),
            "type": TYPE_MAP.get(raw_type, raw_type or "unknown"),
            "from": sender,
            "text": text,
        }

    # ---- 账号列表（面板选"用哪个号当鲸鲸"）----
    _accounts_cache = None
    _accounts_ts = 0.0

    def accounts(self) -> list[dict]:
        import time as _t

        now = _t.time()
        if self._accounts_cache is not None and now - self._accounts_ts < 60:
            return self._accounts_cache
        try:
            from wechatauto import list_accounts

            rows = list_accounts()
        except Exception:
            rows = []
        try:
            online = {w["account"] for w in account_windows()}
        except Exception:
            online = set()
        out = []
        for r in rows:
            acct = str(r.get("account") or "")
            nick = ""
            try:
                from wechatauto import WeChatDB

                probe = WeChatDB(account=acct) if acct else None
                if probe is not None and probe.account == acct:
                    info = probe.get_self_info() or {}
                    nick = str(info.get("nick_name") or "").strip()
            except Exception:
                nick = ""
            out.append({
                "account": acct,
                "wxid": str(r.get("wxid") or ""),
                "nick": nick,
                "online": acct in online,
                "lastActive": int((r.get("last_activity") or 0) * 1000),
            })
        out.sort(key=lambda x: -x["lastActive"])
        self._accounts_cache = out
        self._accounts_ts = now
        return out

    # ---- GUI / 发送 ----
    def hwnd(self) -> int:
        rows = [r for r in account_windows() if r["account"] == self.account]
        if not rows:
            raise RuntimeError(f"找不到账号 {self.account} 的微信主窗口（微信是否在运行/登录？）")
        return int(rows[0]["hwnd"])

    def bg_sender(self):
        """后台发送器（不抢焦点）。首次初始化约 0.5s。"""
        if self._bg is not None and self._bg_account == self.account:
            return self._bg
        from bg_send import BgSender

        self._bg = BgSender(self.hwnd())
        self._bg_account = self.account
        return self._bg

    def gui(self):
        """按账号绑定的 WeChatGUI（UIA 发送通道，会抬窗）。首次初始化约 5-12s。"""
        if self._gui is not None and self._gui_account == self.account:
            return self._gui
        from wechatauto.guia import WeChatGUI

        self._gui = WeChatGUI(hwnd=self.hwnd())
        self._gui_account = self.account
        return self._gui

    def tts(self, text: str, voice: str = "zh-CN-XiaoyiNeural") -> dict:
        """云端 TTS（edge-tts）→ 本地 mp3 缓存。返回路径给桥接发文件用。"""
        import asyncio
        import hashlib
        import os as _os

        text = str(text or "").strip()
        if not text:
            return {"ok": False, "error": "text 为空"}
        cache_dir = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "voice-cache")
        _os.makedirs(cache_dir, exist_ok=True)
        key = hashlib.sha1(f"{voice}|{text}".encode("utf-8")).hexdigest()
        path = _os.path.join(cache_dir, key + ".mp3")
        cached = _os.path.isfile(path)
        if not cached:
            import edge_tts

            async def _run():
                await edge_tts.Communicate(text, voice).save(path)

            asyncio.run(_run())
        return {
            "ok": True,
            "path": path,
            "bytes": _os.path.getsize(path),
            "cached": cached,
            "voice": voice,
            "chars": len(text),
        }

    # ---- 语音发送（V3：虚拟声卡 + 按住录音快捷键）----
    def voice_devices(self) -> dict:
        import miniaudio

        d = miniaudio.Devices()
        return {
            "ok": True,
            "playback": [{"index": i, "name": x.get("name")} for i, x in enumerate(d.get_playbacks())],
            "capture": [{"index": i, "name": x.get("name")} for i, x in enumerate(d.get_captures())],
        }

    def _audio_duration(self, path: str) -> float:
        import miniaudio

        decoded = miniaudio.decode_file(path)
        frames = len(decoded.samples) / max(1, decoded.nchannels)
        return frames / float(decoded.sample_rate)

    def _play_to(self, path: str, name_part: str = "CABLE Input") -> dict:
        import miniaudio
        import time as _t

        devs = miniaudio.Devices()
        target = next((d for d in devs.get_playbacks() if name_part.lower() in str(d.get("name", "")).lower()), None)
        if target is None:
            return {"ok": False, "error": f"找不到播放设备：{name_part}"}
        duration = self._audio_duration(path)
        device = miniaudio.PlaybackDevice(device_id=target["id"])
        with device:
            device.start(miniaudio.stream_file(path))
            _t.sleep(duration + 0.25)
        return {"ok": True, "device": target.get("name"), "duration_s": round(duration, 2)}

    # MiniMax 常见预置音色（label 仅供参考，voice_id 才是真参数）
    MM_VOICES = [
        {"id": "male-qn-qingse", "label": "青涩青年"},
        {"id": "female-shaonv", "label": "少女"},
        {"id": "female-yujie", "label": "御姐"},
        {"id": "female-chengshu", "label": "成熟女性"},
        {"id": "female-tianmei", "label": "甜美少女"},
        {"id": "male-qn-jingying", "label": "精英青年"},
        {"id": "male-badao", "label": "霸道总裁"},
        {"id": "male-qn-daxuesheng", "label": "青年大学生"},
        {"id": "male-qn-qingnian", "label": "青涩青年2"},
        {"id": "presenter_male", "label": "男主持人"},
        {"id": "presenter_female", "label": "女主持人"},
        {"id": "audiobook_male_1", "label": "有声书男声1"},
        {"id": "audiobook_female_1", "label": "有声书女声1"},
    ]
    MM_MODELS = [
        {"id": "speech-2.8-turbo", "label": "Speech 2.8 Turbo（默认，快）"},
        {"id": "speech-02-hd", "label": "Speech 02 HD（音质好）"},
        {"id": "speech-02-turbo", "label": "Speech 02 Turbo（均衡）"},
    ]
    MM_EMOTIONS = ["", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"]

    def voice_options(self) -> dict:
        return {
            "ok": True,
            "minimax": {"voices": self.MM_VOICES, "models": self.MM_MODELS, "emotions": self.MM_EMOTIONS},
            "edge": {
                "voices": [
                    {"id": "zh-CN-XiaoyiNeural", "label": "Xiaoyi · 活泼"},
                    {"id": "zh-CN-XiaoxiaoNeural", "label": "Xiaoxiao · 温柔"},
                    {"id": "zh-CN-YunxiNeural", "label": "Yunxi · 少年"},
                    {"id": "zh-CN-liaoning-XiaobeiNeural", "label": "Xiaobei · 东北话"},
                ]
            },
        }

    def tts_v2(self, text: str, provider: str = "edge", voice: str = "zh-CN-XiaoyiNeural",
               api_key: str = "", model: str = "speech-02-hd", voice_id: str = "male-qn-qingse",
               base_url: str = "https://api.minimaxi.com", emotion: str = "") -> dict:
        """云端 TTS，多提供方：edge（免 key）/ minimax（Bearer key）。缓存键含 provider/model/voice。"""
        import asyncio
        import hashlib
        import json as _json
        import os as _os
        import urllib.request

        text = str(text or "").strip()
        if not text:
            return {"ok": False, "error": "text 为空"}
        provider = (provider or "minimax").strip().lower()
        if provider != "minimax":
            return {"ok": False, "error": "仅支持 MiniMax 云端 TTS（免费备用方案已移除）"}
        cache_dir = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "voice-cache")
        _os.makedirs(cache_dir, exist_ok=True)
        key = hashlib.sha1(f"{provider}|{model}|{voice_id}|{voice}|{text}".encode("utf-8")).hexdigest()
        path = _os.path.join(cache_dir, key + ".mp3")
        cached = _os.path.isfile(path)
        if not cached:
            if provider == "edge":
                import edge_tts

                async def _run():
                    await edge_tts.Communicate(text, voice).save(path)

                asyncio.run(_run())
            elif provider in ("breeze", "breezeblue"):
                if not api_key:
                    return {"ok": False, "error": "Breeze Blue 需要 API Key"}
                base = (base_url or "https://api.breezeblue.ai").rstrip("/")
                url = f"{base}/v1/text-to-speech/{voice_id or ''}"
                payload = _json.dumps({"text": text, "output_format": "mp3"}).encode("utf-8")
                req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}, method="POST")
                try:
                    with urllib.request.urlopen(req, timeout=90) as resp:
                        ctype = resp.headers.get("Content-Type", "")
                        data = resp.read()
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": f"Breeze 请求失败：{exc}"}
                if "audio" not in ctype and data[:1] == b"{":
                    return {"ok": False, "error": f"Breeze 返回非音频：{data[:200]!r}"}
                with open(path, "wb") as f:
                    f.write(data)
            elif provider == "minimax":
                if not api_key:
                    return {"ok": False, "error": "minimax 需要 API Key（在面板里填）"}
                payload = {
                    "model": model or "speech-02-hd",
                    "text": text,
                    "stream": False,
                    "voice_setting": {"voice_id": voice_id or "male-qn-qingse", "speed": 1.0, "vol": 1.0, "pitch": 0, **({"emotion": emotion} if emotion else {})},
                    "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3"},
                }
                req = urllib.request.Request(
                    f"{base_url.rstrip('/')}/v1/t2a_v2",
                    data=_json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        data = _json.loads(resp.read().decode("utf-8"))
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": f"minimax 请求失败：{exc}"}
                hex_audio = ((data or {}).get("data") or {}).get("audio") or ""
                if not hex_audio:
                    return {"ok": False, "error": f"minimax 无音频返回：{str(data)[:200]}"}
                with open(path, "wb") as f:
                    f.write(bytes.fromhex(hex_audio))
            else:
                return {"ok": False, "error": f"未知 TTS 提供方：{provider}"}
        return {
            "ok": True,
            "path": path,
            "bytes": _os.path.getsize(path),
            "cached": cached,
            "provider": provider,
            "voice": voice,
            "voice_id": voice_id,
            "model": model,
            "chars": len(text),
        }

    def _force_foreground(self, hwnd: int, tries: int = 6) -> bool:
        import ctypes
        import time as _t

        user32 = ctypes.windll.user32
        VK_MENU = 0x12
        for _ in range(tries):
            if user32.GetForegroundWindow() == hwnd:
                return True
            user32.keybd_event(VK_MENU, 0, 0, 0)      # ALT down
            user32.keybd_event(VK_MENU, 0, 0x0002, 0)  # ALT up
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:
                pass
            _t.sleep(0.3)
        return user32.GetForegroundWindow() == hwnd
    def voice_clone(self, path: str, voice_id: str, api_key: str,
                    base_url: str = "https://api.minimaxi.com") -> dict:
        """上传复刻音频 → 快速复刻 → 返回 voice_id。"""
        import json as _json
        import os as _os
        import urllib.request
        import uuid

        if not api_key:
            return {"ok": False, "error": "需要 MiniMax API Key"}
        if not _os.path.isfile(path):
            return {"ok": False, "error": f"音频不存在：{path}"}
        if not voice_id:
            voice_id = "clone_" + uuid.uuid4().hex[:8]
        base = base_url.rstrip("/")

        # 1) 上传文件：multipart/form-data
        boundary = "----wx" + uuid.uuid4().hex
        with open(path, "rb") as f:
            blob = f.read()
        filename = _os.path.basename(path)
        parts = []

        def field(name, value):
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())

        field("purpose", "voice_clone")
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        parts.append(blob)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(
            f"{base}/v1/files/upload",
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                up = _json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "stage": "upload", "error": str(exc)}
        file_id = ((up or {}).get("file") or {}).get("file_id") or (up or {}).get("file_id")
        if not file_id:
            return {"ok": False, "stage": "upload", "error": f"没有 file_id：{str(up)[:200]}"}

        # 2) 快速复刻
        payload = _json.dumps({"file_id": file_id, "voice_id": voice_id}).encode("utf-8")
        req2 = urllib.request.Request(
            f"{base}/v1/voice_clone",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req2, timeout=180) as resp:
                cloned = _json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "stage": "clone", "file_id": file_id, "error": str(exc)}
        return {"ok": True, "voice_id": voice_id, "file_id": file_id, "raw": str(cloned)[:300]}

    def send_voice(self, chat: str, text: str = "", path: str = "", hotkey: str = "ctrl+tab") -> dict:
        """按住录音快捷键 → 播放 TTS 音频到 CABLE Input → 松开 → 校验。会抢前台。"""
        import ctypes
        import time as _t

        if not path:
            made = self.tts(text)
            if not made.get("ok"):
                return made
            path = made["path"]

        # 1) 先恢复窗口（最小化时 UIA 树是空的），再切会话并置前
        hwnd = self.hwnd()
        user32 = ctypes.windll.user32
        user32.ShowWindow(hwnd, 9)       # SW_RESTORE
        _t.sleep(0.4)
        # 已经在目标会话就不切（切会话是最容易失败的环节）
        try:
            cur = self.bg_sender().current_chat()
        except Exception:
            cur = None
        switched = {"ok": True, "skipped": True}
        if cur != chat:
            switched = self.bg_sender().open_chat(chat)
            if not switched.get("ok"):
                try:
                    self.bg_sender()._ensure_tree()
                except Exception:
                    pass
                switched = self.bg_sender().open_chat(chat)
            if not switched.get("ok"):
                return {"ok": False, "stage": "switch-failed", "detail": switched}
        user32.ShowWindow(hwnd, 9)       # SW_RESTORE
        # Windows 会阻止后台进程抢前台：用 ALT 轻敲 + 重试，必要时 SwitchToThisWindow
        if not self._force_foreground(hwnd):
            return {"ok": False, "stage": "not-foreground"}

        # 2) 按下并保持快捷键
        VK = {"ctrl": 0x11, "tab": 0x09, "alt": 0x12, "shift": 0x10}
        parts = [p.strip().lower() for p in str(hotkey).split("+") if p.strip()]
        codes = [VK[p] for p in parts if p in VK]
        if not codes:
            return {"ok": False, "stage": "bad-hotkey", "hotkey": hotkey}
        KEYUP = 0x0002
        # 让输入框拿到焦点：微信的“按住说话”是窗口内热键，光置前不够
        try:
            box = self.bg_sender().input_ctrl()
            if box is not None:
                box.SetFocus()
        except Exception:
            pass
        _t.sleep(0.2)
        for code in codes:
            user32.keybd_event(code, 0, 0, 0)
            _t.sleep(0.08)
        _t.sleep(0.5)   # 鲸鲸经验：按下后等 500ms 再放音，微信才真正开始录音

        try:
            played = self._play_to(path)
        finally:
            for code in reversed(codes):
                user32.keybd_event(code, 0, KEYUP, 0)
                _t.sleep(0.03)

        if not played.get("ok"):
            return {"ok": False, "stage": "play-failed", "detail": played}

        # 3) 回读数据库确认出现语音消息（注意：chat 是显示名，库里要按 username 查）
        key = chat
        try:
            for row in self.sessions(50):
                if str(row.get("nick")) == chat or str(row.get("username")) == chat:
                    key = str(row.get("username"))
                    break
        except Exception:
            pass
        verified = False
        for _ in range(8):
            _t.sleep(0.4)
            try:
                rows = self.messages(key, limit=3, after=None)
            except Exception:
                rows = []
            for row in rows:
                if str(row.get("type")) in ("语音", "voice"):
                    verified = True
                    break
            if verified:
                break
        return {
            "ok": verified,
            "verified": verified,
            "stage": "sent",
            "played": played,
            "hotkey": hotkey,
        }

    def send_media(self, chat: str, file_path: str, as_image: bool = False) -> dict:
        """剪贴板粘贴发文件/图片（CF_HDROP + Ctrl+V）。会抢前台焦点——开发期可接受。"""
        import os

        if not os.path.isfile(file_path):
            return {"ok": False, "error": f"文件不存在：{file_path}"}
        gui = self.gui()
        fn = gui.send_image if as_image else gui.send_file
        res = fn(file_path, chat, verify=True)
        ok = bool(getattr(res, "success", False) or getattr(res, "ok", False))
        return {
            "ok": ok,
            "mode": "image" if as_image else "file",
            "detail": str(getattr(res, "message", "") or getattr(res, "msg", "") or "")[:300],
        }

    def send(self, chat: str, text: str) -> dict:
        with self._send_lock:
            t0 = time.time()
            if self.send_mode == "bg":
                res = self.bg_sender().send(text, mode=self.char_mode, confirm_chat=chat)
                # 输入框校验不可靠（用户可能正在打字/草稿被还原），以数据库回读为准
                verified = self._verify_sent(chat, text)
                return {
                    "ok": bool(res.get("ok")) or verified is True,
                    "mode": "bg",
                    "verified": verified,
                    "detail": res,
                    "took_s": round(time.time() - t0, 1),
                }
            gui = self.gui()
            resp = gui.send_msg(text, chat, verify=True)
            ok = isinstance(resp, dict) and resp.get("status") == "成功"
            return {
                "ok": ok,
                "mode": "uia",
                "detail": resp,
                "took_s": round(time.time() - t0, 1),
            }

    def _verify_sent(self, chat: str, text: str):
        """回读数据库，确认这条消息真的出现在会话里（None = 找不到会话）。"""
        want = str(text or "").strip()
        if not want:
            return False
        with self._lock:
            db = self.db()
            username = None
            try:
                for s in db.get_sessions(limit=100):
                    u = str(s.get("username") or "")
                    if u == chat:
                        username = u
                        break
                    try:
                        if db.get_nickname(u) == chat:
                            username = u
                            break
                    except Exception:
                        continue
            except Exception:
                return None
            if not username:
                return None
            for _ in range(10):
                try:
                    rows = db.get_messages(username, limit=1)
                except Exception:
                    rows = []
                if rows and str(rows[0].get("content") or "").strip() == want:
                    return True
                time.sleep(0.4)
            return False


def make_handler(store: WechatStore, allow_send: bool, token: str = ""):
    class Handler(BaseHTTPRequestHandler):
        server_version = "surfcore-wechat-adapter/0.2"

        def _authorized(self) -> bool:
            if not token:
                return True
            return (self.headers.get("Authorization") or "").strip() == f"Bearer {token}"

        def log_message(self, fmt, *args):
            return

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _q(self):
            return parse_qs(urlparse(self.path).query)

        def do_GET(self):
            if not self._authorized():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            path = urlparse(self.path).path
            try:
                if path == "/voice-options":
                    return self._json(200, store.voice_options())
                if path == "/voice-devices":
                    return self._json(200, store.voice_devices())
                if path == "/health":
                    info = store.self_info()
                    rows = [r for r in account_windows() if r["account"] == store.account]
                    return self._json(200, {
                        "ok": True,
                        "account": info.get("username"),
                        "nick": info.get("nick_name"),
                        "hwnd": rows[0]["hwnd"] if rows else None,
                        "allow_send": allow_send,
                        "send_mode": store.send_mode,
                        "char_mode": store.char_mode,
                        "uptime_s": round(time.time() - store._started_at, 1),
                    })
                if path == "/accounts":
                    return self._json(200, {"ok": True, "accounts": store.accounts(), "current": store.account})
                if path == "/windows":
                    return self._json(200, {"ok": True, "windows": account_windows()})
                if path == "/sessions":
                    limit = min(int(self._q().get("limit", ["50"])[0]), MAX_LIMIT)
                    return self._json(200, {"ok": True, "sessions": store.sessions(limit)})
                if path == "/messages":
                    q = self._q()
                    chat = (q.get("chat") or [""])[0]
                    if not chat:
                        return self._json(400, {"ok": False, "error": "chat is required"})
                    limit = min(int((q.get("limit") or ["20"])[0]), MAX_LIMIT)
                    after_raw = (q.get("after") or [None])[0]
                    after = int(after_raw) if after_raw not in (None, "") else None
                    return self._json(200, {"ok": True, "messages": store.messages(chat, limit, after)})
                return self._json(404, {"ok": False, "error": "not found"})
            except Exception as exc:
                traceback.print_exc()
                return self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

        def do_POST(self):
            if not self._authorized():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            path = urlparse(self.path).path
            if path not in ("/send", "/send-file", "/send-image", "/tts", "/voice-devices", "/send-voice", "/voice-clone"):
                return self._json(404, {"ok": False, "error": "not found"})
            if not allow_send:
                return self._json(403, {"ok": False, "error": "send disabled; start with --allow-send"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                chat = str(payload.get("chat") or "")
                if path == "/send":
                    text = str(payload.get("text") or "")
                    if not chat or not text:
                        return self._json(400, {"ok": False, "error": "chat and text are required"})
                    return self._json(200, {"ok": True, **store.send(chat, text)})
                if path == "/voice-clone":
                    return self._json(200, store.voice_clone(str(payload.get("path") or ""), str(payload.get("voiceId") or ""), str(payload.get("apiKey") or ""), str(payload.get("baseUrl") or "https://api.minimaxi.com")))
                if path == "/voice-options":
                    return self._json(200, store.voice_options())
                if path == "/voice-devices":
                    return self._json(200, store.voice_devices())
                if path == "/send-voice":
                    chat_v = str(payload.get("chat") or "")
                    return self._json(200, store.send_voice(chat_v, str(payload.get("text") or ""), str(payload.get("path") or ""), str(payload.get("hotkey") or "ctrl+tab")))
                if path == "/tts":
                    text = str(payload.get("text") or "")
                    voice = str(payload.get("voice") or "zh-CN-XiaoyiNeural")
                    return self._json(200, store.tts_v2(
                        text,
                        str(payload.get("provider") or "minimax"),
                        voice,
                        str(payload.get("apiKey") or ""),
                        str(payload.get("model") or "speech-02-hd"),
                        str(payload.get("voiceId") or "male-qn-qingse"),
                        str(payload.get("baseUrl") or "https://api.minimaxi.com"),
                        str(payload.get("emotion") or ""),
                    ))
                file_path = str(payload.get("path") or "")
                if not chat or not file_path:
                    return self._json(400, {"ok": False, "error": "chat and path are required"})
                result = store.send_media(chat, file_path, as_image=(path == "/send-image"))
                return self._json(200, result)
            except Exception as exc:
                traceback.print_exc()
                return self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8823)
    ap.add_argument("--account", default=None,
                    help="账号目录名（如 wxid_xxx_4258）；留空自动挑最近活跃的")
    ap.add_argument("--token", default="", help="访问令牌；绑定非回环地址时必填")
    ap.add_argument("--allow-send", action="store_true", help="启用 POST /send（会驱动微信）")
    ap.add_argument("--send-mode", choices=["bg", "uia"], default="bg",
                    help="bg=后台消息（不抢焦点，默认）；uia=UIA 点击（会抬窗）")
    ap.add_argument("--char-mode", choices=["utf16", "gbk"], default="utf16",
                    help="后台发送的 WM_CHAR 语义；本机 4.1.15.56 实测 utf16")
    args = ap.parse_args()

    store = WechatStore(args.account, args.send_mode, args.char_mode)
    if args.host not in ("127.0.0.1", "::1", "localhost") and not args.token:
        print("拒绝启动：绑定非回环地址必须提供 --token", file=sys.stderr)
        return 2
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.allow_send, args.token))
    print(f"[wechat-adapter] {args.host}:{args.port} account={args.account or '(auto)'} "
          f"mode={'读写' if args.allow_send else '只读'} send={args.send_mode}/{args.char_mode}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
