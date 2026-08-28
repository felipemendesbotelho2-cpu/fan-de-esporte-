// scripts/gerar-dados.mjs
//
// Robô que gera o dados.json do "Fan de Esporte".
// Roda pelo GitHub Actions (veja .github/workflows/atualizar-jogos.yml).
//
// O que ele faz:
//  1. Descobre "qual é o dia de hoje" sempre pelo fuso do Brasil (America/Sao_Paulo),
//     nunca pelo UTC puro — é a mesma correção que aplicamos no site.
//  2. Busca na API-Football os jogos de hoje das ligas permitidas.
//  3. Pra cada time que joga hoje, busca os últimos 10 jogos finalizados da
//     temporada, com minuto dos gols e estatísticas (escanteios, chutes, etc).
//  4. Calcula a lista "-2 Gols no 1ºT" (times que não fizeram 2+ gols no 1ºT
//     em nenhum dos últimos 5 jogos).
//  5. Salva tudo em dados.json, na raiz do repositório.
//
// Reaproveita dados de execuções anteriores (lidos do próprio dados.json já
// existente) pra não ficar rebuscando estatísticas de jogos que já terminaram
// e não mudam mais — economiza cota da API-Football a cada execução.

import { writeFile, readFile } from 'node:fs/promises';

const API_KEY = process.env.API_FOOTBALL_KEY;
if (!API_KEY) {
  console.error('Faltou configurar o secret API_FOOTBALL_KEY no repositório (Settings → Secrets and variables → Actions).');
  process.exit(1);
}

const SITE_TIMEZONE = 'America/Sao_Paulo';
const API_BASE = 'https://v3.football.api-sports.io';
const TARGET_SEASON = 2026;
const GAMES_LIMIT = 10;
const FRIOS_GAMES_LIMIT = 5;
const OUTPUT_PATH = new URL('../dados.json', import.meta.url);

function getSiteDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TIMEZONE }).format(new Date());
}

// ---------- mesmas regras de filtro usadas no site (mantidas idênticas de propósito) ----------
const YOUTH_OR_RESERVE_KEYWORDS = /sub[\s-]?(13|14|15|16|17|18|19|20|21|22|23)|\bu[\s-]?(13|14|15|16|17|18|19|20|21|22|23)\b|youth|junior|juvenil|jovens|reservas?|reserve|academy|aspirantes|amateur|amador(es)?|women|woman|feminin[ao]|ladies|female|\bW\b|WSL|FAWSL/i;
const TEAM_YOUTH_OR_RESERVE_SUFFIX = /\s(u[\s-]?(13|14|15|16|17|18|19|20|21|22|23)|sub[\s-]?(13|14|15|16|17|18|19|20|21|22|23)|w|women|ladies|reserves?|II|B)$/i;

function isYouthOrReserveLeague(name) {
  return YOUTH_OR_RESERVE_KEYWORDS.test(name || '');
}
function isYouthOrReserveTeamName(name) {
  const n = name || '';
  return YOUTH_OR_RESERVE_KEYWORDS.test(n) || TEAM_YOUTH_OR_RESERVE_SUFFIX.test(n);
}
function isYouthOrReserveFixture(fx) {
  const home = fx.teams && fx.teams.home && fx.teams.home.name;
  const away = fx.teams && fx.teams.away && fx.teams.away.name;
  return isYouthOrReserveTeamName(home) || isYouthOrReserveTeamName(away);
}

const ALLOWED_LEAGUES = [
  { name: 'Brasileirão Série A', test: (n, c) => c === 'Brazil' && /serie\s*a/i.test(n) },
  { name: 'Brasileirão Série B', test: (n, c) => c === 'Brazil' && /serie\s*b/i.test(n) },
  { name: 'Brasileirão Série C', test: (n, c) => c === 'Brazil' && /serie\s*c/i.test(n) },
  { name: 'Copa do Brasil', test: (n, c) => c === 'Brazil' && /copa\s*do\s*brasil/i.test(n) },
  { name: 'Copa Libertadores', test: (n) => /libertadores/i.test(n) },
  { name: 'Copa Sul-Americana', test: (n) => /sudamericana|sul[\s-]*americana/i.test(n) },
  { name: 'Série A (Itália)', test: (n, c) => c === 'Italy' && /^serie\s*a$/i.test(n) },
  { name: 'Premier League', test: (n, c) => c === 'England' && /^premier\s*league$/i.test(n) },
  { name: 'League Cup (Inglaterra)', test: (n, c) => c === 'England' && /(efl\s*cup|carabao\s*cup|league\s*cup)/i.test(n) },
  { name: 'Champions League', test: (n) => /champions\s*league/i.test(n) },
  { name: 'Eliteserien (Noruega)', test: (n, c) => c === 'Norway' && /eliteserien/i.test(n) },
  { name: 'Premiership (Escócia)', test: (n, c) => c === 'Scotland' && /premiership/i.test(n) },
  { name: 'Allsvenskan (Suécia)', test: (n, c) => c === 'Sweden' && /allsvenskan/i.test(n) },
  { name: 'La Liga (Espanha)', test: (n, c) => c === 'Spain' && /^la\s*liga$/i.test(n) },
  { name: 'Primera División (Argentina)', test: (n, c) => c === 'Argentina' && /(primera\s*divisi[oó]n|liga\s*profesional)/i.test(n) },
  { name: 'Saudi Pro League', test: (n, c) => /saudi/i.test(c) && /pro\s*league/i.test(n) },
  { name: 'Primeira Divisão (Arábia Saudita)', test: (n, c) => /saudi/i.test(c) && /first\s*division/i.test(n) },
];

