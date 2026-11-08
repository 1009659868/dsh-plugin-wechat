// dsh-plugin-wechat —— 客户端半：设置里的「微信」一节。
//
// 与 SurfCore 解耦：自己的设置节、自己的 /dsh-wechat/api/*，不依赖 QQ/B站 任何状态。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-wechat',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { useState, useEffect } = React;
    const h = React.createElement;

    const NS = 'wechat-panel';
    const API = '/dsh-wechat/api';

    const CSS = `
      .wx-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 13px;background:rgba(127,127,127,.03);margin-bottom:10px}
      .wx-card h4{margin:0 0 6px;font-size:13px;font-weight:600}
      .wx-card p{margin:0;color:var(--dsw-alias-text-tertiary);font-size:11.5px;line-height:17px}
      .wx-input{box-sizing:border-box;width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font-size:12.5px;margin:4px 0 6px}
      .wx-btn{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;border:none;border-radius:6px;font-size:12.5px;padding:6px 12px;cursor:pointer}
      .wx-btn:disabled{opacity:.6;cursor:not-allowed}
      .wx-btn2{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12.5px;padding:6px 12px;cursor:pointer}
      .wx-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
      .wx-err{color:#e5484d;font-size:12px}
    `;

    let styled = false;
    function useStyleOnce() {
      if (styled) return;
      styled = true;
      try {
        const el = document.createElement('style');
        el.id = 'dsh-plugin-wechat.css';
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch { /* 忽略 */ }
    }

    const splitCsv = (text) => String(text ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);

    function WechatSection() {
      useStyleOnce();
      const [st, setSt] = useState(null);
      const [accounts, setAccounts] = useState([]);
      const [acct, setAcct] = useState('');
      const [groups, setGroups] = useState('');
      const [priv, setPriv] = useState('');
      const [aliases, setAliases] = useState('');
      const [dir, setDir] = useState('');
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState('');
      const [persona, setPersona] = useState('');
      const [personaSaved, setPersonaSaved] = useState('');
      const [personaFile, setPersonaFile] = useState('');
      const [memChats, setMemChats] = useState([]);

      const load = async () => {
        try {
          const r = await fetch(`${API}/status`).then((x) => x.json());
          setSt(r);
          setDir(r?.dir ?? '');
          setGroups((r?.config?.allow?.groups ?? []).join(', '));
          setPriv((r?.config?.allow?.private ?? []).join(', '));
          setAliases((r?.config?.botAliases ?? []).join(', '));
          setErr(r?.ok ? '' : (r?.error ?? ''));
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
        try {
          const a = await fetch(`${API}/accounts`).then((x) => x.json());
          setAccounts(a?.accounts ?? []);
          setAcct(a?.current ?? '');
        } catch { /* 适配层没跑就空着 */ }
        try {
          const p = await fetch(`${API}/persona`).then((x) => x.json());
          setPersona(p?.text ?? '');
          setPersonaSaved(p?.text ?? '');
          setPersonaFile(p?.file ?? '');
        } catch { /* 忽略 */ }
        try {
          const m = await fetch(`${API}/memory`).then((x) => x.json());
          setMemChats(m?.chats ?? []);
        } catch { /* 忽略 */ }
      };

      useEffect(() => { void load(); }, []);

      const post = async (p, body) => {
        const r = await fetch(`${API}/${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        return r.json();
      };

      const startAll = async () => {
        setBusy('start');
        setErr('');
        try {
          // 先把当前输入框里的桥接目录落盘，避免「改了没保存就点启动」
          await post('config', { bridgeDir: dir });
          const r = await post('start');
          if (!r?.ok) throw new Error(r?.error ?? '启动失败');
          setErr(r.started?.length ? `已启动：${r.started.join('、')}` : '已经在运行了');
          await new Promise((res) => setTimeout(res, 2500));
          await load();
        } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const stopAll = async () => {
        setBusy('stop');
        setErr('');
        try {
          const r = await post('stop');
          if (!r?.ok) throw new Error(r?.error ?? '停止失败');
          setErr(r.killed?.length ? `已停止：${r.killed.join('、')}` : '本来就没在跑');
          await new Promise((res) => setTimeout(res, 1200));
          await load();
        } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const save = async () => {
        setBusy('save');
        setErr('');
        try {
          const r = await post('config', {
            allow: { groups: splitCsv(groups), private: splitCsv(priv) },
            botAliases: splitCsv(aliases),
            bridgeDir: dir,
          });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
          setErr('已保存（白名单下一轮生效）');
          await load();
        } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const savePersona = async () => {
        setBusy('persona');
        setErr('');
        try {
          const r = await post('persona', { text: persona });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
          setPersonaSaved(persona);
          setErr(`人格已保存（${r.chars ?? persona.length} 字，下一轮生效）`);
        } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const deleteMem = async (chat, text) => {
        try {
          const r = await post('memory/delete', { chat, text });
          if (!r?.ok) throw new Error(r?.error ?? '删除失败');
          setMemChats(r.chats ?? []);
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      const pickAccount = async (value) => {
        setAcct(value);
        try {
          const r = await post('config', { adapterAccount: value });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
          setErr(`已选定 ${value}（停止后重新一键启动生效）`);
          await load();
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      const adapter = st?.adapter ?? null;
      const statusText = adapter?.ok
        ? `已连接：${adapter.nick ?? ''}（${adapter.account ?? ''}）· 发送 ${adapter.send_mode ?? '-'} / ${adapter.char_mode ?? '-'}`
        : '未连接（适配层没在跑）';

      return h('div', null,
        h('div', { className: 'wx-card' },
          h('h4', null, '微信桥接'),
          h('p', null, statusText),
          h('p', null, `桥接进程：${st?.runtime?.bridgeAlive ? `运行中（pid ${st.runtime.bridgePid}）` : '未运行'}　适配层：${st?.runtime?.adapterAlive ? `运行中（pid ${st.runtime.adapterPid}）` : '未运行'}`),
          h('div', { className: 'wx-row' },
            h('button', { className: 'wx-btn', onClick: startAll, disabled: busy === 'start' }, '一键启动'),
            h('button', { className: 'wx-btn2', onClick: stopAll, disabled: busy === 'stop' }, '停止'),
            h('button', { className: 'wx-btn2', onClick: load }, '刷新状态'))),

        h('div', { className: 'wx-card' },
          h('h4', null, '桥接目录'),
          h('p', null, '指向仓库里的 work/wechat-bridge（含 bridge.mjs 与 config.json）。'),
          h('input', { className: 'wx-input', value: dir, onChange: (e) => setDir(e.target.value) })),

        h('div', { className: 'wx-card' },
          h('h4', null, '微信号（谁在当鲸鲸）'),
          h('p', null, '本机已登录的号会标「当前登录」；换号后先停止再启动。'),
          h('select', { className: 'wx-input', value: acct, onChange: (e) => pickAccount(e.target.value) },
            acct ? null : h('option', { value: '' }, '（未选择：适配层会自己挑最近活跃的号）'),
            accounts.map((a) => h('option', { key: a.account, value: a.account },
              `${a.nick || a.wxid || a.account}${a.online ? ' · 当前登录' : ''}（${a.wxid || a.account}）`)))),

        h('div', { className: 'wx-card' },
          h('h4', null, '群白名单'),
          h('input', { className: 'wx-input', value: groups, placeholder: '群名或 chatroom id（逗号分隔）', onChange: (e) => setGroups(e.target.value) }),
          h('h4', null, '私聊白名单'),
          h('input', { className: 'wx-input', value: priv, placeholder: '昵称或 wxid（逗号分隔）', onChange: (e) => setPriv(e.target.value) }),
          h('h4', null, '@ 别名（群里被叫到的名字）'),
          h('input', { className: 'wx-input', value: aliases, placeholder: '用逗号分隔；留空则只认 @' , onChange: (e) => setAliases(e.target.value) }),
          h('p', null, '空 = 谁都不回。群里只回应 @别名 或正文出现别名的消息。'),
          h('div', { className: 'wx-row' }, h('button', { className: 'wx-btn', onClick: save, disabled: busy === 'save' }, '保存'))),

        h('div', { className: 'wx-card' },
          h('h4', null, '人格'),
          h('p', null, personaFile ? `文件：${personaFile}` : '保存后会写入 <桥接目录>/persona.md'),
          h('textarea', {
            className: 'wx-input',
            style: { minHeight: 120, resize: 'vertical', fontFamily: 'inherit' },
            value: persona,
            placeholder: '你是「鲸鲸」，一个住在微信里的鲸鱼娘……',
            onChange: (e) => setPersona(e.target.value),
          }),
          h('div', { className: 'wx-row' },
            h('button', { className: 'wx-btn', onClick: savePersona, disabled: busy === 'persona' }, '保存人格'),
            persona !== personaSaved ? h('span', { className: 'wx-err' }, '未保存') : null)),

        h('div', { className: 'wx-card' },
          h('h4', null, '记忆'),
          h('p', null, memChats.length
            ? '按衰减后的权重排序（14 天半衰期）；「删」只删这一条。'
            : '还没有记忆：对话里出现值得长期记住的事、且模型写了 [记忆] 行才入库。'),
          memChats.slice(0, 6).map((c) => h('div', { key: c.key, style: { marginTop: 8 } },
            h('h4', null, `${c.key}（${c.count} 条）`),
            c.items.slice(0, 8).map((it) => h('div', {
              key: it.text,
              style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, margin: '2px 0' },
            },
              h('span', { style: { flex: 1 } }, it.text),
              h('span', { style: { color: 'var(--dsw-alias-text-tertiary)' } }, `${it.days} 天前`),
              h('button', { className: 'wx-btn2', onClick: () => deleteMem(c.key, it.text) }, '删')))))),

        err ? h('p', { className: 'wx-err' }, err) : null);
    }

    const inject = ['slots'];
    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: NS, order: 8, label: () => 'Wechat 鲸鲸' },
          WechatSection,
        ), 'dsh-plugin-wechat: settings section'),
        'dsh-plugin-wechat: settings section',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.WechatSection = WechatSection;
    return module.exports;
  },
});
