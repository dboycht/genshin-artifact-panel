/**
 * enka.js —— Enka.Network 数据获取与解析
 *
 * 接口：GET https://enka.network/api/uid/{UID}
 *   由本地服务 /api/enka?uid= 代理转发（Enka 不返回 CORS 头，浏览器直连会被拦）。
 *   官方开发者文档：https://github.com/EnkaNetwork/API-docs
 *
 * 【实测踩到的三个坑，已在本文件中处理】
 *   1) reliquary.level 是「游戏内等级 + 1」（+20 的圣遗物返回 21）→ 必须 −1
 *   2) 官方文档写字段名 propValue，**实际返回的是 statValue** → 两者都兼容
 *   3) 未在游戏内开启「显示角色详情」或角色不在展柜时，avatarInfoList 直接缺失
 *      → 不是错误，要给出可操作的提示
 */
(function (global) {
  "use strict";
  const C = global.App.constants;

  // FIGHT_PROP_* → 本项目的中文词条名
  const PROP2STAT = {
    FIGHT_PROP_HP: "生命值",
    FIGHT_PROP_ATTACK: "攻击力",
    FIGHT_PROP_DEFENSE: "防御力",
    FIGHT_PROP_HP_PERCENT: "生命值百分比",
    FIGHT_PROP_ATTACK_PERCENT: "攻击力百分比",
    FIGHT_PROP_DEFENSE_PERCENT: "防御力百分比",
    FIGHT_PROP_CRITICAL: "暴击率",
    FIGHT_PROP_CRITICAL_HURT: "暴击伤害",
    FIGHT_PROP_CHARGE_EFFICIENCY: "元素充能效率",
    FIGHT_PROP_ELEMENT_MASTERY: "元素精通",
    FIGHT_PROP_HEAL_ADD: "治疗加成",
    FIGHT_PROP_PHYSICAL_ADD_HURT: "物理伤害加成",
    FIGHT_PROP_FIRE_ADD_HURT: "火元素伤害加成",
    FIGHT_PROP_ELEC_ADD_HURT: "雷元素伤害加成",
    FIGHT_PROP_WATER_ADD_HURT: "水元素伤害加成",
    FIGHT_PROP_GRASS_ADD_HURT: "草元素伤害加成",
    FIGHT_PROP_WIND_ADD_HURT: "风元素伤害加成",
    FIGHT_PROP_ROCK_ADD_HURT: "岩元素伤害加成",
    FIGHT_PROP_ICE_ADD_HURT: "冰元素伤害加成"
  };

  /** 经本地服务代理拉取展柜数据 */
  async function fetchUid(uid) {
    const u = String(uid || "").trim();
    if (!/^\d{6,12}$/.test(u)) throw new Error("UID 应为 6~12 位数字");
    const res = await fetch("/api/enka?uid=" + encodeURIComponent(u));
    let body = null;
    try { body = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok) {
      const msg = (body && body.error) || ("请求失败 HTTP " + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.detail = body && body.detail;
      throw err;
    }
    return body;
  }

  const propVal = o => (o == null ? null : (o.val != null ? o.val : o.ival));
  /** Enka 的 propMap 值为字符串（如 "90"），一律转成数字；非法值返回 null */
  const numOrNull = v => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };

  /**
   * 解析 Enka 响应 → { player, roles[], warnings[] }
   * roles 的结构与评分层的数据模型一致。
   */
  function parse(data) {
    const gd = global.App.gamedata;
    const warnings = [];
    const out = { player: null, roles: [], warnings };

    if (!data || typeof data !== "object") { warnings.push("响应不是合法 JSON"); return out; }
    const pi = data.playerInfo || {};
    out.player = {
      uid: data.uid || null,
      nickname: pi.nickname || "",
      level: pi.level || null,
      signature: pi.signature || "",
      worldLevel: pi.worldLevel || null,
      region: data.region || "",
      ttl: data.ttl || null,
      showcaseCount: (pi.showAvatarInfoList || []).length
    };

    const list = data.avatarInfoList;
    if (!Array.isArray(list) || list.length === 0) {
      warnings.push("该 UID 没有返回任何角色详情。游戏内需满足：① 在「角色展柜」放入角色（最多 8 个）；② 打开「显示角色详情」；③ 数据有约 1 分钟缓存，刚改完请稍后再试。");
      return out;
    }

    for (const av of list) {
      try {
        out.roles.push(parseAvatar(av, warnings));
      } catch (e) {
        warnings.push("角色 " + av.avatarId + " 解析失败：" + e.message);
      }
    }
    out.roles.sort((a, b) => (b.panel && b.panel.atk || 0) - (a.panel && a.panel.atk || 0));
    return out;
  }

  function parseAvatar(av, warnings) {
    const gd = global.App.gamedata;
    const char = gd.charById[av.avatarId] || null;
    const level = numOrNull(propVal(av.propMap && av.propMap["4001"]));
    const ascension = numOrNull(propVal(av.propMap && av.propMap["1002"]));
    const constellation = Array.isArray(av.talentIdList) ? av.talentIdList.length : 0;

    // 天赋等级：skillLevelMap 的键是 skillId，用 avatar-skills.json 区分普攻/战技/爆发
    const talents = { auto: null, skill: null, burst: null };
    const skillMap = (global.App.avatarskills || {})[String(av.avatarId)];
    if (skillMap && av.skillLevelMap) {
      for (const type of ["auto", "skill", "burst"]) {
        const id = skillMap[type];
        if (id != null && av.skillLevelMap[id] != null) talents[type] = av.skillLevelMap[id];
      }
    }
    let unmappedTalents = null;
    if (!skillMap && av.skillLevelMap) {
      const vals = Object.values(av.skillLevelMap);
      unmappedTalents = vals;
      warnings.push((char ? char.name : av.avatarId) + "：缺少技能映射，天赋只能给出等级列表（" + vals.join("/") + "）");
    }

    // 装备
    let weapon = null;
    const artifacts = { flower: null, plume: null, sands: null, goblet: null, circlet: null };
    const equipList = Array.isArray(av.equipList) ? av.equipList : [];
    for (const eq of equipList) {
      if (eq.weapon) {
        const w = gd.weaponById[eq.itemId] || null;
        const affix = eq.weapon.affixMap || {};
        const refinement = 1 + (Object.values(affix)[0] || 0);   // affix 是 0~4 → 精炼 1~5
        weapon = {
          slug: w ? w.slug : null,
          itemId: eq.itemId,
          name: w ? w.name : ("武器#" + eq.itemId),
          rarity: eq.flat ? eq.flat.rankLevel : null,
          icon: eq.flat ? eq.flat.icon : null,
          level: eq.weapon.level,
          ascension: eq.weapon.promoteLevel,
          refinement
        };
        if (!w) warnings.push("未知武器 id " + eq.itemId + "（静态表未收录，可能是新武器）");
      } else if (eq.reliquary) {
        const slot = C.ENKA_SLOT[eq.flat && eq.flat.equipType];
        if (!slot) { warnings.push("未知圣遗物部位 " + (eq.flat && eq.flat.equipType)); continue; }
        artifacts[slot] = parseRelic(eq, slot, warnings);
      }
    }

    // 面板（Enka 直接给了算好的最终面板）
    const panel = global.App.scoring.panelFromFightProp(av.fightPropMap, char && char.element);
    if (char) panel.element = char.element;

    // 默认词条与权值
    let weights = {}, effectiveStats = [], archetype = "dps", archetypeLabel = "未识别";
    let erRequirement = null;
    if (char) {
      const d = global.App.roles.defaultsFor(char);
      weights = Object.assign({}, d.weights);
      effectiveStats = d.effectiveStats.slice();
      archetype = d.archetype; archetypeLabel = d.archetypeLabel;
      erRequirement = global.App.roles.defaultERRequirement(char);
    } else {
      warnings.push("未知角色 id " + av.avatarId + "（静态表未收录）");
    }

    const role = {
      id: "enka_" + av.avatarId,
      name: char ? char.name : ("角色#" + av.avatarId),
      charId: av.avatarId,
      charSlug: char ? char.slug : null,
      element: char ? char.element : null,
      level, ascension, constellation, talents, unmappedTalents,
      weapon, artifacts,
      effectiveStats, weights, archetype, archetypeLabel, erRequirement,
      panel,
      source: "enka"
    };
    // 充能需求没把握时，用「面板充能」兜一个，避免门槛判定误报
    if (role.erRequirement == null && panel && isFinite(panel.er)) role.erRequirement = Math.floor(panel.er);
    return role;
  }

  function parseRelic(eq, slot, warnings) {
    const gd = global.App.gamedata;
    const r = eq.reliquary || {};
    const flat = eq.flat || {};
    const setId = flat.setId != null ? flat.setId : null;
    const set = setId != null ? gd.setById[setId] : null;
    if (setId != null && !set) warnings.push("未知套装 id " + setId);

    // 坑 1：level 是「游戏等级 + 1」
    const level = Math.max(0, (isFinite(r.level) ? r.level : 1) - 1);
    // 坑 2：文档写 propValue，实际字段是 statValue
    const val = o => (o == null ? null : (o.statValue != null ? o.statValue : o.propValue));

    const ms = flat.reliquaryMainstat || {};
    const mainStat = PROP2STAT[ms.mainPropId] || ms.mainPropId || null;
    const mainValue = val(ms);

    const substats = (flat.reliquarySubstats || []).map(s => ({
      stat: PROP2STAT[s.appendPropId] || s.appendPropId,
      value: val(s),
      activated: true
    })).filter(s => s.stat && isFinite(s.value));

    // 强化 roll 总数：appendPropIdList 的条目数就是总 roll 数
    const rollIds = Array.isArray(r.appendPropIdList) ? r.appendPropIdList : null;
    const rollCount = rollIds ? rollIds.length : null;
    // 总 roll 9 = 4 初始，8 = 3 初始；否则用数值反推兜底
    let initialCount = rollCount === 9 ? 4 : (rollCount === 8 ? 3 : null);
    if (initialCount == null && level >= C.MAX_LEVEL && substats.length === 4) {
      initialCount = C.inferInitialCount(substats);
    }

    return {
      slot, setId,
      setName: set ? set.name : (setId != null ? ("套装#" + setId) : "未知套装"),
      setSlug: set ? set.slug : null,
      rarity: flat.rankLevel || null,
      icon: flat.icon || null,
      level, mainStat, mainValue, substats,
      rollCount, initialCount,
      source: "enka"
    };
  }

  global.App = global.App || {};
  global.App.enka = { fetchUid, parse, PROP2STAT };
})(typeof window !== "undefined" ? window : globalThis);
