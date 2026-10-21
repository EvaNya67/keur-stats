// Met à jour data/*.json à partir de l'API Riot.
// Lancé toutes les heures par GitHub Actions (.github/workflows/update.yml).
// La clé est lue dans la variable d'environnement RIOT_API_KEY (secret GitHub).
//
// Pour chaque joueur : rangs Solo/Flex, courbe de LP, et le détail de chaque partie
// (classées, normales, ARAM) : dégâts, or, vision, wards, temps mort, objets, runes,
// et les mêmes stats pour l'adversaire direct. L'analyse (points forts, conseils)
// est faite par la page elle-même à partir de ces chiffres.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const KEY = process.env.RIOT_API_KEY;
const RIOT_BASE = process.env.RIOT_BASE; // seulement pour les tests locaux
const DDRAGON = process.env.DDRAGON_BASE || "https://ddragon.leagueoflegends.com";
const SCHEMA = 2;
const MAX_NEW_MATCHES_PER_RUN = Number(process.env.MAX_NEW ?? 120); // par joueur et par exécution
const MAX_GAMES = 300; // parties gardées par joueur (les plus récentes)
const MAX_HISTORY = 200;

// Files gardées : classées, normales, partie rapide, ARAM
const QUEUES = {
  420: { mode: "Faille", label: "Solo/Duo", ranked: true },
  440: { mode: "Faille", label: "Flex", ranked: true },
  400: { mode: "Faille", label: "Normale" },
  430: { mode: "Faille", label: "Normale" },
  490: { mode: "Faille", label: "Partie rapide" },
  480: { mode: "Faille", label: "Partie rapide" },
  450: { mode: "ARAM", label: "ARAM" },
};
const ROLE = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "ADC", UTILITY: "Support" };

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
    if (res.status === 401 || res.status === 403) throw new Error(`Clé Riot refusée (${res.status}) : vérifie ou renouvelle le secret RIOT_API_KEY.`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${pathname}`);
    return res.json();
  }
  throw new Error(`Trop d'échecs sur ${pathname}`);
}

// ---------- Noms en français (Data Dragon, sans clé) ----------
async function loadStatic() {
  const out = { version: null, champs: {}, items: {}, spells: {}, runes: {} };
  try {
    const get = async (p) => (await fetch(DDRAGON + p)).json();
    const v = (await get("/api/versions.json"))[0];
    out.version = v;
    const [ch, it, su, ru] = await Promise.all([
      get(`/cdn/${v}/data/fr_FR/champion.json`),
      get(`/cdn/${v}/data/fr_FR/item.json`),
      get(`/cdn/${v}/data/fr_FR/summoner.json`),
      get(`/cdn/${v}/data/fr_FR/runesReforged.json`),
    ]);
    for (const c of Object.values(ch.data)) out.champs[c.id] = c.name;
    for (const [id, i] of Object.entries(it.data)) out.items[id] = { name: i.name, boots: (i.tags || []).includes("Boots"), cheap: (i.gold?.total ?? 0) < 900 };
    for (const s of Object.values(su.data)) out.spells[s.key] = s.name;
    for (const tree of ru) for (const slot of tree.slots) for (const r of slot.runes) out.runes[r.id] = r.name;
  } catch (e) {
    console.log("Data Dragon indisponible, noms bruts utilisés.");
  }
  return out;
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

// ---------- Une partie → résumé compact ----------
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
function playerLine(p, S) {
  return {
    champion: S.champs[p.championName] || p.championName,
    k: p.kills, d: p.deaths, a: p.assists,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    dmg: p.totalDamageDealtToChampions,
    gold: p.goldEarned,
    vision: p.visionScore,
    wards: p.wardsPlaced,
    pinks: p.visionWardsBoughtInGame,
    wardsKilled: p.wardsKilled,
    dead: p.totalTimeSpentDead,
    cc: p.timeCCingOthers,
  };
}
function summarize(id, m, puuid, S) {
  const info = m.info;
  const q = QUEUES[info.queueId];
  const me = info.participants.find((x) => x.puuid === puuid);
  if (!q || !me) return null;
  const short = info.gameDuration < 300 || !!me.gameEndedInEarlySurrender;
  const mates = info.participants.filter((x) => x.teamId === me.teamId);
  const foes = info.participants.filter((x) => x.teamId !== me.teamId);
  const teamKills = mates.reduce((s, x) => s + x.kills, 0);
  const enemyKills = foes.reduce((s, x) => s + x.kills, 0);
  const teamDmg = mates.reduce((s, x) => s + x.totalDamageDealtToChampions, 0) || 1;
  const min = info.gameDuration / 60;
  const role = q.mode === "ARAM" ? "ARAM" : ROLE[me.teamPosition] || ROLE[me.individualPosition] || "Autre";
  const oppP = q.mode === "ARAM" || !me.teamPosition ? null : foes.find((x) => x.teamPosition === me.teamPosition);
  const items = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5]
    .filter((x) => x && (!S.items[x] || S.items[x].boots || !S.items[x].cheap)) // sans composants ni balises
    .map((x) => S.items[x]?.name || String(x));
  const keystone = me.perks?.styles?.[0]?.selections?.[0]?.perk;
  const line = playerLine(me, S);
  return {
    id: id.replace(/^[A-Z0-9]+_/, ""),
    matchId: id,
    date: new Date(info.gameEndTimestamp || info.gameCreation).toISOString(),
    patch: (info.gameVersion || "").split(".").slice(0, 2).join("."),
    queue: info.queueId,
    queueLabel: q.label,
    ranked: !!q.ranked,
    mode: q.mode,
    role,
    short,
    win: me.win,
    champKey: me.championName,
    ...line,
    duration: r1(min),
    cspm: r1(line.cs / Math.max(1, min)),
    gpm: Math.round(line.gold / Math.max(1, min)),
    vspm: r2(line.vision / Math.max(1, min)),
    deadPct: Math.round((line.dead / Math.max(1, info.gameDuration)) * 100),
    dmgShare: Math.round((line.dmg / teamDmg) * 100),
    dmgRank: [...mates].sort((a, b) => b.totalDamageDealtToChampions - a.totalDamageDealtToChampions).findIndex((x) => x.puuid === puuid) + 1,
    dmgTaken: me.totalDamageTaken,
    heal: me.totalHealsOnTeammates || 0,
    shield: me.totalDamageShieldedOnTeammates || 0,
    kp: teamKills ? Math.round(((me.kills + me.assists) / teamKills) * 100) : 0,
    teamKills,
    enemyKills,
    level: me.champLevel,
    longestLife: me.longestTimeSpentLiving,
    items,
    spells: [S.spells[me.summoner1Id] || "", S.spells[me.summoner2Id] || ""],
    keystone: keystone ? S.runes[keystone] || "" : "",
    opp: oppP ? playerLine(oppP, S) : null,
  };
}

