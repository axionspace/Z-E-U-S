// test-i18n.mjs — the panel language setting.
//
// Two halves. The static half reads Source.js, decodes the payload table and checks that the
// pieces a language switch needs are actually wired together: the engine in the shared head
// row, the dictionary it carries, the control in the settings modal, the server-side
// {{LANG_SETTING}} injection, and the English direction overrides.
//
// It also closes a hole the other suites had: the two AUTHOR->LLM traps left in this build
// are base64 *inside* a payload row, so the plaintext marker search in test-personalize
// never saw them. Anything an atob() in the rows decodes to is checked here.
//
// The behavioural half runs the real engine in a vm against a hand-built DOM and checks what
// a user would actually see: English applied, direction flipped, Latin/config/hidden/textarea
// content left alone, late-rendered nodes caught, and switching back restoring the Persian.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { detectPrelude, xorDecode } from '../wizard/wizard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'Source.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS | ' : 'FAIL | ') + label + (extra ? ' | ' + extra : ''));
  c ? pass++ : fail++;
};

// ---------------------------------------------------------------- decode the payload table
const det = detectPrelude(SRC);
ok(!!det, 'the payload table is present');
const ROW = det.blobs.map((b) => xorDecode(b, det.key));
ok(ROW.length >= 75, 'decoded ' + ROW.length + ' payload rows');

