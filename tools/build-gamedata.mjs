/**
 * build-gamedata.mjs —— 从 genshin-db 裁剪出本项目需要的静态数值表
 *
 * 数据来源：genshin-db（MIT，https://github.com/theBowja/genshin-db）
 *          数据本身来自 fandom wiki 与 Dimbreath/AnimeGameData
 *
 * 用法：
 *   node --max-old-space-size=6144 tools/build-gamedata.mjs <genshin-db 包根目录>
 * 例：
 *   node --max-old-space-size=6144 tools/build-gamedata.mjs ..\_scratch\genshin-research\dataprobe\node_modules\genshin-db
 *
 * 产物（写入 assets/gamedata/，随源码入库；不含任何玩家数据）：
 *   characters.json      角色基本信息（id/名/元素/武器类型/星级）
 *   character-stats.json 角色基础属性成长（base + 曲线名 + 突破加成）
 *   weapons.json         武器基本信息（名/星级/类型/副属性类型）
 *   weapon-stats.json    武器基础攻击成长（base + 曲线名 + 突破加成）
 *   artifact-sets.json   圣遗物套装（2件套/4件套效果文本）
 *   curves.json          等级成长曲线系数表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'gamedata');

const pkgRoot = process.argv[2];
if (!pkgRoot) {
  console.error('用法: node --max-old-space-size=6144 tools/build-gamedata.mjs <genshin-db 包根目录>');
  process.exit(2);
}
const dataPath = path.join(pkgRoot, 'src', 'min', 'data.min.json');
if (!fs.existsSync(dataPath)) {
  console.error('找不到 data.min.json：' + dataPath);
  process.exit(2);
}

const t0 = Date.now();
console.log('[1/5] 读取 ' + dataPath);
const j = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
console.log('      解析完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，库版本数据 ' + JSON.stringify(j.version).length + ' 字节');

const zh = j.data.ChineseSimplified;
const en = j.data.English;
const st = j.stats;
const cv = j.curve;

/**
 * 英文名 → GOOD 格式用的 PascalCase 键（如 "Gilded Dreams" → "GildedDreams"）。
 * GOOD 是社区事实标准（权威 schema 在 frzyc/genshin-optimizer，MIT）。
 * 注意：上游个别键的撇号/连字符处理可能与本推导不同，
 *       因此导入时一律用 normalizeKey() 归一化后再比对，而不是逐字符相等。
 */
const pascal = s => String(s || '')
  .replace(/[^A-Za-z0-9]+/g, ' ')
  .trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join('');
/** 归一化：只留字母数字并小写，用于容错匹配 */
const normalizeKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, obj) => {
  const p = path.join(OUT_DIR, name);
  const s = JSON.stringify(obj);
  fs.writeFileSync(p, s, 'utf8');
  console.log('      -> ' + name + '  ' + (s.length / 1024).toFixed(1) + ' KB');
};

/* ---------- 1. 角色基本信息 ---------- */
console.log('[2/5] 角色');
const characters = Object.entries(zh.characters).map(([slug, c]) => ({
  slug,
  id: c.id,
  name: c.name,
  nameEn: (en.characters[slug] || {}).name || '',
  goodKey: pascal((en.characters[slug] || {}).name),
  rarity: c.rarity,
  element: c.elementText,           // 火/水/风/雷/冰/岩/草
  elementType: c.elementType,
  weaponType: c.weaponText,         // 单手剑/双手剑/长柄武器/弓/法器
  weaponTypeKey: c.weaponType,
  substatType: c.substatType,       // 突破加成属性
  substatText: c.substatText,
  region: c.region
})).sort((a, b) => a.id - b.id);
// 旅行者等同一 id 多形态：保留全部，用 slug 区分
write('characters.json', characters);

/* ---------- 2. 角色属性成长 ---------- */
const characterStats = {};
for (const [slug, s] of Object.entries(st.characters)) {
  characterStats[slug] = {
    base: s.base,                   // {hp, attack, defense, critrate, critdmg}
    curve: s.curve,                 // {hp, attack, defense} 曲线名
    specialized: s.specialized,     // 突破加成属性 key
    promotion: s.promotion          // [{maxlevel, hp, attack, defense, specialized}]
  };
}
write('character-stats.json', characterStats);

