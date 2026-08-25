#!/usr/bin/env node
'use strict';
// AI 使用量儀表板 — 本機伺服器
// 職責:1) 提供 index.html  2) /api/usage 讀取本機 CLI 憑證,向官方端點查詢使用量
// 安全:只綁定 127.0.0.1;token 只在本機使用,絕不傳給前端。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3789;
const ROOT = __dirname;

// ---------- 錯誤訊息 i18n:回傳 errCode+errParams,翻譯延後到回應序列化階段 ----------
// 這樣快取(upstreamCache)裡存的是語言無關的代碼,不會被某次請求的語言污染下次請求。
const SERR = {
  'zh-Hant': {
    NO_CLAUDE_CRED: '找不到 Claude 憑證 (~/.claude/.credentials.json)',
    CLAUDE_TOKEN_EXPIRED: 'Claude token 已過期,請執行任一 claude 指令讓它自動刷新',
    CONN_FAIL: '連線 {service} 失敗: {msg}',
    HTTP_ERR: '{service} API 回應 HTTP {status}',
    PARSE_FAIL: '無法解析 {service} API 回應',
    FORMAT_UNEXPECTED: '{service} 回應格式不符預期',
    NO_CODEX_CRED: '找不到 Codex 憑證 (~/.codex/auth.json)',
    CODEX_CONN_FAIL: '連線失敗: {msg}',
    CODEX_HTTP_ERR: 'HTTP {status} ({urlTail})',
    CODEX_PARSE_FAIL: '無法解析回應',
    CODEX_FORMAT_UNEXPECTED: '回應格式不符預期',
    UNKNOWN_ERROR: '未知錯誤',
    ANTIGRAVITY_NOT_RUNNING: '未偵測到 Antigravity CLI(agy)或 Antigravity IDE;請開啟 IDE 或在終端機執行 agy',
    ANTIGRAVITY_PROBE_FAILED: '偵測到 agy CLI 執行中,但查詢用量失敗或回應格式不符預期',
    STALE_BACKOFF: '退避中(避免觸發限流),沿用舊資料',
    UNEXPECTED_EXCEPTION: '發生非預期錯誤: {msg}',
  },
  en: {
    NO_CLAUDE_CRED: 'Claude credentials not found (~/.claude/.credentials.json)',
    CLAUDE_TOKEN_EXPIRED: 'Claude token has expired — run any `claude` command to let it refresh automatically',
    CONN_FAIL: 'Failed to connect to {service}: {msg}',
    HTTP_ERR: '{service} API responded with HTTP {status}',
    PARSE_FAIL: 'Failed to parse {service} API response',
    FORMAT_UNEXPECTED: '{service} response format did not match expectations',
    NO_CODEX_CRED: 'Codex credentials not found (~/.codex/auth.json)',
    CODEX_CONN_FAIL: 'Connection failed: {msg}',
    CODEX_HTTP_ERR: 'HTTP {status} ({urlTail})',
    CODEX_PARSE_FAIL: 'Failed to parse response',
    CODEX_FORMAT_UNEXPECTED: 'Response format did not match expectations',
    UNKNOWN_ERROR: 'Unknown error',
    ANTIGRAVITY_NOT_RUNNING: 'No Antigravity CLI (agy) or Antigravity IDE detected — open the IDE or run `agy` in a terminal',
    ANTIGRAVITY_PROBE_FAILED: 'agy CLI is running, but fetching usage failed or the response did not match expectations',
    STALE_BACKOFF: 'Backing off to avoid rate limits — using cached data',
    UNEXPECTED_EXCEPTION: 'Unexpected error: {msg}',
  },
};
function terr(code, lang, params) {
  const dict = SERR[lang] || SERR['zh-Hant'];
  let str = dict[code] || code;
  if (params) for (const k in params) str = str.split('{' + k + '}').join(params[k]);
  return str;
}
// 把快取物件裡的 errCode/staleErrCode 依語言翻成 error/staleError 字串;回傳新物件,不動到原快取物件
function localizeResult(r, lang) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  if (out.errCode) out.error = terr(out.errCode, lang, out.errParams);
  if (out.staleErrCode) out.staleError = terr(out.staleErrCode, lang, out.staleErrParams);
  return out;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// ---------- Claude (Anthropic OAuth usage endpoint,即 claude /usage 背後的 API) ----------
