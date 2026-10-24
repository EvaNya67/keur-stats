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
const REQUEST_BUDGET = Number(process.env.MAX_REQ ?? 300); // requêtes par joueur et par exécution (~6 min, sous la limite de 100 / 2 min)
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
  2400: { mode: "ARAM", label: "ARAM : Chaos" },
};
const QV = Object.keys(QUEUES).join(","); // si la liste change, on revérifie les parties ignorées
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
    // noms français des sorts de chaque champion (pour les conseils de la page)
    try {
      const full = await get(`/cdn/${v}/data/fr_FR/championFull.json`);
      out.kits = Object.fromEntries(Object.values(full.data).map((c) => [c.id, c.spells.map((x) => x.name)]));
    } catch (e) {}
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
    team: me.teamId,
  };
}

// ---------- Timeline : où et comment il meurt ----------
// Pour chaque mort : minute, position, tueurs, alliés/ennemis proches (positions relevées
// chaque minute par Riot, interpolées), niveau, or non dépensé.
function extractTimeline(tl, m, puuid, S) {
  const parts = m.info.participants;
  const me = parts.find((x) => x.puuid === puuid);
  if (!me || !tl?.info?.frames) return null;
  const P = {};
  for (const p of parts) P[p.participantId] = { c: S.champs[p.championName] || p.championName, k: p.championName, team: p.teamId };
  const frames = tl.info.frames;
  const posAt = (id, t) => {
    const i = Math.max(0, Math.min(frames.length - 1, Math.floor(t / 60000)));
    const a = frames[i]?.participantFrames?.[id]?.position;
    const b = frames[i + 1]?.participantFrames?.[id]?.position;
    if (!a) return null;
    if (!b) return a;
    const f = Math.max(0, Math.min(1, (t - frames[i].timestamp) / ((frames[i + 1].timestamp - frames[i].timestamp) || 60000)));
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
  const frameAt = (t) => frames[Math.max(0, Math.min(frames.length - 1, Math.floor(t / 60000)))]?.participantFrames || {};
  const deathsAt = {}; // dernières morts de chaque joueur, pour ignorer ceux qui sont morts à ce moment-là
  const deaths = [], kills = [];
  const R = Math.round;
  for (const fr of frames) for (const ev of fr.events || []) {
    if (ev.type !== "CHAMPION_KILL" || !ev.position) continue;
    const t = ev.timestamp;
    if (ev.killerId === me.participantId) kills.push([R(t / 1000), R(ev.position.x), R(ev.position.y)]);
    if (ev.victimId === me.participantId) {
      const inv = [ev.killerId, ...(ev.assistingParticipantIds || [])].filter((id) => P[id] && P[id].team !== me.teamId);
      const isDead = (id) => deathsAt[id] && t - deathsAt[id] < 25000;
      const line = (id, pos) => [P[id].c, P[id].k, R(pos.x), R(pos.y)];
      const by = inv.map((id) => line(id, posAt(id, t) || ev.position));
      const al = [], en = [];
      for (const id of Object.keys(P).map(Number)) {
        if (id === me.participantId || inv.includes(id) || isDead(id)) continue;
        const pos = posAt(id, t);
        if (!pos) continue;
        (P[id].team === me.teamId ? al : en).push(line(id, pos));
      }
      const f = frameAt(t);
      deaths.push({
        t: R(t / 1000), x: R(ev.position.x), y: R(ev.position.y),
        by, al, en,
        lvl: f[me.participantId]?.level ?? null,
        klvl: P[ev.killerId] ? f[ev.killerId]?.level ?? null : null,
        gold: f[me.participantId]?.currentGold ?? null,
        tower: !P[ev.killerId], // tué par une tour / un monstre
      });
    }
    if (ev.victimId) deathsAt[ev.victimId] = t;
  }
  // contexte de chaque mort : le combat autour (kills des deux côtés) et les objectifs pris juste après
  const allKills = [], objs = [];
  const OBJ = { DRAGON: "Dragon", BARON_NASHOR: "Nashor", RIFTHERALD: "Héraut", HORDE: "Larves du Néant", ATAKHAN: "Atakhan" };
  for (const fr of frames) for (const ev of fr.events || []) {
    if (ev.type === "CHAMPION_KILL" && ev.position && P[ev.victimId]) allKills.push({ t: ev.timestamp, x: ev.position.x, y: ev.position.y, mine: P[ev.victimId].team === me.teamId, v: ev.victimId });
    if (ev.type === "ELITE_MONSTER_KILL" && OBJ[ev.monsterType]) objs.push({ t: ev.timestamp, n: OBJ[ev.monsterType], us: ev.killerTeamId === me.teamId });
    if (ev.type === "BUILDING_KILL") objs.push({ t: ev.timestamp, n: ev.buildingType === "INHIBITOR_BUILDING" ? "Inhibiteur" : "Tour", us: ev.teamId !== me.teamId });
  }
  for (const d of deaths) {
    const t = d.t * 1000, near = (k) => Math.hypot(k.x - d.x, k.y - d.y) < 3800 && k.t >= t - 15000 && k.t <= t + 15000;
    d.ak = allKills.filter((k) => !k.mine && near(k)).length; // ennemis tués par son équipe dans ce combat
    d.ek = allKills.filter((k) => k.mine && k.v !== me.participantId && near(k)).length; // alliés morts avec lui
    d.obj = objs.filter((o) => o.t >= t - 5000 && o.t <= t + 60000).map((o) => [o.n, o.us ? 1 : 0, R((o.t - t) / 1000)]);
    // d'où venaient ses tueurs : leur position 20 s avant
    d.from = d.by.map((b) => { const id = Object.keys(P).map(Number).find((i) => P[i].k === b[1] && P[i].team !== me.teamId); const q = id && posAt(id, Math.max(0, t - 20000)); return q ? [R(q.x), R(q.y)] : null; });
  }
  return { deaths, kills, lane: laneStats(frames, parts, me), dv: 2 };
}

// ---------- Phase de lane : lui contre son adversaire direct ----------
function laneStats(frames, parts, me) {
  const opp = me.teamPosition ? parts.find((x) => x.teamId !== me.teamId && x.teamPosition === me.teamPosition) : null;
  if (!opp) return null;
  const snap = (min) => {
    const f = frames[Math.min(min, frames.length - 1)]?.participantFrames;
    if (!f || frames.length - 1 < min) return null;
    const a = f[me.participantId], b = f[opp.participantId];
    if (!a || !b) return null;
    const cs = (x) => (x.minionsKilled || 0) + (x.jungleMinionsKilled || 0);
    return { g: a.totalGold, og: b.totalGold, cs: cs(a), ocs: cs(b), xp: a.xp, oxp: b.xp, lvl: a.level, olvl: b.level };
  };
  const L = { at10: snap(10), at15: snap(15), ek: 0, ed: 0, ea: 0, dOpp: 0, kOpp: 0, solo: 0, soloDeaths: 0, fb: 0, plates: 0, oplates: 0, wards: 0, ganked: 0 };
  // partenaire de lane du bas (support <-> ADC) : comparaison à 10 min
  const duoPos = me.teamPosition === "UTILITY" ? "BOTTOM" : me.teamPosition === "BOTTOM" ? "UTILITY" : null;
  if (duoPos) {
    const mate = parts.find((x) => x.teamId === me.teamId && x.teamPosition === duoPos);
    const foe = parts.find((x) => x.teamId !== me.teamId && x.teamPosition === duoPos);
    const f = frames[Math.min(10, frames.length - 1)]?.participantFrames;
    if (mate && foe && f && frames.length > 10) L.duo10 = { g: f[mate.participantId]?.totalGold, og: f[foe.participantId]?.totalGold };
  }
  const LIM = 14 * 60000;
  for (const fr of frames) for (const ev of fr.events || []) {
    if (ev.timestamp > LIM) continue;
    if (ev.type === "CHAMPION_KILL") {
      const ass = ev.assistingParticipantIds || [];
      if (ev.killerId === me.participantId) { L.ek++; if (ev.victimId === opp.participantId) { L.kOpp++; if (!ass.length) L.solo++; } }
      if (ev.victimId === me.participantId) {
        L.ed++;
        if (ev.killerId === opp.participantId || ass.includes(opp.participantId)) L.dOpp++;
        if (ev.killerId === opp.participantId && !ass.length) L.soloDeaths++;
        const helpers = [ev.killerId, ...ass].filter((id) => id !== opp.participantId && parts.find((p) => p.participantId === id)?.teamId !== me.teamId);
        if (helpers.length) L.ganked++;
      }
      if (ass.includes(me.participantId)) L.ea++;
    }
    if (ev.type === "TURRET_PLATE_DESTROYED") { if (ev.killerId === me.participantId) L.plates++; else if (ev.killerId === opp.participantId) L.oplates++; }
    if (ev.type === "WARD_PLACED" && ev.creatorId === me.participantId) L.wards++;
  }
  // premier sang : +1 s'il le fait, -1 s'il le donne
  const first = frames.flatMap((fr) => fr.events || []).find((ev) => ev.type === "CHAMPION_KILL");
  if (first) L.fb = first.killerId === me.participantId ? 1 : first.victimId === me.participantId ? -1 : 0;
  if (frames.length - 1 < 10) return null; // partie trop courte
  return L;
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
  const skipped = new Set((prev.queuesV === QV && prev.skipQ ? prev.skipped || [] : []).filter((id) => keepIds.includes(id)));
  const known = new Set([...games.map((g) => g.matchId), ...skipped]);
  const unknown = keepIds.filter((id) => !known.has(id));
  // Anciennes parties de la Faille sans timeline : à compléter (les plus récentes d'abord)
  const upgrade = games.filter((g) => g.mode === "Faille" && !g.noTimeline && (!g.deaths || !("lane" in g) || g.dv !== 2)).sort((x, y) => y.date.localeCompare(x.date));
  let budget = REQUEST_BUDGET; // requêtes par joueur et par exécution
  let added = 0, upgraded = 0, left = 0, lastQ = null;
  const skipQ = { ...(prev.queuesV === QV && prev.skipQ ? prev.skipQ : {}) }; // file de chaque partie ignorée (pour vérifier)
  const fetchGame = async (id) => {
    const m = await riot(config.region, `/lol/match/v5/matches/${id}`);
    budget--;
    lastQ = m?.info?.queueId ?? null;
    const g = m && summarize(id, m, puuid, S);
    if (g && g.mode === "Faille" && budget > 0) {
      const tl = await riot(config.region, `/lol/match/v5/matches/${id}/timeline`);
      budget--;
      const x = tl && extractTimeline(tl, m, puuid, S);
      if (x) Object.assign(g, x);
      else if (tl === null) Object.assign(g, { deaths: [], kills: [], noTimeline: true }); // timeline introuvable : on n'insiste pas
    }
    return g;
  };
  for (const id of unknown) {
    if (budget < 2) { left++; continue; }
    const g = await fetchGame(id);
    if (g) { games.push(g); added++; } else { skipped.add(id); skipQ[id] = lastQ; }
  }
  for (const old of upgrade) {
    if (budget < 2) { left++; continue; }
    const g = await fetchGame(old.matchId);
    if (g) { Object.assign(old, g); upgraded++; }
  }
  const pending = left;
  if (pending > 0) console.log(`  ${pending} parties en attente pour la prochaine fois`);
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
    queuesV: QV,
    skipQ: Object.fromEntries(Object.entries(skipQ).filter(([id]) => skipped.has(id))),
  };
  await writeFile(file, JSON.stringify(out));
  console.log(`  ${added} nouvelles parties, ${upgraded} complétées avec la carte des morts, ${games.length} au total`);
}

await mkdir(DATA, { recursive: true });
const S = await loadStatic();
if (S.kits) await writeFile(path.join(DATA, "spells.json"), JSON.stringify(S.kits));
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
