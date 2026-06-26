// Auto-updates the RESULTS array in index.html with newly-finished World Cup 2026
// group-stage matches. Deterministic, no LLM. Run by .github/workflows/update-results.yml.
//
// Sources (free, no key):
//   PRIMARY  live:  https://worldcup26.ir/get/games
//   FALLBACK fixed: https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
//
// It touches the RESULTS + KO_RESULTS data arrays + the "Last updated" line — never the
// rendering logic. Group matches go into RESULTS (append-only, as before). Knockout matches
// are rebuilt into KO_RESULTS (tagged by stage) as soon as the feed names their participants.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'index.html');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ---------- read + parse the page's own data ---------- */
let html = fs.readFileSync(FILE, 'utf8');

function sliceBalanced(src, marker, open, close) {
  const i = src.indexOf(marker);
  if (i === -1) throw new Error(`marker not found: ${marker}`);
  const start = src.indexOf(open, i);
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (depth === 0) { j++; break; } }
  }
  return { literal: src.slice(start, j), start, end: j };
}

const GROUPS = (0, eval)('(' + sliceBalanced(html, 'const GROUPS', '{', '}').literal + ')');
const resBlock = sliceBalanced(html, 'const RESULTS', '[', ']');
const RESULTS = (0, eval)('(' + resBlock.literal + ')');
const koBlock = sliceBalanced(html, 'const KO_RESULTS', '[', ']');
const KO_EXISTING = (0, eval)('(' + koBlock.literal + ')');

// canonical names + group-letter lookup, derived from the page so they stay in sync
const groupOf = {};
for (const [g, teams] of Object.entries(GROUPS)) for (const t of teams) groupOf[t] = g;
const canonical = Object.keys(groupOf);

/* ---------- team-name normalisation ---------- */
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&amp;/g, '&').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ALIASES = {
  'ivory coast': "Côte d'Ivoire", 'cote d ivoire': "Côte d'Ivoire",
  'united states': 'USA', 'united states of america': 'USA', 'usa': 'USA',
  'czech republic': 'Czechia', 'czechia': 'Czechia',
  'turkiye': 'Turkey', 'turkey': 'Turkey',
  'korea republic': 'South Korea', 'republic of korea': 'South Korea', 'south korea': 'South Korea',
  'cabo verde': 'Cape Verde', 'cape verde': 'Cape Verde',
  'ir iran': 'Iran', 'iran': 'Iran',
  'bosnia and herzegovina': 'Bosnia &amp; Herzegovina', 'bosnia herzegovina': 'Bosnia &amp; Herzegovina',
};
const normToCanon = {};
for (const c of canonical) normToCanon[norm(c)] = c;
const toCanon = name => {
  const n = norm(name);
  if (n in ALIASES) return ALIASES[n];
  return normToCanon[n] || null;
};

const isKnockout = t => /(round|knock|final|quarter|semi|last\s*16|r16|r32)/i.test(String(t || ''));
const dnum = d => { const [mo, da] = d.split(' '); return MON.indexOf(mo) * 100 + parseInt(da); };

