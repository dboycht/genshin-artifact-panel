/**
 * card-page.js —— 面板图渲染页
 *
 * 两种取数方式：
 *   ① ?id=xxx  → 由本地服务 /api/card-model 提供（正式的出图链路走这条）
 *   ② localStorage 的 `genshin-artifact-panel.cardpreview`（网页里"预览面板图"用）
 *
 * 所有图片都经本地服务 /api/gameimg/ 代理并落盘缓存，避免每次出图都重新下载立绘。
 */
(function () {
  "use strict";

  const SLOT_NUM = { flower: 1, plume: 2, sands: 3, goblet: 4, circlet: 5 };
  const img = name => name ? ("/api/gameimg/" + encodeURIComponent(name) + ".png") : "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const eqGradeCls = g => ({ "ACE": "ACE", "SSS": "SSS", "SS": "SS", "S": "S" }[g] || "");

  function talentIcon(m, type) {
    const icons = (m.icons || {})[type];
    if (icons) return img(icons);
    return "";
  }

  function render(m) {
    const splash = m.internalName ? img("UI_Gacha_AvatarImg_" + m.internalName) : "";
    const elemColor = {
      "火": "#ff7a5c", "水": "#4fc3f7", "风": "#7ee0c0", "雷": "#b388ff",
      "冰": "#8fd8f0", "岩": "#e8c56a", "草": "#9ccc65"
    }[m.element] || "#d9b96a";

    /* ---- 顶部 ---- */
    const talents = [
      ["auto", "普通攻击"], ["skill", "元素战技"], ["burst", "元素爆发"]
    ].map(([k, cap]) => {
      const lv = (m.talents || {})[k];
      const icon = talentIcon(m, k);
      return '<div class="talent"><div class="ring">'
        + (icon ? '<img src="' + esc(icon) + '" alt="" onerror="this.style.display=\'none\'">' : '')
        + '<span class="lv">' + (lv == null ? "—" : lv) + '</span></div>'
        + '<span class="cap">' + cap + '</span></div>';
    }).join("");

    const hero = '<div class="hero">'
      + '<div class="hero-bg"></div>'
      + (splash ? '<img class="splash" src="' + esc(splash) + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<div class="hero-fade"></div>'
      + '<div class="hero-info">'
      + '<div class="hero-name">' + esc(m.name) + '</div>'
      + '<div class="hero-meta">'
      + (m.uid ? 'UID ' + esc(m.uid) + ' · ' : '')
      + 'Lv.<b>' + (m.level == null ? "—" : m.level) + '</b> · '
      + '<b>' + (m.constellation || 0) + '</b>命'
      + (m.element ? ' · <span style="color:' + elemColor + '">' + esc(m.element) + '</span>' : '')
      + '</div>'
      + '<div class="talents">' + talents + '</div>'
      + '</div></div>';

    /* ---- 面板属性 ---- */
    const panel = '<div class="panel"><div class="panel-grid">'
      + (m.rows || []).map(r => {
        const t = r.text;
        const hl = ["critRate", "critDmg", "er", "dmg"].includes(r.key) ? " hl" : "";
        return '<div class="prow' + hl + '">'
          + '<span class="label">' + esc(r.label) + '</span>'
          + '<span class="total">' + esc(t.total) + '</span>'
          + '<span class="split"><span class="b">' + esc(t.base) + '</span> <span class="g">' + esc(t.bonus) + '</span></span>'
          + '</div>';
      }).join("")
      + '</div></div>';

    /* ---- 圣遗物总评 ---- */
    const at = m.artifactTotal || { score: 0, percent: 0, grade: "C" };
    const contrib = (m.contributions || []).slice(0, 6)
      .map(c => '<span class="c">' + esc(c.label) + ' <b>' + esc(c.text) + '</b></span>').join("");
    const total = '<div class="total">'
      + '<div><div class="score">' + at.score.toFixed(1) + ' <small>/ ' + at.perfect.toFixed(1) + '</small></div>'
      + '<div class="cap">圣遗物总分 · 达成度 ' + at.percent.toFixed(1) + '%<span class="grade">' + esc(at.grade) + '</span></div></div>'
      + '<div class="contrib">' + contrib + '</div>'
      + '</div>';

    /* ---- 武器 ---- */
    let weaponCell = "";
    if (m.weapon) {
      const w = m.weapon;
      const subTxt = w.subValue != null && w.subStatText
        ? esc(w.subStatText) + " +" + (Math.round(w.subValue * 1000) / 10) + "%"
        : esc(w.subStatText || "");
      weaponCell = '<div class="eq weapon">'
        + '<div class="eq-head">'
        + (w.icon ? '<img src="' + esc(img(w.icon)) + '" alt="" onerror="this.style.display=\'none\'">' : '')
        + '<div class="nm"><div class="n">' + esc(w.name) + '</div>'
        + '<div class="s">' + (w.rarity || 5) + '★ · 精炼' + (w.refinement || 1) + ' · Lv.' + (w.level || 0) + '</div></div>'
        + '</div>'
        + (subTxt ? '<div class="eq-main"><span class="k">副属性</span><span class="v">' + subTxt + '</span></div>' : '')
        + (w.effect ? '<div class="effect">' + esc(w.effect) + '</div>' : '')
        + '</div>';
    }

    /* ---- 5 件圣遗物 ---- */
    const arts = (m.artifacts || []).map(a => {
      if (a.empty) {
        return '<div class="eq"><div class="eq-head"><div class="nm"><div class="n" style="color:var(--dim)">未录入</div>'
          + '<div class="s">' + esc(a.slotName) + '</div></div></div></div>';
      }
      const icon = a.icon ? img(a.icon) : (a.setId ? img("UI_RelicIcon_" + a.setId + "_" + (SLOT_NUM[a.slot] || 1)) : "");
      const subs = (a.subs || []).map(s => {
        const arr = s.quality === "high" ? ' <span class="arr">≫</span>' : (s.quality === "mid" ? ' <span class="arr">›</span>' : '');
        return '<div class="sub' + (s.effective ? " eff" : "") + '">'
          + '<span class="r">' + esc(s.rollText) + '</span>'
          + '<span class="n' + (s.effective ? "" : " off") + '">' + esc(s.stat.replace("百分比", "")) + arr + '</span>'
          + '<span class="v">' + esc(s.valueText) + '</span>'
          + '</div>';
      }).join("");
      return '<div class="eq">'
        + '<span class="eq-grade ' + eqGradeCls(a.grade) + '">' + esc(a.grade) + '</span>'
        + '<div class="eq-head">'
        + (icon ? '<img src="' + esc(icon) + '" alt="" onerror="this.style.display=\'none\'">' : '')
        + '<div class="nm"><div class="n">' + esc(a.setName) + '</div>'
        + '<div class="s">' + esc(a.slotName) + ' +' + a.level + ' · ' + (a.rarity || 5) + '★' + '</div></div>'
        + '</div>'
        + '<div class="eq-main"><span class="k">' + esc(a.mainStat) + '</span><span class="v">' + esc(a.mainText) + '</span></div>'
        + '<div class="eq-score"><span>' + a.score.toFixed(2) + ' / ' + a.perfect.toFixed(2) + '</span><b>' + a.percent.toFixed(0) + '%</b></div>'
        + '<div class="subs">' + subs + '</div>'
        + '</div>';
    }).join("");

    const foot = '<div class="foot">'
      + '<span>面板来源：' + (m.panelSource === "enka" ? "Enka.Network 实时数据（与游戏内一致）" : "本地静态数值估算（4 件套效果与武器特效未计入）") + '</span>'
      + '<span>生成于 ' + esc(m.generatedAt || "") + '</span>'
      + '</div>';

    document.getElementById("card").innerHTML = hero + panel + total
      + '<div class="equips">' + weaponCell + arts + '</div>' + foot;
  }

  async function boot() {
    const id = new URLSearchParams(location.search).get("id");
    let model = null;
    if (id) {
      try {
        const r = await fetch("/api/card-model?id=" + encodeURIComponent(id));
        if (r.ok) model = await r.json();
      } catch { /* 落到预览模式 */ }
    }
    if (!model) {
      try {
        const raw = localStorage.getItem("genshin-artifact-panel.cardpreview");
        if (raw) model = JSON.parse(raw);
      } catch { /* ignore */ }
    }
    if (!model) {
      document.getElementById("card").innerHTML =
        '<div class="loading">没有可渲染的数据。<br>请从主界面点「导出面板图」。</div>';
      return;
    }
    render(model);
    // 供 CDP 截图端判断"可以截了"
    document.title = "READY";
    window.__cardReady = true;
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
