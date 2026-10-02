/**
 * smoke-test.mjs —— 无头冒烟测试
 *
 * 把前端的 constants/roles/gamedata/scoring/enka/good 六个模块加载进 Node 的 vm 上下文，
 * 用**合成的** Enka 响应与 GOOD 文件跑通「解析 → 评分 → 估算面板 → 导入导出」全链路。
 *
 * 测试数据全部为构造值，不含任何真实玩家数据。
 *
 * 用法：node tools/smoke-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.05 : eps);

/* ---------- 1. 在 vm 里加载前端模块 ---------- */
const ctx = vm.createContext({ console });
ctx.fetch = async (url) => {
  const p = path.join(PUBLIC, String(url));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  const text = fs.readFileSync(p, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

const MODULES = ['constants.js', 'roles.js', 'gamedata.js', 'scoring.js', 'enka.js', 'good.js'];
console.log('=== 0. 加载前端模块 ===');
for (const m of MODULES) {
  try {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', m), 'utf8'), ctx, { filename: m });
    console.log('  ✅ ' + m);
  } catch (e) {
    console.log('  ❌ ' + m + ' 加载失败：' + e.message);
    fail++;
  }
}
if (fail) { console.log('\n模块加载失败，终止。'); process.exit(1); }

const App = ctx.App;
const C = App.constants, SC = App.scoring, GD = App.gamedata, IO = App.io2;

/* ---------- 2. 静态表加载 ---------- */
console.log('=== 1. 静态数值表 ===');
await GD.load();
App.avatarskills = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'gamedata', 'avatar-skills.json'), 'utf8'));
ok(GD.ready, 'GD.ready = true');
ok(GD.characters.length >= 100, '角色 ' + GD.characters.length + ' 个');
ok(GD.weapons.length >= 200, '武器 ' + GD.weapons.length + ' 个');
ok(GD.sets.length >= 50, '套装 ' + GD.sets.length + ' 个');

/* ---------- 3. 数值表正确性 ---------- */
console.log('=== 2. 数值表与档位运算 ===');
ok(near(C.UMAX['暴击率'], 3.89) && near(C.UMAX['暴击伤害'], 7.77), '双爆满档值 3.89 / 7.77');
ok(near(C.UMAX['攻击力百分比'], 5.83), '大攻击满档 = 5.83（不是 5.8，也不是 5.3 那个流传错误值）');
ok(C.TIER_DISPLAY['攻击力百分比'][2] === 5.2, '大攻击第 3 档显示为 5.2%（纠正 5.3% 的流传错误）');
ok(near(C.ROLL_TIERS['暴击率'][0], 3.89 * 0.7), '四档严格等于 0.7 × Umax');
ok(C.mainStatValue('生命值', 0) === 717 && C.mainStatValue('生命值', 20) === 4780, '主词条生命值 0 级 717 / +20 4780');

// 已知局限：游戏内主词条逐级值是数据表、不是公式，本项目按 0↔+20 线性插值。
// 这里用官方表**量化**偏差，而不是假装没有偏差。
const OFFICIAL_HP = [717, 920, 1123, 1326, 1530, 1733, 1936, 2139, 2342, 2545, 2749, 2952, 3155, 3358, 3561, 3764, 3967, 4171, 4374, 4577, 4780];
const OFFICIAL_ATK = [47, 60, 73, 86, 100, 113, 126, 139, 152, 166, 179, 192, 205, 219, 232, 245, 258, 272, 285, 298, 311];
const devOf = (stat, official) => {
  let max = 0, at = [];
  for (let L = 0; L <= 20; L++) {
    const d = Math.abs(C.mainStatValue(stat, L) - official[L]);
    if (d > max) { max = d; at = [L]; } else if (d === max && d > 0) at.push(L);
  }
  return { max, at };
};
const dHp = devOf('生命值', OFFICIAL_HP), dAtk = devOf('攻击力', OFFICIAL_ATK);
ok(dHp.max === 0, '主词条生命值逐级与官方表完全一致（最大偏差 ' + dHp.max + '）');
ok(dAtk.max <= 1,
  '主词条攻击力逐级最大偏差 ≤1（实测 ' + dAtk.max + '，出现在 ' + dAtk.at.join('/') + ' 级）—— 已知局限，已记入 DEVELOPMENT.md');
console.log('     ℹ️  主词条走线性插值：生命值零偏差、攻击力最多 ±1；离线面板因此整体标注为「估算」，');
console.log('        查 UID 时用的是 Enka 返回的真实面板，不受此影响。');

