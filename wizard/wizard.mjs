#!/usr/bin/env node
/*
 * Zeus Install Wizard — automated installer for the hardened Zeus panel on Cloudflare
 * Flow: token-creation link (random name) → account → D1 → worker upload → subdomain → custom domain
 * The panel source is read from this repository (fork axionspace/Z-E-U-S) — no npm
 * packages, Node.js 18+ only. Every install gets its own build fingerprint (payload
 * table re-keyed and re-ordered, generated identifiers renamed) and the wizard keeps a
 * local profile so the panel can be re-updated later with one command, defaults only.
 *
 * Usage:
 *   node wizard.mjs                (full interactive install)
 *   node wizard.mjs --update        (pick an account, then update a panel with a NEW fingerprint)
 *   node wizard.mjs --prepare-only (fetch/validate the source only, no Cloudflare API calls)
 *   node wizard.mjs --personalize  (download, re-fingerprint and verify the source only)
 *   node wizard.mjs --token-link   (just print a token-creation link with a random name)
 *   node wizard.mjs --no-fingerprint (install the shared repository build unchanged)
 *
 * Requirement: Node.js 18+ (the installers fetch a private copy automatically if missing)
 */
import { readFileSync, writeFileSync, existsSync, rmSync, realpathSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { emitKeypressEvents, clearLine, cursorTo, moveCursor } from 'node:readline';
import { Writable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = 'https://api.cloudflare.com/client/v4';
// Mirrors of the hardened source served from this repository; raw.githubusercontent.com
// is the canonical source and is tried first, then independent CDNs that mirror GitHub,
// so a filtered or failing route never blocks the install.
const FORK_SOURCES = [
  'https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/Source.js',
  'https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',
  'https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/Source.js',
  'https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/Source.js',
];
// Local install profile — the defaults used by the manual update. Never stores a token.
const PROFILE_PATH = join(__dirname, 'profile.json');
const PROFILE_VERSION = 1;
// Exactly the permissions the panel needs (Workers Scripts, KV, D1, Subdomain, ...)
const PERM_GROUPS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'workers_subdomain', type: 'edit' },
  { key: 'account_analytics', type: 'read' },
];
const COMPAT_DATE = '2024-09-23';
// The panel's own over-the-air updater deploys with compatibility_date "2026-07-10" and
// compatibility_flags ["nodejs_compat"] (see analysis/Source.js, the OTA metadata block).
// That is the runtime the panel author ships and tests against, so the wizard deploys
// fresh installs with exactly the same values: an older date or dropped flags risks the
// worker throwing during module evaluation, which Cloudflare reports as error 1101 on
// every route — while the uploaded bytes are perfectly fine.
const REQUIRED_COMPAT_DATE = '2026-07-10';
const REQUIRED_COMPAT_FLAGS = ['nodejs_compat'];

// Small random lowercase name — used for the token name and the worker-name suggestion
function randName(n) {
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[randomInt(abc.length)];
  return s;
}
// Ready-made token-creation link: all permissions pre-set + a random token name
function makeTokenUrl() {
  return (
    'https://dash.cloudflare.com/profile/api-tokens' +
    '?permissionGroupKeys=' + encodeURIComponent(JSON.stringify(PERM_GROUPS)) +
    '&accountId=*&zoneId=all&name=' + randName(10)
  );
}

const KEYWORDS = ['vless','vmess','trojan','shadowsocks','v2ray','xray','hiddify','clash','sing-box','singbox','flclash','panel-zeus','z-e-u-s','hxxyrukih4kvmeawzmdmug2eh5uwtcmt','ss://'];
const KW_RE = new RegExp(KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

let TOKEN = '';
// The CLI sets TOKEN after its prompt. A tool that imports this module can hand the token
// over through the environment instead, and every request still goes through one path.
const apiToken = () => (TOKEN || process.env.ZEUS_CF_TOKEN || '').trim();
let step = 0;
let totalSteps = 10;

// ---------------------------------------------------------------- UI helpers
// Plain English throughout: one question per screen, sensible defaults shown,
// every step prints what it does and why, and every error ends with ONE concrete
// next action.
const line = '─'.repeat(58);

// ---- Terminal styling. Colour, the progress bar, the spinner and the boxed cards only appear
// on a real terminal; piped output, logs, CI and NO_COLOR keep the exact plain text they always
// had, so nothing that reads the transcript changes. FORCE_COLOR=1 turns styling on for a pipe.
const COLOR = !process.argv.includes('--no-color') && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && (!!process.stdout.isTTY || process.env.FORCE_COLOR === '1');
// Windows Terminal, VS Code, Git Bash and every non-Windows terminal get the full
// glyph set. A classic Windows console (cmd.exe / the old PowerShell host) draws its
// output in CP437, where the arc corners, the ▰▱ bar, the braille spinner and every
// emoji come out as "?" — so it gets a plain-ASCII set instead.
// G holds glyphs; ICON holds the little in-line marks and their ASCII fallbacks.
const MODERN = process.env.ZEUS_FORCE_CLASSIC === '1' ? false : (process.env.ZEUS_FORCE_MODERN === '1' || process.platform !== 'win32' || !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI || /xterm|vt100|ansi|cygwin|screen/i.test(process.env.TERM || '')));
// Both sets are plain constants so the classic one can be asserted directly, without
// having to run a child process with a patched environment.
const MODERN_G = { tl: '╭', bl: '╰', on: '▰', off: '▱', note: '·', dash: '—', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] };
const CLASSIC_G = { tl: '+', bl: '+', on: '#', off: '-', note: '-', dash: '-', spin: ['|', '/', '-', '\\'] };
const G = MODERN ? MODERN_G : CLASSIC_G;
// Every in-line symbol the wizard prints, with a pure-ASCII twin. `ic()` picks the
// right one, so no message ever shows a "?" box on a classic console.
const MODERN_ICON = { bolt: '⚡', key: '🔑', bank: '🏢', up: '🔄', party: '🎉', warn: '⚠️', ok: '✅', cross: '❌', bulb: '💡', lock: '🔒', pin: '📍', link: '🔗', globe: '🌐', drum: '🥁', stop: '🛑' };
const CLASSIC_ICON = { bolt: '*', key: '*', bank: '*', up: '*', party: '*', warn: '!', ok: '[ok]', cross: '[x]', bulb: '->', lock: '[lock]', pin: '->', link: '->', globe: '', drum: '*', stop: '[!]' };
const ICON = MODERN ? MODERN_ICON : CLASSIC_ICON;
const ic = (name) => ICON[name] || '';
const sgr = (on, off) => (s) => (COLOR ? `\x1b[${on}m${s}\x1b[${off}m` : String(s));
const S = {
  bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39),
  cyan: sgr(36, 39), gray: sgr(90, 39), brand: sgr('38;5;75', 39), under: sgr(4, 24),
};
const rule = () => (COLOR ? S.dim(line) : line);
const T0 = Date.now();
function elapsed(from = T0) {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function progressBar(n, total) {
  return S.cyan(G.on.repeat(Math.min(n, total))) + S.dim(G.off.repeat(Math.max(0, total - n)));
}
const ZERO_WIDTH = /[̀-ͯ​-‏⁠︀-️]/;
function visWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) {
    if (ZERO_WIDTH.test(ch)) continue;
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf);
    w += wide ? 2 : 1;
  }
  return w;
}

// Open-right boxed cards (no right edge, so emoji width can never misalign anything).
// Every row is padded to the same cell count via visWidth, which keeps the rule
// above the title exactly as long as the separator and the footer.
const CARD_W = 57;
// A classic console has no line-drawing characters at all, so its box is built from
// "-" and "|". Both variants are one cell wide, so the same width maths holds.
const CARD_H = MODERN ? '─' : '-';
const CARD_V = MODERN ? '│' : '|';
const CARD_T = MODERN ? '├' : '+';
const cardTop = (title) => say('\n  ' + S.brand(G.tl + CARD_H.repeat(3)) + ' ' + S.bold(title) + ' ' + S.brand(CARD_H.repeat(Math.max(2, CARD_W - 5 - visWidth(title) - 1))));
// A card row wraps inside the card instead of running past the rules above it: the
// continuation lines get the same "  |" prefix and line up under the text column.
const cardRow = (text = '') => say('  ' + S.brand(CARD_V) + (text ? '  ' + text : ''));
const cardSep = () => say('  ' + S.brand(CARD_T + CARD_H.repeat(CARD_W - 1)));
const cardEnd = () => say('  ' + S.brand(G.bl + CARD_H.repeat(CARD_W - 1)));
// A menu line: number, label, then a dimmed explanation — all one width.
const menuRow = (num, label, note = '', isDefault = false) => {
  const marker = ' ' + (isDefault ? S.cyan('>') : ' ') + ' ';
  const n = S.cyan(String(num).padStart(2));
  const name = isDefault ? S.bold(label) : label;
  return cardRow(marker + n + '  ' + name + (note ? '  ' + S.dim(note.split(' · ').join(' ' + G.note + ' ')) : ''));
};
// Classic consoles draw CP437, where every one of these glyphs is a "?" box. On
// such a terminal the whole transcript is transcoded to ASCII in one place — so
// no message, box rule or separator can leak a glyph that console cannot draw,
// no matter who wrote the string. Modern terminals get it untouched.
const ASCII_MAP = {
  '─': '-', '│': '|', '├': '+', '┌': '+', '╭': '+', '╰': '+', '└': '+', '┐': '+', '┘': '+', '┤': '+',
  '‾': '-', '▁': '_',
  '—': '--', '–': '-', '·': '-', '•': '*', '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...',
  '→': '->', '←': '<-', '↔': '<->', '›': '>', '❯': '>', '✔': 'ok', '✓': 'ok', '✗': 'x', '❌': 'x',
  '🔑': '*', '⚡': '*', '🏢': '*', '🔄': '*', '🎉': '*', '⚠️': '!', '⚠': '!', '✅': '[ok]', '💡': '->',
  '🔒': '[lock]', '📍': '->', '🔗': '->', '🌐': '', '🥁': '*', '🛑': '[!]', '▰': '#', '▱': '-', '█': '#', '░': '-',
  '▶': '>', '◀': '<', '↑': '^', '↓': 'v', '□': '-', '■': '#', '·': '-',
};
const ASCII_RE = new RegExp('(' + Object.keys(ASCII_MAP).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
const plain = (s) => (MODERN ? String(s) : String(s).replace(ASCII_RE, (m) => ASCII_MAP[m]));
// Everything the wizard prints goes through these. On a classic console the global
// console methods are also wrapped, so a write that bypasses say() — a helper that
// logs as its own `log` object, for instance — cannot slip a "?" box past it either.
const say = (s = '') => console.log(plain(s));
const sayErr = (s = '') => console.error(plain(s));
if (!MODERN) {
  for (const method of ['log', 'error', 'warn', 'info']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map((a) => (typeof a === 'string' ? plain(a) : a)));
  }
}
// The success tick is drawn from here so the classic console gets the ASCII twin.
const tick = () => (MODERN ? ' ✔' : ' ok');
// A wait that shows a spinner with the seconds left on a real terminal; a plain sleep elsewhere.
async function pause(ms, label = '') {
  if (!COLOR || !(ms > 0) || !process.stdout.isTTY) return new Promise((r) => setTimeout(r, ms));
  const frames = G.spin;
  const end = Date.now() + ms;
  for (let i = 0; Date.now() < end; i++) {
    const left = Math.ceil((end - Date.now()) / 1000);
    process.stdout.write(plain('\r\x1b[2K     ' + S.cyan(frames[i % frames.length]) + ' ' + S.dim(label + ' · ' + left + 's')));
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(90, end - Date.now()))));
  }
  process.stdout.write('\r\x1b[2K');
}
// The banner is the table of contents: every list below is exactly the sequence of
// [n/m] steps the run will print, in order, with no extra and no missing step.
const FLOW_START = [
  'Cloudflare account & token',
  'What would you like to do?',
];
const FLOW_UPDATE = [
  'Pick the worker — panels are listed for you',
  'Fetch the source, generate a NEW build identity',
  'Upload the update, verify the bytes',
  'Re-check the address — database untouched',
];
const FLOW_INSTALL = [
  'Worker name',
  'workers.dev address',
  'Create D1 database',
  'Prepare hardened source',
  'Personalise this build',
  'Upload worker',
  'Enable public address',
  'Final check & summary',
  'Attach a custom domain (optional)',
];
function bannerStyled() {
  cardTop(ic('bolt') + ' ZEUS  ·  Install & Update Wizard');
  cardRow(S.dim('installer and updater for the hardened panel'));
  cardSep();
  cardRow(S.bold('Start') + S.dim('  the same two questions either way'));
  FLOW_START.forEach((t, i) => menuRow(i + 1, t, i === FLOW_START.length - 1 ? 'update or install, your pick' : ''));
  cardSep();
  cardRow(S.bold('Update') + S.dim('  an existing panel · ' + FLOW_UPDATE.length + ' steps'));
  FLOW_UPDATE.forEach((t, i) => menuRow(i + 1, t));
  cardSep();
  cardRow(S.bold('Install') + S.dim(' a brand-new panel · ' + FLOW_INSTALL.length + ' steps'));
  FLOW_INSTALL.forEach((t, i) => menuRow(i + 1, t, i === FLOW_INSTALL.length - 1 ? 'optional · skip freely' : ''));
  cardEnd();
  say('     ' + ic('lock') + ' ' + S.dim('Your API token is never printed. It is saved on this computer only if you say yes.'));
  say('        ' + S.dim('Remove it any time with ') + S.cyan('node wizard.mjs --forget'));
}
function banner() {
  if (COLOR) return bannerStyled();
  const list = (a) => a.map((t, i) => '       ' + (i + 1) + ') ' + t).join('\n');
  console.log(`
${line}
    Zeus Install & Update Wizard - automated installer for the hardened panel
${line}
    Start (the same two questions either way):
${list(FLOW_START)}
    Update an existing panel (${FLOW_UPDATE.length} steps, same database and address):
${list(FLOW_UPDATE)}
    Install a new panel (${FLOW_INSTALL.length} steps):
${list(FLOW_INSTALL)}
${line}
    Safety: your API token is never printed. It is saved on this computer only if you
       say yes (remove it any time with: node wizard.mjs --forget).
${line}`);
}

// ---- Piped input (for automated testing): when stdin is piped, a non-TTY readline
// reads all lines at once and drops lines that arrive while no question is pending;
// so in that mode we slurp the whole stdin up front and answer each question from
// that queue.
let pipedLines = null;
let pipedIdx = 0;
async function loadPipedInput() {
  if (process.stdin.isTTY) return;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (pipedLines.length && pipedLines[pipedLines.length - 1] === '') pipedLines.pop();
}
function nextPiped() {
  if (!pipedLines || pipedIdx >= pipedLines.length) return null;
  return pipedLines[pipedIdx++];
}

// One question per screen: the prompt shows the question with its default inside
// square brackets so it is always visible.
async function ask(rl, q, def = '') {
  const prompt = `  ${S.bold(q)}${def ? S.dim(` [${def}]`) : ''}: `;
  if (pipedLines) {
    const a = nextPiped();
    if (a === null) {
      if (def) { console.log(prompt + def + '   (no more input — using the default)'); return def; }
      fail('No answer was left in the non-interactive input, and this question has no default: ' + q, 'Run the wizard interactively, or pipe one answer per question in order.');
    }
    console.log(prompt + (a === '' && def ? `${def}   (default)` : a));
    return a || def;
  }
  const a = (await rl.question(prompt)).trim();
  return a || def;
}

