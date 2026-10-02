/**
 * scoring.js —— 评分引擎（圣遗物评分 / 角色练度评分 / 面板）
 *
 * 【口径与出处】
 *  单件圣遗物评分 = Σ (副词条数值 ÷ 该词条满档单发值 Umax) × 该角色权值
 *    ——「滚数当量」口径，主词条不参与副词条评分（另按部位正确性单独判定）。
 *  角色评分满分基准 = Σ_部位 [ 初始最优 min(4,|E|) 条权值和 + 5 × 该部位最高权值 ]
 *    —— 即「客观完美态」动态满分，所以 percent 是角色内的相对达成度，不是全服排名。
 *  充能：不足只打标签不扣分；超额按当量扣分（避免堆无用充能刷分）。
 *    （以上口径参考 aumveil/genshin-artifact-scorer，MIT, © 2026 秋晨，并按其定稿算法文档实现）
 *
 *  ⚠️ 练度综合分（buildRating）是小助手等工具**均未公开**的口径，本项目的权重为自定，
 *     界面上必须与「圣遗物评分」区分标注，不能声称与任何第三方一致。
 */
(function (global) {
  "use strict";
  const C = global.App.constants;

  /* ================= 一、单件圣遗物 ================= */

  /** 该部位可用有效词条集 E(slot) = 有效词条 − {该部位主词条}（主副词条不重复） */
  function effectiveSetFor(role, slot) {
    const eff = (role.effectiveStats || []).slice();
    const art = role.artifacts && role.artifacts[slot];
    const ms = art && art.mainStat;
    return (ms && eff.includes(ms)) ? eff.filter(x => x !== ms) : eff;
  }

  /** 单件评分：只计入「有效词条」的滚数当量 × 权值 */
  function artifactScore(art, role) {
    if (!art || !role) return 0;
    const eff = role.effectiveStats || [];
    const w = role.weights || {};
    let total = 0;
    for (const s of (art.substats || [])) {
      if (s.activated === false) continue;
      if (!eff.includes(s.stat)) continue;
      const wt = w[s.stat];
      if (!wt) continue;
      total += C.rollEquivalent(s.stat, s.value) * wt;
    }
    return total;
  }

  /** 该部位「完美态」得分 = 初始最优 min(4,|E|) 条权值和 + 5 × 该部位最高权值 */
  function perfectSlot(role, slot) {
    const es = effectiveSetFor(role, slot);
    const w = role.weights || {};
    const top = es.slice().sort((a, b) => (w[b] || 0) - (w[a] || 0)).slice(0, Math.min(4, es.length));
    const init = top.reduce((s, k) => s + (w[k] || 0), 0);
    const maxW = es.reduce((m, k) => Math.max(m, w[k] || 0), 0);
    return init + 5 * maxW;
  }

  /** 充能超额惩罚：超出需求的部分按滚数当量全额扣 */
  function energyPenalty(role, panelER) {
    const er = role.erRequirement;
    const cur = isFinite(panelER) ? panelER : role.currentER;
    if (!isFinite(er) || !isFinite(cur)) return 0;
    const excess = Math.max(0, (cur - er) / C.UMAX["元素充能效率"]);
    return excess * ((role.weights || {})["元素充能效率"] || 0);
  }

  /** 一件圣遗物对面板的等价属性合计（主词条 + 副词条），用于列表展示 */
  function artifactStatLines(art) {
    if (!art) return [];
    const out = [];
    if (art.mainStat) out.push({ stat: art.mainStat, value: art.mainValue != null ? art.mainValue : C.mainStatValue(art.mainStat, art.level), main: true });
    for (const s of (art.substats || [])) {
      if (s.activated === false) continue;
      out.push({ stat: s.stat, value: s.value, main: false });
    }
    return out;
  }

  /* ================= 二、角色练度评分（自定口径） ================= */

  // 各维度权重（合计 1.0）——本项目自定义，非任何第三方口径
  const BUILD_WEIGHTS = {
    artifact: 0.40,   // 圣遗物有效词条数达成度
    talent: 0.20,     // 关键天赋等级
    level: 0.15,      // 角色等级
    weapon: 0.15,     // 武器等级 + 精炼
    crit: 0.10        // 面板双爆达成度
  };
  // 参考阈值（社区口径，用于把连续量映射到 0~1）
  const REF = { artifactWords: 28, critRate: 70, critDmg: 140 };

  const clamp01 = v => Math.max(0, Math.min(1, v));

  /**
   * 练度综合评分（0~100）＋ 分维度明细。
   * @param role    角色配置
   * @param panel   面板（Enka 真值或离线估算），可空
   */
  function buildRating(role, panel) {
    const gd = global.App.gamedata;
    const dims = {};

    // 1) 圣遗物：有效词条数 / 28
    let words = 0;
    for (const slot of C.SLOT_KEYS) words += artifactScore(role.artifacts && role.artifacts[slot], role);
    dims.artifact = { value: clamp01(words / REF.artifactWords), raw: Math.round(words * 100) / 100, max: REF.artifactWords, label: "圣遗物有效词条" };

    // 2) 天赋：平均关键天赋等级 / 10
    const t = role.talents || {};
    const tlv = [t.auto, t.skill, t.burst].filter(v => isFinite(v));
    dims.talent = {
      value: tlv.length ? clamp01((tlv.reduce((a, b) => a + b, 0) / tlv.length) / 10) : 0,
      raw: tlv.length ? (tlv.reduce((a, b) => a + b, 0) / tlv.length) : null, max: 10, label: "天赋等级"
    };

    // 3) 等级：(等级 − 1) / 89
    const lv = isFinite(role.level) ? role.level : null;
    dims.level = { value: lv ? clamp01((lv - 1) / 89) : 0, raw: lv, max: 90, label: "角色等级" };

    // 4) 武器：0.6 × 等级/90 + 0.4 × 精炼/5
    const wlv = role.weapon && isFinite(role.weapon.level) ? role.weapon.level : null;
    const ref = role.weapon && isFinite(role.weapon.refinement) ? role.weapon.refinement : null;
    dims.weapon = {
      value: wlv ? (0.6 * clamp01(wlv / 90) + 0.4 * clamp01((ref || 1) / 5)) : 0,
      raw: wlv, max: 90, label: "武器等级/精炼"
    };

    // 5) 双爆：0.5 × min(暴击率,100)/70 + 0.5 × 暴击伤害/140
    const isPctPanel = panel && isFinite(panel.critRate) && isFinite(panel.critDmg);
    dims.crit = {
      value: isPctPanel
        ? clamp01(0.5 * clamp01(Math.min(panel.critRate, 100) / REF.critRate) + 0.5 * clamp01(panel.critDmg / REF.critDmg))
        : 0,
      raw: isPctPanel ? (panel.critRate.toFixed(1) + " / " + panel.critDmg.toFixed(1)) : null,
      max: "70 / 140", label: "面板双爆"
    };

    let total = 0;
    for (const k in BUILD_WEIGHTS) total += BUILD_WEIGHTS[k] * (dims[k] ? dims[k].value : 0);

    // 充能门槛：不达标按比例扣分（超额不加分）
    const tags = [];
    const erReq = role.erRequirement;
    const erNow = panel && isFinite(panel.er) ? panel.er : (isFinite(role.currentER) ? role.currentER : null);
    let erFactor = 1;
    if (isFinite(erReq) && isFinite(erNow)) {
      if (erNow < erReq) {
        erFactor = 0.85;
        tags.push("充能不足，缺 " + (erReq - erNow).toFixed(1) + "%");
      } else {
        tags.push("充能满足需求（" + erNow.toFixed(1) + "% ≥ " + erReq + "%）");
      }
    } else if (isFinite(erReq)) {
      tags.push("未获取到面板充能，无法判定充能门槛");
    }

    const score = Math.round(total * erFactor * 1000) / 10;
    return {
      score,                       // 0~100
      dims, weights: BUILD_WEIGHTS,
      erFactor, tags,
      grade: gradeOf(score)
    };
  }

  function gradeOf(s) {
    if (s >= 90) return "毕业";
    if (s >= 78) return "高练";
    if (s >= 62) return "小毕业";
    if (s >= 45) return "及格";
    if (s >= 28) return "起步";
    return "待养成";
  }

  /* ================= 三、角色圣遗物评分汇总 ================= */

  function characterScore(role, panel) {
    let words = 0, perfect = 0;
    const perSlot = {};
    for (const slot of C.SLOT_KEYS) {
      const art = role.artifacts && role.artifacts[slot];
      const s = artifactScore(art, role);
      const p = perfectSlot(role, slot);
      perSlot[slot] = { score: s, perfect: p, percent: p > 0 ? Math.max(0, s / p * 100) : 0 };
      words += s; perfect += p;
    }
    const penalty = energyPenalty(role, panel && panel.er);
    const adjusted = words - penalty;
    const tags = [];
    const erReq = role.erRequirement;
    const erNow = panel && isFinite(panel.er) ? panel.er : role.currentER;
    if (isFinite(erReq) && isFinite(erNow) && erNow < erReq) tags.push("充能不足，缺 " + (erReq - erNow).toFixed(1) + "%");
    return {
      words, adjustedWords: adjusted, perfect, penalty, tags, perSlot,
      percent: perfect > 0 ? Math.max(0, adjusted / perfect * 100) : 0
    };
  }

  /* ================= 四、面板 ================= */

  const EMPTY_PANEL = () => ({
    hp: null, baseHp: null, atk: null, baseAtk: null, def: null, baseDef: null,
    critRate: null, critDmg: null, er: null, em: null,
    dmg: {}, heal: null, source: null, incomplete: null
  });

  // Enka fightPropMap 的 prop id（小数比例口径：0.5194 = 51.94%）
  const FP = {
    baseHp: 1, hp: 2000, baseAtk: 4, atk: 2001, baseDef: 7, def: 2002,
    critRate: 20, critDmg: 22, er: 23, em: 28, heal: 50,
    phys: 30, pyro: 40, electro: 41, hydro: 42, dendro: 43, anemo: 44, geo: 45, cryo: 46
  };
  const ELEM_BY_PROP = { 40: "火", 41: "雷", 42: "水", 43: "草", 44: "风", 45: "岩", 46: "冰" };

  /** 由 Enka fightPropMap 生成真实面板（比例一律转百分数） */
  function panelFromFightProp(fpm, element) {
    const p = EMPTY_PANEL();
    if (!fpm) return p;
    const g = id => (isFinite(fpm[id]) ? fpm[id] : null);
    const pct = id => { const v = g(id); return v == null ? null : v * 100; };
    p.hp = g(FP.hp); p.baseHp = g(FP.baseHp);
    p.atk = g(FP.atk); p.baseAtk = g(FP.baseAtk);
    p.def = g(FP.def); p.baseDef = g(FP.baseDef);
    p.critRate = pct(FP.critRate); p.critDmg = pct(FP.critDmg);
    p.er = pct(FP.er); p.em = g(FP.em); p.heal = pct(FP.heal);
    p.dmg = {};
    for (const id in ELEM_BY_PROP) {
      const v = pct(id);
      if (v != null) p.dmg[ELEM_BY_PROP[id]] = v;
    }
    const ph = pct(FP.phys);
    if (ph != null) p.dmg["物理"] = ph;
    p.source = "enka";
    return p;
  }

  /**
   * 离线估算面板：角色基础 + 武器 + 圣遗物主副词条 + 可静态解析的 2 件套效果。
   * 不计入：4 件套的条件型效果、武器特效、队伍增益。结果整体标注为「估算」。
   */
  function estimatePanel(role) {
    const gd = global.App.gamedata;
    const p = EMPTY_PANEL();
    if (!gd || !gd.ready) return p;
    const skipped = [];
    // 突破加成 + 武器副属性的累加器（与圣遗物加成合并后再套公式）
    const spec = { pctHp: 0, pctAtk: 0, pctDef: 0, cr: 0, cd: 0, er: 0, em: 0 };

    // 1) 角色基础
    const ch = gd.charByNameOrId(role.charSlug || role.name);
    let baseHp = 0, baseAtk = 0, baseDef = 0;
    let specIs = null;
    if (ch) {
      const b = gd.charBaseAt(ch.slug, role.level || 1, role.ascension);
      if (b) {
        baseHp = b.hp; baseAtk = b.attack; baseDef = b.defense;
        p.element = ch.element;
        specIs = b.specializedIs;
        applySpecialized(spec, ch.substatType, b.specialized);
      }
    }
    // 2) 武器
    let wAtk = 0;
    if (role.weapon && role.weapon.slug) {
      const w = gd.weaponByNameOrId(role.weapon.slug);
      const ws = gd.weaponAt(role.weapon.slug, role.weapon.level || 1, role.weapon.ascension);
      if (w && ws) {
        wAtk = ws.attack;
        applySpecialized(spec, w.mainStatType, ws.specialized);
      }
      if (w && w.refinements) skipped.push("武器特效（" + (w.effectName || w.name) + "）未计入");
    }

    // 3) 圣遗物主副词条 + 2 件套
    let flatHp = 0, flatAtk = 0, flatDef = 0, pctHp = 0, pctAtk = 0, pctDef = 0;
    let cr = 0, cd = 0, er = 0, em = 0, heal = 0;
    const dmg = {};
    const setCount = {};
    for (const slot of C.SLOT_KEYS) {
      const art = role.artifacts && role.artifacts[slot];
      if (!art) continue;
      if (art.meta || art.rarity) skipped.push("圣遗物星级按 5★ 处理");
      if (art.setId != null) setCount[art.setId] = (setCount[art.setId] || 0) + 1;
      const main = art.mainStat;
      const mv = art.mainValue != null ? art.mainValue : C.mainStatValue(main, art.level);
      const acc = (stat, val) => {
        switch (stat) {
          case "生命值": flatHp += val; break;
          case "攻击力": flatAtk += val; break;
          case "防御力": flatDef += val; break;
          case "生命值百分比": pctHp += val; break;
          case "攻击力百分比": pctAtk += val; break;
          case "防御力百分比": pctDef += val; break;
          case "暴击率": cr += val; break;
          case "暴击伤害": cd += val; break;
          case "元素充能效率": er += val; break;
          case "元素精通": em += val; break;
          case "治疗加成": heal += val; break;
          default:
            if (/元素伤害加成|物理伤害加成/.test(stat)) dmg[stat] = (dmg[stat] || 0) + val;
        }
      };
      acc(main, mv);
      for (const s of (art.substats || [])) {
        if (s.activated === false) continue;
        acc(s.stat, s.value);
      }
    }
    // 2 件套
    let setBonusApplied = 0;
    for (const setId in setCount) {
      if (setCount[setId] < 2) continue;
      const set = gd.setById[parseInt(setId, 10)];
      if (!set) continue;
      const eff = gd.parseSimple2pc(set.effect2Pc);
      if (!eff) { skipped.push("「" + set.name + "」2 件套效果不是无条件单属性型，未计入面板"); continue; }
      switch (eff.stat) {
        case "生命值百分比": pctHp += eff.value; break;
        case "攻击力百分比": pctAtk += eff.value; break;
        case "防御力百分比": pctDef += eff.value; break;
        case "元素充能效率": er += eff.value; break;
        case "暴击率": cr += eff.value; break;
        case "暴击伤害": cd += eff.value; break;
        case "治疗加成": heal += eff.value; break;
        case "元素精通": em += eff.value; break;
        default: dmg[eff.stat] = (dmg[eff.stat] || 0) + eff.value;
      }
      setBonusApplied++;
    }
    // 4 件套一律未计入（条件型效果无法静态求值）
    for (const setId in setCount) {
      if (setCount[setId] >= 4) {
        const set = gd.setById[parseInt(setId, 10)];
        skipped.push("「" + (set ? set.name : setId) + "」4 件套效果未计入面板");
      }
    }

    p.baseHp = baseHp || null;
    p.baseAtk = (baseAtk + wAtk) || null;
    p.baseDef = baseDef || null;
    const P = (base, pct) => (base ? base * (1 + pct / 100) : 0);
    p.hp = baseHp ? P(baseHp, pctHp + spec.pctHp) + flatHp : null;
    p.atk = (baseAtk + wAtk) ? P(baseAtk + wAtk, pctAtk + spec.pctAtk) + flatAtk : null;
    p.def = baseDef ? P(baseDef, pctDef + spec.pctDef) + flatDef : null;
    // 角色固有 5% 暴击率 / 50% 暴击伤害：当突破加成就是该项时，spec 里已经含了，不能再加
    p.critRate = (specIs === "critRate" ? 0 : 5) + cr + spec.cr;
    p.critDmg = (specIs === "critDmg" ? 0 : 50) + cd + spec.cd;
    p.er = 100 + er + spec.er;
    p.em = em + spec.em;
    p.heal = (heal || spec.heal) || null;
    if (spec.phys) dmg["物理"] = (dmg["物理"] || 0) + spec.phys;
    p.dmg = dmg;
    p.source = "estimate";
    p.incomplete = [...new Set(skipped)];
    p.appliedSet2pc = setBonusApplied;
    return p;
  }

  /**
   * 把「FIGHT_PROP_*」口径的突破加成/武器副属性累加进 spec（比例 → 百分数）。
   * @param spec 累加器 {pctHp,pctAtk,pctDef,cr,cd,er,em}
   */
  function applySpecialized(spec, propKey, value) {
    if (!spec || !propKey || !isFinite(value)) return;
    switch (propKey) {
      case "FIGHT_PROP_HP_PERCENT": spec.pctHp += value * 100; break;
      case "FIGHT_PROP_ATTACK_PERCENT": spec.pctAtk += value * 100; break;
      case "FIGHT_PROP_DEFENSE_PERCENT": spec.pctDef += value * 100; break;
      case "FIGHT_PROP_CRITICAL": spec.cr += value * 100; break;
      case "FIGHT_PROP_CRITICAL_HURT": spec.cd += value * 100; break;
      case "FIGHT_PROP_CHARGE_EFFICIENCY": spec.er += value * 100; break;
      case "FIGHT_PROP_ELEMENT_MASTERY": spec.em += value; break;
      case "FIGHT_PROP_HEAL_ADD": spec.heal = (spec.heal || 0) + value * 100; break;
      case "FIGHT_PROP_PHYSICAL_ADD_HURT": spec.phys = (spec.phys || 0) + value * 100; break;
      default: break;
    }
  }

  global.App = global.App || {};
  global.App.scoring = {
    effectiveSetFor, artifactScore, perfectSlot, energyPenalty,
    characterScore, artifactStatLines,
    buildRating, gradeOf, BUILD_WEIGHTS, REF,
    panelFromFightProp, estimatePanel, EMPTY_PANEL, FP, ELEM_BY_PROP
  };
})(typeof window !== "undefined" ? window : globalThis);
