// Auto-updates the RESULTS array in index.html with newly-finished World Cup 2026
// group-stage matches. Deterministic, no LLM. Run by .github/workflows/update-results.yml.
//
// Sources (free, no key):
//   PRIMARY  live:  https://worldcup26.ir/get/games
//   FALLBACK fixed: https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
//
// It only touches the data array + the "Last updated" line — never the rendering logic.
// Knockout matches are deliberately skipped for now (the page has no bonus engine yet);
// they'll be handled in a one-off page change when the knockouts begin.

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

// canonical names + group-letter lookup, derived from the page so they stay in sync
const groupOf = {};
for (const [g, teams] of Object.entries(GROUPS)) for (const t of teams) groupOf[t] = g;
const canonical = Object.keys(groupOf);

/* ---------- team-name normalisation ---------- */
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
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

/* ---------- combine, dedupe, append ---------- */
// Dedupe by team-pair only: in the group stage two teams meet exactly once, so the
// date is irrelevant for matching (and our hand-entered dates may differ from the feed's).
const key = (h, a) => [h, a].sort().join('|');

let live = [], open = [];
try { live = await getLive(); } catch (e) { console.warn('live source failed:', e.message); }
try { open = await getOpen(); } catch (e) { console.warn('fallback source failed:', e.message); }
if (!live.length && !open.length) { console.error('Both sources empty — aborting, no changes.'); process.exit(0); }

// union: prefer live; warn on score conflicts
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

if (!added.length) { console.log('No new results.'); process.exit(0); }

RESULTS.sort((a, b) => dnum(a.date) - dnum(b.date));

/* ---------- rewrite the file ---------- */
const lines = RESULTS.map(r =>
  `  {date:${JSON.stringify(r.date)}, group:${JSON.stringify(r.group)}, home:${JSON.stringify(r.home)}, away:${JSON.stringify(r.away)}, hs:${r.hs}, as:${r.as}}`
);
const newArray = '[\n' + lines.join(',\n') + '\n]';
html = html.slice(0, resBlock.start) + newArray + html.slice(resBlock.end);

const now = new Date();
const stamp = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
html = html.replace(/Last updated:[^<]*/, `Last updated: ${stamp}`);

fs.writeFileSync(FILE, html);
console.log(`Added ${added.length} match(es):`);
for (const a of added) console.log(`  ${a.date} [${a.group}] ${a.home} ${a.hs}-${a.as} ${a.away}`);