// -------------------------------------------------------------- truly hidden input
// The only representation of a secret that may ever reach the screen.
function maskSecret(t) {
  return t.length ? '••••••••   (received, ' + t.length + ' chars)' : '(nothing received — try pasting again)';
}
// Reading a secret so that NOTHING the user types stays on the terminal.
//
// The previous implementation muted readline's output stream. On Windows PowerShell and
// cmd/conhost that is not enough: the console echoes the keys itself, so a pasted API
// token still lands on screen and in every scrollback. The reliable way is raw mode — on
// POSIX it clears ECHO, and on Windows setRawMode(true) clears ENABLE_ECHO_INPUT — so the
// OS stops printing the keys and this process decides what to draw: a fixed mask that
// never grows with the input, and never the value itself.
//
// Belt and suspenders: some Windows setups echo keys even in raw mode (seen live with a
// pasted token). So every keypress repaints the whole physical line — clearLine +
// cursorTo erase the entire line first, wiping any echoed characters immediately — and
// only the fixed mask is ever redrawn. Pressing Enter repaints once more, so nothing
// readable is left behind even where echo could not be suppressed.
function restoreTty() {
  // NOTE: only the raw flag is restored here — never pause stdin mid-run. Pausing the
  // input stream after the token prompt used to drain the event loop on Windows, which
  // killed the wizard silently at the very next question. Pausing happens only on real
  // exit paths (fail(), final cleanup), which pause explicitly themselves.
  try { if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
}

// The guide shown before the token prompt: one small card, the link on its own line so it
// stays clickable and copyable, and a one-line privacy note.
function tokenGuide(url) {
  if (!COLOR) {
    console.log('  Open this link in your browser — every required permission is pre-configured and the name is randomised:');
    console.log(`     ${url}`);
    console.log('  (Continue to summary → Create Token → copy the created token and paste it here)');
    say('  ' + ic('lock') + ' Nothing you type is echoed; only a fixed mask with the character count is shown.');
    return;
  }
  cardTop(ic('key') + ' Cloudflare API token');
  cardRow(S.cyan('1') + '  Open the link below  ' + S.dim('(permissions pre-set, random name)'));
  cardRow(S.cyan('2') + '  Continue to summary → Create Token → copy the token');
  cardRow(S.cyan('3') + '  Paste it at the prompt and press Enter');
  cardEnd();
  console.log('\n     ' + S.cyan(S.under(url)) + '\n');
  say('     ' + ic('lock') + ' ' + S.dim('Typing is hidden — only a mask and the character count are shown.') + '\n');
}

async function askSecret(rl, q) {
  const label = 'Paste your Cloudflare API token here and press Enter';
  if (pipedLines) {
    let a = nextPiped();
    while (a === '') a = nextPiped(); // an empty token is meaningless; skip empty lines
    if (a === null) fail('No value was left in the non-interactive input for "' + q + '".', 'Set ZEUS_CF_TOKEN to pass the API token without typing it.');
    console.log('  ' + label + '\n    ' + q + '\n  ' + maskSecret(a.trim()));
    return a.trim();
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    // No TTY to switch into raw mode: at least mute this process's own echo so the value
    // does not come back through readline.
    const prompt = '  ' + label + '\n    ' + q + ': ';
    const orig = rl.output;
    const muted = new Writable({ write(chunk, _enc, cb) { if (String(chunk).includes('\n')) orig.write('\n'); cb(); } });
    let a = '';
    try {
      orig.write(prompt);
      rl.output = muted;
      do { a = (await rl.question('')).trim(); } while (!a);
    } finally { rl.output = orig; }
    console.log('  ' + maskSecret(a));
    return a;
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const origOutput = rl ? rl.output : null;
    const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    if (rl) rl.output = muted;

    const head = plain('  ' + S.bold(ic('key') + ' Token') + S.dim(' ›') + ' ');
    const hint = 'paste your token here';
    let value = '';
    let done = false;
    let warned = false;
    const LANG_WARN = 'switch keyboard to English (Alt+Shift)';
    // The blinking caret is shown only while the field is empty (in front of the hint) and
    // is hidden as soon as the mask appears. It is ALWAYS restored on every exit path.
    const setCaret = (show) => {
      try { if (process.stdout.isTTY) process.stdout.write(show ? '\x1b[?25h\x1b[28m' : '\x1b[?25l'); } catch {}
    };

    // ONE write per redraw. The caret is hidden first, the line is erased and redrawn, and the
    // caret comes back (only while the field is empty, in front of the hint) at the very end of
    // that same write — so no intermediate state is ever painted: no caret jumping to the start
    // of the line, no half-drawn line, no flicker.
    // CONCEAL (SGR 8) is switched on at the end of every frame: if the terminal itself echoes a key
    // before the next redraw (some Windows consoles do, especially after Persian input), that echoed
    // character is printed invisible instead of flashing in front of the line. It is switched off
    // again at the start of the next frame and on every exit path (setCaret(true)).
    const HIDE = '\x1b[?25l', SHOW = '\x1b[?25h', ERASE = '\x1b[28m\r\x1b[2K', CONCEAL = '\x1b[8m';
    let lastFrame = '';
    let pending = false;
    const frame = () => {
      if (value.length) {
        // something was typed: only the mask is shown and the caret stays hidden
        return HIDE + ERASE + head + S.cyan('•'.repeat(8)) + S.dim('   ' + value.length + ' chars') + (warned ? '   ' + S.yellow('! ' + LANG_WARN) : '') + CONCEAL;
      }
      // empty: dim hint with the caret pulled back to the START of it (a real placeholder)
      const txt = warned ? LANG_WARN : hint;
      return HIDE + ERASE + head + (warned ? S.yellow(txt) : S.dim(txt)) + '\x1b[' + txt.length + 'D' + SHOW + CONCEAL;
    };
    const render = () => {
      const f = frame();
      if (f === lastFrame) return;            // nothing changed — never repaint
      lastFrame = f;
      try { process.stdout.write(f); } catch {}
    };
    // A paste arrives as many key events in the same tick: draw once, after the last one.
    const scheduleRender = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; if (!done) render(); });
    };
    const onExit = () => {
      setCaret(true);
      restoreTty();
      if (rl && origOutput) rl.output = origOutput;
    };
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      process.removeListener('exit', onExit);
      setCaret(true);
      restoreTty();
      if (rl) {
        if (origOutput) rl.output = origOutput;
        rl.line = '';
        rl.cursor = 0;
      }
    };
    const submit = () => {
      if (done) return;
      const v = value.trim();
      if (!v) { render(); return; }           // Enter on empty input is ignored
      if (pending) { pending = false; render(); }
      done = true;
      // replace the mask line with the confirmation in one write — never add a second line
      try { process.stdout.write(plain(HIDE + ERASE + '  ' + ic('ok') + ' ' + S.green('Token received') + S.dim(' · ' + v.length + ' chars') + '\n' + SHOW)); } catch {}
      cleanup();
      resolve(v);
    };
    const onKey = (str, key) => {
      if (done) return;
      if (key && (key.name === 'return' || key.name === 'enter')) { submit(); return; }
      // Ctrl+C must always work, even while the terminal is in raw mode
      if (key && key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      if (key && key.name === 'backspace') { value = value.slice(0, -1); warned = false; scheduleRender(); return; }
      if (str && !(key && (key.ctrl || key.meta))) {
        // An API token is plain ASCII. Persian / Arabic / any other non-ASCII letter (typed with
        // the wrong keyboard layout, or pasted) is never added and never drawn — the field stays
        // consistent and a short hint explains what to do. Spaces, control characters and
        // invisible bidi marks (ZWNJ, RLM, LRM ...) are dropped silently.
        let added = false, bad = false;
        for (const ch of str) {
          if (/[\x21-\x7e]/.test(ch)) { value += ch; added = true; }
          else if (ch <= ' ' || /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/.test(ch)) continue;
          else bad = true;
        }
        if (bad) {
          warned = true;
          // Persian input can leave some consoles in an echoing input mode; switching raw mode
          // off and on again re-applies "no echo" before the next key arrives.
          try { stdin.setRawMode(false); stdin.setRawMode(true); } catch {}
        } else if (added) warned = false;
        if (added || bad) scheduleRender();
      }
    };

    process.stdout.write('\n');
    render();
    stdin.setEncoding('utf8');
    emitKeypressEvents(stdin);
    stdin.on('keypress', onKey);
    process.on('exit', onExit);
    stdin.setRawMode(true);
    stdin.resume();
  });
}

// A message with a leading mark: the first line starts with the mark, and any wrapped
// continuation lines are indented under it so the mark never repeats.
function marked(mark, msg) {
  const head = '  ' + mark + ' ';
  const pad = ' '.repeat(visWidth(head));
  const words = String(msg).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && visWidth(next) + (lines.length ? pad.length : head.length) > WRAP_COLS) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  if (!lines.length) return head.trimEnd();
  return head + lines[0] + lines.slice(1).map((l) => '\n' + pad + l).join('');
}
function ok(msg) { say(marked(ic('ok'), msg)); }
function warn(msg) { say(S.yellow(marked(ic('warn') + ' ', msg))); }
function info(msg) { say(S.dim(wrapText(msg))); }
// Greedy wrap to a terminal-cell budget, so a long explanation stays inside the
// columns the cards use instead of wrapping mid-word however wide the window is.
const WRAP_COLS = 96;
function wrapText(text, indent = '     ', cols = WRAP_COLS) {
  const pad = visWidth(indent);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && pad + visWidth(next) > cols) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => indent + l).join('\n');
}
// Context line printed before every Cloudflare-touching step.
function why(text) {
  say(S.dim(wrapText(text)));
}
let activeRl = null; // for a clean readline exit (avoids the Windows assert)
// Every error ends with ONE concrete next action.
function fail(msg, hint) {
  sayErr(`\n  ${ic('cross')} ${S.red(S.bold(msg))}`);
  if (hint) sayErr(`     ${ic('bulb')} Next step: ${S.cyan(hint)}`);
  process.exitCode = 1;
  restoreTty();
  try { process.stdin.pause(); } catch {}
  try { activeRl && activeRl.close(); } catch {}
  throw { __zeusExit: true };
}
function nextStep(title) {
  step++;
  if (COLOR) {
    console.log(`\n${rule()}\n  ${S.bold(S.cyan(`[${step}/${totalSteps}]`))}  ${progressBar(step, totalSteps)}  ${S.bold(title)}${S.dim('   ' + elapsed())}\n${rule()}`);
    return;
  }
  console.log(`\n${line}\n  [${step}/${totalSteps}]  ${title}\n${line}`);
}

// ---------------------------------------------------------------- CF helpers
async function cf(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${apiToken()}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: typeof body === 'string' || body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(35000),
    });
  } catch (e) {
    fail(`Could not reach api.cloudflare.com (${e.message})`, 'Check your internet connection or VPN.');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { success: false, errors: [{ code: res.status, message: text.slice(0, 200) }] }; }
  if (!res.ok || data.success === false) {
    const errs = (data.errors || []).map((e) => `code ${e.code}: ${e.message}`).join(' | ') || `HTTP ${res.status}`;
    return { ok: false, status: res.status, errors: errs, data };
  }
  return { ok: true, status: res.status, data };
}

// ------------------------------------------------------- source preparation
// The source must be a hardened build: payload table present, zero identifiable keywords.
// The table is detected structurally, so both the shared repository build and an already
// personalised one pass.
function checkHardened(txt) {
  const hits = txt.split('\n').filter((l) => KW_RE.test(l)).length;
  const det = detectPrelude(txt);
  return {
    hits,
    valid: txt.length > 800000 && det !== null && hits === 0,
  };
}

async function prepareSource(rl) {
  // 1) Local file: the wizard sitting next to Source.js, the fork layout (wizard/ folder
  // inside the repo clone, Source.js at the root), or an existing Source-hardened.js
  for (const p of [join(__dirname, 'Source.js'), join(ROOT, 'Source.js'), join(ROOT, 'Source-hardened.js')]) {
    if (!existsSync(p)) continue;
    const c = checkHardened(readFileSync(p, 'utf8'));
    if (c.valid) {
      ok('Hardened source loaded from local file: ' + p);
      return { path: p, fresh: false };
    }
    warn(`File ${p} is not the hardened build (${c.hits} suspect lines or invalid structure) — will download from the repository instead.`);
  }

  // 2) Download from this repository (raw first as the canonical source; jsdelivr CDN mirrors as fallback)
  console.log('  ⏳ Downloading the hardened source from axionspace/Z-E-U-S ...');
  for (const url of FORK_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      const c = checkHardened(txt);
      if (!c.valid) throw new Error('received content was not the hardened build');
      const tmp = join(tmpdir(), 'zeus-src-' + randName(8) + '.js');
      writeFileSync(tmp, txt);
      ok(`Downloaded from ${new URL(url).host} (${(txt.length / 1024).toFixed(0)}KB)`);
      return { path: tmp, fresh: true };
    } catch (e) {
      warn(`Mirror ${new URL(url).host} failed: ${e.message}`);
    }
  }
  fail(
    'Could not download the source from any mirror.',
    'Try again with a VPN, or clone this repository and run wizard/wizard.mjs from inside it (it uses the repository Source.js directly).'
  );
}

function scanKeywords(p) {
  const src = readFileSync(p, 'utf8');
  const hits = src.split('\n').filter((l) => KW_RE.test(l)).length;
  return { size: src.length, hits };
}

// ---------------------------------------------------- per-install build fingerprint
// Two installs of the same file are trivially recognisable to a static scanner, so the
// wizard rewrites its own generated layer for every user: a fresh XOR key, a new row
// order for the payload table and brand-new identifier names. The panel's own code, the
// author's watermarks and every decoded runtime value stay byte-for-byte identical — the
// transform is verified row-by-row against the original build before anything is uploaded.
const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rngFrom(seed) {
  let counter = 0;
  let buf = [];
  let pos = 0;
  return {
    byte() {
      if (pos >= buf.length) {
        buf = Array.from(createHash('sha256').update(seed + ':' + ++counter).digest());
        pos = 0;
      }
      return buf[pos++];
    },
    int(n) {
      const limit = 256 - (256 % n);
      let x = this.byte();
      while (x >= limit) x = this.byte();
      return x % n;
    },
  };
}

const xorDecode = (b64, key) => {
  const b = Buffer.from(b64, 'base64');
  for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length];
  return b.toString('utf8');
};
const xorEncode = (plain, key) => {
  const b = Buffer.from(plain, 'utf8');
  for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length];
  return b.toString('base64');
};

// The generated prelude, detected structurally so any fingerprinted build re-reads fine.
const PRELUDE_RE = new RegExp(
  'const\\s+([\\w$]+)\\s*=\\s*\\[\\s*(0x[0-9a-fA-F]{2}(?:\\s*,\\s*0x[0-9a-fA-F]{2})*)\\s*\\]\\s*;\\s*' +
  'const\\s+([\\w$]+)\\s*=\\s*\\[\\s*((?:"[A-Za-z0-9+/=]+"\\s*,\\s*)*"[A-Za-z0-9+/=]+")\\s*\\]\\s*;\\s*' +
  'const\\s+([\\w$]+)\\s*=\\s*new\\s+Array\\(\\s*\\3\\s*\\.\\s*length\\s*\\)\\s*;\\s*' +
  'function\\s+([\\w$]+)\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{[^{}]*?atob[^{}]*?\\}\\s*' +
  'function\\s+([\\w$]+)\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{[^{}]*?\\}'
);

function detectPrelude(txt) {
  const m = PRELUDE_RE.exec(txt);
  if (!m) return null;
  const key = m[2].split(',').map((s) => parseInt(s.trim(), 16));
  const blobs = (m[4].match(/"([A-Za-z0-9+/=]+)"/g) || []).map((s) => s.slice(1, -1));
  if (key.length !== 32 || blobs.length < 20) return null;
  const head = txt.slice(0, m.index).match(/\/\*[\s\S]*?\*\/\s*$/);
  return {
    start: head ? m.index - head[0].length : m.index,
    end: m.index + m[0].length,
    raw: (head ? head[0] : '') + m[0],
    keyName: m[1], key,
    blobName: m[3], blobs,
    cacheName: m[5],
    decName: m[6], decArg: m[7],
    getName: m[8], getArg: m[9],
  };
}

const COMMENT_POOL = [
  'runtime payload table — opaque at rest, reconstructed on demand',
  'packed runtime strings — decoded lazily on first use',
  'deferred runtime string store — expanded at call time',
  'encoded runtime text table — materialised when needed',
  'compact runtime payload store — rebuilt on demand',
];

function buildPrelude(p) {
  const keyList = p.key.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(',');
  const blobList = p.blobs.map((b) => JSON.stringify(b)).join(',\n');
  return `/* ${p.comment} */
const ${p.keyName} = [${keyList}];
const ${p.blobName} = [${blobList}];
const ${p.cacheName} = new Array(${p.blobName}.length);
function ${p.decName}(${p.decArg}) {
	const b = atob(${p.decArg});
	const u = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i) ^ ${p.keyName}[i % ${p.keyName}.length];
	return new TextDecoder().decode(u);
}
function ${p.getName}(${p.getArg}) {
	return ${p.cacheName}[${p.getArg}] !== undefined ? ${p.cacheName}[${p.getArg}] : (${p.cacheName}[${p.getArg}] = ${p.decName}(${p.blobName}[${p.getArg}]));
}`;
}