// ---------- Un joueur ----------
async function updatePlayer(p, S) {
  const file = path.join(DATA, `${p.slug}.json`);
  let prev = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  console.log(`→ ${p.gameName}#${p.tagLine}`);

  let puuid = prev.puuid;
  if (!puuid) {
    const acc = await riot(config.region, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(p.gameName)}/${encodeURIComponent(p.tagLine)}`);
    if (!acc) throw new Error(`Compte introuvable : ${p.gameName}#${p.tagLine}`);
    puuid = acc.puuid;
  }
  if (prev.v !== SCHEMA) prev = { puuid, history: prev.history, solo: prev.solo }; // ancien format : on refait les parties

  const entries = await riot(config.platform, `/lol/league/v4/entries/by-puuid/${puuid}`);
  const solo = pickEntry(entries, "RANKED_SOLO_5x5");
  const flex = pickEntry(entries, "RANKED_FLEX_SR");

  // Toutes les parties de la saison (les plus récentes d'abord)
  const allIds = [];
  for (let start = 0; start < 1000; start += 100) {
    const ids = await riot(config.region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=${seasonStart}&start=${start}&count=100`);
    if (!ids || !ids.length) break;
    allIds.push(...ids);
    if (ids.length < 100) break;
  }
  const keepIds = allIds.slice(0, MAX_GAMES);
  const games = (prev.games || []).filter((g) => keepIds.includes(g.matchId));
  const skipped = new Set((prev.skipped || []).filter((id) => keepIds.includes(id)));
  const known = new Set([...games.map((g) => g.matchId), ...skipped]);
  const unknown = keepIds.filter((id) => !known.has(id));
  const todo = unknown.slice(0, MAX_NEW_MATCHES_PER_RUN); // les plus récentes d'abord
  const pending = unknown.length - todo.length;
  if (pending > 0) console.log(`  ${pending} parties en attente pour la prochaine fois`);

  let added = 0;
  for (const id of todo) {
    const m = await riot(config.region, `/lol/match/v5/matches/${id}`);
    const g = m && summarize(id, m, puuid, S);
    if (g) { games.push(g); added++; } else skipped.add(id);
  }
  games.sort((x, y) => y.date.localeCompare(x.date));

  // Historique LP : un point quand le nombre de parties Solo change
  const history = [...(prev.history || [])];
  const soloGames = solo ? solo.wins + solo.losses : 0;
  const prevSoloGames = prev.solo ? prev.solo.wins + prev.solo.losses : -1;
  if (solo && soloGames !== prevSoloGames) {
    history.push({ t: new Date().toISOString(), score: rankScore(solo), tier: solo.tier, rank: solo.rank, lp: solo.lp });
  }
  while (history.length > MAX_HISTORY) history.shift();

  const out = {
    v: SCHEMA,
    riotId: `${p.gameName}#${p.tagLine}`,
    slug: p.slug,
    puuid,
    region: "EUW",
    updatedAt: new Date().toISOString(),
    ddragon: S.version,
    solo,
    flex,
    history,
    pending,
    games,
    skipped: [...skipped],
  };
  await writeFile(file, JSON.stringify(out));
  console.log(`  ${added} nouvelles parties analysées, ${games.length} au total`);
}

await mkdir(DATA, { recursive: true });
const S = await loadStatic();
let failed = 0;
for (const p of config.players) {
  try {
    await updatePlayer(p, S);
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
