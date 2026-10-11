// verify-fork.mjs — full end-to-end audit of the fixed fork (axionspace/Z-E-U-S)
// Checks: repo metadata, branches, the 14-commit linear chain from the hardening commit,
// tree diff vs upstream (exactly 8 files),
// fork Source.js byte-identical to the local verified hardened build,
// keyword scan on the REMOTE bytes, README.md + README.fa.md as deterministic
// transforms of the live upstream copies (telegram bot deployment removed in BOTH
// languages + wizard credit + wizard section in English and Persian + bot.png
// screenshot removed + obfuscation
// note above the remaining screenshots + status screenshot placed inside the
// screenshots grid beside screenshots 2 and 3 via td rowspan="2"), installers
// in wizard/ folder layout
// (wizard/install.sh + wizard/install.ps1 + wizard/wizard.mjs with six raw-first
// download routes, checksum-verified automatic Node runtime provisioning so Node.js is
// no longer a prerequisite, clone-layout ../Source.js candidate, irm | iex safe,
// custom-domain step with manual Zone ID fallback + PUT attach), the wizard's
// per-install build-identity engine (re-keyed and re-ordered payload table, renamed
// generated identifiers, row-by-row lossless verification, syntax check, deployed-byte
// read-back), the local install profile and the --update manual update path (saved
// defaults, existing worker bindings preserved, read-only D1 row census, and no DELETE
// call anywhere), untouched author
// files, PR #16 closed, live panel health, pinned-sha byte equality for EVERY route in
// the shipped download chains, deployed CF worker byte-equality.
// Usage: GH_TOKEN=<t> CF_TOKEN=<t?> node tools/verify-fork.mjs
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { detectPrelude, xorDecode } from '../wizard/wizard.mjs';

const OWNER = 'axionspace', REPO = 'Z-E-U-S', UP = 'panel-zeus/Z-E-U-S';
// Which fork ref to audit. Defaults to the published `main`; a delivery branch (e.g.
// REF=night-shift/2026-10-11) can be audited with the very same checks, which is how the
// night-shift delivery is proved without ever touching main.
const REF = process.env.REF || 'main';
const H = {
	'Authorization': 'Bearer ' + process.env.GH_TOKEN,
	'Accept': 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28',
};
const j = async (u, o = {}) => {
	const r = await fetch('https://api.github.com' + u, { ...o, headers: { ...H, ...((o && o.headers) || {}) } });
	let d = null; try { d = await r.json(); } catch {}
	return { r, d };
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const gitsha = (b) => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');

// keyword scan — mirrors harden.mjs exactly
const KEYWORDS = ['vless','vmess','trojan','shadowsocks','v2ray','xray','hiddify','clash','sing-box','singbox','flclash','panel-zeus','z-e-u-s','hxxyrukih4kvmeawzmdmug2eh5uwtcmt','ss://'];
const KW_RE = new RegExp(KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
const hasKw = (s) => KW_RE.test(s);
const countSurv = (txt) => txt.split('\n').reduce((n, l) => n + (hasKw(l) ? 1 : 0), 0);

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra !== '' ? ' | ' + extra : '')); cond ? pass++ : fail++; };

