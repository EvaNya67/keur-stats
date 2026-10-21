// Met à jour data/*.json à partir de l'API Riot.
// Lancé toutes les heures par GitHub Actions (.github/workflows/update.yml).
// La clé est lue dans la variable d'environnement RIOT_API_KEY (secret GitHub).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const KEY = process.env.RIOT_API_KEY;
const RIOT_BASE = process.env.RIOT_BASE; // seulement pour les tests locaux
const MAX_NEW_MATCHES_PER_RUN = 90; // reste sous 100 requêtes / 2 min
const MAX_HISTORY = 200;

if (!KEY) {
  console.error("RIOT_API_KEY manquante (ajoute-la dans Settings → Secrets → Actions).");
  process.exit(1);
}

const config = JSON.parse(await readFile(path.join(ROOT, "players.json"), "utf8"));
const seasonStart = Math.floor(new Date(config.seasonStart + "T00:00:00Z").getTime() / 1000);

// ---------- Appels API avec limite de débit ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function riot(host, pathname) {
  const delay = Number(process.env.RIOT_DELAY_MS ?? 1250); // ~96 requêtes / 2 min max
  const wait = lastCall + delay - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = (RIOT_BASE || `https://${host}.api.riotgames.com`) + pathname;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "X-Riot-Token": KEY } });
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get("retry-after")) || 10;
      console.log(`  ${res.status} sur ${pathname}, nouvel essai dans ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${pathname}`);
    return res.json();
  }
  throw new Error(`Trop d'échecs sur ${pathname}`);
}

