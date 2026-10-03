/**
 * card.js —— 面板图的数据模型
 *
 * 把内部角色对象整理成「画图需要的一切」，与渲染方式解耦：
 *   panelRows()      → 面板每行的 总值 / 白字 / 绿字（对齐参考图的三列）
 *   artifactCards()  → 5 件圣遗物卡（单件分、评级、主词条、逐条副词条的 roll 当量）
 *   buildModel()     → 上面两者 + 头部信息 + 圣遗物总分/评级 + 分项统计
 *
 * 【关于「roll 当量」】
 *   参考图里每条副词条前的数字（如 `3.2 暴击率`）是
 *     数值 ÷ 该词条的「平均档位」
 *   平均档位 = 满档单发值 Umax × 0.85（四档 0.7/0.8/0.9/1.0 等概率）。
 *   实测校验：+10.5% 暴击率 → 10.5 / 3.3065 = 3.18 ≈ 3.2 ✓
 *             +15.3% 大防御 → 15.3 / 6.1965 = 2.47 ≈ 2.5 ✓
 *             +41.7  小防御 → 41.7 / 19.6775 = 2.12 ≈ 2.1 ✓
 */
(function (global) {
  "use strict";
  const C = global.App.constants;
  const SC = global.App.scoring;

  /* ---------- 面板三列 ---------- */

  /** 角色突破加成里属于暴击/爆伤的量（genshin-db 口径的 specialized 已含固有值） */
  function ascensionCrit(role) {
    const gd = global.App.gamedata;
    const char = gd.charByNameOrId(role.charSlug || role.name);
    if (!char) return { cr: 0, cd: 0 };
    const b = gd.charBaseAt(char.slug, role.level || 90, role.ascension);
    if (!b) return { cr: 0, cd: 0 };
    if (b.specializedIs === "critRate") return { cr: Math.max(0, b.specialized * 100 - 5), cd: 0 };
    if (b.specializedIs === "critDmg") return { cr: 0, cd: Math.max(0, b.specialized * 100 - 50) };
    return { cr: 0, cd: 0 };
  }

  /**
   * 面板行：每行 { key, label, total, base, bonus, unit, digits }
   * base = 白字（角色/武器基础 + 固有值），bonus = 绿字（圣遗物与各种加成）
   */
  function panelRows(role, panel) {
    const asc = ascensionCrit(role);
    const rows = [];
    const push = (key, label, total, base, unit, digits) => {
      if (total == null || !isFinite(total)) return;
      const b = base == null || !isFinite(base) ? 0 : base;
      rows.push({
        key, label, total, base: b, bonus: total - b, unit: unit || "", digits: digits == null ? 1 : digits
      });
    };

    push("hp", "生命值", panel.hp, panel.baseHp, "", 0);
    push("atk", "攻击力", panel.atk, panel.baseAtk, "", 1);
    push("def", "防御力", panel.def, panel.baseDef, "", 1);
    push("em", "元素精通", panel.em, 0, "", 1);
    push("critRate", "暴击率", panel.critRate, 5 + asc.cr, "%", 1);
    push("critDmg", "暴击伤害", panel.critDmg, 50 + asc.cd, "%", 1);
    push("er", "元素充能", panel.er, 100, "%", 1);

    // 伤害加成：取该角色元素对应的那一项（没有则取最高的正项）
    const dmg = panel.dmg || {};
    const char = global.App.gamedata.charByNameOrId(role.charSlug || role.name);
    const ownKey = char ? C.ELEMENT_DMG[char.element] : null;
    let dmgVal = ownKey && dmg[ownKey] != null ? dmg[ownKey] : 0;
    if (!dmgVal) {
      const best = Object.entries(dmg).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
      if (best) dmgVal = best[1];
    }
    push("dmg", "伤害加成", dmgVal, 0, "%", 1);
    return rows;
  }

  /** 面板行的数字格式化（千分位 + 位数 + 正负号） */
  function fmtRow(r) {
    const f = v => {
      if (v == null || !isFinite(v)) return "—";
      const n = r.digits === 0 ? Math.round(v) : Math.round(v * 10) / 10;
      return n.toLocaleString("en-US", { minimumFractionDigits: r.digits === 0 ? 0 : 1, maximumFractionDigits: r.digits === 0 ? 0 : 1 }) + r.unit;
    };
    const sign = v => (v >= 0 ? "+" : "") + f(v);
    return { total: f(r.total), base: f(r.base), bonus: sign(r.bonus) };
  }

  /* ---------- 副词条 roll 当量 ---------- */

  /**
   * 一条副词条的 roll 当量（数值 ÷ 平均档位）与档位质量标记。
   * @returns {{rolls:number, text:string, quality:'high'|'mid'|'low'}}
   */
  function subRoll(stat, value) {
    const avg = C.SUB_STAT_AVG[stat];
    const umax = C.UMAX[stat];
    if (!avg || !umax || !isFinite(value)) return { rolls: 0, text: "0", quality: "low" };
    const rolls = value / avg;
    // 档位质量：把 roll 数四舍五入到整数后，看实际值占「整数次满档」的比例
    const nearest = Math.max(1, Math.round(rolls));
    const ratio = value / (nearest * umax);
    let quality = "low";
    if (ratio >= 0.9) quality = "high";
    else if (ratio >= 0.8) quality = "mid";
    return { rolls, text: (Math.round(rolls * 10) / 10).toFixed(1), quality, ratio: Math.round(ratio * 100) };
  }

  /** 单件圣遗物的评级（按单件分占该部位完美分的比例；阈值见 README） */
  const ARTIFACT_GRADES = [
    [90, "ACE"], [80, "SSS"], [70, "SS"], [58, "S"], [45, "A"], [30, "B"], [0, "C"]
  ];
  function artifactGrade(percent) {
    for (const [min, label] of ARTIFACT_GRADES) if (percent >= min) return label;
    return "C";
  }

  /**
   * 5 件圣遗物卡。
   * @param role  内部角色对象
   * @param score SC.characterScore(role, panel) 的结果
   */
  function artifactCards(role, score) {
    return C.SLOT_KEYS.map(slot => {
      const art = role.artifacts && role.artifacts[slot];
      const meta = (score && score.perSlot && score.perSlot[slot]) || { score: 0, perfect: 0, percent: 0 };
      if (!art) return { slot, slotName: C.SLOTS[slot].name, empty: true };
      const mainValue = art.mainValue != null ? art.mainValue : C.mainStatValue(art.mainStat, art.level);
      const eff = role.effectiveStats || [];
      const isMainEffective = eff.includes(art.mainStat);
      const subs = (art.substats || [])
        .filter(s => s.activated !== false)
        .map(s => {
          const r = subRoll(s.stat, s.value);
          return {
            stat: s.stat, value: s.value,
            effective: eff.includes(s.stat),
            rolls: r.rolls, rollText: r.text, quality: r.quality, ratio: r.ratio,
            valueText: C.fmt(s.stat, s.value)
          };
        })
        .sort((a, b) => (b.effective - a.effective) || (b.rolls - a.rolls));

      return {
        slot, slotName: C.SLOTS[slot].name, empty: false,
        setName: art.setName, setId: art.setId, icon: art.icon || null,
        level: art.level, rarity: art.rarity || 5,
        mainStat: art.mainStat, mainValue,
        mainText: C.fmt(art.mainStat, mainValue),
        mainEffective: isMainEffective && C.SUB_STATS.includes(art.mainStat),
        score: meta.score, perfect: meta.perfect, percent: meta.percent,
        grade: artifactGrade(meta.percent),
        initialCount: art.initialCount, rollCount: art.rollCount,
        subs
      };
    });
  }

  /* ---------- 分项统计（对齐参考图那六格） ---------- */

  /**
   * 统计这套圣遗物对各项属性的贡献当量（把副词条的 roll 当量按词条汇总）。
   * 参考图显示形如「暴击 +50.9%」「防御 +74.1」「生命 +507.9」——
   * 前两个是百分比词条的合计数值，后两个是固定值词条的合计数值。
   */
  function contributionStats(role) {
    const pct = {}, flat = {};
    for (const slot of C.SLOT_KEYS) {
      const art = role.artifacts && role.artifacts[slot];
      if (!art) continue;
      for (const s of (art.substats || [])) {
        if (s.activated === false) continue;
        const isPct = C.STAT_TYPE[s.stat] === "percent";
        const bucket = isPct ? pct : flat;
        const key = s.stat.replace("百分比", "").replace("元素", "");
        bucket[key] = (bucket[key] || 0) + s.value;
      }
    }
    const out = [];
    for (const [k, v] of Object.entries(pct)) out.push({ key: k, label: k, value: v, text: "+" + v.toFixed(1) + "%", pct: true });
    for (const [k, v] of Object.entries(flat)) out.push({ key: k, label: k, value: v, text: "+" + (Math.round(v * 10) / 10), pct: false });
    return out.sort((a, b) => b.value - a.value);
  }

  /* ---------- 总模型 ---------- */

  function buildModel(role, opts) {
    const o = opts || {};
    const panel = (role.panel && role.panel.source === "enka") ? role.panel : SC.estimatePanel(role);
    const score = SC.characterScore(role, panel);
    const rating = SC.buildRating(role, panel);
    const gd = global.App.gamedata;
    const char = gd.charByNameOrId(role.charSlug || role.name);
    const weaponMeta = role.weapon && role.weapon.slug ? gd.weaponByNameOrId(role.weapon.slug) : null;
    // 立绘与天赋图标名：来自 avatar-skills.json（由 Enka 公开数据字典抽取）
    const av = (global.App.avatarskills || {})[String(role.charId)] || {};

    // 圣遗物总评级：用总达成度映射到同一套分档
    const totalGrade = artifactGrade(score.percent);

    return {
      uid: o.uid || null,
      name: role.name,
      element: role.element,
      charId: role.charId,
      level: role.level,
      constellation: role.constellation || 0,
      talents: role.talents || {},
      internalName: av.internalName || null,
      icons: av.icons || {},
      splash: o.splash || null,           // 立绘本地缓存路径（由调用方解析）
      panelSource: panel.source,
      rows: panelRows(role, panel).map(r => Object.assign(r, { text: fmtRow(r) })),
      rating,
      artifactTotal: { score: score.words, perfect: score.perfect, percent: score.percent, grade: totalGrade },
      contributions: contributionStats(role),
      weapon: role.weapon ? {
        name: role.weapon.name,
        rarity: role.weapon.rarity || (weaponMeta ? weaponMeta.rarity : 5),
        level: role.weapon.level,
        refinement: role.weapon.refinement,
        icon: role.weapon.icon || null,
        subStatText: weaponMeta ? weaponMeta.mainStatText : "",
        subValue: weaponMeta && weaponMeta.slug
          ? (gd.weaponAt(weaponMeta.slug, role.weapon.level || 1, role.weapon.ascension) || {}).specialized
          : null,
        effect: weaponMeta ? (weaponMeta.refinements[(role.weapon.refinement || 1) - 1] || "") : ""
      } : null,
      artifacts: artifactCards(role, score),
      generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      tool: "genshin-artifact-panel"
    };
  }

  global.App = global.App || {};
  global.App.card = {
    panelRows, fmtRow, subRoll, artifactCards, contributionStats, buildModel,
    artifactGrade, ARTIFACT_GRADES, ascensionCrit
  };
})(typeof window !== "undefined" ? window : globalThis);