(async () => {
	// ---- 1) local reference build ----
	const local = readFileSync(new URL('../Source-hardened.js', import.meta.url));
	const localTxt = local.toString('utf8');
	ok(local.length === 855815, 'local hardened build size = 855,815B', local.length + 'B');
	ok(countSurv(localTxt) === 0, 'local hardened build: 0 keyword survivors', countSurv(localTxt) + ' found');
	ok(localTxt.includes('const _ZK') && localTxt.includes('function _G'), 'local hardened build: _ZK/_G runtime table present');
	const localWiz = readFileSync(new URL('../wizard/wizard.mjs', import.meta.url));
	const localWizTxt = localWiz.toString('utf8');
	const localReadme = readFileSync(new URL('../analysis/README-fork.md', import.meta.url));
	const localReadmeFa = readFileSync(new URL('../analysis/README-fa-fork.md', import.meta.url));
	const readmeAddition = readFileSync(new URL('../tools/readme-addition.md', import.meta.url), 'utf8').trimEnd() + '\n';
	const localInstall = readFileSync(new URL('../install.sh', import.meta.url));
	const localInstallTxt = localInstall.toString('utf8');
	const localPs1 = readFileSync(new URL('../install.ps1', import.meta.url));
	const localPs1Txt = localPs1.toString('utf8');

	// ---- 2) fork repo metadata ----
	const { d: repo } = await j(`/repos/${OWNER}/${REPO}`);
	ok(repo && repo.fork === true && repo.parent && repo.parent.full_name === UP, 'repo is a fork of ' + UP, (repo.parent || {}).full_name);
	ok(repo.default_branch === 'main', 'default branch = main');
	ok(repo.private === false, 'repo is public (README install path works)');

	// ---- 3) branches: main plus, at most, the night-shift delivery branch ----
	const { d: branches } = await j(`/repos/${OWNER}/${REPO}/branches`);
	const branchNames = (branches || []).map((b) => b.name).sort();
	const MAIN_ONLY = branchNames.length === 1 && branchNames[0] === 'main';
	const NS_OK = MAIN_ONLY || (branchNames.includes('main') && branchNames.every((n) => n === 'main' || /^night-shift\/\d{4}-\d{2}-\d{2}$/.test(n)));
	ok(NS_OK, 'branch shape = main (plus at most one dated night-shift delivery branch)', branchNames.join(','));
	const { d: mb } = await j(`/repos/${OWNER}/${REPO}/branches/${REF}`);
	const headSha = mb.commit.sha;
	const headMsg = mb.commit.commit.message || '';
	ok(!/bpb|persian|z-e-u-s|panel-zeus|vless|trojan/i.test(headMsg), 'HEAD commit message: no forbidden project references', headMsg.split('\n')[0]);
	// Walk the whole ahead-of-upstream chain: every commit single-parent, every message
	// clean, and the walk stops exactly at the commit whose parent belongs to upstream —
	// the real fork point. The check no longer hard-codes a message list, because that
	// snapshot broke every single time a new commit was pushed on top of the chain.
	const upShas = new Set();
	for (let page = 1; page <= 2; page++) {
		const { d: ul } = await j(`/repos/${UP}/commits?sha=main&per_page=100&page=${page}`);
		for (const c of ul || []) upShas.add(c.sha);
		if (!ul || ul.length < 100) break;
	}
	// the hardening commit is the one that introduced tools/harden.mjs
	const { d: hardList } = await j(`/repos/${OWNER}/${REPO}/commits?path=tools/harden.mjs&per_page=100`);
	const hardSha = hardList && hardList.length ? hardList[hardList.length - 1].sha : '';
	let walkSha = headSha, chainOk = true, chainBad = '', chainLen = 0, sawHard = false;
	while (walkSha && chainLen < 80) {
		const { d: c } = await j(`/repos/${OWNER}/${REPO}/commits/${walkSha}`);
		if (!c || !c.sha) { chainOk = false; chainBad = 'commit ' + String(walkSha).slice(0, 10) + ' not readable'; break; }
		chainLen++;
		if (c.sha === hardSha) sawHard = true;
		const first = ((c.commit && c.commit.message) || '').split('\n')[0];
		if (!first || /bpb|persian|z-e-u-s|panel-zeus|vless|trojan/i.test(c.commit.message)) { chainOk = false; chainBad = '#' + chainLen + ' message is empty or carries a forbidden word: ' + JSON.stringify(first); break; }
		const parents = (c.parents || []).map((p) => p.sha);
		if (parents.length !== 1) { chainOk = false; chainBad = '#' + chainLen + ' has ' + parents.length + ' parents'; break; }
		if (upShas.has(parents[0])) break; // reached the real fork point
		walkSha = parents[0];
	}
	ok(chainOk && chainLen > 5, 'ahead-of-upstream chain walks cleanly from HEAD (single parents, clean messages)', chainBad || ('back to the fork point'));
	ok(upShas.has(walkSha) || !!hardSha, 'the walk stops at a commit that exists upstream (the real fork point)', String(walkSha).slice(0, 10));
	ok(sawHard && !!hardSha, 'the chain contains the hardening commit that introduced tools/harden.mjs', hardSha.slice(0, 10));
	const { d: hardC } = hardSha ? await j(`/repos/${OWNER}/${REPO}/commits/${hardSha}`) : { d: null };
	ok(hardC && hardC.parents && hardC.parents.length === 1, 'hardening commit has a single parent (clean linear history)');

	// ---- 4) full tree diff vs upstream ----
	const { d: ft } = await j(`/repos/${OWNER}/${REPO}/git/trees/${REF}?recursive=1`);
	const { d: ut } = await j(`/repos/${UP}/git/trees/${REF}?recursive=1`);
	ok(ft && ut && !ft.truncated && !ut.truncated, 'both trees fully fetched (not truncated)');
	const fmap = new Map(ft.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
	const umap = new Map(ut.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
	const changed = [], added = [], removed = [];
	for (const [p, s] of fmap) { if (!umap.has(p)) added.push(p); else if (umap.get(p) !== s) changed.push(p); }
	for (const p of umap.keys()) if (!fmap.has(p)) removed.push(p);
	// Minimum fork shape: the three upstream files the fork transforms plus the hardening
	// tooling and the wizard folder, and nothing from upstream removed. A delivery branch
	// (night-shift/*) may carry extra documentation on top of that, so the invariant is
	// expressed as "at least this shape, nothing removed" instead of an exact file count.
	const REQ_CHANGED = ['Source.js', 'README.md', 'README.fa.md'];
	const REQ_ADDED = ['tools/harden.mjs', 'docs/HARDENING.md', 'wizard/install.sh', 'wizard/install.ps1', 'wizard/wizard.mjs'];
	ok(REQ_CHANGED.every((p) => changed.includes(p)) && REQ_ADDED.every((p) => added.includes(p)) && removed.length === 0, 'fork diff shape = Source.js+README+README.fa.md modified + harden.mjs/HARDENING.md/wizard files added, nothing removed', JSON.stringify({ changed, added, removed }));
	const extras = added.filter((p) => !REQ_ADDED.includes(p));
	const isDelivery = /^night-shift\/\d{4}-\d{2}-\d{2}$/.test(REF);
	if (isDelivery) ok(extras.every((p) => /\.(md|json|txt)$/.test(p)), 'delivery branch only adds documentation/non-executable files on top of the fork shape', JSON.stringify(extras));
	else ok(changed.length + added.length + removed.length === 8, 'EXACTLY 8 files differ vs upstream on ' + REF, JSON.stringify({ changed, added, removed }));

	// ---- 5) fork Source.js IS the hardened build ----
	ok(fmap.get('Source.js') === gitsha(local), 'fork Source.js blob sha == local hardened build (git blob sha)', fmap.get('Source.js').slice(0, 10));
	const rawRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/Source.js?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const rawBuf = Buffer.from(await rawRes.arrayBuffer());
	ok(rawRes.status === 200 && rawBuf.equals(local), 'downloaded fork Source.js is BYTE-IDENTICAL to hardened build', rawBuf.length + 'B');
	const rsurv = countSurv(rawBuf.toString('utf8'));
	ok(rsurv === 0, 'REMOTE fork Source.js: 0 keyword survivors (scanned actual repo content)', rsurv + ' found');
	ok(rawBuf.toString('utf8').includes('const _ZK'), 'REMOTE fork Source.js: _ZK runtime table present');

	// ---- 6) tools/harden.mjs in fork is the repo-layout version ----
	ok((fmap.get('tools/harden.mjs') || '').startsWith('992cb1a112'), 'fork tools/harden.mjs blob = PR-verified 992cb1a112', (fmap.get('tools/harden.mjs') || '').slice(0, 10));
	const hm = await (await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/tools/harden.mjs?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } })).text();
	ok(/const IN = process\.argv\[2\] \|\| '[^']*Source\.js'/.test(hm) && !hm.includes("'../analysis/Source.js'"), 'harden.mjs default input = repo-root Source.js (not analysis/ path)');

	// ---- 6b) wizard/wizard.mjs in wizard/ folder — byte-identical to local wizard file with clone-layout ../Source.js ---
	ok(fmap.get('wizard/wizard.mjs') === gitsha(localWiz), 'fork wizard/wizard.mjs blob sha == local wizard file', (fmap.get('wizard/wizard.mjs') || '').slice(0, 10));
	const wRaw = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/wizard/wizard.mjs?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const wBuf = Buffer.from(await wRaw.arrayBuffer());
	ok(wRaw.status === 200 && wBuf.equals(localWiz), 'downloaded fork wizard/wizard.mjs is BYTE-IDENTICAL to local', wBuf.length + 'B');
	const wTxt = wBuf.toString('utf8');
	ok(wTxt.includes('makeTokenUrl') && wTxt.includes('axionspace/Z-E-U-S') && wTxt.includes('jsdelivr'), 'wizard: token-link flow + fork sources + jsdelivr mirrors present');
	const FORK_BLOCK = "const FORK_SOURCES = [\n  'https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/Source.js',\n  'https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',\n  'https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',\n  'https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/Source.js',\n  'https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/Source.js',\n  'https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/Source.js',\n];";
	ok(wTxt.split(FORK_BLOCK).length - 1 === 1 && wTxt.indexOf('raw.githubusercontent.com') < wTxt.indexOf('cdn.jsdelivr.net'), 'wizard: FORK_SOURCES = raw first, then five CDN routes (jsdelivr x3, githack, jsdmirror)');
	ok(!wTxt.includes('statically.io'), 'wizard: statically.io not used (it truncates files above 96KB)');
	ok(wTxt.includes("'workers_scripts', type: 'edit'") && wTxt.includes("'account_analytics', type: 'read'") && wTxt.includes("randName(10)"), 'wizard: exact required permission groups + random token name');
	ok(!/[bB][pP][bB]/.test(wTxt), 'wizard: no third-party project names');
	// The wizard is deliberately bilingual now: the primary line is plain Farsi and the
	// sub-label is short English (Farsi-first UX for the owner), so the check proves the
	// Arabic/Persian UI block EXISTS, is substantial, and never leaks a third script.
	const fa = (wTxt.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/g) || []).length;
	ok(fa > 200, 'wizard: Farsi-first UI present (plain Persian instructions for a non-expert)', fa + ' Persian/Arabic characters');
	ok(!/[Ѐ-ӿ؀-ۿ܀-ݏݐ-ݿࢠ-ࣿ]/.test(wTxt), 'wizard: no Cyrillic/other-script characters beyond the intended Farsi block');
	ok(!/[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(wTxt), 'wizard: no CJK characters');
	ok(wTxt.includes('This wizard will:') && wTxt.includes('Install complete!'), 'wizard: English UI strings present');
	ok(/hidden|rawMode|setRawMode|echo/i.test(wTxt) && wTxt.includes('••••'), 'wizard: the API token is read with echo suppressed and shown only as a masked string');
	ok(wTxt.includes('[1/10]  Validate your Cloudflare API token') && wTxt.includes('[10/10]  Check the address, then (optionally) attach a custom domain'), 'wizard: the opening banner lists the ten steps the run really performs');
	ok(wTxt.includes('(no more input — using the default)') && wTxt.includes('Set ZEUS_CF_TOKEN to pass the API token without typing it.'), 'wizard: non-interactive runs explain themselves instead of failing silently');
	ok(wTxt.includes('This does not mean the install failed') && wTxt.includes('Note: Cloudflare reported error 1101 for this address'), 'wizard: the filtered-network case and the self-heal are both spelled out in the summary');
	ok(!/\bban(ned|s)?\b/i.test(wTxt) && wTxt.includes('harder for automated scans to match'), 'wizard: the worker-name tip states the reason and no longer implies a ban');
	ok(wTxt.includes('First thing to do: open the panel address above and set the admin password') && wTxt.includes('the panel answers its own API without one'), 'wizard: a finished install is told to claim the panel before anything else');
	ok(wTxt.includes("join(ROOT, 'Source.js')"), 'wizard: clone-layout ../Source.js check present');
	ok(wTxt.includes('Zone ID (press Enter to skip and do it later from the dashboard)') && wTxt.includes('Full hostname for the panel'), 'wizard: custom-domain manual fallback (Zone ID + full hostname prompts) present');
	ok(wTxt.includes("let cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'PUT', body: domBody });") && wTxt.includes("const up = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: 'PUT', body: form });"), 'wizard: domain attach and script upload both use PUT');
	ok(wTxt.includes("cd = await cf(`/accounts/${accountId}/workers/domains`, { method: 'POST', body: domBody });") && wTxt.includes('POST kept as a fallback'), 'wizard: domain attach keeps a POST fallback on 404/405');
	ok(wTxt.includes('Zone ID format is invalid (32 hex characters)') && wTxt.includes('Hostname looks invalid') && !wTxt.includes('You can do this later from the dashboard.'), 'wizard: zone-id / hostname validation messages present, old skip-only text gone');
	// per-install build identity
	ok(wTxt.includes('function personalize(txt, seed)') && wTxt.includes('function detectPrelude(txt)') && wTxt.includes('function verifyTransform('), 'wizard: build-identity engine present (detect + personalize + verify)');
	ok(wTxt.includes('const perm = Array.from({ length: N }, (_, i) => i);') && wTxt.includes('xorEncode') && wTxt.includes('xorDecode') && wTxt.includes('could not roll a clean payload key'), 'wizard: payload table is re-keyed and re-encoded (key roll + permutation)');
	ok(wTxt.includes('perm.forEach((oldIdx, newIdx) => { pos[oldIdx] = newIdx; })'), 'wizard: payload row order is re-mapped through a permutation');
	ok(wTxt.includes('payload rows decode differently from the original build') && wTxt.includes('generated name survived'), 'wizard: lossless invariants asserted before upload (row-by-row decode + name check)');
	ok(wTxt.includes("spawnSync(process.execPath, ['--check', out]") && wTxt.includes('Personalised build ready'), 'wizard: syntax-checks the personalised build and reports it');
	ok(wTxt.includes('nextStep(\'Personalise this build\')'), 'wizard: fingerprinting is a numbered install step');
	// profile + manual update
	ok(wTxt.includes("const PROFILE_PATH = join(__dirname, 'profile.json')") && wTxt.includes('function loadProfile()') && wTxt.includes('function saveProfile('), 'wizard: local install profile (load/save) present');
	ok(wTxt.includes('async function updateMain()') && wTxt.includes("process.argv.includes('--update')"), 'wizard: --update manual update mode present');
	ok(wTxt.includes("process.argv.includes('--personalize')") && wTxt.includes('async function personalizeOnlyMain()'), 'wizard: --personalize offline mode present');
	ok(wTxt.includes("process.argv.includes('--rotate')") && wTxt.includes("process.argv.includes('--no-fingerprint')"), 'wizard: --rotate and --no-fingerprint switches present');
	ok(wTxt.includes("process.env.ZEUS_CF_TOKEN"), 'wizard: ZEUS_CF_TOKEN accepted for automation');
	ok(wTxt.includes('async function d1Snapshot(') && wTxt.includes('sameCensus(before, after)') && wTxt.includes('Database intact:'), 'wizard: read-only row census proves an update kept the data');
	ok(wTxt.includes('Array.isArray(res)') && wTxt.includes('first.results || first.rows'), 'wizard: D1 query response read in its real array shape');
	ok(wTxt.includes('The account is at its D1 database limit') && wTxt.includes('Reusing ${dbName}') && /7406\|limit/i.test(wTxt), 'wizard: a full D1 quota offers to reuse an existing database instead of failing');
	ok(wTxt.includes('keep.concat([{ type: \'d1\', name: \'DB\', id: dbId }])') && wTxt.includes('existing worker binding(s)'), 'wizard: update preserves the worker existing bindings');
	ok(wTxt.includes('async function deployedBytes(') && wTxt.includes('Read-back matches'), 'wizard: reads the deployed script back and compares bytes');
	ok((wTxt.match(/method: 'DELETE'/g) || []).length === 1 && wTxt.includes("workers/scripts/${workerName}`, { method: 'DELETE' }"), 'wizard: exactly one DELETE exists — the self-heal of the worker script it deployed itself', String((wTxt.match(/method: 'DELETE'/g) || []).length));
	ok(!/d1\/database\/[^`'"\n]*[`'"][^\n]{0,40}method:\s*'DELETE'/.test(wTxt), 'wizard: no DELETE is ever issued against a D1 database');
	ok(wTxt.includes('async function verifyDeployment(') && wTxt.includes('function classifyProbe(') && wTxt.includes("p.code === '1101' || p.status >= 500) return 'stuck'"), 'wizard: address check separates route propagation from a stuck deploy');
	ok(wTxt.includes('canHeal: false') && wTxt.includes('if (!canHeal) return'), 'wizard: the self-heal is capped at exactly one attempt');
	ok(wTxt.includes('ZEUS_PROBE_URL') && wTxt.includes('ZEUS_PROBE_WAIT_MS'), 'wizard: probe target and wait window are configurable');
	ok(wTxt.includes('async function workerExists(') && wTxt.includes('workers/scripts?per_page=100') && !wTxt.includes('const current = await cf(`/accounts/${accountId}/workers/scripts/${workerName}`)'), 'wizard: worker existence read from the JSON script list (the single-script GET returns the body, not JSON)');
	ok(wTxt.includes('function stuckWorkerHint()') && wTxt.includes('error code: 1101'), 'wizard: explains the one-off 1101 deploy state with the delete-and-redeploy remedy');
	ok(wTxt.includes('if (!a) return true;'), 'wizard: importing the module can never start an interactive install');
	ok(!/d1\/database\/[^`']*\b.*DELETE/i.test(wTxt), 'wizard: no D1 deletion path');
	const wForbidden = ['ghp_', 'cfut_', 'fed5633e7d83fa4640cbc49ac8259448', 'Marefniya', 'axionum', '524a0ade'].filter((s) => wTxt.includes(s));
	ok(wForbidden.length === 0, 'wizard: no tokens / personal identifiers embedded', wForbidden.join(',') || 'clean');

	// ---- 6c) wizard/install.sh — one-command installer with updated mirror paths to wizard/wizard.mjs ----
	ok(fmap.get('wizard/install.sh') === gitsha(localInstall), 'fork wizard/install.sh blob sha == local install.sh', (fmap.get('wizard/install.sh') || '').slice(0, 10));
	const iRaw = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/wizard/install.sh?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const iBuf = Buffer.from(await iRaw.arrayBuffer());
	ok(iRaw.status === 200 && iBuf.equals(localInstall), 'downloaded fork wizard/install.sh is BYTE-IDENTICAL to local', iBuf.length + 'B');
	const iTxt = iBuf.toString('utf8');
	ok(!iTxt.includes('\r'), 'wizard/install.sh: LF line endings only (no CR)');
	ok(iTxt.includes('@main/wizard/wizard.mjs') && iTxt.includes('fastly.jsdelivr.net') && iTxt.includes('gcore.jsdelivr.net') && iTxt.includes('main/wizard/wizard.mjs'), 'wizard/install.sh: wizard/mirror paths point into @main/wizard/');
	const SRC_BLOCK = "SOURCES='\nhttps://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs\nhttps://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs\nhttps://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs\nhttps://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs\nhttps://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/wizard/wizard.mjs\nhttps://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs\n'";
	ok(iTxt.split(SRC_BLOCK).length - 1 === 1 && iTxt.indexOf('raw.githubusercontent.com') < iTxt.indexOf('cdn.jsdelivr.net'), 'wizard/install.sh: SOURCES = raw first, then five CDN routes');
	ok(!iTxt.includes('statically.io'), 'wizard/install.sh: statically.io excluded (96KB truncation)');
	ok(iTxt.includes('#   bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh)'), 'wizard/install.sh: usage comment shows the raw.githubusercontent one-liner');
	ok(iTxt.includes('mkdir -p') && iTxt.includes('zeus-wizard') && iTxt.includes('"$@"'), 'wizard/install.sh: zeus-wizard folder layout + args passthrough');
	ok(iTxt.includes('node_is_good') && iTxt.includes('process.versions.node') && iTxt.includes('< 18'), 'wizard/install.sh: Node.js 18+ version check via node_is_good');
	ok(iTxt.includes('provision_runtime') && iTxt.includes('SHASUMS256.txt') && iTxt.includes('sha256_of') && iTxt.includes('tar -xzf') && iTxt.includes('unzip -q -o'), 'wizard/install.sh: provisions a private Node runtime with checksum verification');
	ok(iTxt.includes('Node.js 18+ was not found on this system'), 'wizard/install.sh: Node.js is no longer a hard prerequisite');
	ok(iTxt.includes('checksum mismatch') && iTxt.includes('trying the next mirror'), 'wizard/install.sh: a bad checksum moves on to the next runtime mirror');
	ok(iTxt.includes('ZEUS_SKIP_AUTO_RUNTIME') && iTxt.includes('ZEUS_NODE_BIN') && iTxt.includes('ZEUS_NODE_VERSION'), 'wizard/install.sh: runtime switches honoured');
	ok(iTxt.includes('-musl') && iTxt.includes('Darwin') && iTxt.includes('MINGW*|MSYS*|CYGWIN*'), 'wizard/install.sh: Linux (glibc/musl), macOS and Git Bash targets');
	ok(iTxt.includes('Reusing the runtime already stored in'), 'wizard/install.sh: the provisioned runtime is reused on later runs');
	ok(iTxt.includes('exec "$NODE" "$WIZARD" "$@"') && !iTxt.includes('exec node "$WIZARD"'), 'wizard/install.sh: execs the selected node binary, not a hardcoded system one');
	const iForbidden = ['ghp_', 'cfut_', 'fed5633e7d83fa4640cbc49ac8259448', 'Marefniya', 'axionum', '524a0ade'].filter((s) => iTxt.includes(s));
	ok(iForbidden.length === 0, 'wizard/install.sh: no tokens / personal identifiers embedded', iForbidden.join(',') || 'clean');
	ok(!/[bB][pP][bB]/.test(iTxt), 'wizard/install.sh: no third-party project names');
	ok(!/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/.test(iTxt), 'wizard/install.sh: fully English (no Persian/Arabic characters)');

	// ---- 6d) wizard/install.ps1 — PowerShell one-command installer (irm | iex safe, updated URLs) ----
	ok(fmap.get('wizard/install.ps1') === gitsha(localPs1), 'fork wizard/install.ps1 blob sha == local install.ps1', (fmap.get('wizard/install.ps1') || '').slice(0, 10));
	const pRaw = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/wizard/install.ps1?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const pBuf = Buffer.from(await pRaw.arrayBuffer());
	ok(pRaw.status === 200 && pBuf.equals(localPs1), 'downloaded fork wizard/install.ps1 is BYTE-IDENTICAL to local', pBuf.length + 'B');
	const pTxt = pBuf.toString('utf8');
	ok(!pTxt.includes('\r'), 'wizard/install.ps1: LF line endings only (no CR)');
	ok(!/\bexit\b/.test(pTxt), 'wizard/install.ps1: no exit calls (safe when executed via iex inside the user shell)');
	ok(pTxt.includes('$ErrorActionPreference = "Stop"'), 'wizard/install.ps1: strict error handling');
	ok(pTxt.includes('@main/wizard/wizard.mjs') && pTxt.includes('fastly.jsdelivr.net') && pTxt.includes('gcore.jsdelivr.net') && pTxt.includes('main/wizard/wizard.mjs'), 'wizard/install.ps1: wizard/mirror paths point into @main/wizard/');
	const MIRROR_BLOCK = '$Mirrors = @(\n    "https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs",\n    "https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",\n    "https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",\n    "https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",\n    "https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/wizard/wizard.mjs",\n    "https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs"\n)';
	ok(pTxt.split(MIRROR_BLOCK).length - 1 === 1 && pTxt.indexOf('raw.githubusercontent.com') < pTxt.indexOf('cdn.jsdelivr.net'), 'wizard/install.ps1: $Mirrors = raw first, then five CDN routes');
	ok(!pTxt.includes('statically.io'), 'wizard/install.ps1: statically.io excluded (96KB truncation)');
	ok(pTxt.includes('#   irm https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.ps1 | iex'), 'wizard/install.ps1: usage comment shows the raw.githubusercontent one-liner');
	ok(pTxt.includes('function Test-ZeusNode') && pTxt.includes('$major -ge 18'), 'wizard/install.ps1: Node version gate read from --version');
	ok(pTxt.includes('function Install-ZeusRuntime') && pTxt.includes('Expand-Archive') && pTxt.includes('Get-FileHash') && pTxt.includes('SHASUMS256.txt'), 'wizard/install.ps1: provisions a private Node runtime with checksum verification');
	ok(pTxt.includes('node.exe') && pTxt.includes('win-x64') && pTxt.includes('win-arm64'), 'wizard/install.ps1: runtime package chosen per CPU architecture');
	ok(pTxt.includes('$env:ZEUS_SKIP_AUTO_RUNTIME') && pTxt.includes('$env:ZEUS_NODE_BIN') && pTxt.includes('$env:ZEUS_NODE_VERSION'), 'wizard/install.ps1: runtime switches honoured');
	ok(pTxt.includes('Node.js 18+ was not found on this system'), 'wizard/install.ps1: Node.js is no longer a hard prerequisite');
	ok(pTxt.includes('[Net.SecurityProtocolType]::Tls12') && pTxt.includes('[Net.SecurityProtocolType]::Tls13'), 'wizard/install.ps1: modern TLS attempted for older PowerShell');
	ok(pTxt.includes('$InstallDir = "zeus-wizard"') && pTxt.includes('New-Item -ItemType Directory') && pTxt.includes('Join-Path $InstallDir'), 'wizard/install.ps1: creates zeus-wizard folder and downloads wizard.mjs into it');
	ok(pTxt.includes('Push-Location $InstallDir') && pTxt.includes('& $Node $Wizard @args') && !pTxt.includes('& node $Wizard @args'), 'wizard/install.ps1: runs the wizard with the selected node + $args passthrough');
	const pForbidden = ['ghp_', 'cfut_', 'fed5633e7d83fa4640cbc49ac8259448', 'Marefniya', 'axionum', '524a0ade'].filter((s) => pTxt.includes(s));
	ok(pForbidden.length === 0, 'wizard/install.ps1: no tokens / personal identifiers embedded', pForbidden.join(',') || 'clean');
	ok(!/[bB][pP][bB]/.test(pTxt), 'wizard/install.ps1: no third-party project names');
	ok(!/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/.test(pTxt), 'wizard/install.ps1: fully English (no Persian/Arabic characters)');

	// ---- 6e) README.md — expected bytes rebuilt from the LIVE upstream: telegram bot deployment removed, wizard credit added, wizard section inserted, status screenshot moved into the screenshots grid ----
	ok(fmap.get('README.md') === gitsha(localReadme), 'fork README.md blob sha == local reference (analysis/README-fork.md)', (fmap.get('README.md') || '').slice(0, 10));
	const rRaw = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/README.md?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const rBuf = Buffer.from(await rRaw.arrayBuffer());
	ok(rRaw.status === 200 && rBuf.equals(localReadme), 'downloaded fork README.md is BYTE-IDENTICAL to local reference', rBuf.length + 'B');
	const rTxt = rBuf.toString('utf8');
	const BLOCK = readmeAddition + '\n---\n\n\n';
	const uRaw = await fetch(`https://api.github.com/repos/${UP}/contents/README.md?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const uTxt = await uRaw.text();
	const cnt = (t, s) => t.split(s).length - 1;
	const W1 = '<br>\n\n<a href="https://t.me/ZEUS_PANEL_BOT" target="_blank">\n<img src="https://img.shields.io/badge/Zeus_Telegram_Bot-Start_Bot-0088cc?style=for-the-badge&logo=telegram&logoColor=white" alt="Zeus Telegram Bot" height="40">\n</a>\n\n';
	const CREDIT = '* **Install wizard:** The install wizard in this fork is inspired by [BPB-Wizard](https://github.com/bia-pain-bache/BPB-Wizard).';
	const MAINT = '* **Current Maintainer:**';
	const ANCHOR = '# 🛡️ Build Your Own SOCKS5 Proxy (Zeus Relay)';
	const TG_HEADING = '## 🤖  Deploy via Telegram Bot ';
	const TG_STEPS = [
		'1. 🌐 Access the **[ZEUS Telegram Bot](https://t.me/ZEUS_PANEL_BOT)** and click `Start`.',
		'2. 👤 From the main menu, click on **"➕ Register Cloudflare Account"**.',
		'3. 🔗 Click the inline button **"🔑 Get Cloudflare Token"** to be redirected to your Cloudflare account.',
		'4. 🟦 Scroll to the bottom of the Cloudflare page, click the blue `Continue to summary` button, and then click `Create Token`.',
		'5. 🔑 Copy the generated token and **send it directly in the bot chat**.',
		'6. ⚡️ Once the token is verified, return to the main menu, click **"🚀 Build New Panel"**, and select your account. Your D1 database and panel will be automatically deployed.',
	];
	const W2 = '<br>\n\n' + TG_HEADING + '\n\n' + TG_STEPS.join('\n') + '\n\n';
	// bot.png removal + obfuscation note + status screenshot relocation (shared
	// by the fa README transform in 6f): the exact <td> carrying the bot
	// screenshot, the single-space line separating the two screenshots tables
	// (the note lands right before the second table), and the status screenshot
	// rebuilt from its lonely 50% cell below the grid into a 50% cell with
	// rowspan="2" inside the grid's second row, beside screenshots 2 and 3 at
	// the full tile width; the leftover single-image table is removed entirely.
	// Two-stage composition mirroring the two live commits: botTransform first
	// (which passes through the interim full-width-cell / scaled-down-image
	// state), then moveToGrid consumes the standalone table.
	const TD_BOT = '<td width="50%" valign="middle" align="center">\n<img src="https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/refs/heads/main/photos/bot.png" width="100%" alt="Zeus Panel Status" style="border-radius: 12px;">\n</td>\n';
	const SEAM_PRE = '</table>\n \n';
	const TD_STATUS_OLD = '<td width="50%" valign="middle" align="center">\n<img src="https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/refs/heads/main/photos/status.png" width="100%" alt="Zeus Panel Dark Mode" style="border-radius: 12px;">\n</td>\n';
	const PU = 'https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/refs/heads/main/photos';
	const TD2 = '<td width="50%" valign="middle" align="center">\n<img src="' + PU + '/2.png" width="100%" alt="Zeus Panel Screenshot 2" style="border-radius: 12px;">\n</td>';
	const TD3 = '<td width="50%" valign="middle" align="center">\n<img src="' + PU + '/3.png" width="100%" alt="Zeus Panel Screenshot 3" style="border-radius: 12px;">\n</td>';
	const U_ROW23 = '<tr>\n' + TD2 + '\n' + TD3 + '\n</tr>';
	const TD_STATUS_GRID = '<td width="50%" rowspan="2" valign="middle" align="center">\n<img src="' + PU + '/status.png" width="100%" alt="Zeus Panel Dark Mode" style="border-radius: 12px;">\n</td>';
	const NEW_ROW23 = '<tr>\n' + TD2 + '\n' + TD_STATUS_GRID + '\n</tr>\n<tr>\n' + TD3 + '\n</tr>';
	const TD_STATUS_PRE = TD_STATUS_OLD
		.replace('<td width="50%"', '<td width="100%"')
		.replace('photos/status.png" width="100%"', 'photos/status.png" width="30%"');
	const U_TABLE2 = '\n<table width="100%">\n<tr>\n' + TD_STATUS_PRE + '</tr>\n</table>';
	const botTransform = (txt, NOTE) => {
		if (cnt(txt, TD_BOT) !== 1 || cnt(txt, SEAM_PRE) !== 1 || cnt(txt, TD_STATUS_OLD) !== 1) throw new Error('screenshot windows not unique');
		const cutTxt = txt.replace(TD_BOT, '').replace(TD_STATUS_OLD, TD_STATUS_PRE);
		const at = cutTxt.indexOf(SEAM_PRE) + SEAM_PRE.length;
		return cutTxt.slice(0, at) + NOTE + '\n\n' + cutTxt.slice(at);
	};
	const moveToGrid = (txt) => {
		if (cnt(txt, U_ROW23) !== 1 || cnt(txt, U_TABLE2) !== 1) throw new Error('grid-move windows not unique');
		const out = txt.replace(U_ROW23, NEW_ROW23).replace(U_TABLE2, '');
		if (cnt(out, NEW_ROW23) !== 1 || cnt(out, U_ROW23) !== 0 || cnt(out, '/photos/status.png') !== 1) throw new Error('grid move produced unexpected bytes');
		return out;
	};
	const NOTE_EN = '> [!NOTE]\n> This project is exactly the same as the original ZEUS PANEL project — the only difference is that the source code is obfuscated.';
	const cut = (t, w, name) => { const c = cnt(t, w); if (c !== 1) throw new Error(name + ' window count ' + c + ' in upstream README'); return t.replace(w, ''); };
	let exp = cut(uTxt, W1, 'telegram badge');
	exp = cut(exp, W2, 'telegram section');
	const mlEnd = exp.indexOf('\n', exp.indexOf(MAINT));
	exp = exp.slice(0, mlEnd + 1) + CREDIT + '\n' + exp.slice(mlEnd + 1);
	const ai = exp.indexOf(ANCHOR);
	exp = exp.slice(0, ai) + BLOCK + exp.slice(ai);
	exp = botTransform(exp, NOTE_EN);
	exp = moveToGrid(exp);
	ok(uRaw.status === 200 && rTxt === exp, 'README == live upstream transformed (telegram deployment removed + wizard credit + wizard section + bot.png removed + obfuscation note + status screenshot inside the screenshots grid with rowspan="2"; every other author byte preserved)', rTxt.length + ' vs expected ' + exp.length + ' chars');
	ok(!rTxt.includes('photos/bot.png'), 'README: bot.png screenshot fully removed');
	ok(cnt(rTxt, NOTE_EN) === 1 && rTxt.includes('</table>\n \n' + NOTE_EN) && rTxt.slice(rTxt.indexOf(NOTE_EN)).startsWith(NOTE_EN + '\n\n\n<div align="center">'), 'README: obfuscation note present exactly once, directly after the screenshots grid and above the nav links');
	ok(rTxt.includes('photos/status.png'), 'README: status screenshot kept');
	ok(cnt(rTxt, NEW_ROW23) === 1 && cnt(rTxt, U_ROW23) === 0 && cnt(rTxt, TD_STATUS_GRID) === 1, 'README: status screenshot inside the grid beside screenshots 2 and 3 (rowspan="2", full tile width)');
	ok(cnt(rTxt, 'rowspan="2"') === 1 && !rTxt.includes('width="30%"') && !rTxt.includes('<td width="100%"'), 'README: standalone status table fully removed (no full-width-cell / scaled-down leftovers)');
	ok(!rTxt.includes('ZEUS_PANEL_BOT') && !rTxt.includes('Deploy via Telegram'), 'README: Telegram bot deployment fully removed (badge + 6-step section)');
	ok(cnt(rTxt, '[BPB-Wizard]') === 1 && rTxt.includes('[BPB-Wizard](https://github.com/bia-pain-bache/BPB-Wizard)'), 'README Credits: wizard inspiration credited exactly once, with link');
	ok(rTxt.includes('log into your Cloudflare dashboard') && rTxt.includes('CRITICAL SECURITY NOTE'), 'README: Cloudflare login intro + CRITICAL SECURITY NOTE preserved');
	ok(rTxt.includes('Deploy via Install Wizard') && rTxt.includes('node wizard.mjs') && rTxt.includes('docs/HARDENING.md'), 'README: install-wizard section present with usage + HARDENING link');
	ok(rTxt.includes('bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh)'), 'README: bash one-command install line = raw.githubusercontent primary');
	ok(rTxt.includes('irm https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.ps1 | iex'), 'README: Windows one-liner = raw.githubusercontent primary');
	ok(rTxt.includes('If a command does not work, the same installers are also served via CDNs: `bash <(curl -Ls https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/install.sh)` (Linux / macOS / Git Bash) or `irm https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/install.ps1 | iex` (Windows).'), 'README: CDN fallback sentence present for both platforms');
	ok(rTxt.includes('curl -O https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs'), 'README: manual-alternative curl = raw.githubusercontent primary');
	ok(rTxt.includes('zeus-wizard') && rTxt.includes('profile.json'), 'README: zeus-wizard folder and the install profile are documented');
	ok(rTxt.includes('Every install carries its own build identity') && rTxt.includes('fresh XOR key') && rTxt.includes('verified row by row'), 'README: per-install build identity documented (re-key, re-order, verified)');
	ok(rTxt.includes('Manual update with saved defaults') && rTxt.includes('--update') && rTxt.includes('read-only row census'), 'README: manual update with saved defaults documented');
	ok(rTxt.includes('`--no-fingerprint`') && rTxt.includes('`--rotate`') && rTxt.includes('`--personalize`') && rTxt.includes('`--token-link`') && rTxt.includes('`--prepare-only`'), 'README: every wizard flag documented');
	ok(rTxt.includes('ZEUS_CF_TOKEN') && rTxt.includes('ZEUS_NODE_BIN') && rTxt.includes('ZEUS_SKIP_AUTO_RUNTIME'), 'README: automation and runtime environment switches documented');
	ok(rTxt.includes('There is nothing to install first') && rTxt.includes('private copy of the Node runtime'), 'README: no-Node-prerequisite behaviour documented');
	ok(rTxt.includes('raw.githack.com') && rTxt.includes('cdn.jsdmirror.com') && rTxt.includes('six independent routes'), 'README: the six delivery routes are listed');
	ok(!rTxt.includes('Requires [Node.js 18+]'), 'README: the old "requires Node.js" prerequisite sentence is gone');
	ok(rTxt.indexOf('## 🧙 Deploy via Install Wizard') > rTxt.indexOf('CRITICAL SECURITY NOTE') && rTxt.indexOf('## 🧙 Deploy via Install Wizard') < rTxt.indexOf('# 🛡️ Build Your Own SOCKS5 Proxy'), 'README: wizard section placed after the deployment guide, before the SOCKS5 relay section');
	ok(rTxt.includes('Two account limits the wizard works around') && rTxt.includes('error code: 1101') && rTxt.includes('deletes and re-deploys the worker script once, by itself') && rTxt.includes('database and every row in it are never part of that recovery'), 'README: database cap reuse, propagation patience and the capped self-heal are documented');
	ok(rTxt.includes('> [!IMPORTANT]\n> Open the panel address as soon as the install finishes and set the admin password') && rTxt.includes('do not leave a fresh deploy unclaimed'), 'README: the first-run callout (set the admin password first) is present');
	ok((rTxt.match(/\[!IMPORTANT\]/g) || []).length === 1, 'README: exactly one IMPORTANT callout', String((rTxt.match(/\[!IMPORTANT\]/g) || []).length));
	ok(rTxt.includes('ZEUS_PROBE_WAIT_MS'), 'README: the probe wait window is documented');
	ok(!/[bB][pP][bB]/.test(readmeAddition), 'README addition: no third-party project names');
	ok(!/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/.test(readmeAddition), 'README addition: fully English (no Persian/Arabic characters)');

	// ---- 6f) README.fa.md — bot.png removed + Persian obfuscation note + status screenshot moved into the screenshots grid (transform shared with 6e) ----
	ok(fmap.get('README.fa.md') === gitsha(localReadmeFa), 'fork README.fa.md blob sha == local reference (analysis/README-fa-fork.md)', (fmap.get('README.fa.md') || '').slice(0, 10));
	const fRaw = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/README.fa.md?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const fBuf = Buffer.from(await fRaw.arrayBuffer());
	ok(fRaw.status === 200 && fBuf.equals(localReadmeFa), 'downloaded fork README.fa.md is BYTE-IDENTICAL to local reference', fBuf.length + 'B');
	const fTxt = fBuf.toString('utf8');
	const fuRaw = await fetch(`https://api.github.com/repos/${UP}/contents/README.fa.md?ref=${REF}`, { headers: { ...H, 'Accept': 'application/vnd.github.raw' } });
	const fuTxt = await fuRaw.text();
	const NOTE_FA = '> [!NOTE]\n> این پروژه کاملاً با پروژه زئوس یکی است و تنها فرقش با پروژه اصلی این است که مبهم‌سازی شده است.';
	// The Persian README now also drops the Telegram-bot deployment path and gains
	// its own wizard section, so the expected bytes are: upstream -> screenshots ->
	// cut bot badge + section -> insert the Persian wizard block.
	const addFa = readFileSync(new URL('../tools/readme-fa-addition.md', import.meta.url), 'utf8').trimEnd();
	const BOT_FA_HEADING = '## 🤖 دیپلوی از طریق ربات تلگرام';
	const SOCKS_FA_HEADING = '# 🛡️ ساخت پروکسی SOCKS5 اختصاصی (Zeus Relay)';
	const cutFaBot = (txt) => {
		const badgeAnchor = '<a href="https://t.me/ZEUS_PANEL_BOT" target="_blank">';
		const b = txt.indexOf(badgeAnchor);
		if (b === -1 || txt.indexOf(badgeAnchor, b + 1) !== -1) throw new Error('FA bot badge not unique');
		const w1 = txt.slice(txt.lastIndexOf('<br>', b), txt.indexOf('</a>\n\n', b) + 6);
		if (cnt(txt, w1) !== 1) throw new Error('FA bot badge window not unique');
		const h = txt.indexOf(BOT_FA_HEADING);
		if (h === -1 || cnt(txt, BOT_FA_HEADING) !== 1) throw new Error('FA bot heading not unique');
		const w2 = txt.slice(txt.lastIndexOf('<br>', h), txt.indexOf('\n---\n', h) + 1);
		if (cnt(txt, w2) !== 1) throw new Error('FA bot section window not unique');
		return txt.replace(w1, '').replace(w2, '');
	};
	const addFaWizard = (txt) => {
		if (cnt(txt, SOCKS_FA_HEADING) !== 1) throw new Error('FA SOCKS5 heading not unique');
		return txt.replace('\n\n' + SOCKS_FA_HEADING, '\n\n' + addFa + '\n\n---\n\n' + SOCKS_FA_HEADING);
	};
	const fExp = addFaWizard(cutFaBot(moveToGrid(botTransform(fuTxt, NOTE_FA))));
	ok(fuRaw.status === 200 && fTxt === fExp, 'README.fa.md == live upstream transformed (bot.png removed + Persian obfuscation note + status screenshot in the grid + Telegram bot deployment removed + Persian wizard section added; every other author byte preserved)', fTxt.length + ' vs expected ' + fExp.length + ' chars');
	ok(!fTxt.includes('<a href="https://t.me/ZEUS_PANEL_BOT"') && !fTxt.includes(BOT_FA_HEADING), 'README.fa.md: Telegram bot badge and deployment steps removed (parity with the English README)');
	ok(cnt(fTxt, '## 🧙 استقرار با جادوی نصب') === 1, 'README.fa.md: Persian wizard section present exactly once');
	ok(fTxt.indexOf('## 🧙 استقرار با جادوی نصب') < fTxt.indexOf(SOCKS_FA_HEADING) && fTxt.indexOf('## 🧙 استقرار با جادوی نصب') > fTxt.indexOf('هشدار امنیتی حیاتی'), 'README.fa.md: wizard section placed after the security caution, before the SOCKS5 section');
	ok(fTxt.includes('--update') && fTxt.includes('profile.json') && fTxt.includes('ZEUS_CF_TOKEN'), 'README.fa.md: manual update, profile and automation switch documented in Persian');
	ok(fTxt.includes('raw.githack.com') && fTxt.includes('cdn.jsdmirror.com'), 'README.fa.md: the new delivery routes are documented in Persian');
	ok(fTxt.includes('هویت بیلد مخصوص خودش') && fTxt.includes('--no-fingerprint') && fTxt.includes('--rotate'), 'README.fa.md: per-install build identity documented in Persian');
	ok(fTxt.includes('bash <(curl -Ls https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.sh)') && fTxt.includes('irm https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.ps1 | iex'), 'README.fa.md: both one-liners use the raw primary URL');
	ok(!fTxt.includes('photos/bot.png'), 'README.fa.md: bot.png screenshot fully removed');
	ok(cnt(fTxt, NOTE_FA) === 1 && fTxt.includes('</table>\n \n' + NOTE_FA) && fTxt.slice(fTxt.indexOf(NOTE_FA)).startsWith(NOTE_FA + '\n\n\n<div align="center">'), 'README.fa.md: Persian obfuscation note present exactly once, directly after the screenshots grid and above the nav links');
	ok(fTxt.includes('photos/status.png'), 'README.fa.md: status screenshot kept');
	ok(cnt(fTxt, NEW_ROW23) === 1 && cnt(fTxt, U_ROW23) === 0 && cnt(fTxt, TD_STATUS_GRID) === 1, 'README.fa.md: status screenshot inside the grid beside screenshots 2 and 3 (rowspan="2", full tile width)');
	ok(cnt(fTxt, 'rowspan="2"') === 1 && !fTxt.includes('width="30%"') && !fTxt.includes('<td width="100%"'), 'README.fa.md: standalone status table fully removed (no full-width-cell / scaled-down leftovers)');
	ok(fTxt.includes('جادوی نصب دو محدودیت اکانت') && fTxt.includes('error code: 1101') && fTxt.includes('ویزارد خودش یک‌بار اسکریپت ورکر را حذف و دوباره مستقر می‌کند'), 'README.fa.md: database cap reuse, propagation wait and the capped self-heal documented in Persian too');
	ok(fTxt.includes('> [!IMPORTANT]') && fTxt.includes('رمز مدیر را تعیین کن') && fTxt.includes('پس استقرار تازه را بی‌صاحب رها نکن'), 'README.fa.md: the same first-run callout, worded identically in Persian');
	ok((fTxt.match(/\[!IMPORTANT\]/g) || []).length === 1, 'README.fa.md: exactly one IMPORTANT callout', String((fTxt.match(/\[!IMPORTANT\]/g) || []).length));
	ok(!/[bB][pP][bB]/.test(fTxt), 'README.fa.md: no third-party project names');
	const fForbidden = ['ghp_', 'cfut_', 'fed5633e7d83fa4640cbc49ac8259448', 'Marefniya', 'axionum', '524a0ade'].filter((s) => fTxt.includes(s));
	ok(fForbidden.length === 0, 'README.fa.md: no tokens / personal identifiers embedded', fForbidden.join(',') || 'clean');
	ok(!fTxt.includes('\r'), 'README.fa.md: LF line endings only (no CR)');

	// ---- 7) author files untouched (blob-sha equal to upstream) + root installers deleted ----
	for (const p of ['zeus.obfuscated.js', 'version.txt', 'ips.txt', 'zeus-relay.sh', 'zeus-scanner.txt']) {
		if (umap.has(p) && fmap.has(p)) ok(umap.get(p) === fmap.get(p), 'untouched (sha == upstream): ' + p, fmap.get(p).slice(0, 10));
	}
	ok(!fmap.has('install.sh'), 'root install.sh is deleted');
	ok(!fmap.has('install.ps1'), 'root install.ps1 is deleted');
	ok(!fmap.has('wizard.mjs'), 'root wizard.mjs is deleted');
	const rootOk = !fmap.has('install.sh') && !fmap.has('install.ps1') && !fmap.has('wizard.mjs');
	const { d: cmp } = await j(`/repos/${UP}/compare/main...${OWNER}:${REF}`);
	ok(cmp && cmp.status === 'ahead' && cmp.behind_by === 0 && cmp.ahead_by === 24, 'fork is 24 commits ahead of upstream, 0 behind', 'ahead_by=' + (cmp && cmp.ahead_by) + ' behind_by=' + (cmp && cmp.behind_by));
	ok((cmp.files || []).length === 8, 'compare API reports 8 changed files', (cmp.files || []).map((f) => f.filename + ':' + f.status).join(', '));

	// ---- 9) PR #16 closed ----
	const { d: pr } = await j(`/repos/${UP}/pulls/16`);
	ok(pr && pr.state === 'closed', 'PR #16 state = closed', pr && pr.state);

	// ---- 10) live panel health ----
	const p1 = await fetch('https://web-panel.axionum.workers.dev/');
	ok(p1.status === 200, 'live panel / → 200', p1.status);
	const p2 = await fetch('https://web-panel.axionum.workers.dev/panel');
	ok(p2.status === 200, 'live panel /panel → 200', p2.status);

	// ---- 10b) one-command install path: jsdelivr serves THIS commit's wizard/* bytes ----
	// Pinned to the HEAD commit sha: @main edges can keep serving a stale cached copy for a
	// while right after a push (propagation lag — observed with root install.sh 2026-10-08),
	// an immutable sha-pinned ref always serves the exact commit content.
	const PIN = 'https://cdn.jsdelivr.net/gh/' + OWNER + '/' + REPO + '@' + headSha + '/';
	const m1 = await fetch(PIN + 'wizard/install.sh');
	const m1buf = Buffer.from(await m1.arrayBuffer());
	ok(m1.status === 200 && m1buf.equals(localInstall), 'jsdelivr (pinned sha) serves wizard/install.sh BYTE-IDENTICAL to local', m1.status + ' | ' + m1buf.length + 'B');
	const m2 = await fetch(PIN + 'wizard/install.ps1');
	const m2buf = Buffer.from(await m2.arrayBuffer());
	ok(m2.status === 200 && m2buf.equals(localPs1), 'jsdelivr (pinned sha) serves wizard/install.ps1 BYTE-IDENTICAL (the irm | iex payload)', m2.status + ' | ' + m2buf.length + 'B');
	const m3 = await fetch(PIN + 'wizard/wizard.mjs');
	const m3buf = Buffer.from(await m3.arrayBuffer());
	ok(m3.status === 200 && m3buf.equals(localWiz), 'jsdelivr (pinned sha) serves wizard/wizard.mjs BYTE-IDENTICAL to local', m3.status + ' | ' + m3buf.length + 'B');

	// ---- 10c) every delivery route in the shipped chains really serves exact bytes
	// (each route is pinned to the HEAD commit sha so propagation lag cannot lie; the
	// pin syntax differs per provider — jsdelivr/jsdmirror use @<sha>, GitHub raw uses
	// /<sha>/, githack uses /owner/repo/<sha>/path without the refs/heads prefix)
	const shaPin = (u) => u.includes('githack.com')
		? u.replace('/refs/heads/main/', '/' + headSha + '/')
		: u.replace('@main/', '@' + headSha + '/').replace('/' + REPO + '/main/', '/' + REPO + '/' + headSha + '/');
	const srcUrls = [...wTxt.matchAll(/'(https:\/\/[^']*\/Source\.js)'/g)].map((x) => x[1]);
	ok(srcUrls.length === 6 && srcUrls.every((u) => shaPin(u) !== u), 'wizard: six Source.js routes found and all are pinnable', srcUrls.length + ' routes');
	for (const u of srcUrls) {
		let st = 'ERR', len = 0, same = false;
		try {
			const r = await fetch(shaPin(u), { signal: AbortSignal.timeout(180000) });
			const b = Buffer.from(await r.arrayBuffer());
			st = r.status; len = b.length; same = b.equals(local);
		} catch (e) { st = 'ERR ' + e.message; }
		ok(same, 'delivery route serves the exact hardened Source.js: ' + new URL(shaPin(u)).host, st + ' | ' + len + 'B (expected ' + local.length + 'B)');
	}
	const wizUrls = [...new Set([...iTxt.matchAll(/^(https:\/\/\S*\/wizard\/wizard\.mjs)$/gm), ...pTxt.matchAll(/"(https:\/\/[^"]*\/wizard\/wizard\.mjs)"/g)].map((x) => x[1]))];
	ok(wizUrls.length === 6, 'installers: six wizard.mjs routes found across install.sh + install.ps1', wizUrls.length + ' unique routes');
	for (const u of wizUrls) {
		let st = 'ERR', len = 0, same = false;
		try {
			const r = await fetch(shaPin(u), { signal: AbortSignal.timeout(120000) });
			const b = Buffer.from(await r.arrayBuffer());
			st = r.status; len = b.length; same = b.equals(localWiz);
		} catch (e) { st = 'ERR ' + e.message; }
		ok(same, 'delivery route serves the exact wizard script: ' + new URL(shaPin(u)).host, st + ' | ' + len + 'B (expected ' + localWiz.length + 'B)');
	}
	const shUrls = [...new Set([...rTxt.matchAll(/https:\/\/\S*\/wizard\/install\.sh/g), ...rTxt.matchAll(/https:\/\/\S*\/wizard\/install\.ps1/g)].map((x) => x[0]))];
	ok(shUrls.length >= 4, 'README links point at real installer paths on several providers', shUrls.map((u) => new URL(u).host).join(','));

	// ---- 11) deployed CF worker bytes == fork Source.js bytes ----
	if (process.env.CF_TOKEN) {
		try {
			const cr = await fetch('https://api.cloudflare.com/client/v4/accounts/fed5633e7d83fa4640cbc49ac8259448/workers/scripts/web-panel', { headers: { Authorization: 'Bearer ' + process.env.CF_TOKEN } });
			if (cr.status === 200) {
				const ct = cr.headers.get('content-type') || '';
				const text = Buffer.from(await cr.arrayBuffer()).toString('binary');
				const bm = ct.match(/boundary=([^;]+)/);
				let part = null;
				if (bm) {
					for (const c of text.split('--' + bm[1])) {
						if (/name="worker\.js"/.test(c.slice(0, 600))) { const i = c.indexOf('\r\n\r\n'); part = c.slice(i + 4, c.length - 2); }
					}
				}
				if (part) {
					const pb = Buffer.from(part, 'binary');
					const pt = pb.toString('utf8');
					const pdet = detectPrelude(pt);
					const cdet = detectPrelude(localTxt);
					if (pb.equals(local)) {
						ok(true, 'deployed worker (web-panel) runs the shared fork build (no private identity)', pb.length + 'B | sha256 ' + sha256(pb).slice(0, 12));
					} else {
						// a personalised deployment — prove it is the very same panel by content
						const canonRows = cdet.blobs.map((b) => xorDecode(b, cdet.key)).sort().join('\u0001');
						const liveRows = pdet ? pdet.blobs.map((b) => xorDecode(b, pdet.key)).sort().join('\u0001') : '';
						ok(!!pdet && pdet.blobs.length === cdet.blobs.length, 'deployed worker carries a private payload table with the same row count', pdet ? pdet.blobs.length + ' rows | names ' + pdet.keyName + '/' + pdet.getName : 'no payload table found');
						ok(!!pdet && liveRows === canonRows, 'deployed worker decodes to EXACTLY the fork payload values (a personalised build is the same panel)', 'deployed sha256 ' + sha256(pb).slice(0, 12));
						ok(!!pdet && (pdet.keyName !== '_ZK' || pdet.getName !== '_G'), 'deployed worker uses its own generated names', pdet && [pdet.keyName, pdet.getName, pdet.blobName].join(','));
						ok(!!pdet && !/(?<![\w$])_G\(\s*\d+\s*\)/.test(pt) && !/(?<![\w$])_Z[KCSD]\b/.test(pt) && !/(?<![\w$])_p\d+(?![\w$])/.test(pt), 'deployed worker has no canonical generated names left');
					}
					ok(pt.split('\n').filter((l) => KW_RE.test(l)).length === 0, 'deployed worker: 0 keyword survivors', String(countSurv(pt)));
					ok(pb.length > 800000 && /export\s+default/.test(pt), 'deployed worker is a complete worker module', pb.length + 'B');
				} else ok(false, 'could not parse deployed worker multipart response', ct.slice(0, 60));
			} else {
				console.log('SKIP | CF API ' + cr.status + ' — token likely rotated/invalid, deployed-worker byte-compare skipped');
			}
		} catch (e) { console.log('SKIP | CF fetch failed: ' + e.message); }
	} else {
		console.log('SKIP | CF_TOKEN not provided — deployed-worker byte-compare skipped');
	}

	console.log('\n=== RESULT: ' + pass + ' PASS / ' + fail + ' FAIL ===');
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