// roll 分解：满档暴击率 3.89 应恰好是 1 次 roll
const d1 = C.decomposeRolls('暴击率', 3.9);
ok(d1.some(x => x.rolls === 1), '3.9% 暴击率可分解为 1 次 roll');
// 7.8% 暴击伤害 = 1 次满档
ok(C.decomposeRolls('暴击伤害', 7.8).some(x => x.rolls === 1), '7.8% 暴击伤害 = 1 次 roll');
// 4 初始 9 roll / 3 初始 8 roll 推断
const fourInit = [
  { stat: '暴击率', value: 3.9 }, { stat: '暴击伤害', value: 7.8 },
  { stat: '攻击力百分比', value: 5.8 }, { stat: '元素充能效率', value: 6.5 }
];
ok(C.decomposeRolls('生命值', 1792.5).some(x => x.rolls === 6), '满 roll 小生命 1792.5 = 6 次 roll');

/* ---------- 4. 合成 Enka 响应：解析 ---------- */
console.log('=== 3. Enka 响应解析（合成数据）===');
const SLUG = 'kamisatoayaka';
const char = GD.charBySlug[SLUG];
const skills = App.avatarskills[String(char.id)];
const mkArt = (enkaType, setId, levelPlus1, mainProp, mainVal, subs) => ({
  itemId: 1,
  reliquary: { level: levelPlus1, mainPropId: mainProp, appendPropIdList: new Array(8).fill(501001) },
  flat: {
    nameTextMapHash: '0', rankLevel: 5, itemType: 'ITEM_RELIQUARY', icon: 'x',
    equipType: enkaType, setId, setNameTextMapHash: '0',
    reliquaryMainstat: { mainPropId: mainProp, statValue: mainVal },
    reliquarySubstats: subs.map(([id, v]) => ({ appendPropId: id, statValue: v }))
  }
});
const enkaResp = {
  uid: '100000000', region: 'CN', ttl: 60,
  playerInfo: { nickname: '测试账号', level: 60, signature: '', worldLevel: 8, showAvatarInfoList: [{ avatarId: char.id, level: 90 }] },
  avatarInfoList: [{
    avatarId: char.id,
    propMap: { '4001': { val: '90' }, '1002': { val: '6' } },
    talentIdList: [1, 2, 3],
    skillLevelMap: skills ? { [skills.auto]: 10, [skills.skill]: 10, [skills.burst]: 10 } : {},
    inherentProudSkillList: [], skillDepotId: 1,
    fightPropMap: {
      '1': 12858.2, '4': 342, '7': 784,
      '20': 0.7000, '22': 1.4000, '23': 1.3000, '28': 100,
      '30': 0, '40': 0, '41': 0, '42': 0, '43': 0, '44': 0, '45': 0, '46': 0.466,
      '50': 0, '2000': 20000, '2001': 2000, '2002': 1000
    },
    equipList: [
      { itemId: 11515, weapon: { level: 90, promoteLevel: 6, affixMap: { '115515': 0 } }, flat: { rankLevel: 5, itemType: 'ITEM_WEAPON' } },
      mkArt('EQUIP_BRACER', 15001, 21, 'FIGHT_PROP_HP', 4780, [['FIGHT_PROP_CRITICAL', 3.9], ['FIGHT_PROP_CRITICAL_HURT', 7.8], ['FIGHT_PROP_ATTACK_PERCENT', 5.8], ['FIGHT_PROP_ELEMENT_MASTERY', 19]]),
      mkArt('EQUIP_NECKLACE', 15001, 21, 'FIGHT_PROP_ATTACK', 311, [['FIGHT_PROP_CRITICAL', 3.5], ['FIGHT_PROP_CRITICAL_HURT', 7.0], ['FIGHT_PROP_ATTACK_PERCENT', 5.3], ['FIGHT_PROP_CHARGE_EFFICIENCY', 6.5]]),
      mkArt('EQUIP_SHOES', 15001, 21, 'FIGHT_PROP_ATTACK_PERCENT', 46.6, [['FIGHT_PROP_CRITICAL', 3.1], ['FIGHT_PROP_CRITICAL_HURT', 6.2], ['FIGHT_PROP_HP_PERCENT', 5.8], ['FIGHT_PROP_DEFENSE', 23]]),
      mkArt('EQUIP_RING', 15001, 21, 'FIGHT_PROP_ICE_ADD_HURT', 46.6, [['FIGHT_PROP_CRITICAL', 2.7], ['FIGHT_PROP_CRITICAL_HURT', 5.4], ['FIGHT_PROP_ATTACK_PERCENT', 4.7], ['FIGHT_PROP_ELEMENT_MASTERY', 16]]),
      mkArt('EQUIP_DRESS', 15001, 21, 'FIGHT_PROP_CRITICAL_HURT', 62.2, [['FIGHT_PROP_CRITICAL', 3.9], ['FIGHT_PROP_ATTACK_PERCENT', 5.8], ['FIGHT_PROP_HP_PERCENT', 5.3], ['FIGHT_PROP_DEFENSE_PERCENT', 7.3]])
    ]
  }]
};