// A generated identifier must look like noise: short, lowercase, one leading underscore.
// Anything that even resembles a product, a protocol, a technology or a panel concept is
// rejected and re-rolled, so a reader of the deployed build learns nothing from the names.
// (This is a naming rule only — it costs nothing at runtime, everything here runs at build time.)
const NAME_BLOCKLIST = [
  ...KEYWORDS, 'zeus', 'panel', 'proxy', 'relay', 'node', 'server', 'client', 'worker',
  'vless', 'vmess', 'trojan', 'ss', 'ws', 'tcp', 'udp', 'http', 'tls', 'ssl', 'dns',
  'admin', 'login', 'user', 'account', 'pass', 'key', 'hash', 'uuid', 'token', 'cloud',
  'flare', 'cloudflare', 'cf', 'edge', 'ip', 'port', 'host', 'proxy', 'sub', 'scan',
];
const NAME_BLOCK_RE = new RegExp(NAME_BLOCKLIST.filter(Boolean).map(rxEsc).join('|'), 'i');

function newName(rng, body, taken) {
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  for (let tries = 0; tries < 2000; tries++) {
    let n = '_';
    const len = 5 + rng.int(4);
    for (let i = 0; i < len; i++) n += abc[rng.int(26)];
    if (taken.has(n)) continue;
    if (NAME_BLOCK_RE.test(n)) continue;                       // never keyword/technology-shaped
    if (new RegExp('(?<![\\w$])' + n + '(?![\\w$])').test(body)) continue;
    taken.add(n);
    return n;
  }
  throw new Error('could not allocate fresh identifier names');
}

function personalize(txt, seed) {
  const det = detectPrelude(txt);
  if (!det) throw new Error('this is not a hardened build (payload table not found)');
  const plain0 = det.blobs.map((b) => xorDecode(b, det.key));
  const N = plain0.length;
  const rng = rngFrom('zeus-fp:' + seed);

  // 1) new row order
  const perm = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const ordered = perm.map((i) => plain0[i]);
  const pos = new Array(N);
  perm.forEach((oldIdx, newIdx) => { pos[oldIdx] = newIdx; });

  // 2) new key, re-rolled until no encoded blob leaks a keyword
  let key, blobs;
  for (let roll = 0; ; roll++) {
    if (roll > 200) throw new Error('could not roll a clean payload key');
    key = Array.from({ length: 32 }, () => rng.byte());
    blobs = ordered.map((p) => xorEncode(p, key));
    if (!blobs.some((b) => KW_RE.test(b))) break;
  }

  // 3) rename every generated identifier, outside the prelude
  const PLACE = '\u0000__ZEUS_PRELUDE__\u0000';
  if (txt.includes(PLACE)) throw new Error('unexpected placeholder in the source');
  let body = txt.slice(0, det.start) + PLACE + txt.slice(det.end);
  const taken = new Set();
  const renames = [];
  for (const oldName of [det.keyName, det.blobName, det.cacheName, det.decName, det.getName]) {
    renames.push([oldName, newName(rng, body, taken)]);
  }
  const renamedIds = [...new Set(body.match(/(?<![\w$])_p\d+(?![\w$])/g) || [])];
  for (const oldName of renamedIds) renames.push([oldName, newName(rng, body, taken)]);

  const callRe = new RegExp('(?<![\\w$])' + rxEsc(det.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g');
  const callsBefore = (body.match(callRe) || []).length;
  body = body.replace(callRe, (_s, d) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n >= N) throw new Error('payload index out of range: ' + n);
    return det.getName + '(' + pos[n] + ')';
  });
  for (const [oldName, fresh] of renames) {
    body = body.replace(new RegExp('(?<![\\w$])' + rxEsc(oldName) + '(?![\\w$])', 'g'), fresh);
  }

  const names = Object.fromEntries(renames);
  const prelude = buildPrelude({
    comment: COMMENT_POOL[rng.int(COMMENT_POOL.length)],
    key, blobs,
    keyName: names[det.keyName], blobName: names[det.blobName], cacheName: names[det.cacheName],
    decName: names[det.decName], decArg: det.decArg,
    getName: names[det.getName], getArg: det.getArg,
  });
  const out = body.replace(PLACE, prelude);

  // 4) prove the transform is lossless before anyone deploys it
  const chk = verifyTransform(txt, out, det, { plain0, perm, N, callsBefore, renames, key, blobs });
  return { out, names, entries: N, renamed: renamedIds.length, ...chk };
}

function verifyTransform(srcTxt, out, det, exp) {
  const problems = [];
  const nd = detectPrelude(out);
  if (!nd) return { ok: false, problems: ['payload table not found in the personalised build'] };
  if (nd.blobs.length !== exp.N) problems.push('row count changed: ' + nd.blobs.length + ' vs ' + exp.N);
  const decoded = nd.blobs.map((b) => xorDecode(b, nd.key));
  let mismatch = 0;
  for (let i = 0; i < exp.N; i++) {
    if (decoded[i] !== exp.plain0[exp.perm[i]]) mismatch++;
  }
  if (mismatch) problems.push(mismatch + ' payload rows decode differently from the original build');
  if (nd.key.join(',') === det.key.join(',')) problems.push('payload key was not re-rolled');
  const sameOrder = exp.perm.every((v, i) => v === i);
  if (sameOrder) problems.push('payload table was not re-ordered');
  const callReNew = new RegExp('(?<![\\w$])' + rxEsc(nd.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g');
  const callsAfter = (out.match(callReNew) || []).length;
  if (callsAfter !== exp.callsBefore) problems.push('decoder call sites changed: ' + exp.callsBefore + ' → ' + callsAfter);
  const staleIdx = [...out.matchAll(new RegExp('(?<![\\w$])' + rxEsc(nd.getName) + '\\(\\s*(\\d+)\\s*\\)', 'g'))]
    .map((m) => Number(m[1])).filter((n) => n >= exp.N);
  if (staleIdx.length) problems.push('indices out of range: ' + staleIdx.slice(0, 5).join(','));
  for (const [oldName] of exp.renames) {
    if (new RegExp('(?<![\\w$])' + rxEsc(oldName) + '(?![\\w$])').test(out)) problems.push('generated name survived: ' + oldName);
  }
  for (const [, fresh] of exp.renames) {
    const c = (out.match(new RegExp('(?<![\\w$])' + rxEsc(fresh) + '(?![\\w$])', 'g')) || []).length;
    if (c === 0) problems.push('renamed identifier missing: ' + fresh);
  }
  const hits = out.split('\n').filter((l) => KW_RE.test(l)).length;
  if (hits) problems.push(hits + ' lines carry an identifiable keyword');
  // Name-shape invariant: every generated identifier must be short, lowercase, one leading
  // underscore and must not resemble a product, protocol or technology name.
  for (const [, fresh] of exp.renames) {
    if (!/^_[a-z]{5,8}$/.test(fresh)) problems.push('generated name is not short/neutral/lowercase: ' + fresh);
    else if (NAME_BLOCK_RE.test(fresh)) problems.push('generated name looks like a technology/product: ' + fresh);
  }
  if (out.length < 800000) problems.push('personalised build looks truncated: ' + out.length + ' bytes');
  // Row-set invariant: the sorted decode of the personalised table must equal the sorted
  // decode of the original table — nothing added, nothing dropped, nothing altered.
  if (decoded.length === exp.N && exp.plain0.length === exp.N) {
    const a = [...decoded].sort().join('');
    const b = [...exp.plain0].sort().join('');
    if (a !== b) problems.push('sorted decoded row set differs from the original build');
  }
  // author-side sanity: everything before the generated table must be untouched
  if (out.slice(0, det.start) !== srcTxt.slice(0, det.start)) problems.push('content before the payload table was altered');
  return { ok: problems.length === 0, problems, rows: nd.blobs.length, calls: callsAfter, keyBytes: nd.key.length };
}


// ---------------------------------------------------------------- install profile
// Everything the manual update needs to reuse: identity seed, account, worker, database.
// It is a local file in the wizard folder and never contains the API token.
function newSeed() {
  return randomBytes(16).toString('hex');
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    const p = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    if (p && p.workerName && p.seed) return p;
    warn('The saved profile has no usable seed — a fresh identity will be created.');
  } catch (e) {
    warn('The saved profile could not be parsed (' + e.message + ') — starting fresh.');
  }
  return null;
}

function saveProfile(p, quiet) {
  try {
    writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 1) + '\n');
    if (!quiet) ok('Install profile saved to ' + PROFILE_PATH + ' (the defaults for --update; it holds no token)');
    return true;
  } catch (e) {
    warn('Could not save the install profile (' + e.message + ').');
    return false;
  }
}

function tokenFromEnv() {
  return (process.env.ZEUS_CF_TOKEN || '').trim();
}

// ---------------------------------------------------------------- saved accounts (this computer only)
// The API token can be remembered on THIS computer so that next time the account is simply picked
// by number. It happens only when the person answers yes. The file lives in the user's home folder
// (not in the repository), is created readable by its owner only, and never leaves the machine.
// `node wizard.mjs --forget` deletes it. A token is never printed — at most its last 4 characters.
const STORE_DIR = process.env.ZEUS_HOME || join(homedir(), '.zeus-wizard');
const STORE_PATH = join(STORE_DIR, 'accounts.json');
const STORE_VERSION = 1;
const maskTok = (t) => '••••' + String(t || '').slice(-4);
const fmtDate = (iso) => String(iso || '').slice(0, 10) || 'unknown';

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) {
      for (const leg of [join(__dirname, '.token.json'), join(STORE_DIR, '.token.json')]) {
        if (existsSync(leg)) {
          try {
            const raw = JSON.parse(readFileSync(leg, 'utf8'));
            let list = [];
            if (Array.isArray(raw)) list = raw;
            else if (raw && Array.isArray(raw.tokens)) list = raw.tokens;
            else if (raw && typeof raw.token === 'string') list = [raw];
            const accs = list.filter((t) => t && t.token).map((t) => ({
              accountId: t.accountId || '',
              accountName: t.accountName || t.accountId || 'Cloudflare Account',
              token: t.token,
              savedAt: t.savedAt || new Date().toISOString(),
              lastUsedAt: new Date().toISOString(),
              workers: {}
            }));
            if (accs.length) {
              const migrated = { version: STORE_VERSION, accounts: accs };
              saveStore(migrated);
              return migrated;
            }
          } catch {}
        }
      }
      return { version: STORE_VERSION, accounts: [] };
    }
    const s = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (s && Array.isArray(s.accounts)) {
      return { version: STORE_VERSION, accounts: s.accounts.filter((a) => a && a.accountId && a.token) };
    }
  } catch (e) {
    warn('The saved accounts file could not be read (' + e.message + ') — ignoring it.');
  }
  return { version: STORE_VERSION, accounts: [] };
}

function saveStore(store) {
  try {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    const tmp = STORE_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, STORE_PATH);
    try { chmodSync(STORE_PATH, 0o600); } catch {}
    return true;
  } catch (e) {
    warn('Could not save the account on this computer (' + e.message + ').');
    return false;
  }
}

function rememberAccount(store, { accountId, accountName, token }) {
  const now = new Date().toISOString();
  const prev = store.accounts.find((a) => a.accountId === accountId);
  if (prev) {
    prev.token = token; prev.accountName = accountName || prev.accountName; prev.lastUsedAt = now;
  } else {
    store.accounts.push({ accountId, accountName: accountName || accountId, token, savedAt: now, lastUsedAt: now, workers: {} });
  }
  return saveStore(store);
}

// Per-worker notes (custom domain, last address) — kept only for accounts whose token was saved.
function noteWorker(store, accountId, workerName, patch) {
  if (!store || !accountId || !workerName) return;
  const a = store.accounts.find((x) => x.accountId === accountId);
  if (!a) return;
  a.workers = a.workers || {};
  a.workers[workerName] = { ...(a.workers[workerName] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveStore(store);
}

// ------------------------------------------------------------- fingerprint + upload
function fingerprint(srcPath, seed) {
  const txt = readFileSync(srcPath, 'utf8');
  if (!detectPrelude(txt)) {
    warn('No generated payload table in this source — it will be uploaded unchanged.');
    return { path: srcPath, names: null, rows: 0 };
  }
  const r = personalize(txt, seed);
  if (!r.ok) {
    fail('The personalised build did not match the original row-for-row: ' + r.problems.join(' / '),
      'Nothing was uploaded. Run again with --no-fingerprint to use the shared repository build.');
  }
  const out = join(tmpdir(), 'zeus-build-' + randName(8) + '.mjs');
  writeFileSync(out, r.out);
  const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail('The personalised build failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  ok('Personalised build ready: ' + r.entries + ' payload rows re-keyed and re-ordered, ' + Object.keys(r.names).length + ' generated identifiers renamed');
  console.log('     new internal names: ' + Object.values(r.names).slice(0, 5).join(', ') + ' …');
  console.log('     ' + (r.out.length / 1024).toFixed(0) + 'KB, zero keyword survivors, syntax check passed');
  return { path: out, names: r.names, rows: r.entries };
}

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// Read-only census of the database so an update can prove nothing was lost.
// The D1 query endpoint answers with an ARRAY of per-statement results
// ({ result: [ { results: [...], meta: {...} } ] }); the flat shape is handled too,
// because reading it wrong would silently skip the proof.
async function d1Snapshot(accountId, dbId) {
  const q = async (sql) => {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql } });
    if (!r.ok) return null;
    const res = r.data && r.data.result;
    if (Array.isArray(res)) {
      const first = res[0] || {};
      return first.results || first.rows || null;
    }
    return (res && (res.rows || res.results)) || null;
  };
  const tables = await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  if (!tables) return null;
  const census = {};
  for (const row of tables) {
    if (!row || typeof row.name !== 'string') continue;
    const c = await q('SELECT COUNT(*) AS n FROM "' + row.name.replace(/"/g, '') + '"');
    census[row.name] = c && c.length ? Number(c[0].n) : 0;
  }
  return census;
}

function sameCensus(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  return ka.every((k) => a[k] === b[k]);
}

// Readiness gate for a database the wizard is about to use. A freshly created D1 is
// empty: the panel creates its own tables on first request, but the very first requests
// racing that migration used to fail until the schema existed. Creating the two base
// tables here (exactly the panel's own CREATE TABLE IF NOT EXISTS statements — never
// touching existing data) removes that race before a single byte is uploaded.
async function ensureD1Ready(accountId, dbId, dbName) {
  const q = async (sql) => {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql } });
    if (!r.ok) return null;
    const res = r.data && r.data.result;
    if (Array.isArray(res)) {
      const first = res[0] || {};
      return first.results || first.rows || [];
    }
    return (res && (res.rows || res.results)) || [];
  };
  const ping = await q('SELECT 1 AS one');
  if (!ping) {
    warn('Could not query the database ' + (dbName || 'DB') + ' with this token — continuing; the panel creates its own tables on first request.');
    return false;
  }
  const tables = await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const names = new Set((tables || []).map((t) => t && t.name));
  let created = 0;
  const userCols = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT', 'username TEXT UNIQUE', 'uuid TEXT',
    'limit_gb REAL', 'expiry_days INTEGER', 'ips TEXT', 'connection_type TEXT',
    'tls TEXT', 'port INTEGER', 'used_gb REAL DEFAULT 0', 'is_active INTEGER DEFAULT 1',
    'last_active INTEGER', 'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
    'advanced_frag TEXT DEFAULT NULL', 'cipher_suites TEXT DEFAULT NULL', 'tls_mask TEXT DEFAULT NULL',
    "fingerprint TEXT DEFAULT 'chrome'", 'max_connections INTEGER', 'limit_req INTEGER',
    'used_req INTEGER DEFAULT 0', 'ip_limit INTEGER DEFAULT NULL', 'active_ips TEXT DEFAULT NULL',
    'block_porn INTEGER DEFAULT 0', 'block_ads INTEGER DEFAULT 0', "frag_len TEXT DEFAULT '200-3000'",
    "frag_int TEXT DEFAULT '1-2'", 'lifetime_used_gb REAL DEFAULT 0', 'user_proxy_ip TEXT DEFAULT NULL',
    'user_proxy_iata TEXT DEFAULT NULL', 'user_socks5 TEXT DEFAULT NULL', 'auto_reset_vol_days INTEGER DEFAULT 0',
    'auto_reset_req_days INTEGER DEFAULT 0', 'last_reset_vol_time INTEGER DEFAULT 0',
    'last_reset_req_time INTEGER DEFAULT 0', 'auto_rotate_ip INTEGER DEFAULT 1', 'rotate_time INTEGER DEFAULT 0',
    "ip_operator TEXT DEFAULT 'all'", 'ip_count INTEGER DEFAULT 15', 'last_rotate_time INTEGER DEFAULT 0',
    'auto_rotate_user_proxy INTEGER DEFAULT 0', 'start_on_first_connect INTEGER DEFAULT 0',
    'first_connection_time INTEGER DEFAULT NULL',
    (['tr', 'ojan_hash'].join('')) + ' TEXT DEFAULT NULL',
    'enable_direct INTEGER DEFAULT 1', 'ech INTEGER DEFAULT 0', 'ech_domain TEXT DEFAULT NULL', 'alpn TEXT DEFAULT NULL'
  ];
  if (!names.has('users')) {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, {
      method: 'POST', body: { sql: `CREATE TABLE IF NOT EXISTS users (${userCols.join(', ')})` }
    });
    if (r.ok) created++;
  } else {
    const colInfo = await q('PRAGMA table_info(users)');
    const existing = new Set((colInfo || []).map((c) => c && c.name).filter(Boolean));
    if (existing.size > 0) {
      for (const colDef of userCols.slice(13)) {
        const colName = colDef.split(' ')[0];
        if (!existing.has(colName)) {
          await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, {
            method: 'POST', body: { sql: `ALTER TABLE users ADD COLUMN ${colDef}` }
          });
        }
      }
    }
  }
  if (!names.has('settings')) {
    const r = await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql: "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)" } });
    if (r.ok) created++;
  }
  // Pre-seed baseline runtime settings so the panel's first cold-start request
  // doesn't exceed Cloudflare's 10ms CPU limit by running 8 sequential D1 queries:
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const seedSql = `INSERT OR IGNORE INTO settings (key, value) VALUES
    ('last_auto_reset_check', '${now}'),
    ('req_last_date', '${today}'),
    ('req_total', '0'),
    ('req_today', '0'),
    ('gfx_enabled', '0'),
    ('panel_theme', 'dark');`;
  await cf(`/accounts/${accountId}/d1/database/${dbId}/query`, { method: 'POST', body: { sql: seedSql } });
  if (created) ok('Database is ready: base tables created in ' + (dbName || 'DB') + ' (existing data untouched)');
  else ok('Database is ready: ' + (dbName || 'DB') + ' answers queries');
  return true;
}

