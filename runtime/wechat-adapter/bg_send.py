"""后台发送 + 后台切会话（M4/M5）：不抢前台的收发通道。

原理（与鲸鲸 bg_sender 同一套公开的 Win32 机制，代码独立实现）：
    · 定位：UIA 只用来**读**控件矩形/会话列表，不做任何 UIA 动作；
    · 点击：PostMessage 鼠标消息（WM_MOUSEMOVE → LBUTTONDOWN → LBUTTONUP），被遮挡也有效；
    · 写字：PostMessage WM_SETFOCUS + 逐字 WM_CHAR（本机实测 UTF-16 码元语义）；
    · 切会话：点会话列表行 + 滚轮（同样走 PostMessage）。
    · 全程不调 SetForegroundWindow / SetFocus / SendInput / mouse_event。

三条实机踩出来的纪律：
    1. 不能用 UIA 的 Invoke/SelectionItem 切会话 —— 会激活窗口，而且本机这版微信切不过去；
    2. WeChatUIA.ensure_window() 会 _activate() 抢前台，必须绕开，只用 _find_main()；
    3. 点完会话行微信会重建控件树（输入框短暂消失），必须重新绑定再读 current_chat()。

用法：
    python bg_send.py --hwnd 8130394 --switch-to "文浩"
    python bg_send.py --hwnd 8130394 --chat "文浩" --text "你好"
    python bg_send.py --hwnd 8130394 --text "探针" --dry-type
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.windll.user32
user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.PostMessageW.restype = wt.BOOL
user32.GetForegroundWindow.restype = wt.HWND
user32.ScreenToClient.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]

WM_SETFOCUS = 0x0007
WM_KILLFOCUS = 0x0008
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_MOUSEWHEEL = 0x020A
VK_BACK = 0x08

ERROR_ACCESS_DENIED = 5
SESSION_LIST_AID = "session_list"
SESSION_ITEM_PREFIX = "session_item_"


class UipiDenied(RuntimeError):
    """PostMessage 被 UIPI 拒绝（微信权限比本进程高）。"""


def foreground() -> int:
    return int(user32.GetForegroundWindow() or 0)


def _lparam(x: int, y: int) -> int:
    return ((y & 0xFFFF) << 16) | (x & 0xFFFF)


def encode_gbk(text: str) -> list[int]:
    """GBK 字节序列（4.1 及以前的 WM_CHAR 语义）。"""
    return list(text.encode("gbk", "replace"))


def encode_utf16(text: str) -> list[int]:
    """UTF-16LE 码元序列（4.2+ / 本机 4.1.15.56 实测的语义）。"""
    data = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data), 2)]


class BgSender:
    def __init__(self, hwnd: int):
        from wechatauto.uia_driver import WeChatUIA

        self.hwnd = int(hwnd)
        self.uia = WeChatUIA(hwnd=self.hwnd)
        win = self.uia._find_main()
        if win is None:
            self.uia.ensure_materialized()
            win = self.uia._find_main()
        if win is None:
            raise RuntimeError("UIA 窗口绑定失败（微信窗口不在/树没物化）")
        self.uia._win = win

    # ---------------- 基础 ----------------
    def _post(self, msg: int, wparam: int, lparam: int) -> None:
        if not user32.PostMessageW(self.hwnd, msg, wparam, lparam):
            err = ctypes.get_last_error()
            if err == ERROR_ACCESS_DENIED:
                raise UipiDenied("PostMessage 被拒绝：微信的完整性级别高于本进程")
            raise ctypes.WinError(err)

    def _to_client(self, sx: int, sy: int) -> tuple[int, int]:
        pt = wt.POINT(int(sx), int(sy))
        if not user32.ScreenToClient(self.hwnd, ctypes.byref(pt)):
            raise ctypes.WinError(ctypes.get_last_error())
        return pt.x, pt.y

    def click_screen(self, sx: int, sy: int, settle: float = 0.12) -> None:
        cx, cy = self._to_client(sx, sy)
        lp = _lparam(cx, cy)
        self._post(WM_MOUSEMOVE, 0, lp)
        time.sleep(0.02)
        self._post(WM_LBUTTONDOWN, 1, lp)
        time.sleep(settle)
        self._post(WM_LBUTTONUP, 0, lp)

    def wheel(self, sx: int, sy: int, delta: int = -360, times: int = 1) -> None:
        """滚轮：lParam 用屏幕坐标，wParam 高字是 delta。"""
        lp = _lparam(sx, sy)
        wp = (delta & 0xFFFF) << 16
        for _ in range(times):
            self._post(WM_MOUSEWHEEL, wp, lp)
            time.sleep(0.12)

    def _refresh(self) -> None:
        """点完会话行后微信会重建控件树，重新绑定一次。"""
        win = self.uia._find_main()
        if win is not None:
            self.uia._win = win
            return
        try:
            self.uia.ensure_materialized()
        except Exception:
            pass
        win = self.uia._find_main()
        if win is not None:
            self.uia._win = win

    def _node_count(self, limit: int = 40) -> int:
        n = 0
        stack = [self.uia._win]
        while stack and n < limit:
            el = stack.pop()
            n += 1
            try:
                stack.extend(el.GetChildren())
            except Exception:
                pass
        return n

    def _ensure_tree(self) -> bool:
        """控件树塌成 Qt 空壳时（只剩主窗、会话列表消失）重新热激活。

        微信在部分操作后会把 accessibility gate 复位，表现就是
        「窗口在、但 session_list / chat_input_field 全没了」，此时所有定位都会失败。
        """
        if self._node_count() >= 20:
            return True
        try:
            self.uia.ensure_materialized(force=True)
        except Exception:
            pass
        self._refresh()
        return self._node_count() >= 20

    # ---------------- 元素 ----------------
    def current_chat(self):
        try:
            return self.uia.current_chat()
        except Exception:
            return None

    def input_ctrl(self):
        try:
            return self.uia._chat_input()
        except Exception:
            return None

    def send_button_ctrl(self):
        from wechatauto.uia_driver import _find_by

        return _find_by(self.uia._win, lambda c: (c.Name or "").strip() == "发送", max_depth=30)

    def read_composer(self):
        ctrl = self.input_ctrl()
        if ctrl is None:
            return None
        try:
            return self.uia._read_edit_value(ctrl)
        except Exception:
            return None

    # ---------------- 会话切换 ----------------
    def _session_list(self):
        from wechatauto.uia_driver import _find_by

        return _find_by(self.uia._win,
                        lambda c: (c.AutomationId or "") == SESSION_LIST_AID,
                        max_depth=24)

    def session_items(self) -> list:
        lst = self._session_list()
        if lst is None:
            # 会话列表单独缺失（常见于微信刚重启、树只物化了一半）：强制重物化一次再找
            try:
                self.uia.ensure_materialized(force=True)
            except Exception:
                pass
            self._refresh()
            lst = self._session_list()
        if lst is None:
            return []
        out = []
        try:
            for ch in lst.GetChildren():
                if (ch.AutomationId or "").startswith(SESSION_ITEM_PREFIX):
                    out.append(ch)
        except Exception:
            pass
        return out

    def open_chat(self, name: str, max_scroll: int = 6) -> dict:
        self._ensure_size()
        self._ensure_tree()
        target = (name or "").strip()
        if not target:
            return {"ok": False, "stage": "empty-name"}
        tries = 0
        for direction in ("down", "up"):
            for _ in range(max_scroll + 1):
                tries += 1
                for it in self.session_items():
                    aid = it.AutomationId or ""
                    label = aid[len(SESSION_ITEM_PREFIX):] if aid.startswith(SESSION_ITEM_PREFIX) else ""
                    shown = (it.Name or "").split("\n")[0]
                    if target not in (label, shown):
                        continue
                    r = it.BoundingRectangle
                    self.click_screen((r.left + r.right) // 2, (r.top + r.bottom) // 2)
                    deadline = time.time() + 3.0
                    cur = None
                    while time.time() < deadline:
                        time.sleep(0.25)
                        self._refresh()
                        cur = self.current_chat()
                        if cur == target:
                            return {"ok": True, "stage": "post-click",
                                    "current": cur, "tries": tries}
                    return {"ok": False, "stage": "switch-timeout",
                            "current": cur, "want": target, "tries": tries}
                lst = self._session_list()
                if lst is None:
                    return {"ok": False, "stage": "no-session-list", "tries": tries}
                r = lst.BoundingRectangle
                self.wheel((r.left + r.right) // 2, (r.top + r.bottom) // 2,
                           delta=-360 if direction == "down" else 360, times=2)
                time.sleep(0.25)
        return {"ok": False, "stage": "not-found", "tries": tries}

    # ---------------- 打字 ----------------
    def type_units(self, units: list[int], gap: float = 0.012) -> None:
        self._post(WM_SETFOCUS, 0, 0)
        time.sleep(0.08)
        for u in units:
            self._post(WM_CHAR, u, 1)
            time.sleep(gap)

    def end_input(self) -> None:
        try:
            self._post(WM_KILLFOCUS, 0, 0)
        except Exception:
            pass

    def clear_composer(self, n: int = 200) -> bool:
        """清空输入框。WM_CHAR 8 本机不认，必须发 WM_KEYDOWN/WM_KEYUP 的 VK_BACK。"""
        if not (self.read_composer() or ""):
            return True
        self._post(WM_SETFOCUS, 0, 0)
        time.sleep(0.05)
        for _ in range(n):
            self._post(WM_KEYDOWN, VK_BACK, 0x000E0001)
            self._post(WM_KEYUP, VK_BACK, 0xC00E0001)
            time.sleep(0.004)
        self.end_input()
        time.sleep(0.1)
        return not (self.read_composer() or "")

    # ---------------- 主流程 ----------------
    def _ensure_size(self, min_w: int = 900, min_h: int = 700) -> bool:
        """把窗口拉到够宽的布局。

        微信 4.x 窗口一窄就切紧凑布局：会话列表从 UIA 树里消失（只剩聊天区），
        于是「切会话」永远失败——实测 440×452 就是这种状态。
        SWP_NOACTIVATE 保证不抢前台。
        """
        rect = wt.RECT()
        if not user32.GetWindowRect(self.hwnd, ctypes.byref(rect)):
            return False
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w >= min_w and h >= min_h:
            return True
        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010
        user32.SetWindowPos(self.hwnd, 0, rect.left, rect.top,
                            max(w, min_w), max(h, min_h),
                            SWP_NOZORDER | SWP_NOACTIVATE)
        time.sleep(0.4)
        return True

    def send(self, text: str, mode: str = "utf16", confirm_chat=None, dry_type: bool = False) -> dict:
        self._ensure_size()
        self._ensure_tree()
        chat = self.current_chat()
        if confirm_chat and chat != confirm_chat:
            switched = self.open_chat(confirm_chat)
            if not switched.get("ok"):
                return {"ok": False, "stage": "switch-failed", "switch": switched,
                        "current": self.current_chat(), "want": confirm_chat}
            chat = self.current_chat()

        # 输入框不认代理对（emoji 🐳 会被吞掉，导致内容比对失败）：先剔除，再打
        stripped = 0
        if any(ord(ch) > 0xFFFF for ch in text):
            kept = "".join(ch for ch in text if ord(ch) <= 0xFFFF)
            stripped = len(text) - len(kept)
            text = kept.rstrip()
            if not text:
                return {"ok": False, "stage": "emoji-only", "stripped": stripped}

        leftover = self.read_composer()
        if (leftover or "").strip():
            if not self.clear_composer(len(leftover) + 8):
                return {"ok": False, "stage": "composer-not-clearable", "composer": leftover}

        ctrl = self.input_ctrl()
        if ctrl is None:
            self._ensure_tree()
            ctrl = self.input_ctrl()
        if ctrl is None:
            return {"ok": False, "stage": "no-input"}
        r = ctrl.BoundingRectangle
        self.click_screen((r.left + r.right) // 2, (r.top + r.bottom) // 2)
        time.sleep(0.15)

        units = encode_utf16(text) if mode == "utf16" else encode_gbk(text)
        self.type_units(units)
        time.sleep(0.15)
        got = self.read_composer()
        self.end_input()

        result = {"mode": mode, "typed": text, "composer": got, "chat": chat, "stripped": stripped}
        if got is None:
            result.update(ok=False, stage="cannot-read-composer")
            return result
        if (got or "").strip() != text.strip():
            result.update(ok=False, stage="composer-mismatch")
            return result
        if dry_type:
            cleared = self.clear_composer(len(text) + 5)
            result.update(ok=True, stage="dry-type", cleared=cleared,
                          composer_after_clear=self.read_composer())
            return result

        btn = self.send_button_ctrl()
        if btn is None:
            result.update(ok=False, stage="no-send-button")
            return result
        br = btn.BoundingRectangle
        self.click_screen((br.left + br.right) // 2, (br.top + br.bottom) // 2, settle=0.05)
        time.sleep(0.35)
        left = self.read_composer()
        result.update(ok=(left or "").strip() == "", stage="sent", composer_after=left)
        return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hwnd", type=int, required=True)
    ap.add_argument("--text", default=None)
    ap.add_argument("--chat", default=None, help="目标会话（会先后台切过去）")
    ap.add_argument("--switch-to", default=None, help="只切会话，不发消息")
    ap.add_argument("--mode", choices=["gbk", "utf16"], default="utf16")
    ap.add_argument("--dry-type", action="store_true")
    args = ap.parse_args()

    fg0 = foreground()
    t0 = time.time()
    s = BgSender(args.hwnd)
    print(f"[ok] bound hwnd={s.hwnd} chat={s.current_chat()!r} ({time.time() - t0:.1f}s)")

    if args.switch_to:
        res = s.open_chat(args.switch_to)
    else:
        if not args.text:
            ap.error("--text 或 --switch-to 至少给一个")
        res = s.send(args.text, mode=args.mode, confirm_chat=args.chat, dry_type=args.dry_type)
    fg1 = foreground()
    print(f"[..] result: {res}")
    print(f"[..] foreground: {fg0} -> {fg1}   changed={fg0 != fg1}   took={time.time() - t0:.1f}s")
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
