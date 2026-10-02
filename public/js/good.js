/**
 * good.js —— 数据导入 / 导出
 *
 * 支持三种格式：
 *   ① 本项目备份 JSON（原样存取，含角色配置与权值）
 *   ② GOOD v3 —— 社区事实标准，权威 schema 在 frzyc/genshin-optimizer（MIT）。
 *      注意百分比键尾带下划线：critRate_ / critDMG_ / atk_ / enerRech_；
 *      精通是 eleMas（无下划线）、充能是 enerRech_、元素伤是 xxx_dmg_。
 *      网上常见的 em / er / anemo_ 写法是错的。
 *   ③ 莫娜占卜铺 mona.json（按部位分成 5 个数组，item.equip 为装备者名）
 *
 * 所有外部格式都**没有本项目的权重配置**，导入后按角色自动套用 roles.js 的默认权重。
 */
(function (global) {
  "use strict";
  const C = global.App.constants;

  const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");

  /* ---------- GOOD 词条键 ↔ 中文 ---------- */
  const GOOD2STAT = {
    hp: "生命值", atk: "攻击力", def: "防御力",
    hp_: "生命值百分比", atk_: "攻击力百分比", def_: "防御力百分比",
    eleMas: "元素精通", enerRech_: "元素充能效率",
    critRate_: "暴击率", critDMG_: "暴击伤害", heal_: "治疗加成",
    physical_dmg_: "物理伤害加成",
    pyro_dmg_: "火元素伤害加成", electro_dmg_: "雷元素伤害加成",
    hydro_dmg_: "水元素伤害加成", dendro_dmg_: "草元素伤害加成",
    anemo_dmg_: "风元素伤害加成", geo_dmg_: "岩元素伤害加成", cryo_dmg_: "冰元素伤害加成"
  };
  const STAT2GOOD = {};
  for (const k in GOOD2STAT) STAT2GOOD[GOOD2STAT[k]] = k;

  const GOOD_SLOT2KEY = { flower: "flower", plume: "plume", sands: "sands", goblet: "goblet", circlet: "circlet" };

  /* ---------- 莫娜词条键 ↔ 中文 ---------- */
  const MONA2STAT = {
    lifeStatic: "生命值", lifePercentage: "生命值百分比",
    attackStatic: "攻击力", attackPercentage: "攻击力百分比",
    defenseStatic: "防御力", defensePercentage: "防御力百分比",
    critical: "暴击率", criticalDamage: "暴击伤害",
    elementalMastery: "元素精通", recharge: "元素充能效率",
    heal: "治疗加成", physicalDamage: "物理伤害加成",
    fireDamage: "火元素伤害加成", pyroDamage: "火元素伤害加成",
    waterDamage: "水元素伤害加成", hydroDamage: "水元素伤害加成",
    thunderDamage: "雷元素伤害加成", electroDamage: "雷元素伤害加成",
    iceDamage: "冰元素伤害加成", cryoDamage: "冰元素伤害加成",
    windDamage: "风元素伤害加成", anemoDamage: "风元素伤害加成",
    rockDamage: "岩元素伤害加成", geoDamage: "岩元素伤害加成",
    grassDamage: "草元素伤害加成", dendroDamage: "草元素伤害加成"
  };
  const MONA_SLOT = { flower: "flower", feather: "plume", sand: "sands", cup: "goblet", head: "circlet" };

  /* ---------- 索引：外部键 → 静态表条目 ---------- */
  function buildIndex() {
    const gd = global.App.gamedata;
    const idx = { char: new Map(), weapon: new Map(), set: new Map() };
    const put = (map, keys, val) => { for (const k of keys) { const n = norm(k); if (n && !map.has(n)) map.set(n, val); } };
    for (const c of gd.characters) put(idx.char, [c.goodKey, c.nameEn, c.name, c.slug], c);
    for (const w of gd.weapons) put(idx.weapon, [w.goodKey, w.nameEn, w.name, w.slug], w);
    for (const s of gd.sets) put(idx.set, [s.goodKey, s.nameEn, s.name, s.slug], s);
    return idx;
  }

  /** 判断某外部角色键是否为「未装备」 */
  const isUnassigned = v => v == null || v === "" || String(v).toLowerCase() === "none";

  /* ================= 导入 ================= */

  function detect(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.format === "GOOD" || Array.isArray(raw.artifacts) && Array.isArray(raw.characters)) return "good";
    if (raw.flower && raw.feather && raw.sand && raw.cup && raw.head) return "mona";
    if (Array.isArray(raw.roles)) return "backup";
    return null;
  }

  function importAny(raw) {
    const kind = detect(raw);
    if (kind === "backup") return { roles: raw.roles, kind, warnings: [] };
    if (kind === "good") return importGood(raw);
    if (kind === "mona") return importMona(raw);
    return {
      roles: [], kind: null,
      warnings: ["无法识别的文件格式。支持：本项目备份、GOOD v3（含 artifacts/characters 数组）、莫娜占卜铺 mona.json（含 flower/feather/sand/cup/head 五个数组）。"]
    };
  }

  /** 用导入进来的零散信息组装成内部角色对象 */
  function makeRole(char, partial) {
    const gd = global.App.gamedata;
    const defaults = char ? global.App.roles.defaultsFor(char) : { weights: {}, effectiveStats: [], archetype: null, archetypeLabel: "未识别" };
    const role = {
      id: "imp_" + (char ? char.slug : Math.random().toString(36).slice(2, 8)),
      name: char ? char.name : (partial && partial.name) || "未命名角色",
      charId: char ? char.id : null,
      charSlug: char ? char.slug : null,
      element: char ? char.element : null,
      level: null, ascension: null, constellation: 0,
      talents: { auto: null, skill: null, burst: null },
      weapon: null,
      artifacts: { flower: null, plume: null, sands: null, goblet: null, circlet: null },
      effectiveStats: defaults.effectiveStats.slice(),
      weights: Object.assign({}, defaults.weights),
      archetype: defaults.archetype, archetypeLabel: defaults.archetypeLabel,
      erRequirement: char ? global.App.roles.defaultERRequirement(char) : 120,
      panel: null,
      source: "import"
    };
    return role;
  }

  function importGood(raw) {
    const gd = global.App.gamedata;
    const idx = buildIndex();
    const warnings = [];
    const version = raw.version || 1;
    if (version > 3) warnings.push("GOOD version=" + version + " 高于本项目已知的 3，字段可能不兼容");

    // 角色
    const roles = [];
    const byKey = new Map();
    for (const c of (raw.characters || [])) {
      const key = c.key || c.name;
      const char = idx.char.get(norm(key)) || null;
      if (!char) warnings.push("GOOD 角色未匹配到静态表：" + key + "（按未识别角色导入）");
      const role = makeRole(char, { name: key });
      role.level = c.level != null ? c.level : null;
      role.ascension = c.ascension != null ? c.ascension : null;
      role.constellation = c.constellation != null ? c.constellation : 0;
      if (c.talent) role.talents = { auto: c.talent.auto ?? null, skill: c.talent.skill ?? null, burst: c.talent.burst ?? null };
      roles.push(role);
      byKey.set(norm(key), role);
    }

    // 武器
    for (const w of (raw.weapons || [])) {
      const key = w.key || w.name;
      const wp = idx.weapon.get(norm(key)) || null;
      if (!wp) warnings.push("GOOD 武器未匹配到静态表：" + key);
      if (isUnassigned(w.location)) continue;
      const role = byKey.get(norm(w.location));
      if (!role) { warnings.push("武器「" + key + "」的装备者 " + w.location + " 不在角色列表中，已忽略"); continue; }
      role.weapon = {
        slug: wp ? wp.slug : null, name: wp ? wp.name : String(key),
        rarity: wp ? wp.rarity : null,
        level: w.level != null ? w.level : 1,
        ascension: w.ascension != null ? w.ascension : 0,
        refinement: w.refinement != null ? w.refinement : 1
      };
    }

    // 圣遗物
    let orphan = 0;
    for (const a of (raw.artifacts || [])) {
      const setKey = a.setKey || a.setName;
      const set = idx.set.get(norm(setKey)) || null;
      if (!set) warnings.push("GOOD 套装未匹配到静态表：" + setKey);
      const slot = GOOD_SLOT2KEY[a.slotKey] || a.slotKey;
      if (!C.SLOTS[slot]) { warnings.push("GOOD 部位无法识别：" + a.slotKey); continue; }
      const art = {
        slot, setId: set ? set.id : null,
        setName: set ? set.name : String(setKey || "未知套装"),
        setSlug: set ? set.slug : null,
        rarity: a.rarity != null ? a.rarity : 5,
        level: a.level != null ? a.level : 0,
        mainStat: GOOD2STAT[a.mainStatKey] || a.mainStatKey || null,
        mainValue: null,       // 由显示层按等级推算
        substats: (a.substats || []).map(s => ({
          stat: GOOD2STAT[s.key] || s.key,
          value: s.value,
          activated: true
        })).filter(s => s.stat),
        rollCount: null,
        source: "good"
      };
      if (art.level >= C.MAX_LEVEL) art.initialCount = C.inferInitialCount(art.substats);
      if (isUnassigned(a.location)) { orphan++; continue; }
      const role = byKey.get(norm(a.location));
      if (!role) { warnings.push("圣遗物（" + art.setName + " " + C.SLOTS[slot].name + "）的装备者 " + a.location + " 不在角色列表中，已忽略"); continue; }
      if (role.artifacts[slot]) warnings.push(role.name + " 的 " + C.SLOTS[slot].name + " 部位有多件，只保留第一件");
      else role.artifacts[slot] = art;
    }
    if (orphan) warnings.push("有 " + orphan + " 件圣遗物未装备在任何角色上，已跳过（本项目按角色组织，不做全背包管理）");

    return { roles, kind: "good", warnings };
  }

  function importMona(raw) {
    const idx = buildIndex();
    const warnings = [];
    const byName = new Map();
    let bag = 0;
    for (const mslot in MONA_SLOT) {
      for (const item of (raw[mslot] || [])) {
        if (!item) continue;
        if (!item.equip) { bag++; continue; }
        const name = String(item.equip).trim();
        if (!byName.has(name)) {
          const char = idx.char.get(norm(name)) || null;
          if (!char) warnings.push("莫娜数据里的角色未匹配到静态表：" + name);
          byName.set(name, makeRole(char, { name }));
        }
        const role = byName.get(name);
        const setEn = item.setName;
        const set = idx.set.get(norm(setEn)) || null;
        if (!set) warnings.push("莫娜套装未匹配到静态表：" + setEn);
        const slot = MONA_SLOT[mslot];
        if (role.artifacts[slot]) continue;
        role.artifacts[slot] = {
          slot, setId: set ? set.id : null,
          setName: set ? set.name : String(setEn || "未知套装"),
          setSlug: set ? set.slug : null,
          rarity: item.star || item.rarity || 5,
          level: item.level || 0,
          mainStat: MONA2STAT[item.mainTag && item.mainTag.name] || (item.mainTag && item.mainTag.name) || null,
          mainValue: null,
          substats: (item.normalTags || []).map(t => ({
            stat: MONA2STAT[t.name] || t.name,
            value: t.value,
            activated: true
          })).filter(s => s.stat),
          rollCount: null,
          source: "mona"
        };
        const art = role.artifacts[slot];
        if (art.level >= C.MAX_LEVEL) art.initialCount = C.inferInitialCount(art.substats);
      }
    }
    if (bag) warnings.push("莫娜数据里有 " + bag + " 件背包装备，已跳过（本项目不做全背包管理）");
    return { roles: [...byName.values()], kind: "mona", warnings };
  }

  /* ================= 导出 ================= */

  /** 导出本项目备份（含权值配置，可完整还原） */
  function exportBackup(roles) {
    return {
      format: "genshin-artifact-panel-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      roles
    };
  }

  /** 导出 GOOD v3（只含圣遗物/角色/武器，不含本项目的权值配置） */
  function exportGood(roles) {
    const gd = global.App.gamedata;
    const characters = [], weapons = [], artifacts = [];
    for (const r of roles) {
      const char = gd.charByNameOrId(r.charSlug || r.name);
      characters.push({
        key: char ? char.goodKey : r.name,
        level: r.level || 1,
        ascension: r.ascension || 0,
        constellation: r.constellation || 0,
        talent: { auto: (r.talents || {}).auto || 1, skill: (r.talents || {}).skill || 1, burst: (r.talents || {}).burst || 1 }
      });
      if (r.weapon && r.weapon.slug) {
        const w = gd.weaponByNameOrId(r.weapon.slug);
        weapons.push({
          key: w ? w.goodKey : r.weapon.name,
          level: r.weapon.level || 1, ascension: r.weapon.ascension || 0,
          refinement: r.weapon.refinement || 1, location: char ? char.goodKey : r.name, lock: false
        });
      }
      for (const slot of C.SLOT_KEYS) {
        const a = r.artifacts && r.artifacts[slot];
        if (!a) continue;
        const set = gd.setByIdOrName(a.setId != null ? a.setId : a.setName);
        artifacts.push({
          setKey: set ? set.goodKey : a.setName,
          slotKey: GOOD_SLOT2KEY[slot],
          level: a.level || 0,
          rarity: a.rarity || 5,
          mainStatKey: STAT2GOOD[a.mainStat] || a.mainStat,
          location: char ? char.goodKey : r.name,
          lock: false,
          substats: (a.substats || []).map(s => ({ key: STAT2GOOD[s.stat] || s.stat, value: s.value }))
        });
      }
    }
    return { format: "GOOD", version: 3, source: "genshin-artifact-panel", characters, weapons, artifacts };
  }

  global.App = global.App || {};
  global.App.io2 = { detect, importAny, importGood, importMona, exportBackup, exportGood, GOOD2STAT, STAT2GOOD, MONA2STAT, norm };
})(typeof window !== "undefined" ? window : globalThis);
