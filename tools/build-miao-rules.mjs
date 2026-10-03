/**
 * build-miao-rules.mjs —— 从 miao-plugin 抽取评分规则用的数据表
 *
 * 【来源与许可】
 *   miao-plugin  https://github.com/yoimiya-kokomi/miao-plugin
 *   License: MIT, Copyright (c) 2023 Yoimiya
 *   README 免责声明第 1 条原文：「miao-plugin 自身的 UI 与代码均开放，无需征得特殊同意，可任意使用。
 *   能备注来源最好，但不强求」
 *   → 因此本项目**移植其评分规则与数据表**，并在文件头与 README 中注明来源。
 *   ⚠️ 立绘/图标等美术素材**不在**该 MIT 授权内（README 第 3 条明说素材来自网络、仅供交流学习），
 *      本项目一律不打包素材，改为运行时从公开图床拉取。
 *
 * 【做了什么】
 *   miao-plugin 的这两个文件是 ESM 且带 import；这里剥掉 import/export 后放进 vm 求值，
 *   把需要的表导出来，裁成我们自己的 JSON。不改动其数值。
 *
 * 用法：node tools/build-miao-rules.mjs <miao-tree 根目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'gamedata', 'miao-rules.json');

const tree = process.argv[2];
if (!tree) {
  console.error('用法：node tools/build-miao-rules.mjs <miao-tree 根目录>');
  process.exit(2);
}

/**
 * 极简 lodash 替身：miao 的模块顶层会直接调 lodash.forEach 之类，
 * 我们不引入依赖，够用即可（只求能把数据表求值出来，不跑它的业务逻辑）。
 */
const LODASH_SHIM = {
  forEach(obj, fn) {
    if (obj == null) return obj;
    if (Array.isArray(obj)) { obj.forEach((v, i) => fn(v, i)); return obj; }
    if (typeof obj === 'object') { for (const k of Object.keys(obj)) fn(obj[k], k); return obj; }
    return obj;
  },
  forOwn(obj, fn) { return LODASH_SHIM.forEach(obj, (v, k) => fn(v, k)); },
  forIn(obj, fn) { return LODASH_SHIM.forEach(obj, (v, k) => fn(v, k)); },
  map(obj, fn) {
    const out = [];
    LODASH_SHIM.forEach(obj, (v, k) => out.push(fn(v, k)));
    return out;
  },
  filter(obj, fn) {
    const out = [];
    LODASH_SHIM.forEach(obj, (v, k) => { if (fn(v, k)) out.push(v); });
    return out;
  },
  find(obj, fn) {
    let hit;
    LODASH_SHIM.forEach(obj, (v, k) => { if (hit === undefined && fn(v, k)) hit = v; });
    return hit;
  },
  keys: o => (o == null ? [] : Object.keys(o)),
  values: o => (o == null ? [] : Object.values(o)),
  isArray: Array.isArray,
  isObject: v => v !== null && typeof v === 'object',
  isString: v => typeof v === 'string',
  isNumber: v => typeof v === 'number',
  includes(arr, v) { return Array.isArray(arr) ? arr.includes(v) : String(arr || '').includes(v); },
  sortBy(arr, keys) {
    const ks = Array.isArray(keys) ? keys : [keys];
    return (arr || []).slice().sort((a, b) => {
      for (const k of ks) {
        const av = a == null ? undefined : a[k], bv = b == null ? undefined : b[k];
        if (av === bv) continue;
        return av > bv ? 1 : -1;
      }
      return 0;
    });
  },
  cloneDeep: v => JSON.parse(JSON.stringify(v)),
  assign: (...a) => Object.assign({}, ...a),
  merge: (...a) => Object.assign({}, ...a),
  uniq: a => [...new Set(a || [])],
  flatten: a => [].concat(...(a || [])),
  sum: a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0),
  toNumber: v => Number(v),
  round: (v, p) => { const m = Math.pow(10, p || 0); return Math.round(v * m) / m; }
};

/** 剥掉 ESM 语法后在一个沙箱里求值，并把指定变量挂到 globalThis 上取出来 */
function loadModule(relPath, exportNames) {
  const file = path.join(tree, relPath);
  if (!fs.existsSync(file)) throw new Error('找不到文件：' + file);
  let src = fs.readFileSync(file, 'utf8');
  // 去掉 import 语句（含多行形式）
  src = src.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  // 去掉 export 关键字
  src = src.replace(/^\s*export\s+default\s+/gm, 'var __default = ');
  src = src.replace(/^\s*export\s+/gm, '');

  const probe = exportNames.map(n =>
    `try { globalThis.__out[${JSON.stringify(n)}] = (typeof ${n} !== 'undefined') ? ${n} : undefined } catch (e) { globalThis.__out[${JSON.stringify(n)}] = '__err:' + e.message }`
  ).join('\n');

  const ctx = vm.createContext({
    console, __out: {}, lodash: LODASH_SHIM,
    // 其余上游全局（Format / Meta / Data …）在本抽取里用不到，
    // 给一个"任何属性都返回可调用空函数"的替身，避免顶层初始化代码中断。
    Format: new Proxy({}, { get: () => (v => String(v)) }),
    Meta: new Proxy({}, { get: () => (() => undefined) }),
    Data: new Proxy({}, { get: () => (() => undefined) }),
    Character: new Proxy({}, { get: () => (() => undefined) }),
    Artifact: new Proxy({}, { get: () => (() => undefined) }),
    Weapon: new Proxy({}, { get: () => (() => undefined) }),
    Attr: new Proxy({}, { get: () => (() => undefined) }),
    game: 'gs'
  });
  // 模块顶层若直接调用没被 shim 覆盖的方法，也不至于整体崩掉：注入一个记录器
  vm.runInContext(src + '\n' + probe, ctx, { filename: relPath });
  return ctx.__out;
}

