// Pulls this week's NFL games + anytime-TD-scorer odds (DraftKings + FanDuel)
// from The Odds API, tags each player with their team (via ESPN's free roster
// API, since the odds API doesn't include team info), and writes odds.json at
// the repo root. Run by .github/workflows/update-odds.yml on a schedule (and
// by hand via "Run workflow" in the GitHub Actions tab).

import { writeFile } from 'node:fs/promises';

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error('Missing ODDS_API_KEY secret/env var.');
  process.exit(1);
}

const SPORT = 'americanfootball_nfl';
const BASE = `https://api.the-odds-api.com/v4/sports/${SPORT}`;
const BOOKMAKERS = ['draftkings', 'fanduel'];
const ESPN_TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=32';
const ESPN_ROSTER_URL = (teamId) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;

function mondayOf(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
function isThursdayGame(commenceTimeIso) {
  // Kickoff time is UTC; a Thursday-night ET game can already show as Friday in UTC,
  // so check the weekday in the game's own (US Eastern) timezone, not UTC.
  return ET_WEEKDAY.format(new Date(commenceTimeIso)) === 'Thu';
}

function logQuota(res, label) {
  console.log(
    `[${label}] requests remaining=${res.headers.get('x-requests-remaining')} used=${res.headers.get('x-requests-used')}`
  );
}

function normalizeName(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/, '')
    .replace(/[^a-z\s-]/g, '')
    .trim();
}

// Builds normalizedPlayerName -> teamDisplayName for every team appearing in
// this week's games, by reading each team's roster from ESPN's free API.
async function buildPlayerTeamMap(teamDisplayNames) {
  const teamsRes = await fetch(ESPN_TEAMS_URL);
  if (!teamsRes.ok) {
    console.warn(`ESPN teams list fetch failed: ${teamsRes.status}; player rows will be untagged.`);
    return new Map();
  }
  const teamsData = await teamsRes.json();
  const allTeams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];
  const idByName = new Map(allTeams.map((t) => [t.team.displayName, t.team.id]));

  const nameToTeam = new Map();
  for (const teamName of teamDisplayNames) {
    const teamId = idByName.get(teamName);
    if (!teamId) {
      console.warn(`No ESPN team id found for "${teamName}"; its players will be untagged.`);
      continue;
    }
    try {
      const res = await fetch(ESPN_ROSTER_URL(teamId));
      if (!res.ok) {
        console.warn(`Roster fetch failed for ${teamName}: ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const group of data.athletes || []) {
        for (const athlete of group.items || []) {
          if (athlete.fullName) {
            nameToTeam.set(normalizeName(athlete.fullName), teamName);
          }
        }
      }
    } catch (err) {
      console.warn(`Roster fetch error for ${teamName}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return nameToTeam;
}

async function main() {
  const eventsRes = await fetch(`${BASE}/events?apiKey=${API_KEY}`);
  if (!eventsRes.ok) {
    throw new Error(`events fetch failed: ${eventsRes.status} ${await eventsRes.text()}`);
  }
  logQuota(eventsRes, 'events');
  const allEvents = await eventsRes.json();

  const now = Date.now();
  const windowEnd = now + 8 * 24 * 60 * 60 * 1000;
  const weekEvents = allEvents.filter((e) => {
    const t = new Date(e.commence_time).getTime();
    return t >= now - 12 * 60 * 60 * 1000 && t <= windowEnd && !isThursdayGame(e.commence_time);
  });

  if (weekEvents.length === 0) {
    console.log('No upcoming NFL events in the current window; leaving odds.json untouched.');
    return;
  }

  weekEvents.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
  const weekId = `week-of-${mondayOf(weekEvents[0].commence_time)}`;

  const teamNames = new Set();
  for (const ev of weekEvents) {
    teamNames.add(ev.home_team);
    teamNames.add(ev.away_team);
  }
  console.log(`Building player->team map for ${teamNames.size} teams...`);
  const playerTeamMap = await buildPlayerTeamMap(teamNames);

  const games = [];
  for (const ev of weekEvents) {
    const url =
      `${BASE}/events/${ev.id}/odds?apiKey=${API_KEY}&regions=us` +
      `&markets=player_anytime_td&oddsFormat=american&bookmakers=${BOOKMAKERS.join(',')}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`odds fetch failed for ${ev.away_team} @ ${ev.home_team}: ${res.status} ${await res.text()}`);
      continue;
    }
    logQuota(res, `${ev.away_team} @ ${ev.home_team}`);
    const data = await res.json();

    const playersByName = new Map();
    for (const bk of data.bookmakers || []) {
      const market = bk.markets?.find((m) => m.key === 'player_anytime_td');
      if (!market) continue;
      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        if (!player) continue;
        // Skip team defense/special-teams entries (e.g. "Falcons D/ST" on DraftKings vs.
        // "Falcons Defense" on FanDuel for the same market) -- this is a player-pick parlay,
        // and the two books don't even name the same defense consistently.
        if (/\bd\/st\b|\bdefense\b/i.test(player)) continue;
        if (!playersByName.has(player)) playersByName.set(player, {});
        playersByName.get(player)[bk.key] = outcome.price;
      }
    }

    const players = Array.from(playersByName.entries()).map(([name, odds]) => ({
      name,
      team: playerTeamMap.get(normalizeName(name)) || null,
      odds,
    }));
    // Away team first (matches how the matchup title reads "Away @ Home"), then home, then
    // anyone we couldn't match to a roster, alphabetical within each group.
    players.sort((a, b) => {
      const rank = (p) => (p.team === ev.away_team ? 0 : p.team === ev.home_team ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

    games.push({
      id: ev.id,
      home: ev.home_team,
      away: ev.away_team,
      commenceTime: ev.commence_time,
      players,
    });

    // Be polite to the API between per-event calls.
    await new Promise((r) => setTimeout(r, 250));
  }

  const out = {
    updatedAt: new Date().toISOString(),
    weekId,
    bookmakers: BOOKMAKERS,
    games,
  };

  await writeFile('odds.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote odds.json: ${games.length} games for ${weekId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
