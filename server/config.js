// server/config.js
// Persists admin configuration to a JSON file on a mounted Docker volume.
// No database. Reads are cached in memory; writes are atomic (temp file + rename).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || '/data/config.json';

// Shape of config:
// {
//   cards: [                       // the 12 MV cards
//     { id: "mv1", label: "MV Card 1", ip: "10.10.60.21" }, ...
//   ],
//   panels: [                      // router touch panels, keyed by their fixed IP
//     {
//       ip: "10.10.61.11",
//       label: "PCR 101 Panel",
//       layout: "1080" | "strip",  // 1920x1080 or 1835x291
//       cardIds: ["mv1","mv2","mv3"],
//       // Optional per-head snapshot filter. If a (cardId, headUuid) key is present,
//       // ONLY the listed snapshot UUIDs are offered for that head. Absent = allow all.
//       snapshotFilters: { "mv1::<headUuid>": ["<snapUuid>", ...] }
//     }
//   ]
// }

const DEFAULT_CONFIG = { cards: [], panels: [], settings: { showUuids: true } };

let cache = null;

async function ensureDir() {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function loadConfig() {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      ...DEFAULT_CONFIG,
      ...parsed,
      settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
    };
  } catch {
    cache = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };
  }
  return cache;
}

export async function saveConfig(next) {
  await ensureDir();
  const tmp = `${CONFIG_PATH}.tmp`;
  const data = JSON.stringify(next, null, 2);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, CONFIG_PATH);
  cache = next;
  return cache;
}

export function getCardById(config, id) {
  return (config.cards || []).find((c) => c.id === id) || null;
}

export function getPanelByIp(config, ip) {
  return (config.panels || []).find((p) => p.ip === ip) || null;
}

// Returns the allowed snapshot UUID list for a (card, head) pair, or null = allow all.
export function allowedSnapshotsFor(panel, cardId, headUuid) {
  if (!panel || !panel.snapshotFilters) return null;
  const key = `${cardId}::${headUuid}`;
  const list = panel.snapshotFilters[key];
  return Array.isArray(list) ? list : null;
}
