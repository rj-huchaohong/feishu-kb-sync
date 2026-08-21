'use strict';

/**
 * auth 模块：登录态管理（HTTP 直连改造的认证底座）
 *
 * 登录态来源（三选一，按需降级）：
 *   ① 复用当前 Windows 用户的 lark-cli DPAPI 凭据（默认，零打扰）——动态发现
 *      HKCU\Software\LarkCli\keychain\lark-cli 中的全部条目，并按当前 profile/app/user 匹配。
 *      同 Windows 用户任何进程可解（与 lark-cli 同权限），拿到完整登录态 JSON
 *      { userOpenId, appId, accessToken, refreshToken, ... }
 *   ② refresh_token 自动刷新（access_token 有效期 2h，refresh_token 30 天）——
 *      每次调用前检查过期，快过期/已过期 → POST /authen/v2/oauth/token 换新
 *   ③ auth login（自实现，Device Flow）——refresh_token 也过期时用户重登一次
 *
 * 凭据持久化：~/.feishu-kb-sync/auth.json（首次迁移后使用同步器自己的副本，
 * 后续运行不再依赖 lark-cli）
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

/** 使用可用的 Python 运行时解密 lark-cli 的 Windows DPAPI keychain。 */
function runPython(script, args = []) {
  const configured = process.env.LARK_SYNC_PYTHON;
  const candidates = configured
    ? [{ command: configured, prefix: [] }]
    : process.platform === 'win32'
      ? [
        { command: 'py.exe', prefix: ['-3'] },
        { command: 'python.exe', prefix: [] },
        { command: 'python3.exe', prefix: [] },
      ]
      : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];

  const scriptArgs = args.map((value) => String(value));
  return new Promise((resolve) => {
    let index = 0;
    const next = () => {
      if (index >= candidates.length) {
        resolve({ ok: false, error: '找不到可用的 Python 运行时（可设置 LARK_SYNC_PYTHON）' });
        return;
      }
      const candidate = candidates[index++];
      execFile(
        candidate.command,
        [...candidate.prefix, '-c', script, ...scriptArgs],
        { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            next();
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ ok: false, error: 'Python 辅助程序返回了无效结果' });
          }
        },
      );
    };
    next();
  });
}

/** 一次枚举并解密当前用户可见的全部 lark-cli keychain 条目。 */
async function registryEntries() {
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
registry_path = sys.argv[1]
service = sys.argv[2]

def decrypt_value(value, account):
    raw = b64d(value)
    raw_arr = (ctypes.c_char * len(raw)).from_buffer_copy(raw)
    inb = DATA_BLOB(len(raw), ctypes.cast(raw_arr, c_void_p))
    entropy = (service + "\\x00" + account).encode("utf-8")
    eb = (ctypes.c_char * len(entropy)).from_buffer_copy(entropy)
    ent = DATA_BLOB(len(entropy), ctypes.cast(eb, c_void_p))
    out = DATA_BLOB()
    ok = f(byref(inb), None, byref(ent), None, None, 0, byref(out))
    if not ok:
        return None
    try:
        return ctypes.string_at(out.pbData, out.cbData).decode("utf-8", "replace")
    finally:
        LocalFree(out.pbData)

try:
    k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_path)
    entries = []
    i = 0
    while True:
        try: name, value, _ = winreg.EnumValue(k, i)
        except OSError: break
        i += 1
        try:
            account = b64d(name).decode("utf-8")
            decrypted = decrypt_value(value, account)
            if decrypted is not None:
                entries.append({"account": account, "value": decrypted})
        except Exception: pass
    winreg.CloseKey(k)
    print(json.dumps({"ok": True, "entries": entries}))
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e))}))
`;
  const result = await runPython(script, [REG_KEY, LARK_SERVICE]);
  return result.ok && Array.isArray(result.entries) ? result.entries : [];
}

/** 通过 lark-cli 的公开身份查询确定当前 profile/app/user，不读取其秘密。 */
async function readLarkCliIdentity() {
  const configured = process.env.LARK_CLI_PATH;
  const candidates = configured
    ? [configured]
    : process.platform === 'win32'
      ? ['lark-cli.cmd', 'lark-cli.exe', 'lark-cli']
      : ['lark-cli'];
  for (const command of candidates) {
    const result = await new Promise((resolve) => {
      const shell = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command);
      execFile(command, ['whoami', '--json'], { shell, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
    if (result) return result;
  }
  return null;
}

function parseLarkCliAccount(account) {
  const text = String(account || '');
  if (text.startsWith('appsecret:')) return { appId: text.slice('appsecret:'.length), userOpenId: null };
  const separator = text.indexOf(':');
  if (separator < 0) return { appId: null, userOpenId: null };
  return { appId: text.slice(0, separator), userOpenId: text.slice(separator + 1) };
}

function parseLarkCliAuthEntry(entry) {
  try {
    const raw = JSON.parse(entry.value);
    const normalized = normalize(raw);
    if (!normalized.accessToken && !normalized.refreshToken) return null;
    const account = parseLarkCliAccount(entry.account);
    return {
      raw,
      appId: normalized.appId || account.appId,
      userOpenId: normalized.userOpenId || account.userOpenId,
    };
  } catch (_) {
    return null;
  }
}

function selectLarkCliAuthCandidate(entries, identity) {
  const candidates = entries.map(parseLarkCliAuthEntry).filter(Boolean);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const appId = identity?.appId || null;
  const userOpenId = identity?.onBehalfOf?.openId || null;
  const matches = candidates.filter((candidate) => (
    (!appId || candidate.appId === appId)
    && (!userOpenId || candidate.userOpenId === userOpenId)
  ));
  return matches.length === 1 ? matches[0] : null;
}

/** 读取当前 lark-cli profile 对应的用户登录态，不依赖固定账号名。 */
async function readLarkCliAuth() {
  const [entries, identity] = await Promise.all([registryEntries(), readLarkCliIdentity()]);
  const selected = selectLarkCliAuthCandidate(entries, identity);
  if (!selected) return null;

  const appId = selected.appId || identity?.appId;
  const secret = entries.find((entry) => entry.account === `appsecret:${appId}`)?.value;
  if (secret && !selected.raw.appSecret && !selected.raw.app_secret && !selected.raw.client_secret) {
    selected.raw.appSecret = secret;
  }
  return selected.raw;
}

/** 兼容外部调用：读取指定 app_id 或当前 profile 的 appSecret。 */
async function readLarkCliSecret(appId = null) {
  const [entries, identity] = await Promise.all([registryEntries(), appId ? Promise.resolve(null) : readLarkCliIdentity()]);
  const target = appId || identity?.appId;
  if (!target) return null;
  return entries.find((entry) => entry.account === `appsecret:${target}`)?.value || null;
}

/** 兼容外部调用：按完整账号名读取 DPAPI 条目。 */
async function registryGetValue(account) {
  const entry = (await registryEntries()).find((item) => item.account === account);
  return entry ? { ok: true, value: entry.value } : { ok: false, error: 'not found' };
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

  // 2. 迁移：从当前 lark-cli profile 的 DPAPI 凭据拿 refresh_token
  const larkAuth = await readLarkCliAuth();
  if (larkAuth) {
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

module.exports = {
  login,
  status,
  logout,
  loadAuth,
  ensureFreshAuth,
  readLarkCliAuth,
  readLarkCliSecret,
  registryGetValue,
  refreshUserToken,
  normalize,
  parseLarkCliAccount,
  selectLarkCliAuthCandidate,
  AUTH_FILE,
};