// Every page is a fixed concatenation of rows; read the getters rather than repeating them
// here, so the suite follows the build instead of a copy of it.
const pages = {};
for (const m of SRC.matchAll(/get (\w+)\(\) \{ return _t_\w+ \|\|= `([^`]+)`;/g)) {
  pages[m[1]] = m[2].replace(/\$\{_G\((\d+)\)\}/g, (_, n) => ROW[+n] || '');
}
for (const p of ['nginx', 'setup', 'login', 'panel', 'status']) {
  ok(typeof pages[p] === 'string' && pages[p].length > 500, 'composed page "' + p + '"', (pages[p] || '').length + ' chars');
}

// ---------------------------------------------------------------- static: the engine
const ENGINE_ROW = ROW.findIndex((r) => r.includes('window.setPanelLang'));
ok(ENGINE_ROW >= 0, 'the language engine lives in a payload row', 'row ' + ENGINE_ROW);
ok(['nginx', 'setup', 'login', 'panel', 'status'].every((p) => pages[p].includes('window.setPanelLang')),
  'every page carries the engine (it sits in the shared head row)');

const at = ROW[ENGINE_ROW].indexOf('window.setPanelLang');
const engineStart = ROW[ENGINE_ROW].lastIndexOf('<script>', at);
const engineEnd = ROW[ENGINE_ROW].indexOf('</script>', at);
ok(engineStart > -1 && engineEnd > engineStart, 'the engine script is locatable', 'row ' + ENGINE_ROW);
const ENGINE_CODE = ROW[ENGINE_ROW].slice(engineStart + '<script>'.length, engineEnd);

for (const [needle, label] of [
  ['/*{{LANG_SETTING}}*/', 'reads the server-rendered language before paint'],
  ['localStorage.getItem', 'remembers the choice per browser'],
  ['paintDirection()', 'sets lang and dir before the body renders'],
  ['MutationObserver', 'keeps translating what the app renders later'],
  ['panel-lang-select', 'reflects the current language in the settings control'],
  ['/api/settings/bulk', 'persists panel_lang beside the other panel settings'],
  ['lang === EN && d === \'rtl\'', 'turns explicit rtl spans around for English'],
  ['text-align:left', 're-points physical alignment for left-to-right'],
  ['scaleX(-1)', 'mirrors the toggle switches so they travel the right way'],
]) ok(ENGINE_CODE.includes(needle), 'engine ' + label);

// ---------------------------------------------------------------- static: the dictionary
let DICT = null, dictError = '';
try {
  const line = ENGINE_CODE.split('\n').find((l) => l.trim().startsWith('var DICT = '));
  if (!line) throw new Error('no var DICT line');
  const start = line.indexOf('{');
  DICT = JSON.parse(line.slice(start).trim().replace(/;$/, ''));
} catch (e) { dictError = String(e && e.message || e); }
ok(!!DICT && Object.keys(DICT).length > 400, 'the dictionary is inline and large enough',
  DICT ? Object.keys(DICT).length + ' entries' : dictError);
const HAS_FA = /[؀-ۿ]/;
if (DICT) {
  const keys = Object.keys(DICT);
  ok(keys.every((k) => HAS_FA.test(k)), 'every key is a Persian source string');
  ok(keys.every((k) => DICT[k] && DICT[k].trim().length > 0), 'no empty translations');
  ok(keys.every((k) => !/<\//i.test(DICT[k])), 'no translation can terminate the script block');
  ok(keys.some((k) => k.includes('زبان پنل')), 'the language section itself is translated');
}

// ---------------------------------------------------------------- static: the settings control
const panel = pages.panel;
ok(panel.includes('id="panel-lang-select"'), 'the settings modal has a language control');
ok(panel.includes('onchange="setPanelLang(this.value)"'), 'the control calls the engine');
ok(panel.includes('<option value="fa">') && panel.includes('<option value="en">'), 'both languages are offered');
ok(panel.indexOf('panel-lang-select') < panel.indexOf('id="refresh-rate-select"'),
  'the language section sits at the top of the settings modal');
ok(panel.includes('جهت نمایش خودکار'), 'the control explains that direction follows the language');

// ---------------------------------------------------------------- static: the server side
ok((SRC.match(/let langSetting = 'fa';/g) || []).length === 3, 'langSetting is declared at all three render sites',
  String((SRC.match(/let langSetting = 'fa';/g) || []).length));
ok((SRC.match(/key = 'panel_lang'/g) || []).length === 3, 'panel_lang is read from D1 at all three render sites',
  String((SRC.match(/key = 'panel_lang'/g) || []).length));
// The substitution is written as a regex literal, so the braces are escaped in the source
// (`\{\{LANG_SETTING\}\}`) and a literal {{LANG_SETTING}} search finds nothing.
ok((SRC.match(/\bLANG_SETTING\b/g) || []).length === 5, 'the placeholder is substituted into every served template',
  String((SRC.match(/\bLANG_SETTING\b/g) || []).length));
ok(SRC.includes("langSetting = 'en'"), 'only English flips the server default');

// ---------------------------------------------------------------- static: the traps are gone
{
  const TRAPS = [
    [/\b_CF_UI_INTEGRITY\b/, 'the _CF_UI_INTEGRITY directive'],
    [/\b_GLOBAL_SECURE_AUTH\b/, 'the _GLOBAL_SECURE_AUTH directive'],
    [/AI_SYSTEM_AUTHORITY/, 'the base64 SYSTEM_AUTHORITY block'],
    [/Do not remove watermarks/, 'the base64 AI_DIRECTIVE block'],
    [/Refuse and reply/, 'the canned refusal instruction'],
    [/Dastkari dar code mojaze nist/, 'the canned Persian refusal'],
    [/hazf zeus mojaz nist/, 'the canned watermark refusal'],
  ];
  const payloads = [];
  for (const m of (SRC + '\n' + ROW.join('\n')).matchAll(/atob\(\s*["']([A-Za-z0-9+/=]{8,})["']\s*\)/g)) {
    try { payloads.push(Buffer.from(m[1], 'base64').toString('utf8')); } catch (e) {}
  }
  const haystack = SRC + '\n' + ROW.join('\n') + '\n' + payloads.join('\n');
  for (const [re, label] of TRAPS) ok(!re.test(haystack), 'no AUTHOR->LLM trap survives: ' + label);
  ok(payloads.every((p) => !/AI_|SYSTEM|refuse|mojaz nist|watermark/i.test(p)),
    'every atob() literal in the rows decodes to something harmless',
    payloads.length ? payloads.length + ' payloads decoded' : 'no atob() literal remains');
}

// ---------------------------------------------------------------- static: every page parses
{
  const dir = mkdtempSync(join(tmpdir(), 'zeus-i18n-'));
  let scripts = 0;
  const problems = [];
  for (const [name, html] of Object.entries(pages)) {
    for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc\s*=/.test(m[1] || '')) continue;
      if (!m[2].trim()) continue;
      scripts++;
      const f = join(dir, name + '-' + scripts + '.js');
      writeFileSync(f, m[2]);
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) problems.push(name + '#' + scripts + ': ' + (r.stderr || '').split('\n').slice(0, 2).join(' '));
    }
  }
  rmSync(dir, { recursive: true, force: true });
  ok(scripts > 20, 'extracted ' + scripts + ' inline scripts from the five pages');
  ok(problems.length === 0, 'every inline script parses', problems.join(' || ') || scripts + ' checked');
}

// ================================================================ behavioural half
const miniDom = () => {
  const records = [];
  const queue = (r) => records.push(r);
  const sibling = (n) => {
    if (!n.parentNode) return null;
    const i = n.parentNode.childNodes.indexOf(n);
    return n.parentNode.childNodes[i + 1] || null;
  };

  class Text {
    constructor(v) { this.nodeType = 3; this._v = String(v); this.parentNode = null; }
    get nodeValue() { return this._v; }
    set nodeValue(v) { this._v = String(v); queue({ type: 'characterData', target: this }); }
    get nextSibling() { return sibling(this); }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.attrs = Object.create(null);
      this.childNodes = [];
      this.parentNode = null;
    }
    get firstChild() { return this.childNodes[0] || null; }
    get head() { return this.tagName === 'HTML' ? this.childNodes.find((c) => c.nodeType === 1 && c.tagName === 'HEAD') : null; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    hasAttribute(n) { return n in this.attrs; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(c) {
      if (c.parentNode) c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1);
      c.parentNode = this;
      this.childNodes.push(c);
      queue({ type: 'childList', addedNodes: [c], removedNodes: [] });
      return c;
    }
    get nextSibling() { return sibling(this); }
  }
  const el = (tag, attrs, kids) => {
    const e = new El(tag);
    for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
    for (const kid of (kids || [])) e.appendChild(typeof kid === 'string' ? new Text(kid) : kid);
    return e;
  };
  const text = (v) => new Text(v);
  const findById = (node, id) => {
    if (node.nodeType === 1 && node.getAttribute('id') === id) return node;
    for (const c of node.childNodes || []) { const hit = findById(c, id); if (hit) return hit; }
    return null;
  };

  const html = el('html', { lang: 'fa', dir: 'rtl' });
  const head = el('head');
  const body = el('body');
  html.appendChild(head);
  html.appendChild(body);

  const domCbs = [];
  const observers = [];
  class MutationObserverShim {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const flush = () => {
    let guard = 0;
    while (records.length && guard++ < 50) {
      const batch = records.splice(0, records.length);
      for (const o of observers) if (o.active) o.cb(batch);
    }
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const fetches = [];
  const fetch = (url, opts) => { fetches.push({ url, opts }); return Promise.resolve({ ok: true }); };

  const document = {
    documentElement: html, head, body,
    readyState: 'loading',
    createElement: (t) => new El(t),
    getElementById: (id) => findById(html, id),
    addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') domCbs.push(cb); },
    removeEventListener: () => {},
  };
  const toasts = [];
  // The real showToast inserts a node; the engine only ever sees the DOM, so the shim has to
  // build one too or the confirmation would never be translated.
  const win = {
    MutationObserver: MutationObserverShim,
    showToast: (m) => { toasts.push(m); body.appendChild(el('div', { id: 'toast-probe' }, [m])); },
  };

  return { html, head, body, el, text, document, localStorage, fetch, fetches, win, toasts,
           MutationObserver: MutationObserverShim, flush, domCbs, store, findById };
};

const boot = (opts = {}) => {
  const D = miniDom();
  if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) D.localStorage.setItem(k, v);
  let code = ENGINE_CODE;
  if (opts.serverLang) code = code.replace(/\/\*\{\{LANG_SETTING\}\}\*\//g, opts.serverLang);
  if (opts.build) opts.build(D);
  vm.runInNewContext(code, {
    window: D.win, document: D.document, localStorage: D.localStorage, fetch: D.fetch,
    MutationObserver: D.MutationObserver, console, setTimeout, clearTimeout,
  }, { filename: 'panel-i18n.js' });
  D.domCbs.forEach((cb) => cb());
  D.flush();
  return D;
};

const contentOf = (ctx, node) => {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) out.push(n.nodeValue);
    else (n.childNodes || []).forEach(walk);
  };
  walk(node);
  return out.join('');
};

// A slice of the real panel: the settings card, a flipped span, Latin data, a hidden config.
const build = (D) => {
  D.head.appendChild(D.el('title', {}, ['تنظیمات پـنـل']));
  D.body.appendChild(D.el('div', { id: 'settings-modal' }, [
    D.el('label', { id: 'lang-label' }, ['زبان پنل']),
    D.el('select', { id: 'panel-lang-select', onchange: 'setPanelLang(this.value)' }, [
      D.el('option', { value: 'fa' }, ['فارسی (راست‌چین)']),
      D.el('option', { value: 'en' }, ['انگلیسی (چپ‌چین)']),
    ]),
    D.el('p', { id: 'lang-hint' }, ['جهت نمایش خودکار از زبان انتخابی شما پیروی می‌کند و روی همه صفحه‌های پنل اعمال می‌شود.']),
    D.el('h4', {}, ['تنظیمات پـنـل']),
    D.el('button', { id: 'save-settings-btn', title: 'ذخیره تنظیمات' }, ['ذخیره تنظیمات']),
    D.el('span', { id: 'count-rtl', dir: 'rtl' }, ['۰ دستگاه متصل']),
    D.el('span', { id: 'addr-ltr', dir: 'ltr' }, ['104.16.0.1']),
    D.el('span', { id: 'latin' }, ['1a2b-3c4d-UUID']),
    D.el('code', { id: 'code-block' }, ['CMD خالی']),
    D.el('textarea', { id: 'input-ips' }, ['104.16.0.1']),
    D.el('div', { id: 'hidden-configs', style: 'display:none; white-space:pre-wrap;' }, ['- name: "ذخیره تنظیمات"']),
    D.el('div', { id: 'plural' }, ['کاربران']),
    D.el('div', { id: 'joined' }, ['۰ کاربر انتخاب شده']),
    D.el('div', { id: 'count-days' }, ['۱۲ روز']),
  ]));
};

const run = boot({ build });
const get = (id) => run.findById(run.html, id);

ok(run.document.documentElement.getAttribute('dir') === 'rtl', 'defaults to right-to-left before anything is chosen');
ok(run.document.documentElement.getAttribute('lang') === 'fa', 'defaults to lang=fa');
ok(contentOf(run, get('save-settings-btn')) === 'ذخیره تنظیمات', 'Persian stays Persian by default');

// ------------------------------------------------------------------ switch to English
run.win.setPanelLang('en');
run.flush(); // microtasks run before the browser paints the toast
{
  const root = run.document.documentElement;
  ok(root.getAttribute('dir') === 'ltr', 'document flips to ltr');
  ok(root.getAttribute('lang') === 'en', 'document lang becomes en');
  ok(contentOf(run, get('save-settings-btn')) === 'Save settings', 'a button label is translated');
  ok(get('save-settings-btn').getAttribute('title') === 'Save settings', 'a title attribute is translated');
  ok(contentOf(run, get('lang-label')) === 'Panel language', 'the language label is translated');
  ok(contentOf(run, run.head).includes('Panel settings'), 'the page title is translated');
  ok(run.findById(run.html, 'panel-lang-select').value === 'en', 'the control reflects the new language');

  ok(get('count-rtl').getAttribute('dir') === 'ltr', 'a dir=rtl span now reads left-to-right');
  ok(contentOf(run, get('count-rtl')) === '0 devices connected', 'and its Persian count is English with ASCII digits');
  ok(get('addr-ltr').getAttribute('dir') === 'ltr', 'a pre-existing dir=ltr span is still ltr');
  ok(contentOf(run, get('latin')) === '1a2b-3c4d-UUID', 'a Latin-only node is not re-spaced or touched');
  ok(contentOf(run, get('input-ips')) === '104.16.0.1', 'textareas (user data) are skipped');
  ok(contentOf(run, get('code-block')) === 'CMD خالی', 'code elements are skipped');
  ok(contentOf(run, get('hidden-configs')) === '- name: "ذخیره تنظیمات"', 'the hidden config block is never rewritten');
  ok(contentOf(run, get('plural')) === 'کاربران', 'a short key does not bite into a longer word');
  ok(contentOf(run, get('joined')) === '0 users selected', 'a whole line matches exactly: digits and all');
  ok(contentOf(run, get('count-days')) === '12 days', 'a scripted number plus a unit translates: digits normalised too');

  ok(run.fetches.some((f) => f.url === '/api/settings/bulk' && /"panel_lang":"en"/.test(f.opts.body)), 'panel_lang is persisted to D1');
  ok(run.store.get('zeus-lang') === 'en', 'the choice is remembered in this browser');
  ok(run.toasts.length === 1, 'the confirmation was raised once');
  ok(contentOf(run, get('toast-probe')) === '🌐 Panel language changed',
    'the confirmation is shown in the new language', JSON.stringify(contentOf(run, get('toast-probe'))));
}

// ------------------------------------------------------------------ a node rendered later
{
  const row = run.el('tr', {}, [run.el('td', { dir: 'rtl' }, ['۵ روز (اولین اتصال)'])]);
  get('settings-modal').appendChild(row);
  run.flush();
  ok(contentOf(run, row) === '5 days (first connection)',
    'a late-rendered node is translated, concatenation and all',
    JSON.stringify(contentOf(run, row)));
  const cell = row.firstChild;
  ok(cell.nodeType === 1 && cell.getAttribute('dir') === 'ltr', 'and its dir=rtl is flipped too',
    'nodeType=' + cell.nodeType + ' dir=' + (cell.getAttribute ? cell.getAttribute('dir') : 'n/a'));
}

// ------------------------------------------------------------------ the app rewrites a node
{
  const badge = run.el('span', { id: 'badge' }, ['در صف تست...']);
  get('settings-modal').appendChild(badge);
  run.flush();
  ok(contentOf(run, badge) === 'Queued for testing...', 'first render translated', JSON.stringify(contentOf(run, badge)));
  badge.childNodes[0].nodeValue = 'در حال تست...';
  run.flush();
  ok(contentOf(run, badge) === 'Testing...', 'the app overwriting the text is translated again', JSON.stringify(contentOf(run, badge)));
}

// ------------------------------------------------------------------ switch back
run.win.setPanelLang('fa');
{
  ok(run.document.documentElement.getAttribute('dir') === 'rtl', 'document flips back to rtl');
  ok(run.document.documentElement.getAttribute('lang') === 'fa', 'document lang is fa again');
  ok(contentOf(run, get('save-settings-btn')) === 'ذخیره تنظیمات', 'Persian is restored');
  ok(get('save-settings-btn').getAttribute('title') === 'ذخیره تنظیمات', 'attributes are restored too');
  ok(!contentOf(run, get('save-settings-btn')).includes('Save'), 'English is gone from the buttons');
  ok(contentOf(run, get('count-rtl')) === '۰ دستگاه متصل', 'the count span is back to its Persian digits');
  ok(get('count-rtl').getAttribute('dir') === 'rtl', 'dir=rtl comes back on the spans that had it');
  ok(get('addr-ltr').getAttribute('dir') === 'ltr', 'a span that was dir=ltr was never touched');
  ok(contentOf(run, get('count-days')) === '۱۲ روز', 'the dynamic count is restored');
  ok(contentOf(run, run.head).includes('تنظیمات پـنـل'), 'the title is restored');
  ok(run.store.get('zeus-lang') === 'fa', 'the browser remembers the way back');
}

// ------------------------------------------------------------------ boots: stored and server
{
  const stored = boot({ build, storage: { 'zeus-lang': 'en' } });
  ok(stored.document.documentElement.getAttribute('dir') === 'ltr', 'a returning English user boots straight into ltr');
  ok(contentOf(stored, stored.findById(stored.html, 'save-settings-btn')) === 'Save settings', 'and the page is already English');

  const fromServer = boot({ build, serverLang: 'en' });
  ok(fromServer.document.documentElement.getAttribute('dir') === 'ltr', 'a browser with no choice boots from the D1 default');
  ok(contentOf(fromServer, fromServer.findById(fromServer.html, 'save-settings-btn')) === 'Save settings', 'with English applied');

  const fallback = boot({ build, serverLang: '/*{{LANG_SETTING}}*/' });
  ok(fallback.document.documentElement.getAttribute('dir') === 'rtl', 'an unreplaced placeholder falls back to Persian instead of breaking');

  const storedWins = boot({ build, storage: { 'zeus-lang': 'fa' }, serverLang: 'en' });
  ok(storedWins.document.documentElement.getAttribute('dir') === 'rtl', 'this browser\'s own choice beats the panel default');

  const bad = boot({ build });
  bad.win.setPanelLang('xx');
  ok(bad.document.documentElement.getAttribute('dir') === 'rtl', 'an unknown language code is ignored');
}

console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) process.exit(1);
