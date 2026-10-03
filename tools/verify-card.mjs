/**
 * verify-card.mjs —— 面板图出图链路自检
 *
 * 做三件事：
 *   ① 用合成数据把「角色对象 → 面板图数据模型」跑一遍，断言模型的每个必需字段
 *   ② 若本地服务在跑，就把模型 POST 到 /api/render 真出一张 PNG
 *   ③ 直接读 PNG 的 IHDR 头校验尺寸与像素密度（不依赖任何图像库）
 *
 * 合成数据全部为构造值，不含任何真实玩家数据。
 *
 * 用法：
 *   node tools/verify-card.mjs                 # 只做 ①③ 的模型自检（会提示服务未启动）
 *   node tools/verify-card.mjs --port 8788     # 连上本地服务真出图
 *   node tools/verify-card.mjs --out D:\x.png
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PORT = getArg('port', null);
const OUT = getArg('out', path.join(ROOT, 'data', 'cache', 'render', 'verify-card.png'));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

/* ---------- 加载前端模块 ---------- */
const ctx = vm.createContext({ console });
ctx.fetch = async (url) => {
  const p = path.join(PUBLIC, String(url));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};
for (const m of ['constants.js', 'roles.js', 'gamedata.js', 'scoring.js', 'enka.js', 'card.js']) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', m), 'utf8'), ctx, { filename: m });
}
const App = ctx.App;
const C = App.constants, SC = App.scoring, GD = App.gamedata, CARD = App.card;

await GD.load();
App.avatarskills = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'gamedata', 'avatar-skills.json'), 'utf8'));

/* ---------- 合成一个角色（结构与 enka.parse 的产物一致） ---------- */
console.log('=== 1. 构造合成角色 ===');
const SLUG = 'kamisatoayaka';
const char = GD.charBySlug[SLUG];
const d = App.roles.defaultsFor(char);
const mkArt = (slot, set, level, mainStat, subs, icon) => ({
  slot, setId: set.id, setName: set.name, setSlug: set.slug, icon: icon || null,
  rarity: 5, level, mainStat, mainValue: null,
  substats: subs.map(([stat, value]) => ({ stat, value, activated: true })),
  rollCount: 8, initialCount: 3, source: 'enka'
});
const gladiator = GD.sets.find(s => s.name === '角斗士的终幕礼');
const role = {
  id: 'verify_card', name: char.name, charId: char.id, charSlug: char.slug, element: char.element,
  level: 90, ascension: 6, constellation: 3,
  talents: { auto: 10, skill: 10, burst: 10 },
  weapon: { slug: 'absolution', itemId: 11515, name: '赦罪', rarity: 5, level: 90, ascension: 6, refinement: 1, icon: 'UI_EquipIcon_Sword_...' },
  artifacts: {
    flower: mkArt('flower', gladiator, 20, '生命值', [['暴击率', 3.9], ['暴击伤害', 7.8], ['攻击力百分比', 5.8], ['元素精通', 19]], 'UI_RelicIcon_15001_1'),
    plume: mkArt('plume', gladiator, 20, '攻击力', [['暴击率', 3.5], ['暴击伤害', 7.0], ['攻击力百分比', 5.2], ['元素充能效率', 6.5]], 'UI_RelicIcon_15001_2'),
    sands: mkArt('sands', gladiator, 20, '攻击力百分比', [['暴击率', 3.1], ['暴击伤害', 6.2], ['生命值百分比', 5.8], ['防御力', 23]], 'UI_RelicIcon_15001_3'),
    goblet: mkArt('goblet', gladiator, 20, '冰元素伤害加成', [['暴击率', 2.7], ['暴击伤害', 5.4], ['攻击力百分比', 4.7], ['元素精通', 16]], 'UI_RelicIcon_15001_4'),
    circlet: mkArt('circlet', gladiator, 20, '暴击伤害', [['暴击率', 3.9], ['攻击力百分比', 5.8], ['生命值百分比', 5.2], ['防御力百分比', 7.3]], 'UI_RelicIcon_15001_5')
  },
  effectiveStats: d.effectiveStats.slice(), weights: Object.assign({}, d.weights),
  archetype: d.archetype, archetypeLabel: d.archetypeLabel,
  erRequirement: 120, panel: null, source: 'enka'
};
ok(!!char, '静态表里找到 ' + char.name);
ok(!!gladiator, '静态表里找到套装「角斗士的终幕礼」');

/* ---------- 2. 数据模型自检 ---------- */
console.log('=== 2. 面板图数据模型 ===');
const model = CARD.buildModel(role, { uid: '100000000' });

ok(model.name === char.name, '角色名：' + model.name);
ok(model.internalName === 'Ayaka', '立绘内部名 = Ayaka（来自 Enka 数据字典）', model.internalName);
ok(!!model.icons.auto, '天赋图标名已带出：' + model.icons.auto);
ok(model.rows.length === 8, '面板 8 行（含元素精通与伤害加成），实得 ' + model.rows.length);
ok(model.rows.every(r => typeof r.text.total === "string" && typeof r.text.base === "string" && typeof r.text.bonus === "string"),
  '每行都有 总值/白字/绿字 三段文本');

