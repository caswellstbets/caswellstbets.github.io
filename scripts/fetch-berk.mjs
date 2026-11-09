// Pulls Berk's pick notifications from his public ntfy topic and appends any
// new ones to berk_picks.json at the repo root, for "Berk's Dumbass Corner".
// ntfy only keeps messages for ~12 hours, so this file is the permanent
// record: messages are only ever added (deduped by ntfy id), never edited or
// removed. Run by .github/workflows/update-berk.yml every 5 minutes (and by
// hand via "Run workflow" in the GitHub Actions tab).

import { readFile, writeFile } from 'node:fs/promises';

const TOPIC = 'berko-nba-20260414-172920';
const OUT = 'berk_picks.json';

async function fetchNtfy() {
  const res = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=all`);
  if (!res.ok) throw new Error(`ntfy fetch failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((m) => m.event === 'message');
}

async function main() {
  let data = { topic: TOPIC, updatedAt: null, messages: [] };
  try {
    data = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    // First run: start from an empty record.
  }

  const known = new Set(data.messages.map((m) => m.id));
  const fresh = (await fetchNtfy())
    .filter((m) => !known.has(m.id))
    .map(({ id, time, title, message, tags, priority }) => ({ id, time, title, message, tags, priority }));

  if (!fresh.length) {
    console.log('No new messages.');
    return;
  }

  data.messages = [...data.messages, ...fresh].sort((a, b) => a.time - b.time);
  data.updatedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`Added ${fresh.length} new message(s); ${data.messages.length} total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