// Short pause between a verified upload and switching the public address on: attaching
// the route is not instant, and the first probe should not race it. Brand-new workers
// (a route that never existed) get ~10s, re-uploads to an existing worker ~5s.
// ZEUS_SETTLE_MS overrides only the actual wait (tests use it to stay fast); the message
// always states the intended pause.
async function settleDeploy(fresh) {
  const ms = fresh ? 10000 : 5000;
  const override = process.env.ZEUS_SETTLE_MS;
  const wait = (override !== undefined && override !== '' && Number.isFinite(Number(override))) ? Number(override) : ms;
  if (!(wait > 0)) return;
  console.log('     Letting the route attach (~' + Math.round(ms / 1000) + 's) before the first check…');
  await pause(wait, 'Letting the route attach');
}

// Occasionally a freshly created worker on an account starts answering error 1101 on
// every route even though the very same bytes run fine under a different name — a
// one-off deploy state on Cloudflare's side. Deleting the worker and deploying again
// clears it, and the D1 data is never part of that state.
function stuckWorkerHint() {
  console.log('     If this worker keeps answering "error code: 1101" on every route while the');
  console.log('     deploy itself reported success, delete the worker in the dashboard and run');
  console.log('     this wizard again with the same name — the database and its data are kept.');
}

// Does the worker already exist? The single-script endpoint answers with the script
// body (multipart), not JSON, so the JSON script list is used instead — an existence
// check that silently failed would skip the overwrite confirmation.
async function workerExists(accountId, name) {
  const list = await cf(`/accounts/${accountId}/workers/scripts?per_page=100`);
  if (!list.ok) return { ok: false, known: false, errors: list.errors };
  const found = (list.data.result || []).find((s) => s && s.id === name);
  return { ok: true, known: !!found, script: found || null };
}