/* ---------- 3. 武器 ---------- */
console.log('[3/5] 武器');
const weapons = Object.entries(zh.weapons).map(([slug, w]) => ({
  slug,
  id: w.id,
  name: w.name,
  nameEn: (en.weapons[slug] || {}).name || '',
  goodKey: pascal((en.weapons[slug] || {}).name),
  rarity: w.rarity,
  weaponType: w.weaponText,
  weaponTypeKey: w.weaponType,
  baseAtkValue: w.baseAtkValue,
  mainStatType: w.mainStatType,     // 副属性 key（如 FIGHT_PROP_CRITICAL）
  mainStatText: w.mainStatText,
  effectName: w.effectName || '',
  // r1..r5 形如 { description, values[] }，只留文本，避免把对象塞进数据表
  refinements: [w.r1, w.r2, w.r3, w.r4, w.r5].map(x => {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    return String(x.description || '');
  })
})).sort((a, b) => a.id - b.id);
write('weapons.json', weapons);

const weaponStats = {};
for (const [slug, s] of Object.entries(st.weapons)) {
  weaponStats[slug] = { base: s.base, curve: s.curve, promotion: s.promotion };
}
write('weapon-stats.json', weaponStats);

/* ---------- 4. 圣遗物套装 ---------- */
console.log('[4/5] 圣遗物套装');
const artifactSets = Object.entries(zh.artifacts).map(([slug, a]) => ({
  slug,
  id: a.id,
  name: a.name,
  nameEn: (en.artifacts[slug] || {}).name || '',
  goodKey: pascal((en.artifacts[slug] || {}).name),
  rarityList: a.rarityList,
  effect2Pc: a.effect2Pc || '',
  effect4Pc: a.effect4Pc || ''
})).sort((a, b) => (a.id || 0) - (b.id || 0));
write('artifact-sets.json', artifactSets);

/* ---------- 5. 成长曲线 ---------- */
console.log('[5/5] 成长曲线');
const curves = { characters: cv.characters, weapons: cv.weapons };
write('curves.json', curves);

/* ---------- 自检：打印规模与抽样，便于人工核对 ---------- */
console.log('\n=== 自检 ===');
console.log('角色 ' + characters.length + ' 个；武器 ' + weapons.length + ' 个；套装 ' + artifactSets.length + ' 个');
console.log('角色曲线等级档位: ' + Object.keys(cv.characters).length);
console.log('武器曲线名数量: ' + Object.keys(cv.weapons[Object.keys(cv.weapons)[0]] || {}).length);

const sampleChar = characters.find(c => c.slug === 'kamisatoayaka');
console.log('\n抽样角色:', JSON.stringify(sampleChar));
const cs = characterStats['kamisatoayaka'];
console.log('抽样角色 90 级突破末档:', JSON.stringify(cs.promotion[cs.promotion.length - 1]));
console.log('抽样角色 maxlevel 序列:', cs.promotion.map(p => p.maxlevel).join(','));

const wk = weapons.find(w => w.slug === 'absolution');
console.log('\n抽样武器:', JSON.stringify({ ...wk, refinements: wk.refinements.map(x => x.slice(0, 24)) }));
console.log('抽样武器 stats:', JSON.stringify(weaponStats['absolution']));

const ak = artifactSets.find(a => a.slug === 'adaycarvedfromrisingwinds');
console.log('\n抽样套装:', JSON.stringify(ak));

// 曲线完整性：角色用到的曲线名是否都在表里
const usedCharCurves = new Set(Object.values(st.characters).flatMap(s => Object.values(s.curve)));
const haveCharCurves = new Set(Object.values(cv.characters).flatMap(o => Object.keys(o)));
const missing = [...usedCharCurves].filter(c => !haveCharCurves.has(c));
console.log('\n角色曲线完整性: 用到 ' + usedCharCurves.size + ' 种，缺失 ' + missing.length + (missing.length ? ' -> ' + missing.join(',') : ' ✅'));

const usedWeaponCurves = new Set(Object.values(st.weapons).flatMap(s => Object.values(s.curve)));
const haveWeaponCurves = new Set(Object.values(cv.weapons).flatMap(o => Object.keys(o)));
const missingW = [...usedWeaponCurves].filter(c => !haveWeaponCurves.has(c));
console.log('武器曲线完整性: 用到 ' + usedWeaponCurves.size + ' 种，缺失 ' + missingW.length + (missingW.length ? ' -> ' + missingW.join(',') : ' ✅'));

console.log('\n完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
