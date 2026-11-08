// 把 preset/wechat-chat 装进 DSH 的 desktop profile（DSH 0.1.7+ 的 preset 机制）。
//
// 机制（照 SurfCore 的 build-agent-preset-patches.mjs）：preset 不是目录，而是一条
// loader 行 `@deepseek-ai/dsh-agent-preset`，config.plugins 是**内联的行列表**，
// 只能通过 profile 的 patch 层插入。
//
//   node install-preset.mjs            # 安装（幂等）
//   node install-preset.mjs --dry-run  # 只打印将要写入的 YAML
//   node install-preset.mjs --remove   # 移除
//
// 会先备份 cordis.patch.yml 到同目录 .bak-<时间戳>。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(HERE, 'preset', 'wechat-chat');
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const ROW_ID = 'preset-wechat-chat';
const PRESET_ID = 'wechat-chat';

const dryRun = process.argv.includes('--dry-run');
const remove = process.argv.includes('--remove');

const meta = yaml.load(fs.readFileSync(path.join(PRESET_DIR, 'preset.yml'), 'utf8'));
const plugins = yaml.load(fs.readFileSync(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8'));

for (const field of ['name', 'description', 'order']) {
  if (meta?.[field] === undefined) throw new Error(`preset.yml 缺少 ${field}`);
}
if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('agent.cordis.yml 必须是非空的插件行列表');

const row = {
  insert: [
    {
      id: ROW_ID,
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: PRESET_ID,
        name: meta.name,
        description: meta.description,
        order: meta.order,
        plugins,
      },
    },
  ],
};

const text = fs.readFileSync(PATCH_FILE, 'utf8');
const doc = yaml.load(text);
if (!Array.isArray(doc)) throw new Error(`${PATCH_FILE} 顶层不是数组，拒绝改写`);

const without = doc.filter((entry) => !(entry && typeof entry === 'object' && Array.isArray(entry.insert)
  && entry.insert.some((r) => r?.id === ROW_ID)));

if (remove) {
  if (without.length === doc.length) {
    console.log(`[preset] ${ROW_ID} 不存在，无需移除`);
    process.exit(0);
  }
  fs.writeFileSync(PATCH_FILE, yaml.dump(without, { lineWidth: -1, noRefs: true }), 'utf8');
  console.log(`[preset] 已移除 ${ROW_ID}（${doc.length} -> ${without.length} 条）`);
  process.exit(0);
}

const next = [...without, row];
const out = yaml.dump(next, { lineWidth: -1, noRefs: true });

if (dryRun) {
  console.log('--- 将写入的 patch 条目 ---');
  console.log(yaml.dump([row], { lineWidth: -1, noRefs: true }));
  process.exit(0);
}

const backup = `${PATCH_FILE}.bak-${Date.now()}`;
fs.copyFileSync(PATCH_FILE, backup);
fs.writeFileSync(PATCH_FILE, out, 'utf8');
console.log(`[preset] 已写入 ${PATCH_FILE}（备份 ${path.basename(backup)}，${doc.length} -> ${next.length} 条）`);
console.log('[preset] 重启 DSH 后生效；可先跑 node probe.mjs 看 presets 列表');