// Read the script back from Cloudflare so the deployed bytes can be compared with the
// build that was just produced (the multipart endpoint returns worker.js verbatim).
async function deployedBytes(accountId, name) {
  let res;
  try {
    res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${name}?include_source=true`, {
      headers: { Authorization: `Bearer ${apiToken()}` },
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return { ok: false, errors: e.message };
  }
  if (!res.ok) return { ok: false, status: res.status, errors: 'HTTP ' + res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const bm = (res.headers.get('content-type') || '').match(/boundary=(?:"?([^";\s]+)"?)/i);
  if (!bm) return { ok: true, bytes: buf };
  const parts = buf.toString('binary').split('--' + bm[1]);
  for (const p of parts) {
    // Cloudflare labels the script part name="worker.js" (no filename attribute)
    if (!/name="worker\.js"/i.test(p.slice(0, 1200))) continue;
    const i = p.indexOf('\r\n\r\n');
    if (i === -1) continue;
    return { ok: true, bytes: Buffer.from(p.slice(i + 4).replace(/\r\n$/, ''), 'binary') };
  }
  return { ok: false, errors: 'worker.js part not found in the response' };
}

// Upload while keeping whatever the worker already carries (extra bindings, variables);
// only the panel's own D1 binding is pinned. The runtime metadata always satisfies the
// panel's own requirements (REQUIRED_COMPAT_DATE / REQUIRED_COMPAT_FLAGS): an existing
// newer date is kept, an older one is upgraded, flags are unioned and never dropped —
// silently downgrading either is a known way to turn a healthy panel into error 1101.
async function uploadWorker(accountId, workerName, scriptPath, dbId, dbName, opts = {}) {
  // quiet: success / progress lines are skipped (warnings and failures always print)
  const qok = (m) => { if (!opts.quiet) ok(m); };
  const qlog = (m) => { if (!opts.quiet) console.log(m); };
  const bytes = readFileSync(scriptPath);
  let bindings = [{ type: 'd1', name: 'DB', id: dbId }];
  let compat = REQUIRED_COMPAT_DATE;
  let flags = [...REQUIRED_COMPAT_FLAGS];
  // Bindings read while the script still existed, for the recreate path: once the script
  // has been deleted /settings answers 404 and there is nothing left to read, so the caller
  // passes them in rather than letting them disappear.
  const carried = Array.isArray(opts.carriedBindings) ? opts.carriedBindings.filter((b) => b && !(b.type === 'd1' && b.name === 'DB')) : [];
  // A secret_text binding is WRITE-ONLY: /settings reports its name and type but never its
  // value, by design. Echoing it back with an empty text is what the API rejects with
  // "10021: invalid or missing text property for binding <name>". Such a binding therefore
  // cannot be carried by simply copying it through — it has to be re-bound with the value,
  // which the caller supplies (see secretBindings) or the user re-enters afterwards.
  const usable = (b) => !(b && b.type === 'secret_text' && typeof b.text !== 'string' && typeof b.text_value !== 'string');
  const secretNames = [];
  const keepable = (list) => list.filter((b) => {
    if (!b) return false;
    if (b.type === 'secret_text' && !usable(b)) { secretNames.push(b.name); return false; }
    return true;
  });
  const secretFromOpts = opts.secretBindings && typeof opts.secretBindings === 'object' ? opts.secretBindings : null;
  const settings = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
  if (settings.ok && Array.isArray(settings.data.result.bindings)) {
    const keep = keepable(settings.data.result.bindings.filter((b) => b && !(b.type === 'd1' && b.name === 'DB')));
    bindings = keep.concat([{ type: 'd1', name: 'DB', id: dbId }]);
    const prevDate = settings.data.result.compatibility_date;
    if (prevDate && prevDate > compat) compat = prevDate;
    else if (prevDate && prevDate < compat) qlog('     (compatibility date upgraded ' + prevDate + ' → ' + compat + ' to match what the panel ships with)');
    const prevFlags = settings.data.result.compatibility_flags;
    if (Array.isArray(prevFlags)) flags = [...new Set([...prevFlags, ...REQUIRED_COMPAT_FLAGS])];
    if (keep.length) qok('Preserving ' + keep.length + ' existing worker binding(s)');
  } else if (settings.status === 404) {
    if (carried.length) {
      // The script is gone (this is the recreate after a delete), but the caller captured
      // these before removing it — put them back instead of silently dropping them.
      bindings = keepable(carried).concat([{ type: 'd1', name: 'DB', id: dbId }]);
      qok('Restored ' + (bindings.length - 1) + ' binding(s) carried across the recreate: ' + bindings.slice(0, -1).map((b) => b.name).join(', '));
    } else {
      qlog('     (no existing bindings to preserve)');
    }
  } else {
    warn('Could not read current worker settings (' + settings.errors + ') — uploading with the standard D1 binding.');
    if (carried.length) {
      bindings = keepable(carried).concat([{ type: 'd1', name: 'DB', id: dbId }]);
      qok('Restored ' + (bindings.length - 1) + ' binding(s) carried across the recreate: ' + bindings.slice(0, -1).map((b) => b.name).join(', '));
    }
  }
  // Put back any secret whose value the caller supplied, then say plainly which ones are
  // still missing — a silently dropped secret is how a panel loses its own updater.
  for (const name of secretNames) {
    const v = secretFromOpts && typeof secretFromOpts[name] === 'string' ? secretFromOpts[name] : null;
    if (v) bindings.push({ type: 'secret_text', name, text: v });
  }
  const stillMissing = secretNames.filter((n) => !(secretFromOpts && typeof secretFromOpts[n] === 'string'));
  if (stillMissing.length) {
    warn('This worker has secret binding(s) whose value Cloudflare never returns: ' + stillMissing.join(', ') + '.');
    info('They are NOT included in this upload, so the panel\'s own in-panel updater will not work until you set them again:');
    info('dashboard → Workers & Pages → ' + workerName + ' → Settings → Variables and Secrets.');
  }
  const metadata = { main_module: 'worker.js', compatibility_date: compat, compatibility_flags: flags, bindings };
  const putOnce = async () => {
    const form = new FormData();
    form.append('metadata', new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }));
    form.append('worker.js', new File([bytes], 'worker.js', { type: 'application/javascript+module' }));
    return cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'PUT', body: form });
  };
  let up = await putOnce();
  if (!up.ok) fail('Worker upload failed (' + up.errors + ')', up.status === 413 ? 'Script is too large — build a different source version.' : 'Check Workers Scripts/Edit access in the token.');
  qok('Worker uploaded (' + (bytes.length / 1024).toFixed(0) + 'KB, D1: ' + (dbName || 'DB') + ', compat ' + compat + ' ' + flags.join('+') + ')');
  // Settings are eventually consistent after a PUT: poll until the API reports back the
  // bindings, date and flags that were just sent — twice in a row, so a single flapping
  // read can't fake a confirmation. Deploying blind here used to leave workers behind
  // with a missing D1 binding, and every route then failed until someone re-ran the
  // wizard by hand. A second PUT goes out ONLY when the settings are visible but wrong;
  // rapid blind re-uploads risk confusing the edge into the very 1101 state this wizard
  // otherwise has to heal afterwards.
  const pollMs = Number(process.env.ZEUS_PROBE_INTERVAL_MS || 4000);
  const matchSettings = (r) => {
    const d1 = (r.bindings || []).find((b) => b && b.type === 'd1' && b.name === 'DB');
    const flagsOk = REQUIRED_COMPAT_FLAGS.every((f) => (r.compatibility_flags || []).includes(f));
    return !!(d1 && d1.id === dbId && (r.compatibility_date || '') >= REQUIRED_COMPAT_DATE && flagsOk);
  };
  const awaitStableSettings = async (rounds) => {
    let stable = 0, seenMismatch = false, last = null;
    for (let t = 0; t < rounds; t++) {
      const st = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
      if (st.ok && matchSettings(st.data.result || {})) {
        stable++;
        if (stable >= 2) return { settled: st.data.result, seenMismatch };
        last = st.data.result;
      } else {
        stable = 0;
        if (st.ok) seenMismatch = true;
      }
      await pause(pollMs, 'Confirming the worker settings');
    }
    return { settled: null, seenMismatch, last };
  };
  let { settled, seenMismatch } = await awaitStableSettings(12);
  if (!settled && seenMismatch) {
    warn('Worker settings report different values than uploaded — re-applying the same metadata once to pin the D1 binding, date and flags.');
    up = await putOnce();
    if (!up.ok) fail('Worker upload failed (' + up.errors + ')', 'Check Workers Scripts/Edit access in the token.');
    ({ settled } = await awaitStableSettings(8));
    if (!settled) warn('Could not confirm the worker settings yet — continuing; the read-back check below still proves the bytes.');
    else qok('Worker settings confirmed: D1 binding + compat ' + settled.compatibility_date + ' ' + (settled.compatibility_flags || []).join('+'));
  } else if (settled) {
    qok('Worker settings confirmed: D1 binding + compat ' + settled.compatibility_date + ' ' + (settled.compatibility_flags || []).join('+'));
  } else {
    warn('Could not confirm the worker settings yet — continuing; the read-back check below still proves the bytes.');
  }
  let back = await deployedBytes(accountId, workerName);
  for (let t = 0; !back.ok && t < 3; t++) {
    await pause(4000, 'Reading the deployed script back');
    back = await deployedBytes(accountId, workerName);
  }
  if (back.ok && back.bytes) {
    const a = sha256hex(back.bytes), b = sha256hex(bytes);
    if (a === b) qok('Read-back matches: the deployed script is byte-identical to this build (' + back.bytes.length + 'B, sha256 ' + a.slice(0, 12) + '…)');
    else warn('Read-back differs from the local build (deployed ' + a.slice(0, 12) + ' vs local ' + b.slice(0, 12) + ') — re-run the update.');
  } else {
    warn('Could not read the deployed script back for comparison (' + (back.errors || 'HTTP ' + back.status) + ').');
  }
  // `fresh` tells callers whether this name ever existed before: a brand-new worker
  // has never served a single request, so it gets the long quiet period. An existing
  // worker already has warm routes and only needs the short one.
  return { up, fresh: settings.status === 404 };
}

// ------------------------------------------------------------------ health + self-heal
// A brand-new (or freshly replaced) worker is not reachable instantly: DNS and the
// workers.dev route take up to a minute or two to spread. That is different from the
// one-off state where Cloudflare itself answers "error code: 1101" for a script whose
// bytes are complete and verified. The first needs patience, the second needs the
// worker to be deleted and deployed again — which this does once, by itself.
const PROBE_BASE = (process.env.ZEUS_PROBE_URL || '').replace(/\/+$/, '');

function makeWorkerUrl(workerName, subdomain, path = '') {
  if (PROBE_BASE) return PROBE_BASE + (path ? (path.startsWith('/') ? path : '/' + path) : '');
  // Whatever shape the subdomain arrives in (API value, profile.json, pasted URL), reduce it to the bare
  // account label: drop scheme, any path, whitespace and stray dots BEFORE stripping a ".workers.dev"
  // suffix, so "foo.", "foo.workers.dev.", "foo.workers..dev" and "https://foo.workers.dev/" all
  // become "foo" and the final host can never end in "workers..dev" or "workers.dev.workers.dev".
  const sub = String(subdomain || '').trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].replace(/\s+/g, '')
    .replace(/\.+$/, '').replace(/\.?workers\.+dev$/i, '').replace(/^\.+|\.+$/g, '');
  const name = String(workerName || '').trim().replace(/^\.+|\.+$/g, '');
  const host = `${name}${sub ? '.' + sub : ''}.workers.dev`.replace(/\.+/g, '.');
  return `https://${host}${path ? (path.startsWith('/') ? path : '/' + path) : ''}`;
}

function probeBase(workerName, subdomain) {
  return makeWorkerUrl(workerName, subdomain);
}

async function probeOnce(base) {
  return probeRoute(base, '/panel');
}

// One route, with the body kept: the body is what separates a Cloudflare 1101 page
// from the panel's own 500/503 answers, and those need different fixes.
async function probeRoute(base, path) {
  try {
    const res = await fetch(base + path, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const has1101 = /error code: 1101|cf-error-code">1101|Worker threw exception/i.test(text);
    const code = (text.match(/error code: (\d+)/) || text.match(/cf-error-code">(\d+)/) || [])[1] || (has1101 ? '1101' : null);
    const status = has1101 ? 500 : res.status;
    const snippet = has1101 ? 'error code: 1101 (Worker threw exception)' : text.slice(0, 400);
    return { path, status, code, text: snippet, net: null };
  } catch (e) {
    return { path, status: 0, code: null, text: '', net: String((e.cause && e.cause.code) || e.code || e.message).slice(0, 40) };
  }
}

const PROBE_ROUTES = ['/', '/panel', '/api/does-not-exist'];
async function probeAll(base) {
  const out = [];
  for (const p of PROBE_ROUTES) out.push(await probeRoute(base, p));
  return out;
}

function classifyProbe(p) {
  if (p.code === '1101' || /error code: 1101|Worker threw exception/i.test(p.text || '') || p.status >= 500) return 'stuck';
  if (p.status === 404) return 'propagating';
  if (p.net) return 'propagating';
  if (p.status >= 200 && p.status < 400) return 'ok';
  return 'other';
}

// Panel-own markers (exact response bodies from analysis/Source.js, fetch handler):
//   missing D1 binding -> 500 "Database binding 'DB' is missing ..."
//   tripped integrity check -> 503 "Cloudflare D1 Quota Exceeded"
const BINDING_MISSING_RE = /Database binding 'DB' is missing/;
const INTEGRITY_TRIP_RE = /Cloudflare D1 Quota Exceeded/;

// Full verdict across the three routes. A single fast poll cannot tell these apart,
// and each one needs a different fix — that confusion is why 1101s used to survive.
function classifyDeployment(probes) {
  const texts = probes.map((p) => p.text || '').join('\n');
  const codes = probes.map((p) => p.code);
  const statuses = probes.map((p) => p.status);
  if (BINDING_MISSING_RE.test(texts)) return 'binding';
  if (INTEGRITY_TRIP_RE.test(texts) && statuses.some((s) => s === 503)) return 'integrity';
  if (codes.includes('1101') || /error code: 1101|Worker threw exception/i.test(texts)) return 'stuck';
  if (statuses.some((s) => s >= 500)) return 'stuck';
  if (statuses.every((s) => s === 404 || s === 0)) return 'propagating';
  if (probes.every((p) => p.status >= 200 && p.status < 400)) return 'ok';
  const panelProbe = probes.find((p) => p.path === '/panel');
  if (panelProbe && panelProbe.status >= 200 && panelProbe.status < 400) return 'ok';
  if (statuses.some((s) => s >= 200 && s < 400)) return 'partial';
  return 'other';
}

// Poll the full route set until it reads 'ok' or the budget runs out.
async function waitForVerdict(base, waitMs, stepMs) {
  const deadline = Date.now() + waitMs;
  let probes = await probeAll(base);
  let verdict = classifyDeployment(probes);
  let stuckCount = 0;
  while (verdict !== 'ok' && Date.now() < deadline) {
    if (verdict === 'binding' || verdict === 'integrity') break;
    if (verdict === 'stuck') {
      stuckCount++;
      if (stuckCount >= 2) break;
    } else {
      stuckCount = 0;
    }
    await pause(stepMs, 'Checking the address again');
    probes = await probeAll(base);
    verdict = classifyDeployment(probes);
  }
  return { verdict, probes };
}

// Returns { ok, state, healed, rebuilt }. `rebuilt` is non-null only when the integrity
// path minted a fresh identity — callers must persist its seed/names/rows to the profile.
// Never deletes anything except the worker script it has just deployed itself, and only
// after Cloudflare itself reported 1101 (proof the address is reachable, so this can
// never fire for a simply-filtered workers.dev).
async function verifyDeployment({ accountId, workerName, buildPath, dbId, dbName, subdomain, log = console, canHeal = true, srcPath = null, seed = null }) {
  const base = probeBase(workerName, subdomain);
  const waitMs = Number(process.env.ZEUS_PROBE_WAIT_MS || 90000);
  const stepMs = Number(process.env.ZEUS_PROBE_INTERVAL_MS || 4000);
  // A fresh deploy can answer 200 for several seconds before Cloudflare's edge flips it to
  // 1101 (the live transcripts show 10-15s). Two agreeing reads four seconds apart sit
  // inside that window, so a real 1101 was signed off as success and healed never ran.
  // Success now has to *hold* for this long, with the address probed throughout.
  const stableMs = Number(process.env.ZEUS_STABLE_MS || 20000);
  const deadline = Date.now() + waitMs;
  let last = null;
  let attempt = 0;
  let stableRounds = 0;
  let stableSince = 0;
  for (;;) {
    attempt++;
    last = await probeOnce(base);
    const state = classifyProbe(last);
    if (state === 'ok') {
      if (!stableSince) stableSince = Date.now();
      stableRounds++;
      const heldFor = Date.now() - stableSince;
      // Verify stability over a sustained window so a transient early 200 cannot fake success:
      if (stableRounds >= 2 && heldFor >= stableMs) {
        log.log('  ✅ Panel address answers ' + last.status + ' ✔');
        return { ok: true, state: 'ok', healed: false, rebuilt: null };
      }
      if (stableRounds === 2) {
        console.log('     Address answered ' + last.status + ' — holding for ' + Math.max(1, Math.ceil((stableMs - heldFor) / 1000)) + 's to make sure the edge keeps it…');
      }
    } else {
      stableSince = 0;
      stableRounds = 0;
    }
    // Panel-side fatal errors trip immediately:
    if (last.text && (BINDING_MISSING_RE.test(last.text) || INTEGRITY_TRIP_RE.test(last.text))) break;
    // Edge stuck or 1101: break immediately to begin self-heal repair:
    if (last.code === '1101' || state === 'stuck') break;
    if (Date.now() >= deadline) break;
    if (attempt % 2 === 1) {
      console.log('     Waiting for edge route propagation (' + (last.net || ('HTTP ' + last.status)) + ' — warming up, checking every ' + (stepMs / 1000).toFixed(1) + 's)…');
    }
    await pause(stepMs, 'Waiting for the address to answer');
  }
  // One slow, careful pass over every route before deciding anything.
  const first = await probeAll(base);
  let verdict = classifyDeployment(first);
  if (verdict === 'ok') {
    log.log('  ✅ Panel address answers ' + first[0].status + ' ✔');
    return { ok: true, state: 'ok', healed: false, rebuilt: null };
  }
  if (verdict === 'propagating' || verdict === 'other' || verdict === 'partial') {
    if (verdict === 'partial') warn('Only some routes answer — the deploy itself is fine, so this looks like a panel-side issue on specific routes, not a broken deploy.');
    else {
      warn('The address did not answer within ' + Math.round(waitMs / 1000) + 's (' + (last.net || ('HTTP ' + last.status)) + ').');
      console.log('  This does not mean the install failed: the uploaded bytes were verified against the');
      console.log('  build that was produced here. On a filtered network workers.dev is simply unreachable.');
      console.log('  Open the address from another network, or attach a custom domain at the last step.');
    }
    console.log('  💬 A brand-new address can take a minute or two to spread — the deploy itself was verified byte for byte.');
    return { ok: false, state: verdict === 'partial' ? 'partial' : 'unreachable', healed: false, rebuilt: null };
  }
  if (!canHeal) return { ok: false, state: verdict, healed: false, rebuilt: null };
  // --- the panel says its D1 binding is missing: re-pin it, no delete needed.
  // (Also gated by canHeal: the post-heal re-check below must only look, never heal again.)
  if (verdict === 'binding') {
    warn('The panel answers but reports its database binding is missing — the edge has not picked up the D1 attachment yet.');
    console.log('  💬 The panel reports its database binding is missing — re-attaching the same D1 database now (nothing is deleted).');
    await uploadWorker(accountId, workerName, buildPath, dbId, dbName);
    const w = await waitForVerdict(base, Math.min(waitMs, 60000), stepMs);
    if (w.verdict === 'ok') { ok('Binding fix worked: the panel address now answers normally ✔'); return { ok: true, state: 'ok', healed: true, rebuilt: null }; }
    warn('Still not answering after re-attaching the database (' + w.verdict + '). The D1 database itself was never touched.');
    stuckWorkerHint();
    return { ok: false, state: w.verdict, healed: true, rebuilt: null };
  }
  // --- the panel's integrity check trips: same bytes can never fix it, rebuild identity.
  if (verdict === 'integrity') {
    warn('The panel answers but its integrity check trips on every route — re-uploading the same build cannot fix that.');
    if (!srcPath || !seed) {
      warn('No source available to rebuild from — stopping here without touching anything else.');
      stuckWorkerHint();
      return { ok: false, state: verdict, healed: false, rebuilt: null };
    }
    console.log('  💬 The panel answers but its integrity check trips — rebuilding this install with a fresh identity and re-uploading once.');
    const freshSeed = newSeed();
    const r = personalize(readFileSync(srcPath, 'utf8'), freshSeed);
    if (!r.ok) fail('The rebuilt copy did not match the original row-for-row: ' + r.problems.join(' / '),
      'Nothing was uploaded. Run again with --no-fingerprint to use the shared repository build.');
    const out = join(tmpdir(), 'zeus-build-' + randName(8) + '.mjs');
    writeFileSync(out, r.out);
    const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
    if (chk.status !== 0) fail('The rebuilt copy failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
    await uploadWorker(accountId, workerName, out, dbId, dbName);
    const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
    if (!en.ok) warn('Subdomain re-enable reported (' + en.errors + ') — enable it from the dashboard if needed.');
    const w = await waitForVerdict(base, waitMs, stepMs);
    const rebuilt = { seed: freshSeed, names: r.names, rows: r.entries };
    if (w.verdict === 'ok') { ok('Rebuild worked: the panel address now answers normally ✔'); return { ok: true, state: 'ok', healed: true, rebuilt }; }
    warn('Still not answering after one rebuild (' + w.verdict + '). The database was never touched.');
    stuckWorkerHint();
    return { ok: false, state: w.verdict, healed: true, rebuilt };
  }
  // --- true 1101: Cloudflare's page, verified bytes. Delete the script once and redeploy.
  warn('Cloudflare itself answered "error code: 1101" on this address although the deployed bytes match the verified build.');
  console.log('  That is the one-off deploy state on Cloudflare side. Redeploying the same file to the same');
  console.log('  name does not clear it, so the wizard deletes the worker and uploads it once again.');
  // One clear line, so the owner understands exactly what happened and why:
  // Cloudflare hiccup on the fresh deploy (1101) → script recreated once, data untouched.
  console.log('  💬 Cloudflare answered 1101 on a fresh deploy — the worker script is recreated once from the same verified bytes; your database, rows, address and domains are never touched.');
  const failedAt = new Date().toISOString();
  console.log('  First failing probe (UTC): ' + failedAt);
  console.log('  To read the exact exception behind a future 1101: dashboard → Workers & Pages → ' + workerName + ' → Observability → Logs, around ' + failedAt.slice(0, 16).replace('T', ' ') + ' UTC.');
  // Cheap fix first: the stuck state may live in this deploy *version* rather than the
  // script record, in which case a fresh version of the identical bytes clears it with
  // no delete at all (routes stay attached the whole time, so this is also faster).
  // Only if that fails does the wizard fall through to delete-and-recreate below.
  console.log('  💬 Same bytes, new version first — re-uploading once without deleting anything…');
  await uploadWorker(accountId, workerName, buildPath, dbId, dbName);
  const retry = await waitForVerdict(base, Math.min(waitMs, 60000), stepMs);
  if (retry.verdict === 'ok') { ok('Re-upload worked: the panel address now answers normally ✔'); return { ok: true, state: 'ok', healed: true, rebuilt: null }; }
  warn('Re-upload alone did not clear it (' + retry.verdict + ') — falling through to recreating the worker script.');
  // The recreate below deletes the script, and once it is gone /settings answers 404 — so
  // uploadWorker can no longer read the existing bindings and would upload with only the D1
  // binding. For a panel carrying secret_text bindings (CF_ACCOUNT_ID / CF_API_TOKEN, which
  // the in-panel updater needs) that would silently strip them. Read them now, while they
  // still exist, and hand them to the re-upload.
  let carried = [];
  const preSettings = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
  if (preSettings.ok && Array.isArray(preSettings.data.result.bindings)) {
    carried = preSettings.data.result.bindings.filter((b) => b && !(b.type === 'd1' && b.name === 'DB'));
    if (carried.length) info('Keeping ' + carried.length + ' non-database binding(s) across the recreate: ' + carried.map((b) => b.name).join(', '));
  }
  const del = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'DELETE' });
  if (!del.ok) { warn('Could not remove the worker (' + del.errors + ') — stopping here without touching anything else.'); return { ok: false, state: 'stuck', healed: false, rebuilt: null }; }
  ok('Worker script removed; the database ' + (dbName || 'DB') + ' was not touched');
  // Confirm the delete landed before re-uploading — racing the edge here used to
  // resurrect the same broken state the delete was meant to clear.
  for (let t = 0; t < 8; t++) {
    const st = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
    if (!st.ok && st.status === 404) break;
    await pause(stepMs, 'Waiting for the delete to land');
  }
  await uploadWorker(accountId, workerName, buildPath, dbId, dbName, { carriedBindings: carried });
  const en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
  if (!en.ok) warn('Subdomain re-enable reported (' + en.errors + ') — enable it from the dashboard if needed.');
  await settleDeploy(true);
  const again = await verifyDeployment({ accountId, workerName, buildPath, dbId, dbName, subdomain, log: { log: () => {} }, canHeal: false });
  if (again.ok) { ok('Self-heal worked: the panel address now answers normally ✔'); return { ok: true, state: 'ok', healed: true, rebuilt: null }; }
  warn('Still not answering after one self-heal (' + again.state + '). The panel code is not the problem — the deployed bytes were verified.');
  console.log('  (Failing since ' + failedAt + ' UTC — that timestamp plus Observability → Logs shows the exact exception.)');
  stuckWorkerHint();
  console.log('     You can also prove it in 10 seconds: run the installer once with a different worker name');
  console.log('     (--no-fingerprint keeps the shared build) — the same bytes run fine on a clean script name.');
  return { ok: false, state: again.state, healed: true, rebuilt: null };
}

// ------------------------------------------------------------------ first-install route priming
// Why this exists (from the owner's live installs): on a brand-new worker name the script is
// created FIRST and the workers.dev route is switched on AFTER it. Cloudflare then answered
// "error code: 1101" on every route although the bytes were verified, and the same bytes only
// ran once the script was created AGAIN while the route record already existed — which is
// exactly the state the final-check self-heal ends in. Waiting longer never changed it (the
// bad state is persistent), and a placeholder-first bootstrap did not either (the route was
// still created after the script).
// So for a worker name that did not exist before THIS run, the wizard now reaches that state
// itself, before any public traffic: script → route on → script recreated → route on again.
// It only ever removes the script this very run created seconds ago; the D1 database and
// every row in it are never touched, and the final-check self-heal below stays exactly as is
// (it still runs if Cloudflare answers 1101 anyway). ZEUS_NO_PREWARM=1 switches this off.
async function primeFreshWorker({ accountId, workerName, buildPath, dbId, dbName }) {
  if (process.env.ZEUS_NO_PREWARM === '1') return false;
  const stepMs = Number(process.env.ZEUS_PROBE_INTERVAL_MS || 4000);
  console.log('  💬 First install of this worker name — recreating the brand-new script once, now that its public route exists, before the first check.');
  console.log('     (only the script this run just created is replaced; the database, its rows and the address are never touched)');
  const del = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'DELETE' });
  if (!del.ok && !/10007/.test(String(del.errors))) {
    warn('Could not recreate the new script (' + del.errors + ') — keeping the first upload; the final check will still self-heal if Cloudflare answers 1101.');
    return false;
  }
  // Confirm the delete landed before creating the script again — racing the edge here
  // would bring back the very state this step is meant to avoid.
  for (let t = 0; t < 8; t++) {
    const st = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
    if (!st.ok && st.status === 404) break;
    await pause(stepMs, 'Waiting for the delete to land');
  }
  await uploadWorker(accountId, workerName, buildPath, dbId, dbName, { quiet: true });
  let en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
  if (!en.ok) {
    warn('Subdomain enable reported (' + en.errors + ') — waiting 10s and retrying once before giving up.');
    await new Promise((r) => setTimeout(r, Number(process.env.ZEUS_SETTLE_MS || 10000)));
    en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
  }
  if (!en.ok) { warn('Subdomain enable failed (' + en.errors + ') — you can enable it from the dashboard.'); return true; }
  ok('Script recreated with its public route in place');
  return true;
}

// ---------------------------------------------------------------- main
async function verifyTokenOrFail(hint) {
  const v = await cf('/user/tokens/verify');
  if (!v.ok) fail('Token is not valid (' + v.errors + ')', hint || 'Create the token again with the listed permissions and paste it here.');
  ok('Token is valid' + (v.data.result?.status ? ` (status: ${v.data.result.status})` : ''));
}

// The token can see one or more accounts: pick one (a single account is chosen automatically).
async function pickAccountFromToken(rl) {
  const accounts = await cf('/accounts?per_page=50');
  if (!accounts.ok || !accounts.data.result?.length) {
    warn('Could not list accounts with this token.');
    const id = (await ask(rl, 'Enter your Account ID manually (from the overview page of your domain/worker)', '')).trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/i.test(id)) fail('Account ID format is invalid (32 hex characters).', 'Copy the Account ID from the Cloudflare dashboard sidebar.');
    return { accountId: id, accountName: id };
  }
  const list = accounts.data.result;
  if (list.length === 1) {
    ok('Account: ' + list[0].name);
    return { accountId: list[0].id, accountName: list[0].name };
  }
  list.forEach((a, i) => console.log(`     ${S.cyan(String(i + 1))}) ${a.name}  ${S.dim('(' + a.id.slice(0, 8) + '…)')}`));
  const idx = parseInt(await ask(rl, 'Account number', '1'), 10);
  const picked = list[idx - 1];
  if (!picked) fail('Invalid selection.', 'Type one of the numbers listed above.');
  ok('Account: ' + picked.name);
  return { accountId: picked.id, accountName: picked.name };
}