const atk = model.rows.find(r => r.key === 'atk');
ok(atk && atk.base > 0 && Math.abs((atk.base + atk.bonus) - atk.total) < 0.05,
  '攻击力行满足 白字 + 绿字 = 总值（' + atk.text.base + ' + ' + atk.text.bonus + ' = ' + atk.text.total + '）');
const cr = model.rows.find(r => r.key === 'critRate');
ok(cr && cr.base === 5, '暴击率白字 = 固有 5%（绫华突破加的是爆伤，故不含突破）', cr && cr.base);
const cd = model.rows.find(r => r.key === 'critDmg');
ok(cd && cd.base > 50, '暴击伤害白字 = 50 + 突破加成 = ' + cd.text.base);
const er = model.rows.find(r => r.key === 'er');
ok(er && er.base === 100, '元素充能白字 = 100%');
const dmgRow = model.rows.find(r => r.key === 'dmg');
ok(dmgRow && Math.abs(dmgRow.total - 46.6) < 0.05, '伤害加成取到冰元素那一项 46.6%', dmgRow && dmgRow.total);

ok(model.artifacts.length === 5, '5 件圣遗物卡');
ok(model.artifacts.every(a => !a.empty), '5 件都已录入');
const flower = model.artifacts.find(a => a.slot === 'flower');
ok(flower.subs.length === 4, '花有 4 条副词条');
ok(flower.subs.every(s => typeof s.rollText === 'string' && Number(s.rollText) > 0),
  '每条副词条都有 roll 当量：' + flower.subs.map(s => s.rollText + ' ' + s.stat).join(' / '));
ok(flower.subs.every(s => typeof s.valueText === 'string' && s.valueText.length > 0), '每条副词条都有格式化数值');
ok(!!flower.grade, '单件评级：' + flower.grade + '（达成度 ' + flower.percent.toFixed(1) + '%）');
ok(!!flower.icon, '单件图标名已带出：' + flower.icon);

// roll 当量口径校验：+10.5% 暴击率 → 3.2（与参考图一致）
const r1 = CARD.subRoll('暴击率', 10.5);
ok(r1.text === '3.2', '+10.5% 暴击率 → roll 当量 3.2（与参考图一致，实得 ' + r1.text + '）');
const r2 = CARD.subRoll('防御力百分比', 15.3);
ok(r2.text === '2.5', '+15.3% 大防御 → roll 当量 2.5（实得 ' + r2.text + '）');
const r3 = CARD.subRoll('防御力', 41.7);
ok(r3.text === '2.1', '+41.7 小防御 → roll 当量 2.1（实得 ' + r3.text + '）');
const r4 = CARD.subRoll('暴击伤害', 7.8);
ok(r4.text === '1.2', '+7.8% 暴击伤害 → roll 当量 1.2（实得 ' + r4.text + '）');

ok(model.weapon && model.weapon.name === '赦罪', '武器卡：' + (model.weapon && model.weapon.name));
ok(!!model.artifactTotal && model.artifactTotal.score > 0, '圣遗物总分 ' + model.artifactTotal.score.toFixed(2)
  + ' / ' + model.artifactTotal.perfect.toFixed(2) + ' → ' + model.artifactTotal.grade);
ok(model.contributions.length > 0, '分项统计 ' + model.contributions.length + ' 项：'
  + model.contributions.slice(0, 4).map(c => c.label + c.text).join(' / '));
ok(model.panelSource === 'estimate', '未查 UID 时面板标为估算（' + model.panelSource + '）');

/* ---------- 3. 真出图 ---------- */
console.log('=== 3. 真出图 ===');
if (!PORT) {
  console.log('  ⏭  未指定 --port，跳过真出图。要跑真出图：先启动服务，再 node tools/verify-card.mjs --port 8788');
} else {
  const url = 'http://127.0.0.1:' + PORT + '/api/render';
  let buf = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, width: 900, scale: 2 })
    });
    if (!res.ok) {
      const t = await res.text();
      console.log('  ❌ 服务返回 HTTP ' + res.status + '：' + t.slice(0, 300));
      fail++;
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, buf);
    }
  } catch (e) {
    console.log('  ❌ 请求失败：' + e.message);
    fail++;
  }

  if (buf) {
    // 直接读 PNG 的 IHDR：宽/高 是大端 32 位，位于偏移 16 与 20
    const sig = buf.subarray(0, 8).toString('hex');
    ok(sig === '89504e470d0a1a0a', 'PNG 文件签名正确');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok(w === 1800, '图宽 = 1800 px（900 CSS px × 2 倍），实得 ' + w);
    ok(h > 1200 && h < 20000, '图高 = ' + h + ' px（整页自适应，未裁切也非空图）');
    ok(buf.length > 20000, '文件 ' + (buf.length / 1024).toFixed(1) + ' KB');
    console.log('  已保存：' + OUT);
  }
}

console.log('\n============================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('============================');
process.exit(fail ? 1 : 0);