const parsed = App.enka.parse(enkaResp);
ok(parsed.roles.length === 1, '解析出 1 个角色');
const role = parsed.roles[0];
ok(role.name === char.name, '角色名 = ' + char.name + '（用 avatarId 反查静态表）', role.name);
ok(role.level === 90 && role.ascension === 6, '等级/突破 = 90 / 6');
ok(role.constellation === 3, '命座 = talentIdList 长度 = 3', role.constellation);
ok(role.talents.auto === 10 && role.talents.skill === 10 && role.talents.burst === 10,
  '天赋等级按 skillId 映射到 普攻/战技/爆发', role.talents);
ok(role.weapon && role.weapon.name === '赦罪', '武器反查 = 赦罪', role.weapon && role.weapon.name);
ok(role.weapon.refinement === 1, 'affixMap 0 → 精炼 1', role.weapon.refinement);

// 坑 1：reliquary.level 21 → 游戏内 +20
ok(role.artifacts.flower.level === 20, 'reliquary.level=21 解析为 +20（坑 1：-1）', role.artifacts.flower.level);
// 坑 2：字段名 statValue
ok(role.artifacts.flower.mainValue === 4780, '主词条取 statValue（坑 2：文档写的 propValue 是错的）', role.artifacts.flower.mainValue);
ok(role.artifacts.flower.substats.length === 4, '副词条 4 条');
ok(role.artifacts.flower.substats[0].stat === '暴击率', 'FIGHT_PROP_CRITICAL → 暴击率');
ok(role.artifacts.flower.substats[0].value === 3.9, '副词条数值取自 statValue');
ok(role.artifacts.goblet.mainStat === '冰元素伤害加成', 'FIGHT_PROP_ICE_ADD_HURT → 冰元素伤害加成');
// 初始词条数：appendPropIdList 8 项 → 3 初始
ok(role.artifacts.flower.rollCount === 8 && role.artifacts.flower.initialCount === 3,
  'appendPropIdList 8 项 → 8 次 roll → 3 初始', { r: role.artifacts.flower.rollCount, i: role.artifacts.flower.initialCount });

// 面板：比例 → 百分数
ok(near(role.panel.critRate, 70, 0.01), 'fightPropMap 20 = 0.70 → 面板暴击率 70%', role.panel.critRate);
ok(near(role.panel.critDmg, 140, 0.01), '面板暴击伤害 140%');
ok(near(role.panel.er, 130, 0.01), '面板充能 130%');
ok(role.panel.source === 'enka', '面板来源标记为 enka');
ok(near(role.panel.dmg['冰'], 46.6, 0.01), '冰元素伤害加成 46.6%');

/* ---------- 5. 评分 ---------- */
console.log('=== 4. 评分与练度 ===');
const cs = SC.characterScore(role, role.panel);
ok(isFinite(cs.words) && cs.words > 0, '圣遗物有效词条合计 > 0：' + cs.words.toFixed(3));
ok(cs.perfect > cs.words, '完美态满分 > 当前得分（' + cs.perfect.toFixed(2) + ' > ' + cs.words.toFixed(2) + '）');
ok(cs.percent >= 0 && cs.percent <= 100, '达成度在 0~100 之间：' + cs.percent.toFixed(1) + '%');
const flowerScore = SC.artifactScore(role.artifacts.flower, role);
ok(flowerScore > 0, '花部位单件分 > 0：' + flowerScore.toFixed(3));
// 权值口径自检：一条满档暴击率(3.89) 在 cr 权值 1.0 下应恰好贡献 1.0
const probe = { effectiveStats: ['暴击率'], weights: { '暴击率': 1 } };
ok(near(SC.artifactScore({ substats: [{ stat: '暴击率', value: 3.89 }] }, probe), 1, 0.001),
  '满档暴击率 × 权值 1.0 = 恰好 1.0 个标准词条');

const rating = SC.buildRating(role, role.panel);
ok(rating.score >= 0 && rating.score <= 100, '练度评分在 0~100：' + rating.score);
ok(['毕业', '高练', '小毕业', '及格', '起步', '待养成'].includes(rating.grade), '评级枚举合法：' + rating.grade);
ok(rating.dims.crit.value > 0, '面板双爆维度已计入（面板来自 Enka）');