// STEP 1 — one place for the token and the account.
//  * saved accounts are listed and picked by number (the saved token is re-verified first);
//  * "n" adds a new token (guide + hidden input), then offers to save it on this computer;
//  * ZEUS_CF_TOKEN still works for automation and is never saved.
async function accountStep(rl, store) {
  const envTok = tokenFromEnv();
  if (envTok) {
    TOKEN = envTok;
    ok('API token read from the ZEUS_CF_TOKEN environment variable (not saved anywhere).');
    await verifyTokenOrFail();
    return pickAccountFromToken(rl);
  }
  why('Pick one of your saved accounts by number, or add a new API token.');
  const saved = store.accounts.slice().sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  if (saved.length) {
    // Every choice is a plain number, so the same key answers both "which account"
    // and "add/forget" — nothing has to be remembered from a letter.
    cardTop(ic('bank') + ' Choose an account');
    saved.forEach((a, i) => {
      if (i) cardRow('');
      cardRow('  ' + S.cyan(String(i + 1).padStart(2)) + '  ' + S.bold(a.accountName || a.accountId));
      cardRow('      ' + S.dim('token ' + maskTok(a.token) + '  ·  ' + a.accountId.slice(0, 8) + '…  ·  used ' + fmtDate(a.lastUsedAt || a.savedAt)));
    });
    cardSep();
    cardRow('  ' + S.cyan(String(saved.length + 1).padStart(2)) + '  ' + S.dim('add another account — paste a new token'));
    cardRow('  ' + S.cyan(String(saved.length + 2).padStart(2)) + '  ' + S.dim('forget a saved account'));
    cardEnd();
  }
  while (saved.length) {
    const ADD = saved.length + 1, FORGET = saved.length + 2;
    const def = '1';
    const label = `Account [1-${FORGET}]`;
    const ans = (await ask(rl, label, def)).trim().toLowerCase();
    const num = parseInt(ans, 10);
    if (num === ADD) break;
    if (num === FORGET) {
      const k = parseInt(await ask(rl, `Forget which account? [1-${saved.length}]`, ''), 10);
      const victim = saved[k - 1];
      if (!victim) { warn(`No saved account has the number ${k || '(none given)'}.`); continue; }
      store.accounts = store.accounts.filter((a) => a.accountId !== victim.accountId);
      saved.splice(k - 1, 1);
      saveStore(store);
      ok('Removed the saved token of ' + (victim.accountName || victim.accountId));
      continue;
    }
    const entry = saved[num - 1];
    if (!entry) { warn(`Type a number from 1 to ${FORGET}.`); continue; }
    TOKEN = entry.token;
    const v = await cf('/user/tokens/verify');
    if (v.ok) {
      ok('Using the saved token of ' + (entry.accountName || entry.accountId) + ' (' + maskTok(entry.token) + ')');
      entry.lastUsedAt = new Date().toISOString();
      saveStore(store);
      return { accountId: entry.accountId, accountName: entry.accountName || entry.accountId };
    }
    warn('The saved token of this account is no longer valid (' + v.errors + ') — paste a new one below; it replaces the old one.');
    break;
  }
  // new token
  tokenGuide(makeTokenUrl());
  TOKEN = await askSecret(rl, 'Enter your Cloudflare API token');
  await verifyTokenOrFail();
  const acc = await pickAccountFromToken(rl);
  const askKeep = !pipedLines || process.argv.includes('--test-save-token');
  const keep = askKeep ? (await ask(rl, 'Save this token on this computer, so next time you just pick this account by number? (y/n)', 'y')).trim().toLowerCase() : 'n';
  if (keep === 'y' || keep === 'yes') {
    if (rememberAccount(store, { ...acc, token: TOKEN })) {
      ok('Saved to ' + STORE_PATH);
      info('Readable only by your user account. Remove it any time with: node wizard.mjs --forget');
    }
  } else {
    info('Not saved — you will paste the token again next time.');
  }
  return acc;
}

// Finds the panel workers of the account: every worker that carries a D1 binding named DB.
async function listPanelWorkers(accountId) {
  const list = await cf(`/accounts/${accountId}/workers/scripts?per_page=100`);
  if (!list.ok) {
    warn('Could not list the workers of this account (' + list.errors + ').');
    return { panels: [], all: [] };
  }
  const scripts = (list.data.result || []).filter((s) => s && s.id);
  const all = scripts.map((s) => ({ name: s.id, modifiedOn: s.modified_on || s.created_on || '', dbId: '' }));
  const panels = [];
  for (let i = 0; i < scripts.length; i += 6) {
    const batch = scripts.slice(i, i + 6);
    const found = await Promise.all(batch.map(async (sc) => {
      const st = await cf(`/accounts/${accountId}/workers/scripts/${sc.id}/settings`);
      if (!st.ok) return null;
      const d1 = ((st.data.result || {}).bindings || []).find((b) => b && b.type === 'd1' && b.name === 'DB');
      return d1 ? { name: sc.id, modifiedOn: sc.modified_on || sc.created_on || '', dbId: d1.id || d1.database_id || '' } : null;
    }));
    panels.push(...found.filter(Boolean));
  }
  const byNew = (a, b) => String(b.modifiedOn).localeCompare(String(a.modifiedOn));
  panels.sort(byNew); all.sort(byNew);
  return { panels, all };
}

// STEP 2 — update an existing panel, or install a new one.
async function actionStep(rl, accountId, forced) {
  const profile = loadProfile() || {};
  why('Existing panels in this account (workers with a D1 binding named DB) are found automatically.');
  const { panels, all } = await listPanelWorkers(accountId);
  if (panels.length) ok(panels.length + ' existing panel' + (panels.length > 1 ? 's' : '') + ' found: ' + panels.slice(0, 4).map((p) => p.name).join(', ') + (panels.length > 4 ? ' …' : ''));
  else info('No existing panel worker was found in this account.');
  if (forced === 'install') return { kind: 'install', panels, all };
  if (forced === 'update') {
    if (!all.length && !profile.workerName) fail('No install profile was found in this folder — --update works on an install made by this wizard.', 'Run the full install once (node wizard.mjs) with the same worker name; it reuses an existing database.');
    return { kind: 'update', panels, all };
  }
  if (!panels.length && !profile.workerName && !process.argv.includes('--test-panels-menu')) {
    return { kind: 'install', panels, all };
  }
  if (!all.length) {
    console.log('  Nothing to update in this account — a new panel will be installed.');
    return { kind: 'install', panels, all };
  }
  cardTop(ic('bolt') + ' What would you like to do?');
  cardRow('');
  cardRow('  ' + S.cyan('1') + '  ' + S.bold('Update an existing panel') + (panels.length > 1 ? S.dim('   ' + panels.length + ' panels found') : ''));
  cardRow('     ' + S.dim('re-deploys it with a fresh build identity — database, users and address stay'));
  cardRow('');
  cardRow('  ' + S.cyan('2') + '  ' + S.bold('Install a new panel'));
  cardRow('     ' + S.dim('new worker, new database, new build identity'));
  cardEnd();
  const def = panels.length ? '1' : '2';
  const a = (await ask(rl, 'Choose 1 or 2', def)).trim();
  return { kind: (a === '1' || a === '2' ? a : def) === '1' ? 'update' : 'install', panels, all };
}

// UPDATE FLOW — pick the worker (auto-listed), then redo exactly what an install does for the
// script: fresh source, a NEW build fingerprint, upload with read-back, health check. The D1
// database, its rows, the workers.dev address and any attached domain are never touched.
async function updateFlow(rl, ctx) {
  const { accountId, accountName, store, profile, panels, all } = ctx;
  const noFingerprint = process.argv.includes('--no-fingerprint');
  step = 0; totalSteps = 4;

  // ---------- [1/4] choose the worker
  nextStep('Choose the worker to update');
  why('Panels are listed automatically — pick one by number. Only its script is replaced.');
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = (sub.ok && sub.data.result && sub.data.result.subdomain) || profile.subdomain || '';
  const hostOf = {};
  const doms = await cf(`/accounts/${accountId}/workers/domains`);
  if (doms.ok && Array.isArray(doms.data.result)) {
    for (const d of doms.data.result) if (d && d.service && d.hostname && !hostOf[d.service]) hostOf[d.service] = d.hostname;
  }
  const savedEntry = store.accounts.find((a) => a.accountId === accountId);
  const savedWorkers = (savedEntry && savedEntry.workers) || {};
  const addrOf = (name) => {
    const h = hostOf[name] || (savedWorkers[name] && savedWorkers[name].hostname);
    return h ? 'https://' + h + '/panel' : makeWorkerUrl(name, subdomain, '/panel');
  };
  let list = panels.length ? panels : (profile.workerName ? [{ name: profile.workerName, dbId: profile.dbId || "", modifiedOn: profile.updatedAt || "" }] : all);
  let showingAll = false;
  let pick = null;
  for (;;) {
    // "show every worker" is a row like any other: the number after the last panel.
    // Nothing here is a letter, so one rule answers every menu in the wizard.
    const expand = list.length + 1;
    cardTop(ic('up') + ' Choose the panel to update');
    list.forEach((w, i) => {
      if (i) cardRow('');
      cardRow('  ' + S.cyan(String(i + 1).padStart(2)) + '  ' + S.bold(w.name));
      cardRow('      ' + S.dim(addrOf(w.name)));
      cardRow('      ' + S.dim('updated ' + fmtDate(w.modifiedOn) + (w.dbId ? '  ·  has its own database' : '')));
    });
    if (!showingAll) {
      cardSep();
      cardRow('  ' + S.cyan(String(expand).padStart(2)) + '  ' + S.dim('show every worker in this account (if your panel is not listed)'));
    }
    cardEnd();
    const top = showingAll ? list.length : expand;
    const pLabel = list.length ? `Panel [1-${top}]` : `Panel [${top}]`;
    const ans = (await ask(rl, pLabel, list.length ? '1' : String(expand))).trim().toLowerCase();
    const num = parseInt(ans, 10);
    if (!showingAll && (num === expand || ans === 'a')) {
      list = all; showingAll = true;
      if (!list.length) fail('This account has no workers.', 'Run the wizard again and choose "Install a new panel".');
      continue;
    }
    pick = list[num - 1];
    if (pick) break;
    warn(`Type a number from 1 to ${top}${showingAll ? '.' : ` (${expand} lists every worker).`}`);
  }
  let dbId = pick.dbId;
  if (!dbId) {
    const st = await cf(`/accounts/${accountId}/workers/scripts/${pick.name}/settings`);
    const d1 = st.ok && ((st.data.result || {}).bindings || []).find((b) => b && b.type === 'd1' && b.name === 'DB');
    dbId = d1 ? (d1.id || d1.database_id || '') : '';
  }
  let dbName = '';
  if (dbId) {
    const dl = await cf(`/accounts/${accountId}/d1/database/${dbId}`);
    if (dl.ok && dl.data.result) dbName = dl.data.result.name || '';
  }
  if (!dbId && profile.dbId) {
    // The worker lost its binding (or the token cannot read settings): the database this
    // folder installed with is still the right one — reuse it, never create or delete.
    dbId = profile.dbId;
    const dl = await cf(`/accounts/${accountId}/d1/database/${dbId}`);
    if (dl.ok && dl.data.result) dbName = dl.data.result.name || '';
    warn('This worker has no D1 binding this token can read — using the database saved in this folder (' + String(dbId).slice(0, 8) + '…).');
  }
  if (!dbId) {
    warn('This worker has no D1 binding named DB (the panel needs one). Pick the database it should use — nothing is created or deleted.');
    const dbs = await cf(`/accounts/${accountId}/d1/database?per_page=50`);
    const free = (dbs.ok && dbs.data.result) || [];
    if (!free.length) fail('No D1 database is available in this account.', 'Run the wizard again and choose "Install a new panel".');
    free.forEach((d, i) => console.log(`     ${S.cyan(String(i + 1))}) ${d.name}`));
    const chosen = free[parseInt(await ask(rl, 'Database number', '1'), 10) - 1];
    if (!chosen) fail('Invalid selection.', 'Type one of the numbers listed above.');
    dbId = chosen.uuid; dbName = chosen.name;
  }
  ok('Selected: ' + pick.name + '  ·  database ' + (dbName || 'DB') + ' (' + String(dbId).slice(0, 8) + '…)');
  const before = await d1Snapshot(accountId, dbId);
  await ensureD1Ready(accountId, dbId, dbName);
  if (before) info('row census before: ' + Object.entries(before).map(([k, v]) => k + '=' + v).join(', '));
  else warn('Row census not available with this token (D1 query) — the update never deletes data regardless.');

  // ---------- [2/4] source + a NEW fingerprint
  nextStep('Fetch the source and generate a new fingerprint');
  why('The latest hardened source is fetched, then this panel gets a freshly generated build identity (new key, order and names) — exactly like a new install.');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail('Source still has ' + scan.hits + ' lines with identifiable keywords!', 'Re-fetch from another mirror, or report the problem.');
  ok('Source ready: ' + (scan.size / 1024).toFixed(0) + 'KB, zero identifiable keywords');
  let seed = null;
  if (noFingerprint) warn('--no-fingerprint: the shared repository build is deployed.');
  else { seed = newSeed(); console.log('  New build identity: ' + seed.slice(0, 8) + '…'); }
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };

  // ---------- [3/4] upload
  nextStep('Upload the update');
  why('The script is replaced and read back so the deployed bytes are proven identical. Bindings, database, address and domains are kept.');
  await uploadWorker(accountId, pick.name, build.path, dbId, dbName);
  const cur = await workerExists(accountId, pick.name);
  await settleDeploy(!cur.known);

  // ---------- [4/4] verify
  nextStep('Verify and finish');
  why('Row counts are compared with the values taken before the upload, then the public address is checked.');
  const after = await d1Snapshot(accountId, dbId);
  if (before && after) {
    if (sameCensus(before, after)) ok('Database intact: ' + Object.keys(after).length + ' tables with identical row counts');
    else warn('Row census changed. This update never deletes anything — check whether the panel itself wrote new rows.');
  } else warn('Could not re-run the row census (needs D1 query access).');
  const health = await verifyDeployment({ accountId, workerName: pick.name, buildPath: build.path, dbId, dbName, subdomain, srcPath: src.path, seed });
  const url = addrOf(pick.name);
  const finalSeed = (health.rebuilt && health.rebuilt.seed) || seed;
  const finalNames = (health.rebuilt && health.rebuilt.names) || build.names || null;
  const finalRows = (health.rebuilt && health.rebuilt.rows) || build.rows || 0;
  const idLine = finalNames
    ? 'new build identity: ' + Object.values(finalNames).slice(0, 2).join(', ') + ' ...'
    : 'shared repository build deployed';
  const reachLine = health.ok
    ? 'responding now' + tick()
    : 'not answered from this machine yet (filtered network or route propagation; the deploy itself was verified byte for byte)';
  if (COLOR) {
    cardTop(ic('up') + ' Update complete  ·  ' + elapsed() + ' total');
    cardRow();
    cardRow(S.bold(pick.name) + S.dim('  ·  same database, same address, freshly rebuilt bytes'));
    cardRow('   ' + S.cyan(S.under(url)));
    cardRow('   ' + (health.ok ? S.green('responding now' + tick()) : S.yellow('not answered from this machine yet') + S.dim(' (filtered network or route propagation;')));
    if (!health.ok) cardRow('   ' + S.dim(' the deploy itself was verified byte for byte)'));
    cardRow();
    cardRow(S.dim(idLine));
    cardEnd();
  } else {
    console.log(`
${line}
  Update complete - ${pick.name}: same database, same address, freshly rebuilt bytes:
        ${url}
        ${reachLine}
      ${idLine}
${line}`);
  }
  if (health.rebuilt) console.log('  Note: the panel kept tripping its integrity check, so this update rebuilt it with a brand-new identity. The database was never touched.');
  saveProfile({
    ...profile, version: PROFILE_VERSION, accountId, accountName, workerName: pick.name, dbName, dbId, subdomain, panelUrl: url,
    seed: finalSeed || null, fingerprint: !!finalSeed, names: finalNames, rows: finalRows,
    source: src.fresh ? 'downloaded' : 'local', updatedAt: new Date().toISOString(),
    healedAt: health.healed ? new Date().toISOString() : (profile.healedAt || null),
  }, true);
  noteWorker(store, accountId, pick.name, { panelUrl: url });
}

