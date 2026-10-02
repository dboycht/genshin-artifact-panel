/**
 * verify-gamedata.mjs —— 静态数值表自检
 *
 * 判据（读不到就报"失明"，不报"没问题"）：
 *   1) 六个数据文件都存在且可解析
 *   2) 角色/武器/套装数量与已知规模一致
 *   3) 每条记录都带 goodKey（GOOD 导入导出要用）
 *   4) 曲线完整性：角色与武器用到的曲线名都能在 curves.json 里查到
 *   5) 抽样人工核对（绫华 90 级基础属性、赦罪 90 级基础攻击）
 *   6) 技能映射覆盖情况
 *
 * 用法：node tools/verify-gamedata.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..', 'public', 'gamedata');

let fail = 0, warn = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) fail++; };
const warnIf = (cond, msg) => { if (!cond) { console.log('  ⚠️  ' + msg); warn++; } };

function readJson(name) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.log('  ❌ ' + name + ' 解析失败：' + e.message); fail++; return null; }
}

console.log('=== 1. 文件存在性 ===');
const chars = readJson('characters.json');
const cstats = readJson('character-stats.json');
const weapons = readJson('weapons.json');
const wstats = readJson('weapon-stats.json');
const sets = readJson('artifact-sets.json');
const curves = readJson('curves.json');
const skills = readJson('avatar-skills.json');
ok(!!chars && !!cstats && !!weapons && !!wstats && !!sets && !!curves,
  '六个核心数据文件齐全');
if (!chars || !cstats || !weapons || !wstats || !sets || !curves) {
  console.log('\n缺文件，后续检查跳过。');
  process.exit(1);
}

console.log('=== 2. 规模 ===');
ok(chars.length >= 100, '角色 ' + chars.length + ' 个（≥100）');
ok(weapons.length >= 200, '武器 ' + weapons.length + ' 个（≥200）');
ok(sets.length >= 50, '套装 ' + sets.length + ' 套（≥50）');

console.log('=== 3. goodKey 完整性 ===');
for (const [label, arr] of [['角色', chars], ['武器', weapons], ['套装', sets]]) {
  const miss = arr.filter(x => !x.goodKey || !x.nameEn);
  ok(miss.length === 0, label + ' goodKey 缺失 ' + miss.length + ' 个'
    + (miss.length ? '：' + miss.slice(0, 8).map(x => x.name).join('、') : ''));
}
// 归一化后必须唯一，否则导入时无法定位
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
for (const [label, arr] of [['套装', sets], ['武器', weapons], ['角色', chars]]) {
  const seen = new Map(), dup = [];
  for (const x of arr) {
    const k = norm(x.goodKey);
    if (seen.has(k)) dup.push(x.name + ' ↔ ' + seen.get(k));
    else seen.set(k, x.name);
  }
  warnIf(dup.length === 0, label + ' goodKey 归一化后有 ' + dup.length + ' 组重名（导入需人工消歧）：'
    + dup.slice(0, 5).join('；'));
}

console.log('=== 4. 曲线完整性 ===');
const usedChar = new Set(Object.values(cstats).flatMap(s => Object.values(s.curve)));
const haveChar = new Set(Object.values(curves.characters).flatMap(o => Object.keys(o)));
const missC = [...usedChar].filter(c => !haveChar.has(c));
ok(missC.length === 0, '角色曲线 用到 ' + usedChar.size + ' 种，缺失 ' + missC.length);

const usedW = new Set(Object.values(wstats).flatMap(s => Object.values(s.curve).filter(Boolean)));
const haveW = new Set(Object.values(curves.weapons).flatMap(o => Object.keys(o)));
const missW = [...usedW].filter(c => !haveW.has(c));
ok(missW.length === 0, '武器曲线 用到 ' + usedW.size + ' 种，缺失 ' + missW.length);

console.log('=== 5. 抽样核对（人工可复核的已知值）===');
const DUMP = (() => {
  const j = JSON.parse(fs.readFileSync(
    path.resolve('D:/code/DeepSeekHarness/_scratch/genshin-research/dataprobe/node_modules/genshin-db/src/min/data.min.json'), 'utf8'));
  return j;
})();

function charAt(slug, level, asc) {
  const s = cstats[slug];
  const promo = (() => {
    for (let i = s.promotion.length - 2; i >= 0; i--) {
      if (level > s.promotion[i].maxlevel) return s.promotion[i + 1];
      if (level === s.promotion[i].maxlevel) return (asc > i || asc === '+') ? s.promotion[i + 1] : s.promotion[i];
    }
    return s.promotion[0];
  })();
  const cur = curves.characters[level] || {};
  const x = n => (typeof n === 'number' ? n : 1);
  return {
    hp: s.base.hp * x(cur[s.curve.hp]) + (promo.hp || 0),
    attack: s.base.attack * x(cur[s.curve.attack]) + (promo.attack || 0),
    defense: s.base.defense * x(cur[s.curve.defense]) + (promo.defense || 0)
  };
}

const ayaka = charAt('kamisatoayaka', 90, 6);
console.log('  神里绫华 90 级（6 突破）: HP ' + ayaka.hp.toFixed(1) + ' / ATK ' + ayaka.attack.toFixed(1) + ' / DEF ' + ayaka.defense.toFixed(1));
// 社区公认值：绫华 90 级 HP 12858 / ATK 342 / DEF 784（误差应在个位数内）
ok(Math.abs(ayaka.hp - 12858) < 12, '绫华 90 级 HP 落在官方值附近（期望≈12858）');
ok(Math.abs(ayaka.attack - 342) < 3, '绫华 90 级 基础攻击 落在官方值附近（期望≈342）');
ok(Math.abs(ayaka.defense - 784) < 6, '绫华 90 级 基础防御 落在官方值附近（期望≈784）');

// 武器：赦罪 90 级基础攻击官方值 674
const ws = wstats['absolution'];
const wcur = curves.weapons[90] || {};
const wpromo = ws.promotion[ws.promotion.length - 1];
const wAtk = ws.base.attack * (wcur[ws.curve.attack] || 1) + (wpromo.attack || 0);
console.log('  赦罪 90 级 基础攻击: ' + wAtk.toFixed(1));
ok(Math.abs(wAtk - 674) < 3, '赦罪 90 级基础攻击落在官方值附近（期望≈674）');

console.log('=== 6. 技能映射 ===');
if (!skills) {
  console.log('  ⚠️  avatar-skills.json 不存在（未跑 build-enka-map.mjs）——天赋将无法区分普攻/战技/爆发');
  warn++;
} else {
  const n = Object.keys(skills).length;
  const miss = chars.filter(c => !skills[String(c.id)]);
  console.log('  映射 ' + n + ' 个角色；genshin-db 的 ' + chars.length + ' 个角色中 ' + miss.length + ' 个无映射');
  if (miss.length) console.log('    未覆盖：' + miss.slice(0, 15).map(c => c.name).join('、') + (miss.length > 15 ? ' …' : ''));
  warnIf(miss.length <= chars.length * 0.15, '未覆盖角色比例偏高');
}

console.log('\n结果：失败 ' + fail + ' 项，警告 ' + warn + ' 项');
process.exit(fail ? 1 : 0);
