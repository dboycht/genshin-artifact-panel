/**
 * build-enka-map.mjs —— 从 Enka.Network 的公开数据字典抽取「角色 → 三个技能的 skillId 映射」
 *
 * 【为什么需要】
 *   Enka 的 UID 接口返回 skillLevelMap = { skillId: 等级 }（如 {10017:10, 10032:10, 10041:10}），
 *   但 skillId 本身不带语义；要区分「普通攻击 / 元素战技 / 元素爆发」必须知道 id → 技能类型。
 *   Enka 公开的 store/characters.json 里每个角色带 Skills 字段，值为
 *     Skill_A_*  普通攻击
 *     Skill_E_*  元素战技
 *     Skill_S_*  元素爆发
 *   （命名与米哈游原始数据一致，Skill_A/E/S 是游戏自身约定）
 *
 * 【本脚本只提取事实性标识符映射】（avatarId → 三个 skillId），不搬运任何美术资源或文案。
 *   来源：https://github.com/EnkaNetwork/API-docs （Enka 官方开发者文档）
 *
 * 用法：
 *   node --use-system-ca tools/build-enka-map.mjs               # 联网抓取（自动重试）
 *   node tools/build-enka-map.mjs <本地 characters.json 路径>    # 用已下载的副本（推荐：代理偶发 502）
 *
 * 注意：本机的 GitHub 走加速器（hosts → 127.0.0.1）且是 MITM 代理，
 *       Node 必须加 --use-system-ca，否则报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'gamedata', 'avatar-skills.json');
const SRC = 'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json';

const TYPE_BY_PREFIX = [
  [/^Skill_A/, 'auto'],    // 普通攻击
  [/^Skill_E/, 'skill'],   // 元素战技
  [/^Skill_S/, 'burst']    // 元素爆发
];

function classify(skillName) {
  if (typeof skillName !== 'string') return null;
  for (const [re, type] of TYPE_BY_PREFIX) if (re.test(skillName)) return type;
  return null;
}

/** 读取上游：本地文件优先，否则联网抓取（最多 4 次，指数退避） */
async function readSource() {
  const local = process.argv[2];
  if (local) {
    console.log('读取本地副本 ' + local);
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  }
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(SRC, { headers: { 'User-Agent': 'genshin-artifact-panel/build-enka-map' } });
      if (res.ok) return await res.json();
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    const wait = 800 * i;
    console.warn('第 ' + i + ' 次抓取失败（' + lastErr.message + '），' + wait + 'ms 后重试');
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error('抓取上游失败：' + lastErr.message + '\n可先用浏览器/Invoke-WebRequest 下载后传入本地路径。');
}

const store = await readSource();

const out = {};
let skipped = 0;
for (const [avatarId, c] of Object.entries(store)) {
  const skills = c && c.Skills;
  if (!skills) { skipped++; continue; }
  const entry = { name: c.NameTextMapHash || null };
  for (const [skillId, skillName] of Object.entries(skills)) {
    const type = classify(skillName);
    if (type) entry[type] = Number(skillId);
  }
  if (entry.auto || entry.skill || entry.burst) {
    out[avatarId] = { auto: entry.auto ?? null, skill: entry.skill ?? null, burst: entry.burst ?? null };
  } else {
    skipped++;
  }
}

fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
console.log('写入 ' + OUT);
console.log('角色数 ' + Object.keys(out).length + '，跳过 ' + skipped);

// 自检：安柏 10000021 应为 auto=10041, skill=10017, burst=10032
const amber = out['10000021'];
console.log('自检 安柏(10000021): ' + JSON.stringify(amber));
const ok = amber && amber.auto === 10041 && amber.skill === 10017 && amber.burst === 10032;
console.log(ok ? '自检通过 ✅' : '自检未通过 ⚠️（上游数据可能变动，请人工核对）');

// 覆盖率检查：与 genshin-db 角色表比对（可选）
const charsPath = path.resolve(__dirname, '..', 'public', 'gamedata', 'characters.json');
if (fs.existsSync(charsPath)) {
  const chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'));
  const missing = chars.filter(c => !out[String(c.id)]);
  console.log('genshin-db 角色 ' + chars.length + ' 个，其中 ' + missing.length + ' 个无技能映射'
    + (missing.length ? '：' + missing.slice(0, 12).map(c => c.name).join('、') + (missing.length > 12 ? ' …' : '') : ''));
}
