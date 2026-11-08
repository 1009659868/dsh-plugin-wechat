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

    const MM_VOICES = [
      ['male-qn-qingse', '青涩青年'], ['female-shaonv', '少女'], ['female-yujie', '御姐'],
      ['female-chengshu', '成熟女性'], ['female-tianmei', '甜美少女'], ['male-qn-jingying', '精英青年'],
      ['male-badao', '霸道总裁'], ['presenter_male', '男主持人'], ['presenter_female', '女主持人'],
      ['audiobook_male_1', '有声书男声'], ['audiobook_female_1', '有声书女声'],
    ];
    const MM_MODELS = [
      ['speech-2.8-turbo', 'Speech 2.8 Turbo（默认）'], ['speech-02-hd', 'Speech 02 HD'],
      ['speech-02-turbo', 'Speech 02 Turbo'],
    ];
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
      const [memChats, setMemChats] = useState([]);
      const [mode, setMode] = useState('local');
      const [vm, setVm] = useState(null);
      const [stopVmOnSwitch, setStopVmOnSwitch] = useState(false);
      const [voiceCfg, setVoiceCfg] = useState({ enabled: true, provider: 'minimax', voice: 'zh-CN-XiaoyiNeural', apiKey: '', model: 'speech-2.8-turbo', voiceId: 'male-qn-qingse' });
      const [voiceOptions, setVoiceOptions] = useState(null);

      const load = async () => {
        try {
          const r = await fetch(`${API}/status`).then((x) => x.json());
          setSt(r);
          setDir(r?.dir ?? '');
          setGroups((r?.config?.allow?.groups ?? []).join(', '));
          setPriv((r?.config?.allow?.private ?? []).join(', '));
          setAliases((r?.config?.botAliases ?? []).join(', '));
          setVoiceCfg({
            enabled: r?.config?.voice?.enabled !== false,
            transport: r?.config?.voice?.transport ?? 'bubble',
            voice: r?.config?.voice?.voice ?? 'zh-CN-XiaoyiNeural',
          });
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
          const m = await fetch(`${API}/memory`).then((x) => x.json());
          setMemChats(m?.chats ?? []);
        } catch { /* 忽略 */ }
        try {
          const v = await fetch(`${API}/vm/status`).then((x) => x.json());
          setVm(v);
          setMode(v?.mode === 'vm' ? 'vm' : 'local');
          setStopVmOnSwitch(v?.stopOnSwitchBack === true);
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

      const deleteMem = async (chat, text) => {
        try {
          const r = await post('memory/delete', { chat, text });
          if (!r?.ok) throw new Error(r?.error ?? '删除失败');
          setMemChats(r.chats ?? []);
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      const switchMode = async (value) => {
        setMode(value);
        try {
          const r = await post('config', { mode: value });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
          setErr(value === 'vm'
            ? '已切到虚拟机模式：先在 VM 里装好微信和适配层，再点「一键启动」'
            : '已切回本机模式');
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      const toggleStopVm = async (value) => {
        setStopVmOnSwitch(value);
        try {
          const r = await post('config', { vmStopOnSwitchBack: value });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      const vmStart = async () => {
        setBusy('vm');
        setErr('');
        try {
          const r = await post('vm/start');
          if (!r?.ok) throw new Error(r?.hint || r?.error || '启动失败');
          setErr(`虚拟机已就绪：${r.baseUrl}（桥接已指向它）`);
          await load();
        } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const vmStop = async () => {
        setBusy('vm');
        try { await post('vm/stop', {}); await load(); } catch (e) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
      };

      const saveVoice = async (patch) => {
        const next = { ...voiceCfg, ...patch };
        setVoiceCfg(next);
        try {
          const r = await post('config', { voice: next });
          if (!r?.ok) throw new Error(r?.error ?? '保存失败');
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
          h('h4', null, '运行位置'),
          h('select', { className: 'wx-input', value: mode, onChange: (e) => switchMode(e.target.value) },
            h('option', { value: 'local' }, '本机（微信装在这台电脑上）'),
            h('option', { value: 'vm' }, '虚拟机（微信在 Hyper-V 里）')),
          h('p', null, '本机：文本不抢焦点；发图片/表情包会短暂抢占前台（剪贴板粘贴）。'),
          h('p', null, '虚拟机：主机完全不抢焦点，但需要先在 VM 里备好微信和适配层。'),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 6 } },
            h('input', { type: 'checkbox', checked: stopVmOnSwitch, onChange: (e) => toggleStopVm(e.target.checked) }),
            '切回本机模式时顺便停掉虚拟机（默认关）')),

        mode === 'vm' ? h('div', { className: 'wx-card' },
          h('h4', null, '虚拟机'),
          h('p', null, vm?.ok
            ? `状态：${vm.status?.state ?? '未知'}　IP：${vm.status?.ip || '未分配'}`
            : `不可用：${vm?.hint || vm?.error || '未知错误'}`),
          h('div', { className: 'wx-row' },
            h('button', { className: 'wx-btn', onClick: vmStart, disabled: busy === 'vm' }, '启动虚拟机'),
            h('button', { className: 'wx-btn2', onClick: vmStop, disabled: busy === 'vm' }, '停止'))) : null,

        h('div', { className: 'wx-card' },
          h('h4', null, '语音'),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
            h('input', { type: 'checkbox', checked: voiceCfg.enabled, onChange: (e) => saveVoice({ enabled: e.target.checked }) }),
            '启用语音（对方明确要语音时回一条）'),
          h('p', null, '需要：微信录音快捷键 = Ctrl+Tab、微信麦克风 = CABLE Output、系统输出 = CABLE Input。发送时会短暂抢占前台。'),
          
          h('select', { className: 'wx-input', value: voiceCfg.provider, onChange: (e) => saveVoice({ provider: e.target.value }) },
            h('option', { value: 'minimax' }, 'MiniMax（默认，需 API Key）'),
            h('option', { value: 'edge' }, 'Edge TTS（免费，无需 Key）')),
          h('input', { className: 'wx-input', value: voiceCfg.apiKey, placeholder: 'MiniMax API Key', onChange: (e) => saveVoice({ apiKey: e.target.value }) }),
          h('select', { className: 'wx-input', value: voiceCfg.model, onChange: (e) => saveVoice({ model: e.target.value }) },
            MM_MODELS.map(([id, label]) => h('option', { key: id, value: id }, label))),
          h('select', {
            className: 'wx-input',
            value: MM_VOICES.some(([id]) => id === voiceCfg.voiceId) ? voiceCfg.voiceId : '__custom',
            onChange: (e) => saveVoice({ voiceId: e.target.value === '__custom' ? '' : e.target.value }),
          },
            MM_VOICES.map(([id, label]) => h('option', { key: id, value: id }, label)),
            h('option', { value: '__custom' }, '自定义 / 我克隆的音色…')),
          h('input', { className: 'wx-input', value: voiceCfg.voiceId, placeholder: 'voice_id（填你克隆的音色 ID）', onChange: (e) => saveVoice({ voiceId: e.target.value }) }),
          h('select', { className: 'wx-input', value: voiceCfg.voice, onChange: (e) => saveVoice({ voice: e.target.value }) },
            h('option', { value: 'zh-CN-XiaoyiNeural' }, 'Xiaoyi · 活泼'),
            h('option', { value: 'zh-CN-XiaoxiaoNeural' }, 'Xiaoxiao · 温柔'),
            h('option', { value: 'zh-CN-liaoning-XiaobeiNeural' }, 'Xiaobei · 东北话'))),

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