function matchAllowedLeague(leagueName, leagueCountry) {
  const n = leagueName || '';
  const c = leagueCountry || '';
  if (isYouthOrReserveLeague(n)) return null;
  return ALLOWED_LEAGUES.find((l) => l.test(n, c)) || null;
}

// ---------- fila simples pra não estourar o limite de requisições/min da API ----------
const MAX_CONCURRENT = 6;
const MIN_START_INTERVAL_MS = 250;
let activeCalls = 0;
let lastStartAt = 0;
const queue = [];

function pump() {
  if (activeCalls >= MAX_CONCURRENT || !queue.length) return;
  const wait = Math.max(0, lastStartAt + MIN_START_INTERVAL_MS - Date.now());
  if (wait > 0) { setTimeout(pump, wait); return; }
  const task = queue.shift();
  lastStartAt = Date.now();
  activeCalls++;
  Promise.resolve().then(task.fn)
    .then((r) => { activeCalls--; task.resolve(r); pump(); })
    .catch((e) => { activeCalls--; task.reject(e); pump(); });
  pump();
}
function schedule(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

async function apiGet(path) {
  return schedule(async () => {
    const res = await fetch(API_BASE + path, { headers: { 'x-apisports-key': API_KEY } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' em ' + path + (body ? ' — ' + body.slice(0, 300) : ''));
    }
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length) {
      throw new Error('Erro da API em ' + path + ': ' + JSON.stringify(data.errors));
    }
    return data;
  });
}

// ---------- jogos de hoje ----------
async function fetchTodayGames() {
  const today = getSiteDateStr();
  const data = await apiGet('/fixtures?date=' + today + '&timezone=' + encodeURIComponent(SITE_TIMEZONE));
  return (data.response || [])
    .filter((fx) => fx.fixture?.status && ['NS', '1H', 'HT', '2H', 'ET', 'P'].includes(fx.fixture.status.short))
    .filter((fx) => matchAllowedLeague(fx.league?.name, fx.league?.country))
    .filter((fx) => !isYouthOrReserveFixture(fx))
    .map((fx) => {
      const allowed = matchAllowedLeague(fx.league.name, fx.league.country);
      return {
        time: new Date(fx.fixture.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: SITE_TIMEZONE }),
        date: fx.fixture.date,
        league: allowed.name,
        leagueCountry: fx.league.country,
        leagueId: fx.league.id,
        leagueSeason: fx.league.season,
        fixtureId: fx.fixture.id,
        home: { id: fx.teams.home.id, name: fx.teams.home.name },
        away: { id: fx.teams.away.id, name: fx.teams.away.name },
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 40);
}

// ---------- últimos 10 jogos de cada time, com minuto dos gols e estatísticas ----------
function findStatValue(stats, regex) {
  const found = stats.find((s) => regex.test(s.type || ''));
  if (!found || found.value == null) return null;
  const n = Number(found.value);
  return Number.isNaN(n) ? null : n;
}

async function fetchGoalMinutes(fixtureId, teamId) {
  const data = await apiGet('/fixtures/events?fixture=' + fixtureId);
  return (data.response || [])
    .filter((ev) => ev.type === 'Goal' && ev.team?.id === teamId)
    .map((ev) => (ev.time?.elapsed || 0) + (ev.time?.extra || 0));
}

async function fetchMatchStats(fixtureId, teamId) {
  const data = await apiGet('/fixtures/statistics?fixture=' + fixtureId + '&team=' + teamId);
  const stats = data.response?.[0]?.statistics || [];
  return {
    cornersTotal: findStatValue(stats, /corner/i),
    totalShots: findStatValue(stats, /^total\s*shots$/i),
    shotsOnGoal: findStatValue(stats, /shots\s*on\s*goal/i),
    yellowCards: findStatValue(stats, /yellow\s*cards/i),
    redCards: findStatValue(stats, /red\s*cards/i),
    foulsCommitted: findStatValue(stats, /^fouls$/i),
  };
}

async function fetchLastFixtures(teamId, previousStatsByFixture) {
  const data = await apiGet('/fixtures?team=' + teamId + '&season=' + TARGET_SEASON);
  const finished = (data.response || [])
    .filter((fx) => ['FT', 'AET', 'PEN'].includes(fx.fixture?.status?.short))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, GAMES_LIMIT);

  return Promise.all(finished.map(async (fx) => {
    const isHome = fx.teams.home.id === teamId;
    const ht = fx.score.halftime || {};
    const ft = fx.score.fulltime || {};
    const base = {
      fixtureId: fx.fixture.id,
      gf_ht: isHome ? (ht.home ?? 0) : (ht.away ?? 0),
      ga_ht: isHome ? (ht.away ?? 0) : (ht.home ?? 0),
      gf_ft: isHome ? (ft.home ?? 0) : (ft.away ?? 0),
      ga_ft: isHome ? (ft.away ?? 0) : (ft.home ?? 0),
      date: fx.fixture.date,
      opponent: isHome ? fx.teams.away.name : fx.teams.home.name,
      isHome,
    };

    // Jogo que já terminou não muda mais — se já buscamos o minuto dos gols e
    // as estatísticas dele numa execução anterior, reaproveita em vez de gastar
    // cota da API de novo.
    const cached = previousStatsByFixture.get(fx.fixture.id);
    if (cached) {
      return {
        ...base,
        minutesScored: cached.minutesScored ?? null,
        cornersTotal: cached.cornersTotal ?? null,
        totalShots: cached.totalShots ?? null,
        shotsOnGoal: cached.shotsOnGoal ?? null,
        yellowCards: cached.yellowCards ?? null,
        redCards: cached.redCards ?? null,
        foulsCommitted: cached.foulsCommitted ?? null,
      };
    }

    let minutesScored = null;
    let stats = {};
    try { minutesScored = await fetchGoalMinutes(fx.fixture.id, teamId); } catch (_e) { minutesScored = null; }
    try { stats = await fetchMatchStats(fx.fixture.id, teamId); } catch (_e) { stats = {}; }
    return { ...base, minutesScored, ...stats };
  }));
}