/* ---------- fetch sources ---------- */
async function getLive() {
  const r = await fetch('https://worldcup26.ir/get/games', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('live ' + r.status);
  const data = await r.json();
  const out = [];
  for (const g of (data.games || data)) {
    if (String(g.finished).toUpperCase() !== 'TRUE') continue;
    if (isKnockout(g.type)) continue;
    const home = toCanon(g.home_team_name_en), away = toCanon(g.away_team_name_en);
    if (!home || !away) continue;
    const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(g.local_date || '');
    if (!m) continue;
    out.push({ home, away, hs: +g.home_score, as: +g.away_score, date: `${MON[+m[1] - 1]} ${+m[2]}` });
  }
  return out;
}

async function getOpen() {
  const r = await fetch('https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json');
  if (!r.ok) throw new Error('openfootball ' + r.status);
  const d = await r.json();
  const out = [];
  for (const m of (d.matches || [])) {
    if (!m.score || !Array.isArray(m.score.ft)) continue;
    if (isKnockout(m.round)) continue;
    const home = toCanon(m.team1), away = toCanon(m.team2);
    if (!home || !away) continue;
    const mm = /(\d{4})-(\d{2})-(\d{2})/.exec(m.date);
    if (!mm) continue;
    out.push({ home, away, hs: m.score.ft[0], as: m.score.ft[1], date: `${MON[+mm[2] - 1]} ${+mm[3]}` });
  }
  return out;
}

/* ---------- knockout sources ---------- */
// Stage codes shared with the page: R32, R16, QF, SF, 3P (third-place), F (final).
const STAGE_LIVE = { r32:'R32', r16:'R16', qf:'QF', sf:'SF', final:'F', third:'3P' };
const STAGE_OPEN = {
  'round of 32':'R32', 'round of 16':'R16',
  'quarter-final':'QF', 'quarter-finals':'QF', 'quarterfinal':'QF',
  'semi-final':'SF', 'semi-finals':'SF', 'semifinal':'SF',
  'final':'F', 'match for third place':'3P', 'third place play-off':'3P',
};
const STAGE_ORDER = ['R32', 'R16', 'QF', 'SF', '3P', 'F'];

// Knockout matches whose participants the feed has named (played or upcoming). done:false
// means fixtured-but-not-played, so its 0-0 score must be ignored by consumers.
async function getLiveKO() {
  const r = await fetch('https://worldcup26.ir/get/games', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('live ' + r.status);
  const data = await r.json();
  const out = [];
  for (const g of (data.games || data)) {
    const stage = STAGE_LIVE[String(g.type || '').toLowerCase()];
    if (!stage) continue;
    const home = toCanon(g.home_team_name_en), away = toCanon(g.away_team_name_en);
    if (!home || !away) continue;
    const done = String(g.finished).toUpperCase() === 'TRUE';
    const hs = done ? +g.home_score : 0, as = done ? +g.away_score : 0;
    const win = done ? (hs > as ? home : as > hs ? away : null) : null;  // live feed carries no shootout data
    out.push({ stage, home, away, hs, as, done, win });
  }
  return out;
}

async function getOpenKO() {
  const r = await fetch('https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json');
  if (!r.ok) throw new Error('openfootball ' + r.status);
  const d = await r.json();
  const out = [];
  for (const m of (d.matches || [])) {
    const stage = STAGE_OPEN[String(m.round || '').toLowerCase().trim()];
    if (!stage) continue;
    const home = toCanon(m.team1), away = toCanon(m.team2);
    if (!home || !away) continue;
    const done = !!(m.score && Array.isArray(m.score.ft));
    let hs = 0, as = 0, win = null;
    if (done) {
      const s = m.score, dec = Array.isArray(s.et) ? s.et : s.ft;   // goals that stand (after extra time)
      hs = dec[0]; as = dec[1];
      win = hs > as ? home : as > hs ? away : null;
      if (!win && Array.isArray(s.p)) win = s.p[0] > s.p[1] ? home : s.p[1] > s.p[0] ? away : null;  // shootout
    }
    out.push({ stage, home, away, hs, as, done, win });
  }
  return out;
}

/* ---------- combine, dedupe, append ---------- */
// Dedupe by team-pair only: in the group stage two teams meet exactly once, so the
// date is irrelevant for matching (and our hand-entered dates may differ from the feed's).
const key = (h, a) => [h, a].sort().join('|');

let live = [], open = [], liveKO = [], openKO = [];
try { live = await getLive(); } catch (e) { console.warn('live source failed:', e.message); }
try { open = await getOpen(); } catch (e) { console.warn('fallback source failed:', e.message); }
try { liveKO = await getLiveKO(); } catch (e) { console.warn('live KO source failed:', e.message); }
try { openKO = await getOpenKO(); } catch (e) { console.warn('fallback KO source failed:', e.message); }
if (!live.length && !open.length && !liveKO.length && !openKO.length) {
  console.error('All sources empty — aborting, no changes.'); process.exit(0);
}

/* ----- group stage: union (prefer live), append new matches by team-pair ----- */
const merged = new Map();
for (const g of live) merged.set(key(g.home, g.away), g);
for (const g of open) {
  const k = key(g.home, g.away);
  if (!merged.has(k)) merged.set(k, g);
  else {
    const a = merged.get(k);
    if (a.hs !== g.hs || a.as !== g.as)
      console.warn(`score conflict ${g.home} v ${g.away} ${g.date}: live ${a.hs}-${a.as} vs open ${g.hs}-${g.as} (keeping live)`);
  }
}

const seen = new Set(RESULTS.map(r => key(r.home, r.away)));
const added = [];
for (const g of merged.values()) {
  const k = key(g.home, g.away);
  if (seen.has(k)) continue;
  seen.add(k);
  const entry = { date: g.date, group: groupOf[g.home], home: g.home, away: g.away, hs: g.hs, as: g.as };
  RESULTS.push(entry);
  added.push(entry);
}
if (added.length) RESULTS.sort((a, b) => dnum(a.date) - dnum(b.date));

/* ----- knockout: rebuild KO_RESULTS from the feeds (prefer live; a played result beats a fixture) ----- */
const koKey = k => k.stage + '|' + [k.home, k.away].sort().join('|');
const koRank = k => (k.done ? 2 : 0) + (k.win != null ? 1 : 0);   // prefer played, then a decided result (e.g. pens)
const koMap = new Map();
for (const g of [...openKO, ...liveKO]) {              // live iterated last → wins equal-rank ties
  const prev = koMap.get(koKey(g));
  if (!prev || koRank(g) >= koRank(prev)) koMap.set(koKey(g), g);
}
const koList = [...koMap.values()].sort((a, b) =>
  STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.home.localeCompare(b.home));
// only overwrite existing KO data if the feeds returned some (don't wipe on a transient glitch)
const koSig = arr => JSON.stringify(arr.map(k => [k.stage, k.home, k.away, k.hs, k.as, k.done, k.win ?? null]));
const koChanged = koList.length > 0 && koSig(koList) !== koSig(KO_EXISTING);

if (!added.length && !koChanged) { console.log('No new results.'); process.exit(0); }

/* ---------- rewrite the file (later block first, so the earlier block's offsets stay valid) ---------- */
if (koChanged) {
  const koLines = koList.map(k => k.done
    ? `  {stage:${JSON.stringify(k.stage)}, home:${JSON.stringify(k.home)}, away:${JSON.stringify(k.away)}, hs:${k.hs}, as:${k.as}, done:true, win:${JSON.stringify(k.win)}}`
    : `  {stage:${JSON.stringify(k.stage)}, home:${JSON.stringify(k.home)}, away:${JSON.stringify(k.away)}, hs:${k.hs}, as:${k.as}, done:false}`);
  html = html.slice(0, koBlock.start) + '[\n' + koLines.join(',\n') + '\n]' + html.slice(koBlock.end);
}
if (added.length) {
  const lines = RESULTS.map(r =>
    `  {date:${JSON.stringify(r.date)}, group:${JSON.stringify(r.group)}, home:${JSON.stringify(r.home)}, away:${JSON.stringify(r.away)}, hs:${r.hs}, as:${r.as}}`);
  html = html.slice(0, resBlock.start) + '[\n' + lines.join(',\n') + '\n]' + html.slice(resBlock.end);
}

const now = new Date();
const stamp = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
html = html.replace(/Last updated:[^<]*/, `Last updated: ${stamp}`);

fs.writeFileSync(FILE, html);
if (added.length) {
  console.log(`Added ${added.length} group match(es):`);
  for (const a of added) console.log(`  ${a.date} [${a.group}] ${a.home} ${a.hs}-${a.as} ${a.away}`);
}
if (koChanged) {
  const played = koList.filter(k => k.done).length;
  console.log(`KO_RESULTS: ${koList.length} match(es) — ${played} played, ${koList.length - played} fixtured.`);
}
