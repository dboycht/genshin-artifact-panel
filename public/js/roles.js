/**
 * roles.js —— 角色「有效词条 + 权值」表
 *
 * 【重要声明】
 *   提瓦特小助手 / ysin 等工具的练度与评分权重**均未公开**，不存在可对齐的权威数值。
 *   本表的权值口径是**本项目自定**的启发式结果，不声称与任何第三方一致；
 *   界面上必须提供手动修改入口（见 weights 可编辑）。
 *
 * 【生成规则（可复核）】
 *   依据角色自身的**突破加成属性**（genshin-db 的 substatType）判定养成倾向——
 *   突破加什么，通常就吃什么，这是从游戏数据本身得出的强信号，而非抄任何权重表：
 *     FIGHT_PROP_CRITICAL / _CRITICAL_HURT / _ATTACK_PERCENT → 暴击输出型
 *     FIGHT_PROP_HP_PERCENT                                  → 生命型
 *     FIGHT_PROP_DEFENSE_PERCENT                             → 防御型
 *     FIGHT_PROP_ELEMENT_MASTERY                             → 精通型
 *     FIGHT_PROP_CHARGE_EFFICIENCY                           → 充能型
 *   再叠加一张**治疗角色名单**（本代理依据公开角色定位整理），把治疗位单独归为治疗型。
 *
 * 【权值刻度】
 *   1.0 = 「一条满档副词条 = 1 个标准词条」。
 *   在该刻度下 暴击率 与 暴击伤害 取等权，恰好复现社区惯用的双爆分 CV = 2×暴击率 + 暴击伤害
 *   （因为 1 条满档暴击率 3.89% × 2 = 7.78% ≈ 1 条满档暴击伤害 7.77%）。
 */
(function (global) {
  "use strict";

  // 治疗/护盾定位角色（公开角色定位，用于归入治疗型）
  const HEALERS = new Set([
    "芭芭拉", "七七", "琴", "迪奥娜", "珊瑚宫心海", "白术", "久岐忍", "班尼特",
    "早柚", "米卡", "希格雯", "夏沃蕾", "闲云", "卡齐娜", "绮良良", "莱依拉",
    "钟离", "托马", "辛焱", "迪希雅", "坎蒂丝"
  ]);

  // 各倾向的权值模板（0~2 刻度）
  const ARCHETYPES = {
    dps: {
      label: "暴击输出型",
      weights: {
        "暴击率": 1.0, "暴击伤害": 1.0, "攻击力百分比": 0.75,
        "元素精通": 0.25, "元素充能效率": 0.25, "攻击力": 0.1,
        "生命值百分比": 0, "防御力百分比": 0, "生命值": 0, "防御力": 0
      }
    },
    hp: {
      label: "生命型",
      weights: {
        "生命值百分比": 1.0, "暴击率": 0.75, "暴击伤害": 0.75,
        "元素充能效率": 0.5, "元素精通": 0.25, "攻击力百分比": 0.25,
        "生命值": 0.1, "攻击力": 0, "防御力百分比": 0, "防御力": 0
      }
    },
    def: {
      label: "防御型",
      weights: {
        "防御力百分比": 1.0, "暴击率": 0.75, "暴击伤害": 0.75,
        "元素充能效率": 0.5, "攻击力百分比": 0.25, "防御力": 0.1,
        "元素精通": 0, "生命值百分比": 0, "生命值": 0, "攻击力": 0
      }
    },
    em: {
      label: "精通型",
      weights: {
        "元素精通": 1.0, "元素充能效率": 0.75, "暴击率": 0.5,
        "暴击伤害": 0.5, "攻击力百分比": 0.25, "生命值百分比": 0.25,
        "生命值": 0, "防御力百分比": 0, "攻击力": 0, "防御力": 0
      }
    },
    er: {
      label: "充能型",
      weights: {
        "元素充能效率": 1.0, "暴击率": 0.75, "暴击伤害": 0.75,
        "攻击力百分比": 0.5, "元素精通": 0.25, "生命值百分比": 0.25,
        "攻击力": 0, "生命值": 0, "防御力百分比": 0, "防御力": 0
      }
    },
    heal: {
      label: "治疗/护盾型",
      weights: {
        "生命值百分比": 1.0, "元素充能效率": 1.0, "元素精通": 0.25,
        "暴击率": 0.25, "暴击伤害": 0.25, "攻击力百分比": 0.25,
        "生命值": 0.1, "防御力百分比": 0.1, "攻击力": 0, "防御力": 0
      }
    }
  };

  const SPEC_TO_ARCH = {
    "FIGHT_PROP_CRITICAL": "dps",
    "FIGHT_PROP_CRITICAL_HURT": "dps",
    "FIGHT_PROP_ATTACK_PERCENT": "dps",
    "FIGHT_PROP_HP_PERCENT": "hp",
    "FIGHT_PROP_DEFENSE_PERCENT": "def",
    "FIGHT_PROP_ELEMENT_MASTERY": "em",
    "FIGHT_PROP_CHARGE_EFFICIENCY": "er"
  };

  /** 依据角色静态数据推断原型 key */
  function archetypeOf(char) {
    if (char && HEALERS.has(char.name)) return "heal";
    const a = char && SPEC_TO_ARCH[char.substatType];
    return a || "dps";
  }

  /** 生成某角色的默认有效词条与权值 */
  function defaultsFor(char) {
    const key = archetypeOf(char);
    const tpl = ARCHETYPES[key];
    const weights = {};
    const effectiveStats = [];
    for (const stat in tpl.weights) {
      const w = tpl.weights[stat];
      if (w > 0) { effectiveStats.push(stat); weights[stat] = w; }
    }
    return { archetype: key, archetypeLabel: tpl.label, weights, effectiveStats };
  }

  /** 充能需求默认值：充能权重高说明靠充能循环 → 需求定高一点 */
  function defaultERRequirement(char) {
    const a = archetypeOf(char);
    if (a === "er") return 200;
    if (a === "em" || a === "heal") return 160;
    return 120;
  }

  /** 同步有效词条集：保证「有权值的都在有效集里、有效集里的都有权值」 */
  function syncEffective(weights) {
    return Object.keys(weights || {}).filter(k => (weights[k] || 0) > 0);
  }

  global.App = global.App || {};
  global.App.roles = {
    HEALERS, ARCHETYPES, SPEC_TO_ARCH,
    archetypeOf, defaultsFor, defaultERRequirement, syncEffective
  };
})(typeof window !== "undefined" ? window : globalThis);
