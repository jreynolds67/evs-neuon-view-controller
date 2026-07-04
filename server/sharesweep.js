// server/sharesweep.js
// Periodically polls every card and sets `shared: true` on any snapshot that isn't
// already shared, so newly-created snapshots propagate across boards automatically.
//
// Controlled by:
//   SHARE_SWEEP_ENABLE   "true" to run (default false — opt in)
//   SHARE_SWEEP_INTERVAL_MS  poll interval (default 60000)

import { getSnapshotInfo, normalizeSnapshotEntry, setSnapshotShared } from './board.js';
import { loadConfig } from './config.js';

const ENABLED = String(process.env.SHARE_SWEEP_ENABLE || 'false') === 'true';
const INTERVAL_MS = parseInt(process.env.SHARE_SWEEP_INTERVAL_MS || '60000', 10);

let running = false;
let timer = null;
const status = { lastRun: null, lastError: null, shared: 0, checked: 0, enabled: ENABLED };

async function sweepOnce() {
  if (running) return; // never overlap runs
  running = true;
  let shared = 0, checked = 0;
  try {
    const config = await loadConfig();
    for (const card of config.cards || []) {
      if (!card.ip) continue;
      let info;
      try {
        info = await getSnapshotInfo(card.ip);
      } catch {
        continue; // unreachable card — skip this cycle
      }
      const entries = (info.snapshots || [])
        .map(normalizeSnapshotEntry)
        .filter((e) => e.uuid && e.deleted !== true);
      for (const e of entries) {
        checked++;
        if (e.shared === true) continue; // already shared
        try {
          await setSnapshotShared(card.ip, e, true);
          shared++;
        } catch {
          // leave for next cycle
        }
      }
    }
    status.lastRun = Date.now();
    status.lastError = null;
    status.shared = shared;
    status.checked = checked;
    if (shared) console.log(`[share-sweep] shared ${shared} snapshot(s) across ${(config.cards || []).length} card(s)`);
  } catch (e) {
    status.lastError = e.message;
  } finally {
    running = false;
  }
}

export function startShareSweep() {
  if (!ENABLED) {
    console.log('[share-sweep] disabled (set SHARE_SWEEP_ENABLE=true to enable)');
    return;
  }
  console.log(`[share-sweep] enabled, every ${INTERVAL_MS}ms`);
  sweepOnce();
  timer = setInterval(sweepOnce, INTERVAL_MS);
  timer.unref?.();
}

export function shareSweepStatus() {
  return { ...status, intervalMs: INTERVAL_MS };
}

// Allow a manual trigger from the admin API.
export async function runShareSweepNow() {
  await sweepOnce();
  return shareSweepStatus();
}