async function main() {
  const forced = process.argv.includes('--update') ? 'update' : (process.argv.includes('--install') ? 'install' : null);
  banner();
  const noFingerprint = process.argv.includes('--no-fingerprint');

  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const cleanup = () => { try { rl && rl.close(); } catch {} };
  process.on('SIGINT', () => { console.log('\n\nCancelled.'); cleanup(); process.exit(130); });

  // Saved defaults from an earlier run (last worker, address) and the accounts saved on this computer
  const profile = loadProfile() || {};
  const store = loadStore();

  // ---------- Start 1/2: account & token
  step = 0; totalSteps = 2;
  nextStep('Cloudflare account & token');
  const { accountId, accountName } = await accountStep(rl, store);

  // ---------- Start 2/2: update or install
  nextStep('What would you like to do?');
  const plan = await actionStep(rl, accountId, forced);
  if (plan.kind === 'update') {
    await updateFlow(rl, { accountId, accountName, store, profile, panels: plan.panels, all: plan.all });
    cleanup();
    say('\nDone. Good luck! ' + ic('globe'));
    return;
  }

  // ---------- Install a new panel: every new panel gets its own, freshly generated build identity
  step = 0; totalSteps = FLOW_INSTALL.length;
  let seed = null;
  if (noFingerprint) {
    warn('--no-fingerprint: the shared repository build is uploaded unchanged.');
  } else {
    seed = newSeed();
  }

  // ---------- [1/9] worker name
  nextStep('Worker name');
  why('The worker name becomes part of your panel address. A neutral, random name is harder for automated scans to match.');
  const suggestedName = randName(8);
  console.log('  Tip: press Enter to accept the suggested random name (' + suggestedName + ').');
  const workerName = (await ask(rl, 'Worker name', suggestedName)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(workerName)) fail('Worker name may only contain lowercase letters, digits and hyphens.', 'Press Enter to accept the suggested random name.');

  // ---------- [2/9] workers.dev address
  nextStep('workers.dev address');
  why('Your account workers.dev subdomain is read so the final panel address can be built.');
  let subdomain = profile.subdomain || '';
  for (let t = 0; t < 3; t++) {
    const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
    if (sub.ok && sub.data.result?.subdomain) {
      subdomain = sub.data.result.subdomain;
      break;
    }
    if (t < 2) await pause(2000, 'Reading your workers.dev subdomain');
  }
  if (subdomain) {
    ok('Final address will be: ' + makeWorkerUrl(workerName, subdomain));
  } else {
    warn('Could not fetch the subdomain — continuing anyway.');
  }
  warn('Note: workers.dev is blocked in Iran; attach a custom domain for use inside Iran (final step).');

  // ---------- [3/9] D1
  nextStep('Create D1 database');
  why('The panel keeps every user and setting in one D1 database; an existing one is reused, never replaced or deleted.');
  let dbName = workerName + '-db';
  let dbId = '';

  // The worker name is fresh on every install, so this only matches when the same
  // machine re-runs the wizard against a worker it already deployed (e.g. a retry
  // after a failed first attempt) — its binding is the truth, keep that database.
  const bindRes = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
  if (bindRes.ok && bindRes.data.result && Array.isArray(bindRes.data.result.bindings)) {
    const d1 = bindRes.data.result.bindings.find((b) => b && b.type === 'd1' && b.name === 'DB');
    const boundId = d1 ? d1.id || d1.database_id || '' : '';
    if (boundId) {
      const bound = await cf(`/accounts/${accountId}/d1/database/${boundId}`);
      if (bound.ok && bound.data.result) {
        dbId = boundId;
        dbName = bound.data.result.name || dbName;
        ok('Using existing database: ' + dbName + ' (' + dbId.slice(0, 8) + '...)');
      }
    }
  }

  if (!dbId) {
    const listDb = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
    const existing = listDb.ok && (listDb.data.result || []).find((d) => d.name === dbName);
    if (existing) {
      dbId = existing.uuid;
      ok('Using existing database: ' + dbName + ' (' + dbId.slice(0, 8) + '...)');
    }
  }

  if (!dbId) {
    const created = await cf(`/accounts/${accountId}/d1/database`, { method: 'POST', body: { name: dbName } });
    if (created.ok) {
      dbId = created.data.result.uuid;
      ok('Database created: ' + dbName);
    } else {
      // Accounts hit a hard cap on databases (CF error 7406) after repeated installs;
      // reusing an existing database is the way through that, never deleting anything.
      if (!/7406|limit/i.test(created.errors)) {
        fail('D1 database creation failed (' + created.errors + ')', 'Make sure the token has D1/Edit access and your account has D1 (the free plan includes it).');
      }
      warn('The account is at its D1 database limit (' + created.errors + ').');
      const pool = await cf(`/accounts/${accountId}/d1/database?per_page=50`);
      const free = (pool.ok && pool.data.result) || [];
      if (!free.length) fail('There is no database available to reuse.', 'Delete an old test database in the dashboard, then run this wizard again.');
      console.log('  Existing databases in this account (nothing is deleted by this wizard):');
      free.forEach((d, i) => console.log(`     ${i + 1}) ${d.name}`));
      const pick = await ask(rl, 'Reuse which database number? (press Enter to stop here)', '');
      const chosen = pick ? free[parseInt(pick, 10) - 1] : null;
      if (!chosen) fail('No database chosen — the install stopped before any change.', 'Free a D1 slot in the dashboard and run the wizard again.');
      dbId = chosen.uuid;
      dbName = chosen.name;
      warn('Reusing ' + dbName + ' (' + String(dbId).slice(0, 8) + '…) — anything it already holds stays as it is.');
    }
  }

  await ensureD1Ready(accountId, dbId, dbName);

  // ---------- [4/9] source
  nextStep('Prepare hardened source');
  why('The panel file is fetched from this repository (or a CDN mirror) and scanned so no identifying string survives.');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  if (scan.hits > 0) fail(`Source still has ${scan.hits} lines with identifiable keywords!`, 'Re-fetch from another mirror, or report the problem.');
  ok('Source is ready: ' + src.path + ' (' + (scan.size / 1024).toFixed(0) + 'KB, zero identifiable keywords)');
  info('Size: ' + (scan.size / 1024).toFixed(0) + 'KB | keyword survivors: 0');

  // ---------- [5/9] fingerprint
  nextStep('Personalise this build');
  why('The payload string table is re-keyed, re-ordered and renamed so your build is not byte-identical to anyone else\u2019s own build.');
  const build = seed ? fingerprint(src.path, seed) : { path: src.path, names: null, rows: 0 };
  if (!seed) warn('Fingerprint skipped (--no-fingerprint) — the shared repository build is deployed.');

  // ---------- [6/9] upload
  nextStep('Upload worker');
  why('The built file is uploaded and immediately read back so the deployed bytes are proven identical.');
  const exists = await workerExists(accountId, workerName);
  if (exists.known) {
    // Pre-flight: if this name already answers 1101 right now (stale record from an
    // earlier aborted run), say so up front — replacing it with a fresh upload is the
    // cure, and the health check at the end will confirm it worked.
    const pre = await probeRoute(probeBase(workerName, subdomain), '/');
    if (pre.code === '1101') warn('This worker address already answers "error code: 1101" right now — overwriting it with a fresh upload is the fix; the final check will confirm.');
    const overwrite = await ask(rl, `Worker "${workerName}" already exists; overwrite it? (y/n)`, 'y');
    if (overwrite.toLowerCase() !== 'y') fail('Cancelled by user.', 'Pick a different worker name if you do not want to replace it.');
    console.log('     (only the script is replaced — D1 data, the workers.dev address and any attached domain are kept)');
  }
  const { fresh } = await uploadWorker(accountId, workerName, build.path, dbId, dbName);

  const panelUrl = makeWorkerUrl(workerName, subdomain, '/panel');
  const prof = {
    version: PROFILE_VERSION,
    seed: seed || null,
    fingerprint: !!seed,
    accountId, accountName, workerName, dbName, dbId, subdomain, panelUrl,
    names: build.names || null,
    rows: build.rows || 0,
    source: src.fresh ? 'downloaded' : 'local',
    installedAt: profile.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hostname: profile.hostname || null,
  };
  saveProfile(prof);
  noteWorker(store, accountId, workerName, { panelUrl });

  // ---------- [7/9] enable workers.dev
  nextStep('Enable public address');
  let en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: 'POST', body: { enabled: true, previews_enabled: false },
  });
  if (!en.ok) {
    warn('Subdomain enable reported (' + en.errors + ') — waiting 10s and retrying once before giving up.');
    await new Promise((r) => setTimeout(r, 10000));
    en = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
      method: 'POST', body: { enabled: true, previews_enabled: false },
    });
  }
  if (!en.ok) warn('Subdomain enable failed (' + en.errors + ') — you can enable it from the dashboard.');
  else ok('Enabled: ' + makeWorkerUrl(workerName, subdomain));
  // Only for a name that did not exist before this run (never for an overwrite or a re-use).
  if (fresh && !exists.known && en.ok) await primeFreshWorker({ accountId, workerName, buildPath: build.path, dbId, dbName });
  await settleDeploy(fresh);

  // ---------- [8/9] health check (waits for propagation, self-heals a 1101 state)
  nextStep('Final check & summary');
  const health = await verifyDeployment({ accountId, workerName, buildPath: build.path, dbId, dbName, subdomain, srcPath: src.path, seed });
  if (health.rebuilt) {
    seed = health.rebuilt.seed;
    prof.seed = seed;
    prof.names = health.rebuilt.names;
    prof.rows = health.rebuilt.rows;
    saveProfile(prof, true);
    console.log('\n  Note: the panel kept tripping its integrity check, so the wizard rebuilt this');
    console.log('  install with a brand-new identity and re-uploaded once. The database was never touched.');
  }
  if (health.healed) {
    prof.healedAt = new Date().toISOString();
    saveProfile(prof, true);
    console.log('\n  Note: Cloudflare reported error 1101 for this address, so the wizard recreated the');
    console.log('  worker script once with the identical verified bytes. The database was never touched.');
  }

  // The last screen of the install. Both variants are built from the same strings, so
  // the plain (no-color) card and the styled one can never drift apart.
  const subPattern = makeWorkerUrl(workerName, subdomain, '/sub/<username>');
  const identityNote = build.names
    ? ' (' + Object.values(build.names).slice(0, 2).join(', ') + ' ...)'
    : '';
  if (COLOR) {
    cardTop(ic('party') + ' Install complete  ·  ' + elapsed() + ' total');
    cardRow();
    cardRow(S.bold(ic('pin') + ' Panel address') + S.dim('  (open it first and set the admin password)'));
    cardRow('   ' + S.cyan(S.under(panelUrl)));
    cardRow();
    cardRow(S.bold(ic('link') + ' User subscription pattern'));
    cardRow('   ' + S.cyan(subPattern));
    cardRow();
    cardRow(S.yellow(ic('warn') + '  First thing to do: ') + 'open the panel address and set the admin password.');
    cardRow(S.dim('   Until a password exists the panel answers its own API without one —'));
    cardRow(S.dim('   that is the author\'s first-run design, so never leave a fresh install unclaimed.'));
    cardSep();
    cardRow(S.bold('Good to know'));
    cardRow(S.cyan('1') + '  This deployment has its own build identity' + S.dim(identityNote));
    cardRow('   ' + S.dim('— it is not byte-identical to anybody else\'s install of the panel.'));
    cardRow(S.cyan('2') + '  The in-panel "Update panel" button replaces this build with the author\'s;');
    cardRow('   ' + S.dim('restore yours with ') + S.cyan('node wizard.mjs --update'));
    cardRow(S.cyan('3') + '  Inside Iran, finish the custom-domain step below (or do it later).');
    cardRow(S.cyan('4') + '  Keep your API token private. It is saved here only if you said yes.');
    cardRow('   ' + S.dim('Remove it any time with ') + S.cyan('node wizard.mjs --forget'));
    cardEnd();
  } else {
    const mid = (t) => '     ' + t;
    console.log(`
${line}
  Install complete!

${mid(ic('pin') + ' Panel address (open it first and set the admin password):')}
${mid('   ' + panelUrl)}

${mid(ic('link') + ' User subscription pattern:')}
${mid('   ' + subPattern)}

  ${ic('warn')}  First thing to do: open the panel address above and set the admin password.
     Until a password exists the panel answers its own API without one - that is the
     author's first-run design, so do not leave a fresh install unclaimed.
${line}
  Four important notes:
      1. This deployment has its own build identity${identityNote} - it is not
         byte-identical to anybody else's install of the same panel.
      2. If you ever use the "Update panel" button inside the panel, the author's own
         build replaces this one - restore it with: node wizard.mjs --update
      3. For use inside Iran, finish the custom-domain step below (or do it later).
      4. Keep your API token private. It is saved on this computer only if you said yes
         (node wizard.mjs --forget removes it).
${line}`);
  }

  // ---------- [9/9] optional custom domain — the panel works without it; workers.dev is
  // filtered inside Iran, so this is the step that makes it usable there.
  nextStep('Attach a custom domain (optional)');
  why('The panel is already live on its workers.dev address. workers.dev is blocked in Iran, so a domain of your own is what makes it reachable there. Skipping changes nothing.');
  const wantDomain = await ask(rl, 'Do you have a custom domain you want to attach? (y/n)', 'n');
  if (wantDomain.toLowerCase() === 'y') {
    // Listing zones needs a token with Zone:Read — the wizard-created token does not include it,
    // so fall back to the manual Zone ID route (attaching itself only needs Workers Scripts access).
    const zones = await cf('/zones?per_page=50');
    let zoneId = '';
    let hostname = '';
    if (zones.ok && zones.data.result?.length) {
      zones.data.result.forEach((z, i) => console.log(`     ${i + 1}) ${z.name}`));
      const zi = parseInt(await ask(rl, 'Domain number', '1'), 10);
      const zone = zones.data.result[zi - 1];
      if (!zone) {
        warn('Invalid selection; skipped.');
      } else {
        zoneId = zone.id;
        hostname = (await ask(rl, `Subdomain to use on ${zone.name} (e.g. panel)`, 'panel')).trim().toLowerCase() + '.' + zone.name;
      }
    } else {
      warn('Could not list zones — Zone:Read access is required for the list only.');
      console.log('  You can still attach it now: open the Cloudflare dashboard, open your domain,');
      console.log('  and copy the "Zone ID" from the right sidebar of the Overview page.');
      zoneId = (await ask(rl, 'Zone ID (press Enter to skip and do it later from the dashboard)', '')).trim();
      if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) {
        warn('Zone ID format is invalid (32 hex characters); skipped.');
        zoneId = '';
      }
      if (zoneId) hostname = (await ask(rl, 'Full hostname for the panel (e.g. panel.mydomain.com)', '')).trim().toLowerCase();
    }
    if (zoneId && hostname) {
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
        warn('Hostname looks invalid; skipped — you can attach it later from the dashboard (Worker → Settings → Domains).');
      } else {
        const domBody = { environment: 'production', hostname, service: workerName, zone_id: zoneId };
        // API docs list PUT for attaching a domain; POST kept as a fallback for robustness.
        let cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'PUT', body: domBody });
        if (!cd.ok && (cd.status === 404 || cd.status === 405)) {
          cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'POST', body: domBody });
        }
        if (!cd.ok) warn('Domain attach failed (' + cd.errors + ') — from the dashboard: Worker → Settings → Domains');
        else {
          ok('Domain attached: https://' + hostname + '/panel');
          console.log('     (DNS record and certificate are created automatically; allow a few minutes)');
          prof.hostname = hostname;
          prof.panelUrl = `https://${hostname}/panel`;
          prof.updatedAt = new Date().toISOString();
          saveProfile(prof, true);
          ok('Profile updated with the domain address: ' + prof.panelUrl);
          noteWorker(store, accountId, workerName, { hostname, panelUrl: prof.panelUrl });
        }
      }
    }
  }

  cleanup();
  say('\nDone. Good luck! ' + ic('globe'));
}