/* ---------- ① 数值表（extra.js） ---------- */
console.log('[1/3] 读取 resources/meta-gs/artifact/extra.js');
const ex = loadModule('resources/meta-gs/artifact/extra.js',
  ['attrMap', 'attrPct', 'basicNum', 'mainIdMap', 'attrIdMap', 'attrFormat', 'mainAttrMap']);

const basicNum = typeof ex.basicNum === 'number' ? ex.basicNum : null;
console.log('      basicNum =', basicNum);
const attrMap = ex.attrMap && typeof ex.attrMap === 'object' ? ex.attrMap : null;
const attrIdMap = ex.attrIdMap && typeof ex.attrIdMap === 'object' ? ex.attrIdMap : null;
const mainIdMap = ex.mainIdMap && typeof ex.mainIdMap === 'object' ? ex.mainIdMap : null;
console.log('      attrMap ' + (attrMap ? Object.keys(attrMap).length + ' 条' : '（未取到）'));
console.log('      attrIdMap ' + (attrIdMap ? Object.keys(attrIdMap).length + ' 条' : '（未取到）'));
console.log('      mainIdMap ' + (mainIdMap ? Object.keys(mainIdMap).length + ' 条' : '（未取到）'));

/* ---------- ② 角色权重表（artis-mark.js） ---------- */
console.log('[2/3] 读取 resources/meta-gs/artifact/artis-mark.js');
const am = loadModule('resources/meta-gs/artifact/artis-mark.js', ['usefulAttr', 'usefulAttrSr']);
const usefulAttr = am.usefulAttr && typeof am.usefulAttr === 'object' ? am.usefulAttr : null;
console.log('      usefulAttr ' + (usefulAttr ? Object.keys(usefulAttr).length + ' 个角色' : '（未取到）'));

/* ---------- ③ 组装输出 ---------- */
console.log('[3/3] 写入');
const out = {
  _source: {
    project: 'miao-plugin',
    url: 'https://github.com/yoimiya-kokomi/miao-plugin',
    license: 'MIT',
    copyright: 'Copyright (c) 2023 Yoimiya',
    files: [
      'resources/meta-gs/artifact/extra.js',
      'resources/meta-gs/artifact/artis-mark.js'
    ],
    note: '仅移植评分规则所用的数值表与权重表；美术素材不在 MIT 授权内，本项目不打包素材。',
    extractedAt: new Date().toLocaleDateString('sv')
  },
  basicNum,
  attrMap,
  attrIdMap,
  mainIdMap,
  usefulAttr
};

// 自检：报告里查证过的几个值
console.log('\n=== 自检（与调研报告核对的已知值）===');
const check = (label, actual, expect, tol) => {
  const ok = typeof actual === 'number' && Math.abs(actual - expect) <= (tol == null ? 1e-6 : tol);
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + ' = ' + actual + '（期望 ' + expect + '）');
  return ok;
};
let allOk = true;
if (attrMap) {
  allOk &= check('cpct 满档（暴击率%）', attrMap.cpct && attrMap.cpct.value, 3.885);
  allOk &= check('cdmg 满档（暴击伤害%）', attrMap.cdmg && attrMap.cdmg.value, 7.77);
  allOk &= check('mastery 满档（元素精通）', attrMap.mastery && attrMap.mastery.value, 23.31);
  allOk &= check('atk 满档（大攻击%）', attrMap.atk && attrMap.atk.value, 5.8275, 1e-4);
  allOk &= check('def 满档（大防御%）', attrMap.def && attrMap.def.value, 7.284375, 1e-4);
} else { allOk = false; }
if (usefulAttr) {
  const g = usefulAttr['甘雨'];
  console.log('  甘雨权重: ' + JSON.stringify(g));
  allOk &= !!(g && g.cpct === 100 && g.cdmg === 100 && g.atk === 75 && g.mastery === 75);
}

fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
console.log('\n写入 ' + OUT + '  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log(allOk ? '自检全部通过 ✅' : '⚠️ 有自检未通过，请人工核对上游是否改动');
