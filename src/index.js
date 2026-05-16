require('dotenv').config();

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (require('electron-squirrel-startup')) app.quit();

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'WoWForge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'WoWForge.conf');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

const DEFAULT_CONFIG = {
  wowInstallPath: 'C:\\Program Files (x86)\\World of Warcraft',
  serverIP: process.env.SERVER_IP || '25.24.139.38',
};

const DB_CONFIG = {
  host: process.env.DATABASE_URL,
  port: parseInt(process.env.DATABASE_PORT),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: 'acore_auth',
  connectTimeout: 8000,
};

const DB_CHARS = { ...DB_CONFIG, database: 'acore_characters' };
const DB_WEB = { ...DB_CONFIG, database: 'website_2024' };

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    const lines = Object.entries(DEFAULT_CONFIG).map(([k, v]) => `${k} = ${v}`).join('\n');
    fs.writeFileSync(CONFIG_FILE, lines, 'utf8');
  }
}

function readConfig() {
  ensureConfig();
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  const cfg = { ...DEFAULT_CONFIG };
  for (const line of raw.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) cfg[k.trim()] = rest.join('=').trim();
  }
  return cfg;
}

// ── Session (Remember Me) ─────────────────────────────────────────────────────
function readSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch { }
  return null;
}

function writeSession(data) {
  ensureConfig();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data), 'utf8');
}

function clearSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 650,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getMysql() {
  try { return require('mysql2/promise'); }
  catch { return null; }
}

async function srpVerify(username, password, row) {
  const crypto = require('crypto');
  const saltBuf = Buffer.isBuffer(row.salt) ? row.salt : Buffer.from(row.salt, 'binary');

  const h1 = crypto.createHash('sha1')
    .update(Buffer.from(`${username.toUpperCase()}:${password.toUpperCase()}`, 'utf8'))
    .digest();

  const h2 = crypto.createHash('sha1')
    .update(Buffer.concat([saltBuf, h1]))
    .digest();

  const h2BigInt = BigInt('0x' + Buffer.from(h2).reverse().toString('hex'));
  const g = 7n;
  const N = BigInt('0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7');

  let base = g % N, exp = h2BigInt, result = 1n;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % N;
    exp = exp / 2n;
    base = (base * base) % N;
  }

  let hex = result.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const computedBuf = Buffer.alloc(32);
  Buffer.from(hex, 'hex').reverse().copy(computedBuf);

  const storedBuf = Buffer.isBuffer(row.verifier) ? row.verifier : Buffer.from(row.verifier, 'binary');
  return computedBuf.equals(storedBuf.slice(0, 32));
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('app:minimize', () => mainWindow?.minimize());
ipcMain.handle('app:close', () => app.quit());
ipcMain.handle('config:read', () => readConfig());
ipcMain.handle('config:openDir', () => { ensureConfig(); shell.openPath(CONFIG_DIR); });
ipcMain.handle('session:read', () => readSession());
ipcMain.handle('session:clear', () => clearSession());

ipcMain.handle('db:connect', async () => {
  const mysql = getMysql();
  if (!mysql) return { ok: false, error: 'mysql2 not found. Run: npm install mysql2' };
  try {
    const conn = await mysql.createConnection(DB_CONFIG);
    await conn.end();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:login', async (_e, { username, password, rememberMe }) => {
  const mysql = getMysql();
  if (!mysql) return { ok: false, error: 'mysql2 not found.' };
  try {
    const conn = await mysql.createConnection(DB_CONFIG);
    const [rows] = await conn.execute(
      'SELECT id, username, email, expansion, online, locked, last_login, salt, verifier FROM account WHERE username = ?',
      [username.toUpperCase()]
    );
    await conn.end();

    if (rows.length === 0) return { ok: false, error: 'Account not found.' };
    const row = rows[0];

    const valid = await srpVerify(username, password, row);
    if (!valid) return { ok: false, error: 'Incorrect password.' };

    if (rememberMe) {
      writeSession({ username, password });
    } else {
      clearSession();
    }

    const { salt: _s, verifier: _v, ...account } = row;
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Fetch characters for an account ID (online ones first, then all)
ipcMain.handle('chars:fetch', async (_e, { accountId }) => {
  const mysql = getMysql();
  if (!mysql) return { ok: false, chars: [] };
  try {
    const conn = await mysql.createConnection(DB_CHARS);
    const [rows] = await conn.execute(
      `SELECT name, race, class, gender, level, zone, online
       FROM characters
       WHERE account = ?
       ORDER BY online DESC, level DESC
       LIMIT 10`,
      [accountId]
    );
    await conn.end();
    return { ok: true, chars: rows };
  } catch (e) {
    return { ok: false, chars: [], error: e.message };
  }
});

ipcMain.handle('wow:launch', async () => {
  const cfg = readConfig();
  const exePath = path.join(cfg.wowInstallPath, 'Wow.exe');
  if (!fs.existsSync(exePath)) {
    return { ok: false, error: `Wow.exe not found at: ${exePath}` };
  }
  const { spawn } = require('child_process');
  spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

ipcMain.handle('articles:fetch', async () => {
  const mysql = getMysql();

  if (!mysql) {
    return {
      ok: false,
      articles: [],
      error: 'mysql2 package missing'
    };
  }

  let conn;

  try {
    conn = await mysql.createConnection(DB_WEB);

    const [rows] = await conn.execute(`
  SELECT
    id,
    JSON_UNQUOTE(JSON_EXTRACT(headline, '$.english')) AS headline,
    JSON_UNQUOTE(JSON_EXTRACT(content, '$.english')) AS content,
    timestamp
  FROM articles
  ORDER BY timestamp DESC
  LIMIT 20
`);

    return {
      ok: true,
      articles: rows ?? []
    };

  } catch (e) {
    console.error('[articles:fetch]', e);

    return {
      ok: false,
      articles: [],
      error: e.message
    };

  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch { }
    }
  }
});