async function fetchClaude() {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const cred = readJsonSafe(credPath);
  const oauth = cred && cred.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    return { ok: false, errCode: 'NO_CLAUDE_CRED' };
  }
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    return { ok: false, errCode: 'CLAUDE_TOKEN_EXPIRED' };
  }
  let res;
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': 'Bearer ' + oauth.accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, errCode: 'CONN_FAIL', errParams: { service: 'Anthropic', msg: e.message } };
  }
  if (!res.ok) return { ok: false, errCode: 'HTTP_ERR', errParams: { service: 'Anthropic', status: res.status } };
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, errCode: 'PARSE_FAIL', errParams: { service: 'Anthropic' } };

  const pick = (o, windowMinutes) => (o && typeof o === 'object' && num(o.utilization) != null)
    ? { usedPct: num(o.utilization), resetsAt: o.resets_at || null, windowMinutes }
    : null;
  const session = pick(data.five_hour, 300);
  const longterm = pick(data.seven_day, 10080);
  if (!session && !longterm) return { ok: false, errCode: 'FORMAT_UNEXPECTED', errParams: { service: 'Anthropic' } };

  const extra = [];
  const opus = pick(data.seven_day_opus, 10080);
  if (opus) extra.push({ label: 'Opus 每週', ...opus });
  return { ok: true, session, longterm, longtermLabel: '每週', extra };
}

// ---------- Codex (ChatGPT 後端 rate-limit 端點,best-effort) ----------
function normalizeCodexWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const usedPct = num(w.used_percent ?? w.usedPercent ?? w.utilization);
  if (usedPct == null) return null;
  const winSec = num(w.limit_window_seconds ?? w.window_seconds);
  const windowMinutes = winSec != null ? Math.round(winSec / 60)
    : num(w.window_minutes ?? w.window_duration_mins ?? w.windowMinutes);
  let resetsAt = null;
  const resetUnix = num(w.reset_at ?? w.resets_at);
  if (resetUnix != null && resetUnix > 1e9) {
    resetsAt = new Date(resetUnix * 1000).toISOString();
  } else if (typeof w.resets_at === 'string') {
    resetsAt = w.resets_at;
  } else if (num(w.reset_after_seconds ?? w.resets_in_seconds) != null) {
    resetsAt = new Date(Date.now() + (w.reset_after_seconds ?? w.resets_in_seconds) * 1000).toISOString();
  }
  return { usedPct, resetsAt, windowMinutes };
}

function normalizeCodex(data) {
  const rl = data.rate_limit || data.rate_limits || data.rateLimits || data;
  if (!rl || typeof rl !== 'object') return null;
  const session = normalizeCodexWindow(rl.primary_window || rl.primary || rl.five_hour);
  const longterm = normalizeCodexWindow(rl.secondary_window || rl.secondary || rl.weekly || rl.monthly);
  if (!session && !longterm) return null;
  const mins = longterm && longterm.windowMinutes;
  const longtermLabel = mins ? (mins >= 20000 ? '每月' : '每週') : '每週';
  return { session, longterm, longtermLabel };
}