/* ---------- 6. 离线面板估算 ---------- */
console.log('=== 5. 离线面板估算 ===');
const est = SC.estimatePanel(role);
ok(est.source === 'estimate', '来源标记为 estimate');
ok(near(est.baseHp, 12858.2, 15), '绫华 90 级基础生命 ≈12858（静态表算得 ' + est.baseHp.toFixed(1) + '）');
ok(est.baseAtk > 342 && est.baseAtk < 342 + 700, '基础攻击 = 角色 342 + 武器白值（算得 ' + est.baseAtk.toFixed(1) + '）');
// 绫华突破加成是暴击伤害：genshin-db 口径的 specialized 已含固有 50%，不可重复相加
//   暴击率   = 固有 5 + 副词条 (3.9+3.5+3.1+2.7+3.9 = 17.1)                = 22.1
//   暴击伤害 = 副词条 26.4 + 头冠主词条 62.2 + 突破 88.4 + 武器副属性 44.1 = 221.1
//   （5★ 武器 90 级暴伤副属性是 44.1%，不是 88.2%——这一点容易写错）
ok(near(est.critRate, 22.1, 0.05), '估算暴击率 = 固有 5 + 副词条 17.1 = 22.1%（实测 ' + est.critRate.toFixed(2) + '）');
ok(near(est.critDmg, 221.1, 0.05),
  '估算暴击伤害 = 副词条 26.4 + 主词条 62.2 + 突破 88.4 + 武器 44.1 = 221.1%（实测 ' + est.critDmg.toFixed(2) + '）');
// 反向验证：突破加成若被重复计入固有 50%，结果会是 271.1
ok(!near(est.critDmg, 271.1, 0.5), '突破加成未重复计入固有 50%（否则会是 271.1）');
ok(Array.isArray(est.incomplete) && est.incomplete.length > 0, '离线估算会明确列出未计入项（' + est.incomplete.length + ' 条）');

/* ---------- 7. GOOD 导入 / 导出 ---------- */
console.log('=== 6. GOOD 导入导出 ===');
const good = IO.exportGood([role]);
ok(good.format === 'GOOD' && good.version === 3, '导出为 GOOD v3');
ok(good.artifacts.length === 5, '导出 5 件圣遗物');
ok(good.artifacts[0].slotKey === 'flower' && good.artifacts[0].level === 20, 'slotKey/level 正确');
ok(good.artifacts[0].substats.some(s => s.key === 'critRate_' && s.value === 3.9), '副词条键用 GOOD 口径 critRate_');
ok(good.artifacts[0].mainStatKey === 'hp', '主词条键用 GOOD 口径 hp');
const back = IO.importGood(good);
ok(back.roles.length === 1, 'GOOD 回环导入 1 个角色');
ok(back.roles[0].name === char.name, 'GOOD 回环角色名正确：' + back.roles[0].name);
ok(back.roles[0].artifacts.flower.substats[0].value === 3.9, 'GOOD 回环副词条数值保持');
ok(back.roles[0].artifacts.goblet.mainStat === '冰元素伤害加成', 'GOOD 回环主词条保持');

// 未装备的圣遗物应被跳过并提示
const good2 = JSON.parse(JSON.stringify(good));
good2.artifacts.push({ setKey: 'GladiatorsFinale', slotKey: 'flower', level: 20, rarity: 5, mainStatKey: 'hp', location: '', substats: [{ key: 'critRate_', value: 3.1 }] });
const back2 = IO.importGood(good2);
ok(back2.warnings.some(w => w.includes('未装备')), '未装备的圣遗物被跳过并给出提示');

/* ---------- 8. 莫娜导入 ---------- */
console.log('=== 7. 莫娜格式导入 ===');
const mona = {
  flower: [{ setName: 'gladiatorFinale', mainTag: { name: 'lifeStatic' }, normalTags: [{ name: 'critical', value: 0.039 }], level: 20, equip: char.name, star: 5 }],
  feather: [], sand: [], cup: [], head: []
};
const bm = IO.importMona(mona);
ok(bm.roles.length === 1, '莫娜数据导入 1 个角色');
ok(bm.roles[0].artifacts.flower.mainStat === '生命值', '莫娜 lifeStatic → 生命值');
ok(near(bm.roles[0].artifacts.flower.substats[0].value, 0.039), '莫娜词条数值原样保留（0.039）');

/* ---------- 9. 格式探测 ---------- */
console.log('=== 8. 格式探测 ===');
ok(IO.detect(good) === 'good', '探测 GOOD');
ok(IO.detect(mona) === 'mona', '探测莫娜');
ok(IO.detect({ roles: [] }) === 'backup', '探测本项目备份');
ok(IO.detect({ foo: 1 }) === null, '未知格式返回 null');

console.log('\n============================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('============================');
process.exit(fail ? 1 : 0);
