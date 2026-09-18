# Weekly TD Parlay

A GitHub Pages site for the league's weekly 12-leg anytime-TD-scorer parlay.

- **Matchups + odds**: pulled from [The Odds API](https://the-odds-api.com) (DraftKings + FanDuel
  anytime-TD-scorer lines), refreshed automatically once a day by a GitHub Action
  (`.github/workflows/update-odds.yml`), which writes `odds.json`. Thursday games are excluded.
  Players are tagged with their team (via ESPN's free roster API, since the odds API doesn't
  include team info) so the page can group them.
- **Manual "Refresh odds" button**: lets anyone pull fresh odds straight into their own browser,
  gated to Wednesday-Sunday 1pm ET, max 3 times/day, 3-hour cooldown between clicks (see `README`
  security note below -- this uses a client-side copy of the odds API key).
- **Fantasy team names**: pulled live, client-side, from the league's public ESPN API on every
  page load (league 96984283) -- no hardcoded list to go stale.
- **Picks**: stored in Firebase Firestore, and vandalism-proof by construction -- see "How picks
  stay tamper-proof" below.
- **Other entries**: a free-for-all notes board at the bottom (pick your team, type anything) for
  mistakes or off-parlay bets. Unlimited entries per team, no locking -- just an append-only log.
- **League Holdings** (top of page): a value chart for the league's BTC + SPCX + cash position.
  No database involved at all -- see below.

## How picks stay tamper-proof

Every write (a pick, a team lock, a note) is *create-only* in `firestore.rules`: once a document
exists at a given path, any further write to that same path is treated as an "update," which the
rules deny. There's no code path for editing or deleting something that already exists -- not from
this page, not from anyone with the public Firebase config, not from us.

A pick submission writes two documents in one atomic batch:
- `picks/{weekId}/entries/{matchupId}` -- enforces one pick per **matchup**.
- `picks/{weekId}/teamLocks/{teamSlug}` -- enforces one pick per **fantasy team**.

If either the matchup or the team is already taken, the whole batch is rejected -- so a race
between two people can't double-book a matchup or let one team sneak in two picks.
`otherEntries/{weekId}/notes/{noteId}` has no such lock (any team can add as many notes as they
want), but is still create-only so old notes can't be edited or erased.

## League Holdings (BTC + SPCX + cash value chart)

Shows the league's holdings value (10.328119 SPCX shares + 0.01919374 BTC + $9.82 cash, edit the
constants at the top of `scripts/fetch-portfolio.mjs` if positions change) as a 3-line chart from
Sept 10, 2026 to today, plus the current total and each asset's value.

**No signup, no API key, no database** -- unlike the odds data, this needed neither. SPCX price
history comes from Yahoo Finance's free chart endpoint, and BTC's from CoinGecko's free endpoint;
both are genuinely keyless, but Yahoo blocks direct *browser* requests (no CORS headers), so it
can't be called client-side the way the old crypto-only version of this page did. Since CORS is a
browser-only restriction, `.github/workflows/update-portfolio.yml` calls it from a GitHub Action
instead (plain server-to-server HTTP, no restriction) every 30 minutes and writes `portfolio.json`,
which the page reads directly. It costs nothing extra to run this often -- public repos get
unlimited Action minutes, and neither API involves a metered key. The chart's last point is always
today's *live* current value (from the same live numbers as the headline total), even before
today's trading day has a finalized closing price.

## One-time setup (you'll need to do these two account signups yourself)

### 1. The Odds API key (free, no card)

1. Go to https://the-odds-api.com and sign up for a free API key (500 requests/month).
2. In this GitHub repo: **Settings -> Secrets and variables -> Actions -> New repository secret**.
   - Name: `ODDS_API_KEY`
   - Value: the key you got.
3. That's it -- the workflow already reads `secrets.ODDS_API_KEY`.

Budget note: each daily run costs about 1 credit per NFL game that week (~15), so ~450/month at
the default once-a-day schedule. Check the Action's log output (it prints the API's
`x-requests-remaining` header) before adding more scheduled runs in `update-odds.yml`.

**Security note on the manual refresh button:** `index.html` also embeds a copy of the odds API
key (`ODDS_API_KEY_CLIENT`) so the "Refresh odds" button can call The Odds API directly from the
browser without a server. Unlike the Firebase config, this key genuinely is sensitive -- anyone who
views the page source can read it and use up your free-tier quota. The Wed-Sun/cooldown/3-per-day
limits in the code are a courtesy speed bump for your own league, not real security. If you'd
rather not expose a key at all, delete the refresh button/`fetchLiveOdds` code and rely solely on
the daily Action (which keeps its key private as a repo secret). Otherwise, treat this as a
low-stakes, easily-rotated key -- get a second free key from the-odds-api.com dedicated to the
client button if you want to limit blast radius, and just regenerate it if it's ever abused.

### 2. Firebase project (free Spark plan)

1. Go to https://console.firebase.google.com, create a new project (Google Analytics not needed).
2. In the project, go to **Build -> Firestore Database -> Create database** (start in production mode,
   pick any region).
3. Go to the Firestore **Rules** tab and paste in the contents of `firestore.rules` from this repo,
   then **Publish**.
4. Go to **Project settings -> General -> Your apps -> Add app -> Web** (the `</>` icon), register
   the app (any nickname), and copy the `firebaseConfig` object it gives you.
5. Open `index.html` in this repo and replace the placeholder `firebaseConfig` object (search for
   `REPLACE_ME`) with the one you copied.

This config is not a secret -- it just identifies which Firebase project to talk to. All the actual
access control lives in `firestore.rules`.

## Files

- `index.html` -- the page itself.
- `odds.json` -- data file the Action overwrites; the page fetches it directly (same-origin, no API key exposed).
- `portfolio.json` -- data file the portfolio Action overwrites; holds current + historical league holdings value.
- `scripts/fetch-odds.mjs` -- Node script the Action runs to build `odds.json` (also tags players by team).
- `scripts/fetch-portfolio.mjs` -- Node script the Action runs to build `portfolio.json`.
- `.github/workflows/update-odds.yml` -- the daily odds scheduled job.
- `.github/workflows/update-portfolio.yml` -- the 30-minute holdings-value scheduled job.
- `firestore.rules` -- paste into the Firebase console; this is what makes everything vandalism-proof.

## Notes / things worth knowing

- Thursday night games are excluded from `odds.json` on purpose (see `isThursdayGame` in
  `scripts/fetch-odds.mjs`) -- only Sunday/Monday (and Saturday late-season) games show up.
- Team defense/special-teams TD props (e.g. "Falcons D/ST") are filtered out -- this is a
  player-pick parlay, and DraftKings/FanDuel don't even name the same defense consistently.
- Player-to-team tagging comes from matching names against ESPN's roster API; a handful of players
  (recent signings/practice-squad call-ups not yet reflected on ESPN) may not match and show up
  under an "Other / unmatched" group instead of their real team.
- If a game's anytime-TD odds haven't been posted by the sportsbooks yet (common early in the week),
  that matchup shows "TD odds not posted yet" instead of a player list, until the next refresh picks
  them up.
- The team dropdown greys out (marks "already picked") any fantasy team that already has a pick this
  week -- this now reflects the real `teamLocks` database state, not just a UI guess.
- Everything is a static site (no server needed) -- GitHub Pages serves `index.html`, `odds.json`, etc.
  directly.