async function fetchCodex() {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  const auth = readJsonSafe(authPath);
  const tokens = auth && auth.tokens;
  if (!tokens || !tokens.access_token) {
    return { ok: false, errCode: 'NO_CODEX_CRED' };
  }
  const headers = {
    'Authorization': 'Bearer ' + tokens.access_token,
    'Content-Type': 'application/json',
    'originator': 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs',
  };
  if (tokens.account_id) headers['chatgpt-account-id'] = tokens.account_id;

  const urls = [
    'https://chatgpt.com/backend-api/wham/usage',
    'https://chatgpt.com/backend-api/codex/usage',
  ];
  let lastErr = null;
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    } catch (e) { lastErr = { errCode: 'CODEX_CONN_FAIL', errParams: { msg: e.message } }; continue; }
    if (!res.ok) { lastErr = { errCode: 'CODEX_HTTP_ERR', errParams: { status: res.status, urlTail: url.split('/').pop() } }; continue; }
    const data = await res.json().catch(() => null);
    if (!data) { lastErr = { errCode: 'CODEX_PARSE_FAIL' }; continue; }
    const norm = normalizeCodex(data);
    if (norm) return { ok: true, ...norm };
    lastErr = { errCode: 'CODEX_FORMAT_UNEXPECTED' };
  }
  return { ok: false, ...(lastErr || { errCode: 'UNKNOWN_ERROR' }) };
}

// ---------- Antigravity(Google agentic CLI「agy」;無公開 usage API,借用 CLI 自己的本機 loopback 服務) ----------
// 2026-07-04 探測過程(細節見 開發計畫.md):agy.exe 執行檔本身是加殼過的封閉二進位、雲端 usage 端點
// (daily-cloudcode-pa.googleapis.com)的認證憑證存在 Windows 認證管理員裡且是不透明編碼,
// 兩條路都撞牆。後來在開源專案 steipete/CodexBar(docs/antigravity.md)裡找到:agy CLI 執行期間會在
// 127.0.0.1 開一個「自己就有 quota 資料」的 Connect-RPC 本機服務,不需要 CSRF token(這點跟
// Antigravity 桌面 App/IDE 版本不同),已實機驗證此法可行且與 CLI 內 `/model` 畫面數字一致:
//   POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//   headers: Content-Type: application/json, Connect-Protocol-Version: 1  body: {}
//   回應:{ response: { groups: [ { displayName, buckets: [{ bucketId, window, remainingFraction, resetTime }] } ] } }
// 限制:此服務只在 agy CLI 行程存活時才會開著(關閉終端機視窗就沒了),故偵測不到時只能提示
// 使用者「請先在終端機執行 agy 保持連線」,不會主動幫使用者背著啟動一個 agy 行程(避免意外side effect
// /行程生命週期管理複雜化,超出這個零依賴小工具的範圍)。目前只在 Windows 實機驗證過;macOS/Linux
// 的 ps/lsof 分支沿用 CodexBar 文件裡的位置與指令,未實機測試。
// 2026-07-17 擴充:除了 agy CLI,也偵測 Antigravity IDE 的 language server
// (language_server_windows_x64.exe 等)。IDE 版的 RPC 需要 CSRF token,而 token 就寫在
// 行程的啟動參數 --csrf_token 裡,放進 X-Codeium-Csrf-Token header 即可(IDE 2.1.1 實測
// RetrieveUserQuotaSummary 可用,與 CodexBar 文件所述「IDE 會 404」不同,應為版本差異)。
// 回傳 [{port, csrfToken}];csrfToken 為 null 代表 agy CLI(接受空 token)。
const AGY_VBS_PATH = path.join(os.tmpdir(), 'aiDash-lsproc.vbs');
const AGY_VBS_SRC = 'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")\r\n' +
  'Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name LIKE \'language_server_%\'")\r\n' +
  'For Each p In procs\r\n' +
  '  WScript.Echo p.ProcessId & "|" & p.CommandLine\r\n' +
  'Next\r\n';
