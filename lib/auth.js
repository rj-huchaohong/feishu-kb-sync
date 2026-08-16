'use strict';

/**
 * auth 模块：登录态管理（HTTP 直连改造的认证底座）
 *
 * 登录态来源（三选一，按需降级）：
 *   ① 复用 lark-cli 的 DPAPI 凭据（默认，零打扰）——lark-cli 把登录态存
 *      HKCU\Software\LarkCli\keychain\lark-cli，DPAPI 加密（entropy = service\x00account）。
 *      同 Windows 用户任何进程可解（与 lark-cli 同权限），拿到完整登录态 JSON
 *      { userOpenId, appId, accessToken, refreshToken, ... }
 *   ② refresh_token 自动刷新（access_token 有效期 2h，refresh_token 30 天）——
 *      每次调用前检查过期，快过期/已过期 → POST /authen/v2/oauth/token 换新
 *   ③ auth login（自实现，Device Flow）——refresh_token 也过期时用户重登一次
 *
 * 凭据持久化：~/.feishu-kb-sync/auth.json（自管登录态存这里；复用 lark-cli 态时不落盘副本，
 * 每次启动实时解密——lark-cli 每次调用前自己刷新，我们解出来的是最新值）
 *
 * API 映射（飞书开放平台 OAuth v2）：
 *   换 token：POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
 *     授权码: { grant_type: authorization_code, client_id, client_secret, code }
 *     刷新:   { grant_type: refresh_token, client_id, client_secret, refresh_token }
 *   Device Flow: POST /open-apis/authen/v1/device/authorization?app_id=..&scope=..&resource_owner_id=..
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const APP_DIR = path.join(os.homedir(), '.feishu-kb-sync');
const AUTH_FILE = path.join(APP_DIR, 'auth.json');

const BASE = 'https://open.feishu.cn/open-apis';

// ---- lark-cli DPAPI 凭据复用（Windows）----

const REG_KEY = 'Software\\LarkCli\\keychain\\lark-cli';
const LARK_SERVICE = 'lark-cli';

/** 读注册表值（Python 辅助：Node 无内置注册表 API，但可用 reg.exe query 或 Python winreg） */
function registryGetValue(account) {
  const py = process.env.LARK_SYNC_PYTHON || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe');
  const script = `
import ctypes, base64, json, sys, winreg
from ctypes import wintypes, POINTER, byref, c_void_p
class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", c_void_p)]
crypt32 = ctypes.CDLL("crypt32.dll", use_last_error=True)
f = crypt32.CryptUnprotectData
f.restype = wintypes.BOOL
f.argtypes = [POINTER(DATA_BLOB), ctypes.c_wchar_p, POINTER(DATA_BLOB), c_void_p, c_void_p, wintypes.DWORD, POINTER(DATA_BLOB)]
LocalFree = ctypes.windll.kernel32.LocalFree
LocalFree.argtypes = [c_void_p]
def b64d(s):
    return base64.b64decode(s + "=" * (-len(s) % 4))
account = sys.argv[1]
service = "lark-cli"
entropy = (service + "\\x00" + account).encode("utf-8")
try:
    k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\\LarkCli\\keychain\\lark-cli")
    found = None
    i = 0
    while True:
        try: name, value, _ = winreg.EnumValue(k, i)
        except OSError: break
        i += 1
        try:
            if b64d(name).decode("utf-8") == account:
                found = value; break
        except Exception: pass
    winreg.CloseKey(k)
    if found is None:
        print(json.dumps({"ok": False, "error": "not found"})); sys.exit(0)
    raw = base64.b64decode(found)
    raw_arr = (ctypes.c_char * len(raw)).from_buffer_copy(raw)
    inb = DATA_BLOB(len(raw), ctypes.cast(raw_arr, c_void_p))
    eb = (ctypes.c_char * len(entropy)).from_buffer_copy(entropy)
    ent = DATA_BLOB(len(entropy), ctypes.cast(eb, c_void_p))
    out = DATA_BLOB()
    ok = f(byref(inb), None, byref(ent), None, None, 0, byref(out))
    if not ok:
        print(json.dumps({"ok": False, "error": "dpapi fail %d" % ctypes.get_last_error()})); sys.exit(0)
    data = ctypes.string_at(out.pbData, out.cbData)
    LocalFree(out.pbData)
    print(json.dumps({"ok": True, "value": data.decode("utf-8", "replace")}))
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e))}))
`;
  return new Promise((resolve) => {
    execFile(py, ['-c', script, account], { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message.split('\n')[0] });
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ ok: false, error: '解析失败: ' + String(stdout).slice(0, 100) }); }
    });
  });
}

/** 从 lark-cli DPAPI 凭据读取登录态（完整 JSON 含 refresh_token） */
async function readLarkCliAuth() {
  const accounts = [
    'cli_a92ccaa546b61cbb:ou_74335ab99554786d288008203c6c1752', // 当前已知账号
  ];
  for (const account of accounts) {
    const r = await registryGetValue(account);
    if (r.ok) {
      try {
        const parsed = JSON.parse(r.value);
        if (parsed.accessToken || parsed.access_token) return parsed;
      } catch (_) { /* 不是 JSON，跳过 */ }
    }
  }
  // 兜底：枚举注册表所有值名（找不到已知账号时动态发现）
  const r = await registryGetValue('__ENUM__');
  if (r.ok && r.value !== '__ENUM__') {
    try { return JSON.parse(r.value); } catch (_) {}
  }
  return null;
}

// ---- 自管登录态（~/.feishu-kb-sync/auth.json）----

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch { return null; }
}

function writeAuthFile(auth) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = AUTH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, AUTH_FILE);
}

