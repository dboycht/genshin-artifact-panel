/**
 * gamedata.js —— 静态养成数据（角色 / 武器 / 套装 / 成长曲线）
 *
 * 数据由 tools/build-gamedata.mjs 从 genshin-db（MIT）裁剪生成，见 assets/gamedata/。
 * 属性合成公式按 genshin-db 的口径（MIT）复刻：
 *   角色 hp/atk/def = base × curve[等级][曲线名] + 突破加成
 *   武器 攻击        = base.attack × curve[等级][曲线名] + 突破加成
 *   武器 副属性      = base.specialized × curve[等级][副属性曲线名]
 *   突破档判定见 promotionBonus()（等级落在突破临界点时由 ascension 决定取前档还是后档）
 */
(function (global) {
  "use strict";

  const G = {
    ready: false,
    characters: [], charBySlug: {}, charById: {}, charByName: {},
    charStats: {}, weapons: [], weaponBySlug: {}, weaponById: {}, weaponByName: {},
    weaponStats: {}, sets: [], setById: {}, setByName: {}, curves: {}
  };

  const DIR = "gamedata/";

  async function load(dir) {
    const base = dir || DIR;
    const files = ["characters.json", "character-stats.json", "weapons.json",
      "weapon-stats.json", "artifact-sets.json", "curves.json"];
    const got = await Promise.all(files.map(f =>
      fetch(base + f).then(r => {
        if (!r.ok) throw new Error("读取 " + f + " 失败：" + r.status);
        return r.json();
      })
    ));
    const [chars, cstats, weapons, wstats, sets, curves] = got;

    G.characters = chars;
    G.charStats = cstats;
    for (const c of chars) {
      G.charBySlug[c.slug] = c;
      G.charById[c.id] = c;
      G.charByName[c.name] = c;
    }
    G.weapons = weapons;
    G.weaponStats = wstats;
    for (const w of weapons) {
      G.weaponBySlug[w.slug] = w;
      G.weaponById[w.id] = w;
      G.weaponByName[w.name] = w;
    }
    G.sets = sets;
    for (const s of sets) {
      G.setById[s.id] = s;
      // 套装重名（同一套装的 4★/5★ 版本）时保留 id 较大的那个
      G.setByName[s.name] = s;
    }
    G.curves = curves;
    G.ready = true;
    return G;
  }

  /** 突破档判定：返回 [阶段索引, 该阶段加成对象] */
  function promotionBonus(promotions, level, ascension) {
    for (let i = promotions.length - 2; i >= 0; i--) {
      if (level > promotions[i].maxlevel) return [i + 1, promotions[i + 1]];
      if (level === promotions[i].maxlevel) {
        if (Number.isFinite(ascension) && ascension > i || ascension === "+") return [i + 1, promotions[i + 1]];
        return [i, promotions[i]];
      }
    }
    return [0, promotions[0]];
  }

  /** 角色在 (等级, 突破阶段) 的基础属性；ascension 省略时按「未突破」处理 */
  function charBaseAt(slug, level, ascension) {
    const s = G.charStats[slug];
    if (!s) return null;
    const lv = Math.max(1, Math.min(100, parseInt(level, 10) || 1));
    const [phase, promo] = promotionBonus(s.promotion, lv, ascension);
    const cur = G.curves.characters[lv] || {};
    const x = n => (typeof n === "number" ? n : 1);
    const out = {
      level: lv, ascension: phase,
      hp: s.base.hp * x(cur[s.curve.hp]) + (promo.hp || 0),
      attack: s.base.attack * x(cur[s.curve.attack]) + (promo.attack || 0),
      defense: s.base.defense * x(cur[s.curve.defense]) + (promo.defense || 0),
      specialized: promo.specialized || 0,
      specializedType: s.specialized,
      // 当突破加的是暴击率/暴击伤害时，genshin-db 口径的 specialized 已把
      // 角色固有的 5% 暴击率 / 50% 暴击伤害**包含在内**，调用方不可再加一次基础值。
      specializedIs: null
    };
    // 暴击率/暴击伤害为「突破加成」的角色，基础值要叠加基础暴击
    if (s.specialized === "FIGHT_PROP_CRITICAL") {
      out.specialized += (s.base.critrate || 0);
      out.specializedIs = "critRate";
    } else if (s.specialized === "FIGHT_PROP_CRITICAL_HURT") {
      out.specialized += (s.base.critdmg || 0);
      out.specializedIs = "critDmg";
    }
    return out;
  }

  /** 武器在 (等级, 突破阶段) 的基础攻击与副属性值 */
  function weaponAt(slug, level, ascension) {
    const s = G.weaponStats[slug];
    if (!s) return null;
    const maxLv = s.promotion[s.promotion.length - 1].maxlevel;
    const lv = Math.max(1, Math.min(maxLv, parseInt(level, 10) || 1));
    const [, promo] = promotionBonus(s.promotion, lv, ascension);
    const cur = G.curves.weapons[lv] || {};
    const x = n => (typeof n === "number" ? n : 1);
    return {
      level: lv,
      attack: s.base.attack * x(cur[s.curve.attack]) + (promo.attack || 0),
      specialized: s.base.specialized * x(cur[s.curve.specialized])
    };
  }

  /* ---------- 套装 2 件套效果：只静态解析「无条件、单一属性」型 ---------- */

  const PCT_STAT_PAT = [
    [/^攻击力提高/, "攻击力百分比"],
    [/^生命值上限提高|^生命值提高/, "生命值百分比"],
    [/^防御力提高/, "防御力百分比"],
    [/^元素充能效率提高/, "元素充能效率"],
    [/^暴击率提高/, "暴击率"],
    [/^暴击伤害提高/, "暴击伤害"],
    [/^治疗加成提高/, "治疗加成"],
    [/^物理伤害加成提高/, "物理伤害加成"],
    [/^元素精通提高/, "元素精通"]
  ];

  /**
   * 解析 2 件套效果文本。
   * 只接受「<属性>提高<数值>[%|点]。」这种无条件单属性形式，其余返回 null（面板中标注为未计入）。
   * @returns {null | {stat:string, value:number}}
   */
  function parseSimple2pc(text) {
    if (!text || typeof text !== "string") return null;
    const t = text.trim();
    for (const [re, stat] of PCT_STAT_PAT) {
      if (!re.test(t)) continue;
      const m = t.match(/提高(\d+(?:\.\d+)?)\s*(%|点)?/);
      if (!m) continue;
      const rest = t.slice(t.indexOf(m[0]) + m[0].length).replace(/[。．.\s]/g, "");
      if (rest) return null;                       // 后面还有别的效果 → 不当作简单型
      return { stat, value: parseFloat(m[1]) };
    }
    // 元素伤害加成：2 件套里只有「X元素伤害加成提高15%」
    const m2 = t.match(/^(火|水|雷|冰|风|岩|草)元素伤害加成提高(\d+(?:\.\d+)?)%/);
    if (m2) {
      const rest = t.slice(m2[0].length).replace(/[。．.\s]/g, "");
      if (!rest) return { stat: m2[1] + "元素伤害加成", value: parseFloat(m2[2]) };
    }
    return null;
  }

  /* ---------- 查询辅助 ---------- */

  function charByNameOrId(key) {
    if (key == null) return null;
    if (typeof key === "number") return G.charById[key] || null;
    const s = String(key).trim();
    return G.charByName[s] || G.charBySlug[s.toLowerCase().replace(/\s/g, "")] || null;
  }
  function weaponByNameOrId(key) {
    if (key == null) return null;
    if (typeof key === "number") return G.weaponById[key] || null;
    const s = String(key).trim();
    return G.weaponByName[s] || G.weaponBySlug[s.toLowerCase().replace(/\s/g, "")] || null;
  }
  function setByIdOrName(key) {
    if (key == null) return null;
    if (typeof key === "number") return G.setById[key] || null;
    const s = String(key).trim();
    return G.setByName[s] || G.setById[parseInt(s, 10)] || null;
  }

  /** 按武器类型列出武器（用于下拉） */
  function weaponsOfType(weaponType) {
    if (!weaponType) return G.weapons;
    return G.weapons.filter(w => w.weaponType === weaponType);
  }

  global.App = global.App || {};
  global.App.gamedata = Object.assign(G, {
    load, charBaseAt, weaponAt, promotionBonus, parseSimple2pc,
    charByNameOrId, weaponByNameOrId, setByIdOrName, weaponsOfType
  });
})(typeof window !== "undefined" ? window : globalThis);