function readLanguageServerCmdlines() {
  try {
    let stale = true;
    try { stale = fs.readFileSync(AGY_VBS_PATH, 'utf8') !== AGY_VBS_SRC; } catch {}
    if (stale) fs.writeFileSync(AGY_VBS_PATH, AGY_VBS_SRC);
    return execSync('cscript //nologo "' + AGY_VBS_PATH + '"', { encoding: 'utf8', timeout: 10000 });
  } catch { return ''; }
}
function findAgyTargets() {
  const targets = [];
  const pidTokens = {}; // pid -> csrf token(null = agy CLI,不需 token)
  try {
    if (os.platform() === 'win32') {
      try {
        const tasklistOut = execSync('tasklist /FI "IMAGENAME eq agy.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 3000 });
        for (const m of tasklistOut.matchAll(/"agy\.exe","(\d+)"/g)) pidTokens[m[1]] = null;
      } catch {}
      try {
        // wmic 在新版 Windows 已移除;EDR 會擋 node 子行程呼叫 powershell(Access is denied,
        // 2026-07-17 實測本機如此)。改走 cscript + WMI VBS——實測可行。
        const out = readLanguageServerCmdlines();
        for (const line of out.split('\n')) {
          const i = line.indexOf('|');
          if (i < 1) continue;
          const pid = line.slice(0, i).trim();
          const tok = line.slice(i + 1).match(/--csrf_token[= ]+([0-9a-fA-F-]+)/);
          if (/^\d+$/.test(pid) && tok) pidTokens[pid] = tok[1];
        }
      } catch {}
      const pids = Object.keys(pidTokens);
      if (!pids.length) return [];
      const netstatOut = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 3000 });
      for (const line of netstatOut.split('\n')) {
        const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && pids.includes(m[2])) targets.push({ port: m[1], csrfToken: pidTokens[m[2]] });
      }
      return targets;
    }
    // macOS/Linux:ps 輸出含完整命令列,agy 與 language server 一起掃(未實機驗證)
    const psOut = execSync('ps -ax -o pid=,command=', { encoding: 'utf8', timeout: 3000 });
    for (const l of psOut.split('\n')) {
      const line = l.trim();
      const pid = line.split(/\s+/)[0];
      if (!/^\d+$/.test(pid)) continue;
      if (/(^|[\\/])agy(\s|$)/.test(line)) {
        pidTokens[pid] = null;
      } else if (/language_server_[a-z0-9_]+/.test(line)) {
        const tok = line.match(/--csrf_token[= ]+([0-9a-fA-F-]+)/);
        if (tok) pidTokens[pid] = tok[1];
      }
    }
    for (const pid of Object.keys(pidTokens)) {
      try {
        const lsofOut = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`, { encoding: 'utf8', timeout: 3000 });
        for (const m of lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)) targets.push({ port: m[1], csrfToken: pidTokens[pid] });
      } catch { /* 該 pid 查不到就跳過 */ }
    }
    return targets;
  } catch { return []; }
}

// 呼叫本機 agy/IDE 的 Connect-RPC 服務;loopback 自簽憑證,只在 127.0.0.1 才允許略過憑證驗證
function postAgyLocalRpc(port, rpcPath, csrfToken, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // metadata 為 CodexBar 記載的最小中繼資料;agy CLI 與 IDE 都接受
    const body = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: '1.0.0' } });
    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'Content-Length': Buffer.byteLength(body),
    };
    if (csrfToken) headers['X-Codeium-Csrf-Token'] = csrfToken;
    const req = https.request({
      host: '127.0.0.1', port, path: rpcPath, method: 'POST',
      headers,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function normalizeAntigravityQuota(json) {
  const groups = json && json.response && Array.isArray(json.response.groups) ? json.response.groups : null;
  if (!groups || !groups.length) return null;
  const pickBucket = (group) => {
    const b = group && Array.isArray(group.buckets) ? group.buckets[0] : null;
    if (!b || num(b.remainingFraction) == null) return null;
    const windowMinutes = b.window === 'weekly' ? 10080 : (b.window === 'daily' ? 1440 : 300);
    return { usedPct: Math.round((1 - b.remainingFraction) * 1000) / 10, resetsAt: b.resetTime || null, windowMinutes };
  };
  const geminiGroup = groups.find(g => /gemini/i.test(g.displayName || ''));
  const otherGroup = groups.find(g => g !== geminiGroup) || null;
  let longterm = pickBucket(geminiGroup);
  const otherBucket = pickBucket(otherGroup);
  const extra = [];
  if (longterm && otherBucket) {
    extra.push({ label: (otherGroup.displayName || 'Claude/GPT') + ' 每週', ...otherBucket });
  } else if (!longterm && otherBucket) {
    longterm = otherBucket;
  }
  if (!longterm) return null;
  return { session: null, longterm, longtermLabel: '每週', extra };
}

async function fetchAntigravity() {
  const targets = findAgyTargets();
  if (!targets.length) return { ok: false, errCode: 'ANTIGRAVITY_NOT_RUNNING' };
  let lastErrCode = 'ANTIGRAVITY_PROBE_FAILED';
  for (const { port, csrfToken } of targets) {
    let raw;
    try {
      raw = await postAgyLocalRpc(port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken);
    } catch { continue; }
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    const norm = normalizeAntigravityQuota(json);
    if (norm) return { ok: true, ...norm };
  }
  return { ok: false, errCode: lastErrCode };
}

// ---------- Context 使用率:掃描本機 CLI session 記錄(只讀檔尾,成本極低) ----------
const ACTIVE_MS = 30 * 60000; // 30 分鐘內有寫入才算活躍 session
const pad2 = n => String(n).padStart(2, '0');

function tailLines(file, bytes = 262144) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } finally { fs.closeSync(fd); }
}

// Claude Code:~/.claude/projects/<專案>/<session>.jsonl,每則訊息帶 token usage
function parseClaudeTail(fp) {
  let lines;
  try { lines = tailLines(fp); } catch { return null; }
  let tokens = null, cwd = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; } // 檔尾第一行可能被截斷,跳過
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
    const u = j.message && j.message.usage;
    if (tokens == null && u && num(u.input_tokens) != null) {
      tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
    if (tokens != null && cwd) break;
  }
  if (tokens == null) return null;
  // 2026-07-24 改回傳原始 token 數,不再自行猜 context window 換算成 %:
  // 這裡讀到的只是「上一輪送給 API 的 prompt 有多少 token」,實際 context window 上限跟
  // auto-compact 觸發門檻都是 Claude Code 內部邏輯與帳號方案決定,本機沒有管道查證,寫死
  // 200000 當分母算出來的 % 在啟用大 context window 的帳號上會嚴重失真(參考 2026-07-24 討論)。
  const label = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : path.basename(fp).slice(0, 8);
  return { label, tokens };
}

function scanClaudeContext() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; }
  const now = Date.now();
  const sessions = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (now - st.mtimeMs > ACTIVE_MS) continue; // mtime 預過濾,絕大多數檔案到此為止
      const info = parseClaudeTail(fp);
      if (info) sessions.push({ ...info, mtime: st.mtimeMs, ageMin: Math.round((now - st.mtimeMs) / 60000) });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 8).map(({ label, tokens, ageMin }) => ({ label, tokens, ageMin }));
}

// Codex CLI:~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,token_count 事件帶累計 usage
// 同 parseClaudeTail:不再算 %,直接回傳原始 token 數(model_context_window 有時缺欄位,
// 猜一個 272000 當 fallback 一樣不可靠)
function parseCodexTail(fp) {
  let lines;
  try { lines = tailLines(fp); } catch { return null; }
  let tokens = null, cwd = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    const p = j.payload || {};
    if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
    if (tokens == null && p.type === 'token_count' && p.info) {
      const u = p.info.last_token_usage || p.info.total_token_usage || {};
      const t = (u.input_tokens || 0) + (u.output_tokens || 0);
      if (t > 0) tokens = t;
    }
    if (tokens != null && cwd) break;
  }
  if (tokens == null) return null;
  const label = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : path.basename(fp).replace(/\.jsonl$/, '').slice(-8);
  return { label, tokens };
}

function scanCodexContext() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const now = Date.now();
  const sessions = [];
  for (const t of [now, now - 86400000]) { // 今天與昨天(跨午夜邊界)
    const d = new Date(t);
    const dir = path.join(root, String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()));
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (now - st.mtimeMs > ACTIVE_MS) continue;
      const info = parseCodexTail(fp);
      if (info) sessions.push({ ...info, mtime: st.mtimeMs, ageMin: Math.round((now - st.mtimeMs) / 60000) });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 8).map(({ label, tokens, ageMin }) => ({ label, tokens, ageMin }));
}

// ---------- 即時 Token 用量統計 (近 24 小時 / 1 小時) ----------
function getClaudeRealtimeUsage() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return null; }
  const now = Date.now();
  const limit24h = now - 24 * 3600 * 1000;
  
  let totalInput = 0;
  let totalOutput = 0;
  let last1hInput = 0;
  let last1hOutput = 0;
  const hourly = new Array(24).fill(0); // index = 幾小時前(0=目前這小時,23=23小時前)

  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < limit24h) continue;

      let content;
      try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter(Boolean);

      const requests = {}; // requestId -> { input, output, timestamp }

      for (let i = 0; i < lines.length; i++) {
        try {
          const j = JSON.parse(lines[i]);
          if (j.type === 'assistant' && j.message && j.message.usage && j.requestId) {
            const u = j.message.usage;
            const ts = j.timestamp ? new Date(j.timestamp).getTime() : st.mtimeMs;
            if (ts >= limit24h) {
              const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
              const output = u.output_tokens || 0;
              requests[j.requestId] = { input, output, timestamp: ts };
            }
          }
        } catch {}
      }

      for (const reqId in requests) {
        const req = requests[reqId];
        totalInput += req.input;
        totalOutput += req.output;
        if (req.timestamp >= now - 3600000) {
          last1hInput += req.input;
          last1hOutput += req.output;
        }
        const hoursAgo = Math.floor((now - req.timestamp) / 3600000);
        if (hoursAgo >= 0 && hoursAgo < 24) hourly[hoursAgo] += req.input + req.output;
      }
    }
  }

  return {
    last1h: { input: last1hInput, output: last1hOutput, total: last1hInput + last1hOutput },
    last24h: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
    hourly,
  };
}

function getCodexRealtimeUsage() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const now = Date.now();
  const limit24h = now - 24 * 3600 * 1000;
  
  let totalInput = 0;
  let totalOutput = 0;
  let last1hInput = 0;
  let last1hOutput = 0;
  const hourly = new Array(24).fill(0); // index = 幾小時前(0=目前這小時,23=23小時前)

  for (const t of [now, now - 86400000]) {
    const d = new Date(t);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < limit24h) continue;

      let content;
      try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        try {
          const j = JSON.parse(lines[i]);
          const p = j.payload || {};
          if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
            const ts = j.timestamp ? new Date(j.timestamp).getTime() : st.mtimeMs;
            if (ts >= limit24h) {
              const u = p.info.last_token_usage;
              const input = u.input_tokens || 0;
              const output = u.output_tokens || 0;

              totalInput += input;
              totalOutput += output;
              if (ts >= now - 3600000) {
                last1hInput += input;
                last1hOutput += output;
              }
              const hoursAgo = Math.floor((now - ts) / 3600000);
              if (hoursAgo >= 0 && hoursAgo < 24) hourly[hoursAgo] += input + output;
            }
          }
        } catch {}
      }
    }
  }

  return {
    last1h: { input: last1hInput, output: last1hOutput, total: last1hInput + last1hOutput },
    last24h: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
    hourly,
  };
}

let tokenCache = {
  at: 0,
  data: null
};
function getRealtimeTokensCached() {
  const now = Date.now();
  if (tokenCache.data && now - tokenCache.at < 30000) {
    return tokenCache.data;
  }
  let claude = null;
  let codex = null;
  try { claude = getClaudeRealtimeUsage(); } catch {}
  try { codex = getCodexRealtimeUsage(); } catch {}
  
  tokenCache.at = now;
  tokenCache.data = { claude, codex };
  return tokenCache.data;
}

// ---------- 使用量草皮圖(近 12 個月每日 token 用量,合併 Claude + Codex) ----------
// 只讀本地日誌就能算,Antigravity 沒有本地紀錄可掃,故不計入。
// 掃過去一年份量較大,快取拉長到 30 分鐘(草皮圖本來就不需要逐秒更新)。
function localDateStr(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 2026-07-21:草皮圖(每日 token,近 12 個月)跟專案清單(去重 cwd + 各自 token 總量,
// 不設 366 天上限)其實要讀同一批檔案,原本分兩三個函式各掃一次很浪費,合併成單一 pass。
function normalizeProjectPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  if (os.platform() === 'win32') s = s.toLowerCase(); // Windows 檔案系統不分大小寫,避免同路徑算成兩個專案
  return s;
}
function projectLabel(p) {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
}
function touchProject(projMap, cwd, tokens, mtimeMs) {
  const norm = normalizeProjectPath(cwd);
  if (!norm) return;
  if (!projMap[norm]) projMap[norm] = { label: projectLabel(cwd), tokens: 0, lastActivity: 0 };
  projMap[norm].tokens += tokens;
  if (mtimeMs > projMap[norm].lastActivity) projMap[norm].lastActivity = mtimeMs;
}

function scanClaudeUsage(dayMap, projMap, sinceMs) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }

      let content;
      try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }

      // 同一 requestId 在串流中會重複出現多行,usage 數字後面的行才是完整值,故用物件覆寫取最後一筆
      const requests = {};
      let cwd = null;
      for (const line of content.split('\n')) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!cwd && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
        if (j.type !== 'assistant' || !j.message || !j.message.usage || !j.requestId) continue;
        const u = j.message.usage;
        const ts = j.timestamp ? new Date(j.timestamp).getTime() : st.mtimeMs;
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        requests[j.requestId] = { tokens, ts };
      }
      let fileTokens = 0;
      for (const rid in requests) {
        const r = requests[rid];
        fileTokens += r.tokens;
        if (r.ts >= sinceMs) { // 草皮圖只收近 12 個月
          const day = localDateStr(r.ts);
          dayMap[day] = (dayMap[day] || 0) + r.tokens;
        }
      }
      if (cwd) touchProject(projMap, cwd, fileTokens, st.mtimeMs); // 專案清單不設時間上限
    }
  }
}

function scanCodexUsage(dayMap, projMap, sinceMs) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  let years;
  try { years = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return; }
  for (const y of years) {
    const yDir = path.join(root, y.name);
    let months;
    try { months = fs.readdirSync(yDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
    for (const m of months) {
      const mDir = path.join(yDir, m.name);
      let days;
      try { days = fs.readdirSync(mDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const dd of days) {
        const dDir = path.join(mDir, dd.name);
        let files;
        try { files = fs.readdirSync(dDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        const dayKey = y.name + '-' + m.name + '-' + dd.name;
        const dayTs = new Date(Number(y.name), Number(m.name) - 1, Number(dd.name)).getTime();
        let dayTotal = 0;
        for (const f of files) {
          const fp = path.join(dDir, f);
          let content;
          try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
          let cwd = null;
          let fileTokens = 0;
          for (const line of content.split('\n')) {
            if (!line) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const p = j.payload || {};
            if (!cwd && typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;
            if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
              const u = p.info.last_token_usage;
              fileTokens += (u.input_tokens || 0) + (u.output_tokens || 0);
            }
          }
          dayTotal += fileTokens;
          if (cwd) {
            let st;
            try { st = fs.statSync(fp); } catch { st = null; }
            touchProject(projMap, cwd, fileTokens, st ? st.mtimeMs : dayTs);
          }
        }
        if (dayTotal > 0 && dayTs >= sinceMs - 86400000) dayMap[dayKey] = (dayMap[dayKey] || 0) + dayTotal;
      }
    }
  }
}

const HEATMAP_CACHE_MS = 30 * 60000;
let heatmapCache = { at: 0, data: null };
function getHeatmapCached() {
  const now = Date.now();
  if (heatmapCache.data && now - heatmapCache.at < HEATMAP_CACHE_MS) return heatmapCache.data;
  // Claude/Codex 分開各自的 dayMap,才能讓前端的日/週累積圖跟小時圖一樣可以分別勾選;
  // 草皮圖用的 days 仍是兩者加總(見下方合併)
  const claudeDayMap = {};
  const codexDayMap = {};
  const projMap = {};
  const sinceMs = now - 366 * 86400000;
  try { scanClaudeUsage(claudeDayMap, projMap, sinceMs); } catch {}
  try { scanCodexUsage(codexDayMap, projMap, sinceMs); } catch {}
  const dayMap = {};
  for (const k in claudeDayMap) dayMap[k] = (dayMap[k] || 0) + claudeDayMap[k];
  for (const k in codexDayMap) dayMap[k] = (dayMap[k] || 0) + codexDayMap[k];
  const projects = Object.values(projMap).sort((a, b) => b.tokens - a.tokens);
  const data = {
    days: dayMap, projectCount: projects.length, projects,
    daysByProvider: { claude: claudeDayMap, codex: codexDayMap },
  };
  heatmapCache = { at: now, data };
  return data;
}

// ---------- 上游快取與退避:降低撞到 Anthropic/Codex 429 限流的機率 ----------
// 成功結果快取 3 分鐘(原 55 秒)、失敗後至少 2 分鐘退避才重試(原本每次前端輪詢
// 都會重打,限流期間反而火上加油)、沿用舊成功資料的時間拉長到 30 分鐘(原 10 分鐘)。
const CACHE_MS = 180000;
const FAIL_BACKOFF_MS = 120000;
const STALE_MS = 1800000;
const upstreamCache = {};
async function cachedFetch(key, fn) {
  const now = Date.now();
  const c = upstreamCache[key];
  if (c) {
    if (c.result.ok && now - c.at < CACHE_MS) return c.result; // 成功快取仍新鮮
    if (c.lastFail && now - c.lastFail < FAIL_BACKOFF_MS) {    // 才失敗過,退避中,先不重試
      return c.result.ok
        ? { ...c.result, stale: true, staleErrCode: 'STALE_BACKOFF' }
        : c.result;
    }
  }
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, errCode: 'UNEXPECTED_EXCEPTION', errParams: { msg: String(e && e.message || e) } }; }
  if (r.ok) {
    upstreamCache[key] = { at: now, result: r };
    return r;
  }
  if (c && c.result.ok && now - c.at < STALE_MS) {
    upstreamCache[key] = { at: c.at, lastFail: now, result: c.result };
    return { ...c.result, stale: true, staleErrCode: r.errCode, staleErrParams: r.errParams };
  }
  upstreamCache[key] = { at: c ? c.at : now, lastFail: now, result: r };
  return r;
}

// ---------- HTTP 伺服器 ----------
function reqLang(req) {
  const q = (req.url.split('?')[1] || '');
  return new URLSearchParams(q).get('lang') === 'en' ? 'en' : 'zh-Hant';
}
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/usage') {
    const lang = reqLang(req);
    const [claudeRaw, codexRaw, antigravityRaw] = await Promise.all([
      cachedFetch('claude', fetchClaude),
      cachedFetch('codex', fetchCodex),
      cachedFetch('antigravity', fetchAntigravity),
    ]);
    // 翻譯結果一律用複本(localizeResult 已 shallow-copy),避免把某次請求的語言寫回共用快取物件
    const claude = localizeResult(claudeRaw, lang);
    const codex = localizeResult(codexRaw, lang);
    const antigravity = localizeResult(antigravityRaw, lang);
    // Context 掃描是本機檔案操作,便宜,每次請求即時計算(不論配額查詢成敗)
    try { claude.context = scanClaudeContext(); } catch { claude.context = []; }
    try { codex.context = scanCodexContext(); } catch { codex.context = []; }

    // 即時 Token 用量統計
    const rt = getRealtimeTokensCached();
    if (claude) claude.realtimeUsage = rt.claude;
    if (codex) codex.realtimeUsage = rt.codex;

    // 草皮圖:近 12 個月每日 token 用量(合併 Claude + Codex,與個別提供商無關)
    const heatmap = getHeatmapCached();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ time: new Date().toISOString(), providers: { claude, codex, antigravity }, heatmap }));
    return;
  }

  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('index.html not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('AI 使用量儀表板已啟動: http://127.0.0.1:' + PORT);
    console.log('按 Ctrl+C 結束');
  });
}
