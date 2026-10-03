/**
 * constants.js —— 数值表与档位运算
 *
 * 【数值来源与许可】
 *   副词条四档 = Umax × [0.7, 0.8, 0.9, 1.0]，四档等概率（期望系数 0.85）。
 *     交叉验证：m19e/artifact-scorer（MIT）SubStatusMap 与多份独立 datamine 表一致。
 *     ⚠️ 流传较广的一处写法把「攻击力%／生命值%」第 3 档写成 5.3%，精确值 5.247%、游戏内显示 5.2%。
 *        本项目：计算用精确值，渲染用显示值（TIER_DISPLAY）。
 *   主词条 0 级 / +20 值：m19e/artifact-scorer（MIT）MainStatusMap。
 *   结构参考：aumveil/genshin-artifact-scorer（MIT, © 2026 秋晨）。
 */
(function (global) {
  "use strict";

  const SLOTS = {
    flower: { key: "flower", name: "生之花", short: "花", enka: "EQUIP_BRACER", good: "flower" },
    plume: { key: "plume", name: "死之羽", short: "羽", enka: "EQUIP_NECKLACE", good: "plume" },
    sands: { key: "sands", name: "时之沙", short: "沙", enka: "EQUIP_SHOES", good: "sands" },
    goblet: { key: "goblet", name: "空之杯", short: "杯", enka: "EQUIP_RING", good: "goblet" },
    circlet: { key: "circlet", name: "理之冠", short: "头", enka: "EQUIP_DRESS", good: "circlet" }
  };
  const SLOT_KEYS = ["flower", "plume", "sands", "goblet", "circlet"];
  const ENKA_SLOT = {};
  for (const k of SLOT_KEYS) ENKA_SLOT[SLOTS[k].enka] = k;

  // 副词条满档单发最大值（精确值）
  const UMAX = {
    "暴击率": 3.89, "暴击伤害": 7.77,
    "攻击力百分比": 5.83, "生命值百分比": 5.83, "防御力百分比": 7.29,
    "元素精通": 23.31, "元素充能效率": 6.48,
    "攻击力": 19.45, "生命值": 298.75, "防御力": 23.15
  };
  const TIER_RATIO = [0.7, 0.8, 0.9, 1.0];
  const ROLL_TIERS = {}, TIER_DISPLAY = {};
  for (const k in UMAX) {
    ROLL_TIERS[k] = TIER_RATIO.map(r => +(UMAX[k] * r).toFixed(5));
  }
  Object.assign(TIER_DISPLAY, {
    "暴击率": [2.7, 3.1, 3.5, 3.9], "暴击伤害": [5.4, 6.2, 7.0, 7.8],
    "攻击力百分比": [4.1, 4.7, 5.2, 5.8], "生命值百分比": [4.1, 4.7, 5.2, 5.8],
    "防御力百分比": [5.1, 5.8, 6.6, 7.3], "元素精通": [16, 19, 21, 23],
    "元素充能效率": [4.5, 5.2, 5.8, 6.5], "攻击力": [14, 16, 18, 19],
    "生命值": [209, 239, 269, 299], "防御力": [16, 19, 21, 23]
  });

  const EXPECTED_TIER = 0.85;
  // 单发期望档位（四档等概率）——面板图里「每条副词条前的数字」就用它做分母
  const SUB_STAT_AVG = {};
  for (const k in UMAX) SUB_STAT_AVG[k] = +(UMAX[k] * EXPECTED_TIER).toFixed(5);
  const SUB_STATS = Object.keys(UMAX);
  const STAT_TYPE = {};
  for (const k of SUB_STATS) {
    STAT_TYPE[k] = (k.includes("百分比") || k === "暴击率" || k === "暴击伤害" || k === "元素充能效率")
      ? "percent" : "flat";
  }

  // 主词条 0 级 / +20（flat 为原值，percent 为百分数）
  const MAIN_STAT_RANGE = {
    "生命值": { min: 717, max: 4780, digits: 0 },
    "攻击力": { min: 47, max: 311, digits: 0 },
    "攻击力百分比": { min: 7.0, max: 46.6, digits: 1 },
    "生命值百分比": { min: 7.0, max: 46.6, digits: 1 },
    "防御力百分比": { min: 8.7, max: 58.3, digits: 1 },
    "元素精通": { min: 28, max: 187, digits: 0 },
    "元素充能效率": { min: 7.8, max: 51.8, digits: 1 },
    "暴击率": { min: 4.7, max: 31.1, digits: 1 },
    "暴击伤害": { min: 9.3, max: 62.2, digits: 1 },
    "治疗加成": { min: 5.4, max: 35.9, digits: 1 },
    "物理伤害加成": { min: 8.7, max: 58.3, digits: 1 }
  };
  for (const e of ["火", "水", "雷", "冰", "风", "岩", "草"]) {
    MAIN_STAT_RANGE[e + "元素伤害加成"] = { min: 7.0, max: 46.6, digits: 1 };
  }

  const MAIN_STATS_BY_SLOT = {
    flower: ["生命值"],
    plume: ["攻击力"],
    sands: ["攻击力百分比", "防御力百分比", "生命值百分比", "元素精通", "元素充能效率"],
    goblet: ["攻击力百分比", "防御力百分比", "生命值百分比", "元素精通",
      "物理伤害加成", "风元素伤害加成", "岩元素伤害加成", "雷元素伤害加成",
      "草元素伤害加成", "水元素伤害加成", "火元素伤害加成", "冰元素伤害加成"],
    circlet: ["攻击力百分比", "防御力百分比", "生命值百分比", "元素精通",
      "暴击率", "暴击伤害", "治疗加成"]
  };

  const ELEMENT_DMG = {
    "火": "火元素伤害加成", "水": "水元素伤害加成", "雷": "雷元素伤害加成",
    "冰": "冰元素伤害加成", "风": "风元素伤害加成", "岩": "岩元素伤害加成",
    "草": "草元素伤害加成"
  };

  /* ---------- 档位运算 ---------- */

  /** 面板口径：主词条在 0~20 级间的取值。
   *  说明：游戏内主词条逐级值是数据表而非公式，此处按 0 级↔+20 线性插值后按位数取整。
   *  实测 HP（717→4780）逐级与官方值完全一致；其余词条个别等级可能有 ±1 的尾数差，
   *  故离线面板整体标注为「估算」，UID 路径一律以 Enka 返回的真实面板为准。 */
  function mainStatValue(stat, level) {
    const r = MAIN_STAT_RANGE[stat];
    if (!r) return 0;
    const lv = Math.max(0, Math.min(20, Number(level) || 0));
    const v = r.min + (r.max - r.min) * lv / 20;
    const p = Math.pow(10, r.digits);
    return Math.round(v * p) / p;
  }

  /** 滚数当量：数值 ÷ 满档单发最大值（1.0 档满档 = 1.0） */
  function rollEquivalent(stat, value) {
    const u = UMAX[stat];
    if (!u || !isFinite(value)) return 0;
    return value / u;
  }

  /** 把一条副词条显示值分解为各档位 roll 次数；允许 ±0.1 的显示取整误差。
   *  注意：档位值保持浮点、只对「求和后」取整比较——
   *  若先把档位四舍五入成整数再相加，像小生命 298.75 这样的小数档位会累积误差
   *  （6 次满档 1792.5 会被算成 1792.8 而失配）。 */
  function decomposeRolls(stat, value, maxRolls) {
    const t = ROLL_TIERS[stat];
    if (!t) return [];
    const max = maxRolls || 6;
    const target = Math.round(value * 10);
    const out = [];
    for (let k = 1; k <= max; k++) {
      let best = null;
      for (let a = 0; a <= k; a++)
        for (let b = 0; a + b <= k; b++)
          for (let c = 0; a + b + c <= k; c++) {
            const d = k - a - b - c;
            const sum = t[0] * a + t[1] * b + t[2] * c + t[3] * d;
            const diff = Math.abs(Math.round(sum * 10) - target);
            if (best === null || diff < best.diff) best = { diff, tiers: [a, b, c, d], sum };
          }
      if (best && best.diff <= 1) out.push({ rolls: k, tiers: best.tiers });
    }
    return out;
  }

  /** 满级 5★ 圣遗物初始词条数：总 roll 9 = 4 初始、8 = 3 初始；无法判定返回 null */
  function inferInitialCount(substats) {
    const subs = (substats || []).filter(s => s && s.activated !== false);
    if (subs.length !== 4) return null;
    const sets = subs.map(s => {
      const d = decomposeRolls(s.stat, s.value);
      return d.length ? d.map(x => x.rolls) : null;
    });
    if (sets.some(s => s === null)) return null;
    const feasible = total => {
      for (const a of sets[0]) for (const b of sets[1]) for (const c of sets[2]) for (const d of sets[3])
        if (a + b + c + d === total) return true;
      return false;
    };
    const can4 = feasible(9), can3 = feasible(8);
    if (can4 && !can3) return 4;
    if (can3 && !can4) return 3;
    return null;
  }

  /** 数值展示（百分比带 %，flat 按位数） */
  function fmt(stat, value) {
    const isPct = !!(STAT_TYPE[stat] === "percent" || (MAIN_STAT_RANGE[stat] && stat.includes("百分比"))
      || /伤害加成|治疗加成|暴击|充能/.test(stat));
    if (value == null || !isFinite(value)) return "—";
    if (isPct) return (Math.round(value * 10) / 10) + "%";
    return String(Math.round(value * 10) / 10);
  }

  global.App = global.App || {};
  global.App.constants = {
    SLOTS, SLOT_KEYS, ENKA_SLOT,
    UMAX, ROLL_TIERS, TIER_DISPLAY, TIER_RATIO, EXPECTED_TIER, SUB_STAT_AVG, SUB_STATS, STAT_TYPE,
    MAIN_STAT_RANGE, MAIN_STATS_BY_SLOT, ELEMENT_DMG,
    MAX_LEVEL: 20, MAX_ROLLS_PER_STAT: 6, MAX_WEIGHT: 2,
    mainStatValue, rollEquivalent, decomposeRolls, inferInitialCount, fmt
  };
})(typeof window !== "undefined" ? window : globalThis);