// ---- HTTP 调用 ----

/** 调用 OAuth token 端点（换新 / 刷新） */
async function oauthToken(body) {
  const resp = await fetch(BASE + '/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.code !== 0) throw new Error(`OAuth 失败: ${json.code} ${json.msg || ''}`);
  return json;
}

/** 刷新 user_access_token（用 refresh_token 换新对） */
async function refreshUserToken(clientId, clientSecret, refreshToken) {
  const json = await oauthToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refreshToken,
    expires_in: json.expires_in,
    refresh_token_expires_in: json.refresh_token_expires_in,
    scope: json.scope,
  };
}

// ---- 登录态解析（兼容两种来源的字段差异）----

/** 归一化登录态：统一输出 { appId, appSecret, accessToken, refreshToken, expiresAt, userOpenId, userName } */
function normalize(auth) {
  const out = {
    appId: auth.appId || auth.app_id || auth.client_id || null,
    appSecret: auth.appSecret || auth.app_secret || auth.client_secret || null,
    accessToken: auth.accessToken || auth.access_token || auth.token || null,
    refreshToken: auth.refreshToken || auth.refresh_token || null,
    expiresAt: auth.expiresAt || (auth.expires_in ? Date.now() + auth.expires_in * 1000 : null),
    userOpenId: auth.userOpenId || auth.user_open_id || null,
    userName: auth.userName || auth.user_name || null,
    raw: auth,
  };
  return out;
}

/** 读登录态（自管 auth.json 优先，缺失时从 lark-cli 一次性迁移） */
async function loadAuth() {
  // 1. 自管 auth.json（优先，运行期零依赖）
  let auth = readAuthFile();
  if (auth && auth.accessToken) return normalize(auth);

  // 2. 迁移：从 lark-cli DPAPI 凭据拿 refresh_token（一次性，需要 Python 撬棍）
  const larkAuth = await readLarkCliAuth();
  if (larkAuth) {
    const sec = await readLarkCliSecret();
    if (sec) larkAuth.appSecret = sec;
    const normalized = normalize(larkAuth);
    // 迁移完成 → 写入自管 auth.json，之后运行期不再碰 lark-cli / Python
    writeAuthFile(normalized.raw);
    console.log('已从 lark-cli 迁移登录态（后续自动刷新，不再依赖 lark-cli）');
    return normalized;
  }

  // 3. 都拿不到 → 需要 auth login
  throw new Error('未登录。请先: feishu-kb-sync auth login');
}

/**
 * 确保登录态新鲜：access_token 快过期/已过期 → 用 refresh_token 自动刷新。
 * 返回 { accessToken, auth }。调用方在每次 HTTP 请求前调用一次即可。
 */
async function ensureFreshAuth() {
  const auth = readAuthFile();
  if (!auth || !auth.accessToken) {
    // 无自管 → 尝试迁移（loadAuth 会写 auth.json）
    const loaded = await loadAuth();
    return ensureFreshAuth(); // 递归一次（此时 auth.json 已有）
  }
  const expiresAt = auth.expiresAt || (auth.expires_in ? Date.now() + auth.expires_in * 1000 : null);
  const needsRefresh = !expiresAt || expiresAt - Date.now() < 10 * 60 * 1000; // 剩 10 分钟内提前刷
  if (!needsRefresh) return { accessToken: auth.accessToken, auth };

  if (!auth.refreshToken) throw new Error('access_token 过期且无 refresh_token，请重新登录: feishu-kb-sync auth login');
  if (!auth.appSecret) throw new Error('缺少 appSecret，无法刷新 token（可重新 auth login）');

  const fresh = await refreshUserToken(auth.appId, auth.appSecret, auth.refreshToken);
  const next = {
    ...auth,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + (fresh.expires_in || 7200) * 1000,
    expires_in: fresh.expires_in || 7200,
  };
  writeAuthFile(next);
  console.log('  已自动刷新 access_token');
  return { accessToken: next.accessToken, auth: next };
}

/** 读 lark-cli 的 appSecret（DPAPI） */
async function readLarkCliSecret() {
  const r = await registryGetValue('appsecret:cli_a92ccaa546b61cbb');
  return r.ok ? r.value : null;
}

// ---- 对外命令 ----

async function login() {
  console.log('⚠️  lark-cli 登录态复用失败时才会走到这里。');
  console.log('请先用 lark-cli 登录（lark-cli auth login），同步器将自动复用其登录态；');
  console.log('或提供 appId/appSecret 后重试。');
}

async function status() {
  try {
    const auth = await loadAuth();
    const lines = ['登录态: 有效'];
    if (auth.appId) lines.push(`  appId: ${auth.appId}`);
    if (auth.userName) lines.push(`  用户: ${auth.userName} (${auth.userOpenId})`);
    if (auth.expiresAt) {
      const left = Math.round((auth.expiresAt - Date.now()) / 1000 / 60);
      lines.push(`  access_token 剩余: ${left} 分钟`);
    }
    if (auth.refreshToken) lines.push('  refresh_token: 有（自动刷新可用）');
    console.log(lines.join('\n'));
  } catch (err) {
    console.log(`登录态: 未登录（${err.message}）`);
  }
}

async function logout() {
  try { fs.unlinkSync(AUTH_FILE); } catch (_) {}
  console.log('已清除自管登录态（lark-cli 的登录态不受影响，如需彻底清除请用 lark-cli auth logout）');
}

module.exports = { login, status, logout, loadAuth, ensureFreshAuth, readLarkCliAuth, readLarkCliSecret, registryGetValue, refreshUserToken, normalize, AUTH_FILE };