// ---------- Noms et icônes des champions (Data Dragon, sans clé) ----------
async function loadChampions() {
  try {
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    const v = versions[0];
    const json = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/fr_FR/champion.json`)).json();
    const names = {};
    for (const c of Object.values(json.data)) names[c.id] = c.name;
    return { version: v, names };
  } catch (e) {
    console.log("Data Dragon indisponible, noms bruts utilisés.");
    return { version: null, names: {} };
  }
}

// ---------- Rangs ----------
const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const DIV = { I: 1, II: 2, III: 3, IV: 4 };
function rankScore(e) {
  if (!e) return null;
  const i = TIERS.indexOf(e.tier);
  if (i === -1) return 2800 + e.lp; // Maître, Grand Maître, Challenger
  return i * 400 + (4 - DIV[e.rank]) * 100 + e.lp;
}
function pickEntry(entries, queue) {
  const e = (entries || []).find((x) => x.queueType === queue);
  return e ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses } : null;
}

// ---------- Agrégation par champion ----------
function aggregate(matches, names) {
  const by = {};
  for (const m of matches) {
    const c = (by[m.champ] ??= { id: m.champ, games: 0, wins: 0, k: 0, d: 0, a: 0, cs: 0, min: 0, kpSum: 0 });
    c.games++;
    if (m.win) c.wins++;
    c.k += m.k; c.d += m.d; c.a += m.a; c.cs += m.cs; c.min += m.dur / 60;
    c.kpSum += m.teamKills ? (m.k + m.a) / m.teamKills : 0;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return Object.values(by)
    .map((c) => ({
      id: c.id,
      name: names[c.id] || c.id,
      games: c.games,
      wins: c.wins,
      losses: c.games - c.wins,
      k: r1(c.k / c.games),
      d: r1(c.d / c.games),
      a: r1(c.a / c.games),
      kda: Math.round(((c.k + c.a) / Math.max(1, c.d)) * 100) / 100,
      kp: Math.round((c.kpSum / c.games) * 100),
      cs: Math.round(c.cs / c.games),
      cspm: r1(c.cs / Math.max(1, c.min)),
    }))
    .sort((x, y) => y.games - x.games || y.wins - x.wins);
}

// ---------- Un joueur ----------
async function updatePlayer(p, champs) {
  const file = path.join(DATA, `${p.slug}.json`);
  const prev = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  console.log(`→ ${p.gameName}#${p.tagLine}`);

  let puuid = prev.puuid;
  if (!puuid) {
    const acc = await riot(config.region, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(p.gameName)}/${encodeURIComponent(p.tagLine)}`);
    if (!acc) throw new Error(`Compte introuvable : ${p.gameName}#${p.tagLine}`);
    puuid = acc.puuid;
  }

  const entries = await riot(config.platform, `/lol/league/v4/entries/by-puuid/${puuid}`);
  const solo = pickEntry(entries, "RANKED_SOLO_5x5");
  const flex = pickEntry(entries, "RANKED_FLEX_SR");

  // Parties classées (Solo + Flex) de la saison, seulement les nouvelles
  const known = new Set((prev.matches || []).map((m) => m.id));
  const newIds = [];
  for (let start = 0; start < 1000; start += 100) {
    const ids = await riot(config.region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?type=ranked&startTime=${seasonStart}&start=${start}&count=100`);
    if (!ids || !ids.length) break;
    const fresh = ids.filter((id) => !known.has(id));
    newIds.push(...fresh);
    if (fresh.length < ids.length || ids.length < 100) break; // on a rejoint les parties déjà connues
  }
  // Les plus anciennes d'abord ; le reste sera récupéré à la prochaine exécution
  const todo = newIds.reverse().slice(0, MAX_NEW_MATCHES_PER_RUN);
  if (newIds.length > todo.length) console.log(`  ${newIds.length - todo.length} parties en attente pour la prochaine fois`);

  const matches = [...(prev.matches || [])];
  for (const id of todo) {
    const m = await riot(config.region, `/lol/match/v5/matches/${id}`);
    if (!m) continue;
    const info = m.info;
    const me = info.participants.find((x) => x.puuid === puuid);
    if (!me || info.gameDuration < 300 || me.gameEndedInEarlySurrender) {
      matches.push({ id, skip: true });
      continue;
    }
    const teamKills = info.participants.filter((x) => x.teamId === me.teamId).reduce((s, x) => s + x.kills, 0);
    matches.push({
      id,
      t: info.gameEndTimestamp || info.gameCreation,
      queue: info.queueId,
      champ: me.championName,
      win: me.win,
      k: me.kills, d: me.deaths, a: me.assists,
      cs: me.totalMinionsKilled + me.neutralMinionsKilled,
      dur: info.gameDuration,
      teamKills,
    });
  }
  matches.sort((x, y) => (x.t || 0) - (y.t || 0));
  const played = matches.filter((m) => !m.skip);

  // Historique LP : un point quand le nombre de parties Solo change
  const history = [...(prev.history || [])];
  const soloGames = solo ? solo.wins + solo.losses : 0;
  const prevSoloGames = prev.solo ? prev.solo.wins + prev.solo.losses : -1;
  if (solo && soloGames !== prevSoloGames) {
    history.push({ t: new Date().toISOString(), score: rankScore(solo), tier: solo.tier, rank: solo.rank, lp: solo.lp });
  }
  while (history.length > MAX_HISTORY) history.shift();

  const out = {
    riotId: `${p.gameName}#${p.tagLine}`,
    slug: p.slug,
    puuid,
    updatedAt: new Date().toISOString(),
    ddragon: champs.version,
    solo,
    flex,
    history,
    champions: aggregate(played, champs.names),
    matches,
  };
  await writeFile(file, JSON.stringify(out, null, 1));
  console.log(`  ${todo.length} nouvelles parties, ${played.length} au total`);
}

await mkdir(DATA, { recursive: true });
const champs = await loadChampions();
let failed = 0;
for (const p of config.players) {
  try {
    await updatePlayer(p, champs);
  } catch (e) {
    failed++;
    console.error(`  Erreur pour ${p.gameName}#${p.tagLine} : ${e.message}`);
  }
}
await writeFile(
  path.join(DATA, "players.json"),
  JSON.stringify(config.players.map((p) => ({ slug: p.slug, riotId: `${p.gameName}#${p.tagLine}` })), null, 1)
);
if (failed === config.players.length) process.exit(1);