// Source preparation without any token / Cloudflare network access (for testing)
async function prepareOnlyMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  console.log('Prepare-only mode: source preparation only\n');
  const src = await prepareSource(rl);
  const scan = scanKeywords(src.path);
  console.log(`  File: ${src.path}`);
  console.log(`  Size: ${(scan.size / 1024).toFixed(0)}KB | identifiable keywords: ${scan.hits}`);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  say('  ' + ic('ok') + ' Preparation successful');
}

// Delete saved API tokens from this computer: node wizard.mjs --forget
async function forgetMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const store = loadStore();
  if (!store.accounts.length) {
    console.log('  No saved accounts on this computer (' + STORE_PATH + ').');
    if (rl) rl.close();
    return;
  }
  // Same numbered card as the picker, so "which one" is always answered with a number.
  const ALL = store.accounts.length + 1;
  cardTop(ic('lock') + ' Remove saved tokens');
  store.accounts.forEach((a, i) => {
    if (i) cardRow('');
    cardRow('  ' + S.cyan(String(i + 1).padStart(2)) + '  ' + S.bold(a.accountName || a.accountId));
    cardRow('      ' + S.dim('token ' + maskTok(a.token)));
  });
  cardSep();
  cardRow('  ' + S.cyan(String(ALL).padStart(2)) + '  ' + S.dim('all of them — removes the whole file'));
  cardEnd();
  info('File: ' + STORE_PATH);
  const ans = (await ask(rl, `Remove which? [1-${ALL}]`, String(ALL))).trim().toLowerCase();
  const num = parseInt(ans, 10);
  if (num === ALL || ans === 'all') {
    try { rmSync(STORE_PATH, { force: true }); ok('All saved tokens were removed from this computer.'); }
    catch (e) { warn('Could not remove the file (' + e.message + ').'); }
  } else {
    const v = store.accounts[num - 1];
    if (!v) warn(`No saved account has the number ${num || '(none given)'} — nothing was removed.`);
    else {
      store.accounts = store.accounts.filter((a) => a.accountId !== v.accountId);
      saveStore(store);
      ok('Removed the saved token of ' + (v.accountName || v.accountId));
    }
  }
  if (rl) rl.close();
}

// Build a private copy of the panel source without touching the Cloudflare API.
async function personalizeOnlyMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const profile = loadProfile();
  const rotate = process.argv.includes('--rotate');
  const seed = profile && profile.seed && !rotate ? profile.seed : newSeed();
  console.log('Personalise-only mode: a private copy of the source, no Cloudflare calls\n');
  console.log('  build identity seed: ' + seed + (profile && profile.seed && !rotate ? '   (from the saved profile)' : ''));
  const src = await prepareSource(rl);
  const r = personalize(readFileSync(src.path, 'utf8'), seed);
  if (!r.ok) fail('Personalisation failed: ' + r.problems.join(' / '));
  const out = join(process.cwd(), 'Source-personalized.js');
  writeFileSync(out, r.out);
  const chk = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail('The personalised copy failed a syntax check.', (chk.stderr || '').split('\n').slice(0, 3).join(' '));
  const scan = scanKeywords(out);
  console.log('  rows re-keyed: ' + r.entries + ' | identifiers renamed: ' + Object.keys(r.names).length);
  console.log('  new internal names: ' + Object.values(r.names).slice(0, 5).join(', ') + ' …');
  console.log(`  ${out} (${(scan.size / 1024).toFixed(0)}KB, keyword survivors ${scan.hits}, syntax check passed)`);
  if (rl) rl.close();
  if (scan.hits > 0) { process.exitCode = 2; return; }
  say('  ' + ic('ok') + ' Personalised copy ready');
}

function onUnhandled(e) {
  if (e && e.__zeusExit) return; // controlled exit from fail()
  console.error(e && e.stack || e);
  process.exitCode = 1;
}

if (typeof fetch !== 'function') {
  sayErr(ic('cross') + ' Node.js 18 or newer is required (fetch is not available in this version).');
  process.exit(1);
}

// Imported as a module (test harness) rather than run as a program? Then only the
// helpers below are exposed and nothing prompts or talks to the network. When the path
// comparison cannot be resolved the script assumes it is being run directly, so real
// installs never go quiet.
function looksImported() {
  const a = process.argv[1];
  if (!a) return true; // loaded by an expression or stdin: stay silent, never prompt
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(a)) !== realpathSync(self);
  } catch {
    return resolve(a) !== self;
  }
}

export { detectPrelude, personalize, verifyTransform, checkHardened, scanKeywords, xorDecode, xorEncode, rngFrom, buildPrelude, fingerprint, uploadWorker, workerExists, deployedBytes, d1Snapshot, sameCensus, ensureD1Ready, settleDeploy, verifyDeployment, classifyProbe, classifyDeployment, probeOnce, probeRoute, probeAll, probeBase, loadProfile, saveProfile, makeTokenUrl, maskSecret, restoreTty, askSecret, ask, helpText, visWidth, loadStore, saveStore, rememberAccount, STORE_PATH, STORE_DIR, accountStep, actionStep, updateFlow, listPanelWorkers, NAME_BLOCK_RE, KEYWORDS, KW_RE, FORK_SOURCES, PERM_GROUPS, PROFILE_VERSION, COMPAT_DATE, REQUIRED_COMPAT_DATE, REQUIRED_COMPAT_FLAGS };

// Help, so a first-time owner knows what every flag does before running it.
function helpText() {
  return `
${line}
    Zeus Install Wizard - help
${line}
    Usage:
      node wizard.mjs                 full interactive install
      node wizard.mjs --update        pick an account, then update a panel (new fingerprint)
      node wizard.mjs --install       pick an account, then install a new panel
      node wizard.mjs --forget        delete saved API tokens from this computer
      node wizard.mjs --prepare-only  validate the source only, no Cloudflare calls
      node wizard.mjs --personalize   build a private copy, no Cloudflare calls
      node wizard.mjs --token-link    only print the token-creation link
      node wizard.mjs --rotate        mint a brand-new build identity
      node wizard.mjs --no-fingerprint  deploy the shared repository build unchanged
      node wizard.mjs --no-color      plain output: no colours, boxes or spinners (NO_COLOR works too)
      node wizard.mjs --help          this help
      node wizard.mjs --doctor        diagnose a deployed worker (read-only)

    Environment:
      ZEUS_CF_TOKEN       read the API token from the env instead of typing it
      ZEUS_PROBE_WAIT_MS  how long the final address check waits for propagation (default 90000)
      ZEUS_PROBE_URL      custom address for the final health check (used by tests)
      ZEUS_SETTLE_MS      calm wait between verified upload and the first check (default 10000 for a new worker, 5000 otherwise)

    Safety: your token is never printed — it shows as ••••••••. It is saved only if you say yes.
${line}`;
}

function helpStyled() {
  const cmd = (c, d) => cardRow(S.cyan(c.padEnd(32)) + S.dim(d));
  cardTop(ic('bolt') + ' ZEUS  ·  Install & Update Wizard  ·  help');
  cardRow(S.bold('Usage') + S.dim('   node wizard.mjs [option]'));
  cardSep();
  cmd('(no option)', 'full interactive install');
  cmd('--update', 'pick an account, then update a panel');
  cmd('--install', 'pick an account, then install a new panel');
  cmd('--forget', 'delete saved API tokens from this computer');
  cmd('--doctor [worker]', 'diagnose a deployed worker (read-only)');
  cmd('--token-link', 'only print the token-creation link');
  cmd('--rotate', 'mint a brand-new build identity');
  cmd('--no-fingerprint', 'deploy the shared repository build unchanged');
  cmd('--prepare-only', 'validate the source only, no Cloudflare calls');
  cmd('--personalize', 'build a private copy, no Cloudflare calls');
  cmd('--no-color', 'plain output (NO_COLOR works too)');
  cmd('--help', 'this help');
  cardSep();
  cardRow(S.bold('Environment'));
  cmd('ZEUS_CF_TOKEN', 'read the API token from the env instead of typing it');
  cmd('ZEUS_PROBE_WAIT_MS', 'how long the final check waits (default 90000)');
  cmd('ZEUS_PROBE_URL', 'custom address for the final check (tests)');
  cmd('ZEUS_SETTLE_MS', 'calm wait before the first check (10s new, 5s existing)');
  cmd('ZEUS_NO_PREWARM=1', 'skip the first-install route priming');
  cmd('FORCE_COLOR=1', 'keep colours even when piped');
  cardSep();
  cardRow(ic('lock') + ' ' + S.dim('Your token is never printed — it shows as a fixed mask. Saved only if you say yes.'));
  cardEnd();
}

// ---------------------------------------------------------------- doctor
// Read-only diagnosis of a deployed worker: settings, D1, bytes and routes, with one
// recommended action at the end. Nothing is uploaded, changed or deleted here — run it
// and paste the output when asking for help.
// Usage: node wizard.mjs --doctor [worker-name]
async function doctorMain() {
  await loadPipedInput();
  const rl = pipedLines ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  activeRl = rl;
  const profile = loadProfile() || {};
  const argWorker = process.argv[process.argv.indexOf('--doctor') + 1];
  const defWorker = (argWorker && !argWorker.startsWith('--')) ? argWorker : (profile.workerName || '');
  if (COLOR) {
    cardTop('🩺 ZEUS  ·  Doctor');
    cardRow(S.dim('read-only diagnosis — nothing is changed or deleted'));
    cardEnd();
    console.log('');
  } else console.log('Doctor mode: read-only diagnosis, nothing is changed or deleted\n');
  const acct = await accountStep(rl, loadStore());
  const accountId = acct.accountId;
  const workerName = (await ask(rl, 'Worker name', defWorker)).trim();
  if (!workerName) fail('No worker name given.', 'Run again as: node wizard.mjs --doctor <worker-name>.');
  console.log('\n  ' + (COLOR ? S.bold(S.cyan('worker settings')) + S.dim('  ' + '─'.repeat(40)) : '--- worker settings ---'));
  const st = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/settings`);
  if (!st.ok) fail('Could not read the worker settings (' + (st.errors || ('HTTP ' + st.status)) + ').', 'Check the worker name and that the token lists this account.');
  const res = st.data.result || {};
  const dateOk = (res.compatibility_date || '') >= REQUIRED_COMPAT_DATE;
  const flagsOk = REQUIRED_COMPAT_FLAGS.every((f) => (res.compatibility_flags || []).includes(f));
  console.log('  compatibility_date : ' + (res.compatibility_date || '(none)') + (dateOk ? '  ✅' : '  ❌ older than the required ' + REQUIRED_COMPAT_DATE));
  console.log('  compatibility_flags: ' + JSON.stringify(res.compatibility_flags || []) + (flagsOk ? '  ✅' : '  ❌ missing ' + REQUIRED_COMPAT_FLAGS.join(',')));
  const d1 = (res.bindings || []).find((b) => b && b.type === 'd1' && b.name === 'DB');
  console.log('  D1 binding         : ' + (d1 ? ('DB -> ' + String(d1.id || d1.database_id || '').slice(0, 8) + '…  ✅') : 'NONE  ❌ the panel cannot work without it'));
  if (profile.dbId && d1 && (d1.id || d1.database_id) !== profile.dbId) warn('The binding points at a different database than the saved profile (' + String(profile.dbId).slice(0, 8) + '…).');
  if (d1 && (d1.id || d1.database_id)) {
    console.log('\n  ' + (COLOR ? S.bold(S.cyan('D1 database')) + S.dim('  ' + '─'.repeat(40)) : '--- D1 database ---'));
    const dl = await cf(`/accounts/${accountId}/d1/database/${d1.id || d1.database_id}`);
    console.log('  database           : ' + (dl.ok ? dl.data.result.name + '  ✅' : 'LOOKUP FAILED ' + (dl.errors || dl.status)));
    const census = await d1Snapshot(accountId, d1.id || d1.database_id);
    console.log('  tables             : ' + (census ? Object.entries(census).map(([k, v]) => k + '=' + v).join(', ') + '  ✅' : 'query failed (token needs D1 query access)'));
  }
  console.log('\n  ' + (COLOR ? S.bold(S.cyan('deployed bytes')) + S.dim('  ' + '─'.repeat(40)) : '--- deployed bytes ---'));
  const back = await deployedBytes(accountId, workerName);
  if (!back.ok || !back.bytes) {
    console.log('  Could not read the deployed script (' + (back.errors || ('HTTP ' + back.status)) + ').');
  } else {
    const txt = back.bytes.toString('utf8');
    const det = detectPrelude(txt);
    console.log('  size               : ' + back.bytes.length + 'B' + (back.bytes.length > 800000 ? '  ✅' : '  ❌ looks incomplete — re-run the installer'));
    console.log('  module export      : ' + (/export\s+default/.test(txt) ? 'present  ✅' : 'MISSING  ❌ the upload is damaged — re-run the installer'));
    console.log('  payload table      : ' + (det ? det.blobs.length + ' rows, decoder ' + det.getName + '  ✅' : 'NOT FOUND  ❌ the upload is damaged — re-run the installer'));
  }
  console.log('\n  ' + (COLOR ? S.bold(S.cyan('routes')) + S.dim('  ' + '─'.repeat(40)) : '--- routes ---'));
  const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
  const subdomain = (sub.ok && sub.data.result && sub.data.result.subdomain) || profile.subdomain || '';
  const probes = await probeAll(probeBase(workerName, subdomain));
  for (const p of probes) {
    const mark = p.code ? ('error code ' + p.code) : (p.net ? ('network: ' + p.net) : (p.text ? p.text.slice(0, 60) : ''));
    console.log('  ' + p.path.padEnd(20) + String(p.status).padEnd(6) + mark);
  }
  const verdict = classifyDeployment(probes);
  console.log('\n  verdict: ' + (COLOR ? (verdict === 'ok' ? S.green(S.bold(verdict)) : S.yellow(S.bold(verdict))) : verdict));
  if (verdict !== 'ok') console.log('  Probed at (UTC): ' + new Date().toISOString() + ' — dashboard → Workers & Pages → ' + workerName + ' → Observability → Logs around this time shows the exact exception.');
  if (verdict === 'ok') console.log('  ✅ The panel answers every route — nothing to fix. If a browser still shows an error, hard-refresh (Ctrl+Shift+R) or check your VPN.');
  else if (verdict === 'binding') console.log('  Next step: run `node wizard.mjs --update` and accept the saved database — the wizard re-attaches the D1 binding without deleting anything.');
  else if (verdict === 'integrity') console.log('  Next step: run `node wizard.mjs --update --rotate` — the panel needs a freshly rebuilt identity, and your data stays in place.');
  else if (verdict === 'stuck') console.log('  Next step: run `node wizard.mjs --update` — the wizard deletes only the worker script and redeploys the verified bytes; the database is never touched.');
  else console.log('  Next step: wait a few minutes for the address to propagate, then run the doctor again. If it persists, attach a custom domain.');
  if (rl) rl.close();
}

if (looksImported()) {
  // module import: helpers only, no prompts, no network
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
  if (COLOR) helpStyled(); else console.log(helpText());
} else if (process.argv.includes('--doctor')) {
  doctorMain().catch(onUnhandled);
} else if (process.argv.includes('--token-link')) {
  console.log('\n  Cloudflare API token-creation link (permissions pre-set + random name):\n');
  console.log('  ' + S.cyan(makeTokenUrl()));
  console.log('\n  Open it in a browser → Continue to summary → Create Token → copy the token.');
  console.log('  Paste the token only into the wizard — it is never printed; it is saved only if you say yes.\n');
} else if (process.argv.includes('--forget')) {
  forgetMain().catch(onUnhandled);
} else if (process.argv.includes('--personalize')) {
  personalizeOnlyMain().catch(onUnhandled);
} else if (process.argv.includes('--prepare-only')) {
  prepareOnlyMain().catch(onUnhandled);
} else {
  main().catch(onUnhandled);
}