// ---------- times "frios no 1º tempo" ----------
function buildFrios1t(games, teamStats) {
  const teamsMap = new Map();
  games.forEach((g) => {
    [['home', g.home], ['away', g.away]].forEach(([side, team]) => {
      if (team.id == null) return;
      const key = 'id:' + team.id;
      if (!teamsMap.has(key)) teamsMap.set(key, { id: team.id, name: team.name, side, game: g });
    });
  });
  const entries = Array.from(teamsMap.values());
  const usable = entries.filter((e) => teamStats[e.id]);
  const qualified = usable.filter((e) => {
    const fixtures = teamStats[e.id].fixtures;
    return fixtures.length >= FRIOS_GAMES_LIMIT && fixtures.slice(0, FRIOS_GAMES_LIMIT).every((f) => f.gf_ht < 2);
  });
  return { qualified, totalTeams: entries.length, usableTeams: usable.length };
}

// ---------- reaproveita o dados.json da execução anterior, se existir ----------
async function loadPreviousStatsByFixture() {
  const map = new Map();
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf8');
    const prev = JSON.parse(raw);
    Object.values(prev.teamStats || {}).forEach((entry) => {
      (entry.fixtures || []).forEach((f) => {
        if (f.fixtureId != null) map.set(f.fixtureId, f);
      });
    });
  } catch (_e) {
    // primeira execução — não tem dados.json anterior ainda, segue normal.
  }
  return map;
}

async function main() {
  console.log('Buscando jogos de hoje (' + getSiteDateStr() + ', fuso ' + SITE_TIMEZONE + ')…');
  const games = await fetchTodayGames();
  console.log(games.length + ' jogos encontrados nas ligas selecionadas.');

  const previousStatsByFixture = await loadPreviousStatsByFixture();

  const teamIds = new Set();
  games.forEach((g) => {
    if (g.home.id != null) teamIds.add(g.home.id);
    if (g.away.id != null) teamIds.add(g.away.id);
  });

  const teamStats = {};
  let done = 0;
  await Promise.all(Array.from(teamIds).map(async (id) => {
    try {
      teamStats[id] = { fixtures: await fetchLastFixtures(id, previousStatsByFixture) };
    } catch (err) {
      console.warn('Falha ao buscar últimos jogos do time ' + id + ':', err.message);
    }
    done++;
    console.log(done + '/' + teamIds.size + ' times processados');
  }));

  const frios1t = buildFrios1t(games, teamStats);

  const output = {
    updatedAt: new Date().toISOString(),
    games,
    teamStats,
    frios1t,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('dados.json gerado com sucesso em ' + OUTPUT_PATH.pathname);
}

main().catch((err) => {
  console.error('Falha ao gerar dados.json:', err);
  process.exit(1);
});
