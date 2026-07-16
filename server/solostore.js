// server/solostore.js
// Persisted record of which heads are currently "soloed" (one window blown up to fullscreen)
// and the full widget layout captured before the solo, so any panel can restore the mosaic —
// and a container restart can't strand an on-air head with a single fullscreen window.
//
// Shape on disk (/data/solo-state.json):
//   { "<cardId>::<headUuid>": { targetUuid, widgets: [<full WidgetGet>...], at } }
//
// Kept small: written only on solo/unsolo (operator actions), never on the hot poll path.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SOLO_PATH = process.env.SOLO_STATE_PATH || '/data/solo-state.json';

let store = {};        // key -> capture
let loaded = false;

function key(cardId, headUuid) { return `${cardId}::${headUuid}`; }

// Load once at startup. A missing file is normal (nothing soloed). A malformed file is logged
// and treated as empty rather than crashing the app.
export async function loadSoloStore() {
  if (loaded) return;
  try {
    const raw = await readFile(SOLO_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    store = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error(`[solo] failed to load ${SOLO_PATH}: ${e.message} — starting with no soloed heads.`);
    }
    store = {};
  }
  loaded = true;
}

async function persist() {
  const dir = dirname(SOLO_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${SOLO_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await rename(tmp, SOLO_PATH);
}

// Sync read — safe on the poll path because the store is fully loaded at boot.
export function isSoloed(cardId, headUuid) {
  return !!store[key(cardId, headUuid)];
}

export function getSolo(cardId, headUuid) {
  return store[key(cardId, headUuid)] || null;
}

export async function setSolo(cardId, headUuid, capture) {
  store[key(cardId, headUuid)] = capture;
  await persist();
}

export async function clearSolo(cardId, headUuid) {
  if (store[key(cardId, headUuid)]) {
    delete store[key(cardId, headUuid)];
    await persist();
  }
}
