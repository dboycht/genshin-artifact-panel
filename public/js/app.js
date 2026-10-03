/**
 * app.js —— 界面与状态
 *
 * 数据全部留在浏览器本地（localStorage），服务端不落任何玩家数据。
 */
(function () {
  "use strict";
  const C = App.constants;
  const SC = App.scoring;
  const GD = App.gamedata;
  const IO = App.io2;

  const LS_KEY = "genshin-artifact-panel.roles.v1";
  const ELEMENT_COLOR = {
    "火": "#ff7a5c", "水": "#4fc3f7", "风": "#7ee0c0", "雷": "#b388ff",
    "冰": "#8fd8f0", "岩": "#e8c56a", "草": "#9ccc65"
  };
  const PANEL_ROWS = [
    ["hp", "生命值上限", ""], ["atk", "攻击力", ""], ["def", "防御力", ""],
    ["em", "元素精通", ""], ["critRate", "暴击率", "%"], ["critDmg", "暴击伤害", "%"],
    ["er", "元素充能效率", "%"], ["heal", "治疗加成", "%"]
  ];

  const state = {
    roles: [], selected: null, player: null,
    banner: null, loading: false
  };
  const $ = s => document.querySelector(s);

  /* ================= 启动 ================= */

  async function boot() {
    try {
      await GD.load();
    } catch (e) {
      showBanner("err", "静态数值表加载失败：" + e.message + "。请确认通过本地服务（启动.bat）打开，而不是直接双击 index.html。");
      return;
    }
    // 技能映射（区分普攻/战技/爆发）——缺了也能跑，只是天赋不分项
    try {
      const r = await fetch("gamedata/avatar-skills.json");
      App.avatarskills = r.ok ? await r.json() : {};
    } catch { App.avatarskills = {}; }

    restore();
    $("#ver").textContent = "v1.0.1 · 静态表 " + GD.characters.length + " 角色 / " + GD.weapons.length + " 武器 / " + GD.sets.length + " 套装";
    bind();
    renderAll();

    const q = new URLSearchParams(location.search).get("uid");
    if (q) { $("#uidInput").value = q; doQuery(false); }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.roles)) {
        state.roles = data.roles;
        state.player = data.player || null;
        state.selected = state.roles[0] ? state.roles[0].id : null;
      }
    } catch (e) { console.warn("本地数据读取失败", e); }
  }
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ roles: state.roles, player: state.player }));
    } catch (e) { showBanner("warn", "本地保存失败（可能是浏览器存储已满）：" + e.message); }
  }

  /* ================= 事件 ================= */

  function bind() {
    $("#btnQuery").addEventListener("click", () => doQuery(false));
    $("#btnRefresh").addEventListener("click", () => doQuery(true));
    $("#uidInput").addEventListener("keydown", e => { if (e.key === "Enter") doQuery(false); });
    $("#btnImport").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", onFile);
    $("#btnExportBackup").addEventListener("click", () => download(IO.exportBackup(state.roles), "圣遗物面板-备份-" + today() + ".json"));
    $("#btnExportGood").addEventListener("click", () => download(IO.exportGood(state.roles), "GOOD-" + today() + ".json"));
    $("#btnExportCard").addEventListener("click", () => exportCard(null));
    $("#btnExportAll").addEventListener("click", exportAllCards);
    $("#btnAddManual").addEventListener("click", addManual);
    $("#btnClear").addEventListener("click", () => {
      if (!confirm("确定清空本机保存的全部角色数据？此操作不可撤销（建议先导出备份）。")) return;
      state.roles = []; state.selected = null; state.player = null;
      persist(); renderAll();
    });

    /**
     * 把角色的「面板图数据模型」交给本地服务渲染成 PNG 并下载。
     * 真正的截图在服务端用本机 Chrome 无头完成（见 tools/render.mjs）。
     * @returns {Promise<boolean>} 是否成功
     */
    async function exportCard(role) {
      const r = role || current();
      if (!r) { showBanner("warn", "请先在左侧选择一个角色。"); return false; }
      if (!App.card) { showBanner("err", "面板图模块（card.js）未加载。"); return false; }
      const btn = $("#btnExportCard");
      const oldText = btn.textContent;
      btn.disabled = true; btn.textContent = "出图中…";
      showBanner("info", "正在渲染「" + r.name + "」的面板图。首次出图要下载立绘（约 1~2 MB），会慢几秒…");
      try {
        const model = App.card.buildModel(r, {
          uid: state.player && state.player.uid ? state.player.uid : null
        });
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model, width: 900, scale: 2 })
        });
        if (!res.ok) {
          let msg = "HTTP " + res.status;
          try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* 非 JSON */ }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const fname = "面板图-" + r.name + "-" + today() + ".png";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showBanner("info", "已导出 " + fname + "（" + Math.round(blob.size / 1024) + " KB）");
        return true;
      } catch (e) {
        showBanner("err", "出图失败：" + e.message
          + "。若提示找不到 Chrome，请确认本机装了 Chrome 或 Edge；也可用 CHROME_PATH 环境变量指定。");
        return false;
      } finally {
        btn.disabled = false; btn.textContent = oldText;
      }
    }

    /** 为列表里每个角色逐个出图（串行，避免同时拉起多个无头 Chrome） */
    async function exportAllCards() {
      if (!state.roles.length) { showBanner("warn", "还没有角色，先查 UID 或导入数据。"); return; }
      if (!App.card) { showBanner("err", "面板图模块（card.js）未加载。"); return; }
      if (!confirm("将为 " + state.roles.length + " 个角色逐个出图，每张约几秒。继续？")) return;
      const btn = $("#btnExportAll");
      btn.disabled = true;
      let okCount = 0, badCount = 0;
      for (let i = 0; i < state.roles.length; i++) {
        btn.textContent = "出图 " + (i + 1) + "/" + state.roles.length;
        const okOne = await exportCard(state.roles[i]);
        if (okOne) okCount++; else badCount++;
      }
      btn.disabled = false; btn.textContent = "批量出图";
      showBanner(badCount ? "warn" : "info",
        "批量出图完成：成功 " + okCount + " 张" + (badCount ? "，失败 " + badCount + " 张" : "") + "。");
    }
  }

  const today = () => new Date().toLocaleDateString("sv");

  async function doQuery(force) {
    const uid = $("#uidInput").value.trim();
    if (!/^\d{6,12}$/.test(uid)) { showBanner("warn", "请输入 6~12 位数字 UID。"); return; }
    setLoading(true);
    showBanner("info", "正在向 Enka.Network 查询 UID " + uid + "…" + (force ? "（强制刷新，可能受 Enka 限流）" : ""));
    try {
      const data = await App.enka.fetchUid(uid);
      const parsed = App.enka.parse(data);
      state.player = parsed.player;

      if (!parsed.roles.length) {
        showBanner("warn", "没有取得角色数据。" + parsed.warnings.join(" "));
        setLoading(false);
        return;
      }
      // 合并策略：同角色名覆盖，其余保留
      const byName = new Map(state.roles.map(r => [r.name, r]));
      let added = 0, updated = 0;
      for (const nr of parsed.roles) {
        if (byName.has(nr.name)) { updated++; byName.set(nr.name, nr); }
        else { byName.set(nr.name, nr); added++; }
      }
      state.roles = [...byName.values()];
      state.selected = parsed.roles[0].id;
      persist(); renderAll();

      const msgs = ["已获取 " + parsed.roles.length + " 个展柜角色（新增 " + added + "，更新 " + updated + "）。"];
      if (parsed.player.ttl) msgs.push("Enka 缓存 " + parsed.player.ttl + " 秒。");
      if (parsed.warnings.length) msgs.push("注意：" + parsed.warnings.join(" "));
      showBanner(parsed.warnings.length ? "warn" : "info", msgs.join(" "));
    } catch (e) {
      showBanner("err", e.message + (e.detail ? "（" + e.detail + "）" : ""));
    } finally {
      setLoading(false);
    }
  }

  function setLoading(on) {
    state.loading = on;
    $("#btnQuery").disabled = on;
    $("#btnQuery").textContent = on ? "查询中…" : "查询 UID";
  }

  async function onFile(ev) {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      const raw = JSON.parse(text.replace(/^\ufeff/, ""));
      const res = IO.importAny(raw);
      if (!res.roles || !res.roles.length) {
        showBanner("err", "没有导入任何角色。" + (res.warnings || []).join(" "));
        return;
      }
      const mode = confirm("导入 " + res.roles.length + " 个角色。\n\n点「确定」= 合并（同名角色覆盖）\n点「取消」= 全部替换");
      if (mode) {
        const byName = new Map(state.roles.map(r => [r.name, r]));
        for (const r of res.roles) byName.set(r.name, r);
        state.roles = [...byName.values()];
      } else {
        state.roles = res.roles;
      }
      state.selected = res.roles[0].id;
      persist(); renderAll();
      const w = res.warnings || [];
      showBanner(w.length ? "warn" : "info",
        "导入完成（格式：" + (res.kind || "未知") + "，角色 " + res.roles.length + " 个）。"
        + (w.length ? " 有 " + w.length + " 条提示：" : "")
        + (w.length ? "<ul>" + w.slice(0, 12).map(x => "<li>" + esc(x) + "</li>").join("") + (w.length > 12 ? "<li>…其余 " + (w.length - 12) + " 条已省略</li>" : "") + "</ul>" : ""));
    } catch (e) {
      showBanner("err", "导入失败：" + e.message);
    }
  }

  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showBanner("info", "已导出 " + filename);
  }

  function addManual() {
    if (!GD.ready) return;
    const name = prompt("输入角色名（需与游戏内一致，例如：神里绫华）");
    if (!name) return;
    const char = GD.charByNameOrId(name.trim());
    if (!char) { showBanner("warn", "静态表里找不到角色「" + name + "」，请检查写法。"); return; }
    const d = App.roles.defaultsFor(char);
    const role = {
      id: "m_" + char.slug + "_" + Date.now(),
      name: char.name, charId: char.id, charSlug: char.slug, element: char.element,
      level: 90, ascension: 6, constellation: 0,
      talents: { auto: 1, skill: 1, burst: 1 },
      weapon: null,
      artifacts: { flower: null, plume: null, sands: null, goblet: null, circlet: null },
      effectiveStats: d.effectiveStats.slice(), weights: Object.assign({}, d.weights),
      archetype: d.archetype, archetypeLabel: d.archetypeLabel,
      erRequirement: App.roles.defaultERRequirement(char),
      panel: null, source: "manual"
    };
    state.roles.push(role);
    state.selected = role.id;
    persist(); renderAll();
    showBanner("info", "已新增「" + char.name + "」。手动录入模式下没有 Enka 面板，面板栏会用静态数据估算（4 件套效果不计入）。");
  }

  /* ================= 渲染 ================= */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function showBanner(kind, html) {
    const el = $("#banner");
    el.className = "banner " + kind;
    el.innerHTML = html;
    if (kind !== "info") return;
    clearTimeout(showBanner._t);
  }

  function renderAll() { renderList(); renderDetail(); }

  function renderList() {
    const ul = $("#roleList");
    $("#roleCount").textContent = state.roles.length ? state.roles.length + " 个角色" : "";
    const p = state.player;
    $("#playerInfo").textContent = p
      ? (p.nickname ? p.nickname + " · " : "") + "UID " + (p.uid || "—") + (p.region ? " · " + p.region : "")
      : "尚未查询";
    ul.innerHTML = state.roles.map(r => {
      const sc = selectedScore(r);
      const color = ELEMENT_COLOR[r.element] || "#666";
      return '<li data-id="' + esc(r.id) + '" class="' + (r.id === state.selected ? "active" : "") + '">'
        + '<span class="rn"><i class="el" style="background:' + color + '"></i><span>' + esc(r.name) + '</span></span>'
        + '<span class="rs">' + (sc == null ? "—" : sc.toFixed(1)) + '</span></li>';
    }).join("");
    ul.querySelectorAll("li").forEach(li => li.addEventListener("click", () => {
      state.selected = li.dataset.id;
      renderAll();
    }));
  }

  /** 当前选中角色的练度分（列表与详情共用） */
  function selectedScore(r) {
    try {
      const panel = panelOf(r);
      return SC.buildRating(r, panel).score;
    } catch { return null; }
  }

  function current() { return state.roles.find(r => r.id === state.selected) || null; }

  /** 面板：Enka 真值优先，否则静态估算 */
  function panelOf(role) {
    if (role.panel && role.panel.source === "enka") return role.panel;
    return SC.estimatePanel(role);
  }

  function renderDetail() {
    const role = current();
    const box = $("#detail");
    if (!role) {
      box.innerHTML = '<div class="empty"><h2>还没有数据</h2><p>在上方输入 UID 查询角色展柜，或点「导入」载入 JSON 文件。</p></div>';
      return;
    }
    const panel = panelOf(role);
    const rating = SC.buildRating(role, panel);
    const score = SC.characterScore(role, panel);

    box.innerHTML = head(role, panel) + cardRating(role, rating, score) + cardPanel(panel, role)
      + cardArtifacts(role, score) + cardWeights(role);
    bindDetail(role);
  }

  function head(role, panel) {
    const isEnka = panel.source === "enka";
    return '<div class="detail-head">'
      + '<h2>' + esc(role.name) + '</h2>'
      + (role.element ? '<span class="pill" style="border-color:' + (ELEMENT_COLOR[role.element] || "#666") + '">' + esc(role.element) + '</span>' : '')
      + '<span class="pill">' + esc(role.archetypeLabel || "—") + '</span>'
      + '<span class="pill ' + (isEnka ? "enka" : "est") + '">'
      + (isEnka ? "面板：Enka 真实值" : "面板：离线估算") + '</span>'
      + '<span class="pill">' + esc(role.source === "enka" ? "展柜数据" : role.source === "good" ? "GOOD 导入" : role.source === "mona" ? "莫娜导入" : "手动录入") + '</span>'
      + '</div>';
  }

  function cardRating(role, rating, score) {
    const dims = Object.keys(rating.weights).map(k => {
      const d = rating.dims[k]; if (!d) return "";
      const pct = (d.value * 100).toFixed(0);
      const shown = d.raw == null ? "无数据" : d.raw + (typeof d.max === "number" ? " / " + d.max : d.max ? "（参考 " + d.max + "）" : "");
      return '<div class="dim"><span class="nm">' + esc(d.label) + '</span>'
        + '<span class="bar"><i style="width:' + pct + '%"></i></span>'
        + '<span class="v">' + esc(shown) + '</span></div>';
    }).join("");

    return '<div class="card"><h3>练度评分 <span class="note">权重为本项目自定口径（小助手等未公开该口径），可手动调整</span></h3>'
      + '<div class="score-grid">'
      + '<div class="big-score"><div class="num">' + rating.score.toFixed(1) + '<small> / 100</small></div>'
      + '<div class="grade">' + esc(rating.grade) + '</div>'
      + '<div class="subscore">圣遗物有效词条 <b>' + score.words.toFixed(2) + '</b><br>'
      + '完美态满分 <b>' + score.perfect.toFixed(2) + '</b><br>'
      + '圣遗物达成度 <b>' + score.percent.toFixed(1) + '%</b></div></div>'
      + '<div class="dims">' + dims + '</div>'
      + '</div>'
      + (rating.tags.length ? '<div class="notice">' + rating.tags.map(esc).join("；") + '</div>' : '')
      + '</div>';
  }

  function cardPanel(panel, role) {
    const rows = PANEL_ROWS.map(([k, label, unit]) => {
      const v = panel[k];
      const txt = v == null ? "—" : (k === "hp" || k === "atk" || k === "def" ? Math.round(v).toLocaleString() : v.toFixed(1) + (unit || ""));
      const extra = (k === "atk" && panel.baseAtk) ? '<small> 白字 ' + Math.round(panel.baseAtk) + '</small>'
        : (k === "hp" && panel.baseHp) ? '<small> 白字 ' + Math.round(panel.baseHp) + '</small>'
          : (k === "def" && panel.baseDef) ? '<small> 白字 ' + Math.round(panel.baseDef) + '</small>' : "";
      const hl = (k === "critRate" || k === "critDmg" || k === "er") ? " hl" : "";
      return '<div class="stat' + hl + '"><div class="k">' + label + '</div><div class="v">' + txt + extra + '</div></div>';
    }).join("");

    const dmgRows = Object.entries(panel.dmg || {})
      .filter(([, v]) => v > 0)
      .map(([k, v]) => '<div class="stat"><div class="k">' + esc(k.endsWith("伤害加成") ? k : k + "伤害加成")
        + '</div><div class="v">' + v.toFixed(1) + '%</div></div>')
      .join("");

    const notes = [];
    if (panel.source !== "enka") {
      notes.push("这是按静态数值表估算的面板，不是游戏内真实面板。");
      if (panel.appliedSet2pc) notes.push("已计入 " + panel.appliedSet2pc + " 个套装的无条件 2 件套加成。");
      if (panel.incomplete && panel.incomplete.length) {
        notes.push("以下内容未计入：<ul>" + [...new Set(panel.incomplete)].slice(0, 8).map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>");
      }
      notes.push("圣遗物主词条按 0 级↔+20 线性插值，个别等级可能有尾数差；要看真实面板请查 UID。");
    }
    return '<div class="card"><h3>角色面板 <span class="note">' + (panel.source === "enka" ? "来自 Enka，与游戏内一致" : "离线估算") + '</span></h3>'
      + '<div class="panel-grid">' + rows + dmgRows + '</div>'
      + (notes.length ? '<div class="notice">' + notes.join("<br>") + '</div>' : '')
      + '</div>';
  }

  function cardArtifacts(role, score) {
    const items = C.SLOT_KEYS.map(slot => {
      const art = role.artifacts[slot];
      const meta = score.perSlot[slot] || { score: 0, perfect: 0, percent: 0 };
      if (!art) {
        return '<div class="art"><div class="art-head"><div><span class="set">未录入</span>'
          + '<span class="slot">' + C.SLOTS[slot].name + '</span></div><div class="sc">—</div></div></div>';
      }
      const mainV = art.mainValue != null ? art.mainValue : C.mainStatValue(art.mainStat, art.level);
      const eff = role.effectiveStats || [];
      const subs = (art.substats || []).map(s => {
        const isEff = eff.includes(s.stat);
        return '<span class="s' + (isEff ? " eff" : "") + '">' + esc(s.stat) + ' <b>' + C.fmt(s.stat, s.value) + '</b>'
          + (isEff ? '' : ' <i style="opacity:.55">无效</i>') + '</span>';
      }).join("");
      const initTxt = art.initialCount ? (art.initialCount === 4 ? "4 初始（9 次强化机会）" : "3 初始（8 次强化机会）")
        : (art.rollCount ? art.rollCount + " 次 roll" : "初始词条数未知");
      return '<div class="art">'
        + '<div class="art-head"><div><span class="set">' + esc(art.setName) + '</span>'
        + '<span class="slot">' + C.SLOTS[slot].name + ' +' + (art.level || 0) + (art.rarity ? " · " + art.rarity + "★" : "") + '</span></div>'
        + '<div class="sc">' + meta.score.toFixed(2) + ' <small>/ ' + meta.perfect.toFixed(2)
        + ' · ' + meta.percent.toFixed(0) + '%</small></div></div>'
        + '<div class="subs"><span class="s main">' + esc(art.mainStat || "—") + ' <b>' + C.fmt(art.mainStat, mainV) + '</b></span>'
        + '<span class="s" style="opacity:.4">|</span>' + subs + '</div>'
        + '<div class="tagline">' + esc(initTxt) + '</div>'
        + '</div>';
    }).join("");
    return '<div class="card"><h3>圣遗物逐件评分 <span class="note">分数 = Σ(数值 ÷ 满档值) × 该角色权值；绿色为有效词条</span></h3>'
      + '<div class="arts">' + items + '</div></div>';
  }

  function cardWeights(role) {
    const w = role.weights || {};
    const rows = C.SUB_STATS.map(stat => {
      const v = w[stat] || 0;
      return '<tr class="' + (v > 0 ? "" : "off") + '">'
        + '<td>' + esc(stat) + '</td>'
        + '<td><input type="range" min="0" max="2" step="0.05" value="' + v + '" data-stat="' + esc(stat) + '">'
        + '<span class="wv">' + v.toFixed(2) + '</span></td>'
        + '<td>' + (v > 0 ? "有效" : "忽略") + '</td></tr>';
    }).join("");

    const t = role.talents || {};
    return '<div class="card"><h3>角色配置 <span class="note">权值刻度：1.0 = 一条满档副词条算一个标准词条</span></h3>'
      + '<table class="wtable"><thead><tr><th>副词条</th><th>权值</th><th>计入</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="field"><label>充能需求</label><input id="inpER" type="number" step="5" value="' + (role.erRequirement != null ? role.erRequirement : "") + '">%'
      + '<span style="color:var(--dim)">不达标会扣分并提示；超额不加分</span></div>'
      + '<div class="field"><label>角色等级</label><input id="inpLevel" type="number" min="1" max="90" value="' + (role.level != null ? role.level : "") + '">'
      + '<label style="margin-left:14px">突破</label><input id="inpAsc" type="number" min="0" max="6" value="' + (role.ascension != null ? role.ascension : 0) + '">'
      + '<label style="margin-left:14px">天赋</label>'
      + '<input id="inpTalentA" type="number" min="1" max="15" value="' + (t.auto != null ? t.auto : "") + '" title="普通攻击">'
      + '<input id="inpTalentE" type="number" min="1" max="15" value="' + (t.skill != null ? t.skill : "") + '" title="元素战技">'
      + '<input id="inpTalentQ" type="number" min="1" max="15" value="' + (t.burst != null ? t.burst : "") + '" title="元素爆发">'
      + '<span style="color:var(--dim)">依次为 普攻 / 战技 / 爆发</span></div>'
      + '<div class="field"><button id="btnResetW" class="ghost">恢复默认权重</button>'
      + '<button id="btnDelRole" class="ghost danger">删除这个角色</button></div>'
      + '</div>';
  }

  function bindDetail(role) {
    const box = $("#detail");
    box.querySelectorAll('input[type=range][data-stat]').forEach(inp => {
      // 拖动中只更新显示与总分数字（重建 DOM 会让滑杆失焦）
      inp.addEventListener("input", () => {
        const stat = inp.dataset.stat;
        const v = parseFloat(inp.value);
        role.weights[stat] = v;
        role.effectiveStats = App.roles.syncEffective(role.weights);
        const wv = inp.parentElement.querySelector(".wv");
        if (wv) wv.textContent = v.toFixed(2);
        const tr = inp.closest("tr");
        if (tr) { tr.classList.toggle("off", v <= 0); tr.lastElementChild.textContent = v > 0 ? "有效" : "忽略"; }
        updateScoreNumbers(role);
        persist();
      });
      // 松手后再整块重绘，让圣遗物逐件分与面板同步
      inp.addEventListener("change", () => {
        const y = box.scrollTop;
        renderDetail();
        $("#detail").scrollTop = y;
      });
    });
    const er = $("#inpER");
    if (er) er.addEventListener("change", () => {
      role.erRequirement = er.value === "" ? null : Number(er.value);
      renderDetail(); persist();
    });
    const lv = $("#inpLevel"), asc = $("#inpAsc");
    const onLevel = () => {
      role.level = lv.value === "" ? null : Number(lv.value);
      role.ascension = asc.value === "" ? null : Number(asc.value);
      renderDetail(); persist();
    };
    if (lv) lv.addEventListener("change", onLevel);
    if (asc) asc.addEventListener("change", onLevel);
    const ta = $("#inpTalentA"), te = $("#inpTalentE"), tq = $("#inpTalentQ");
    const onTalent = () => {
      role.talents = {
        auto: ta.value === "" ? null : Number(ta.value),
        skill: te.value === "" ? null : Number(te.value),
        burst: tq.value === "" ? null : Number(tq.value)
      };
      renderDetail(); persist();
    };
    [ta, te, tq].forEach(x => x && x.addEventListener("change", onTalent));

    const rb = $("#btnResetW");
    if (rb) rb.addEventListener("click", () => {
      const char = GD.charByNameOrId(role.charSlug || role.name);
      if (!char) return;
      const d = App.roles.defaultsFor(char);
      role.weights = Object.assign({}, d.weights);
      role.effectiveStats = d.effectiveStats.slice();
      role.archetype = d.archetype; role.archetypeLabel = d.archetypeLabel;
      persist(); renderDetail();
    });
    const del = $("#btnDelRole");
    if (del) del.addEventListener("click", () => {
      if (!confirm("删除角色「" + role.name + "」及其圣遗物数据？")) return;
      state.roles = state.roles.filter(r => r.id !== role.id);
      state.selected = state.roles[0] ? state.roles[0].id : null;
      persist(); renderAll();
    });
  }

  /** 拖动滑杆时的轻量刷新：只改列表分数与总评分数字，不重建 DOM */
  function updateScoreNumbers(role) {
    const panel = panelOf(role);
    const rating = SC.buildRating(role, panel);
    const score = SC.characterScore(role, panel);
    const num = document.querySelector("#detail .big-score .num");
    if (num) num.innerHTML = rating.score.toFixed(1) + '<small> / 100</small>';
    const grade = document.querySelector("#detail .big-score .grade");
    if (grade) grade.textContent = rating.grade;
    const sub = document.querySelector("#detail .big-score .subscore");
    if (sub) {
      sub.innerHTML = "圣遗物有效词条 <b>" + score.words.toFixed(2) + "</b><br>"
        + "完美态满分 <b>" + score.perfect.toFixed(2) + "</b><br>"
        + "圣遗物达成度 <b>" + score.percent.toFixed(1) + "%</b>";
    }
    // 分维度条
    Object.keys(rating.weights).forEach((k, i) => {
      const d = rating.dims[k]; if (!d) return;
      const bars = document.querySelectorAll("#detail .dims .dim .bar i");
      if (bars[i]) bars[i].style.width = (d.value * 100).toFixed(0) + "%";
    });
    renderList();
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
