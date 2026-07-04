// server/backup.js
// Scheduled daily backup of a target board. Exports the board's snapshots to a dated file
// (or per-folder files if the board won't do a single whole-board export) stored on the
// volume, and prunes anything older than the retention window.
//
// Config lives in the main config file under config.backup:
//   { enabled, cardId, timeHHMM: "03:00", retentionDays: 30 }
//
// Files are written to BACKUP_DIR (default /data/backups) as:
//   <date>__<cardLabel>__<folder-or-all>.bin

import { readdir, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSnapshotInfo, normalizeSnapshotEntry, exportSnapshots } from './board.js';
import { loadConfig, getCardById } from './config.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';

let timer = null;
const status = { lastRun: null, lastError: null, lastFiles: [], nextCheck: null };

async function ensureDir() {
  if (!existsSync(BACKUP_DIR)) await mkdir(BACKUP_DIR, { recursive: true });
}

function safe(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'x';
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Perform one backup of the configured card. Tries a single whole-board export first;
// if that fails, falls back to one file per distinct folder path found on the board.
export async function runBackupNow() {
  await ensureDir();
  const config = await loadConfig();
  const bcfg = config.backup || {};
  // Target can be a defined card id OR a raw board IP.
  let ip = null, label = null;
  const card = getCardById(config, bcfg.target);
  if (card && card.ip) { ip = card.ip; label = card.label || card.id; }
  else if (bcfg.target && /\d+\.\d+\.\d+\.\d+/.test(bcfg.target)) { ip = bcfg.target; label = bcfg.target; }
  if (!ip) {
    status.lastError = 'No valid backup target (card or IP) configured';
    return status;
  }
  label = safe(label);
  const date = todayStamp();
  const written = [];

  try {
    // Attempt 1: whole board as a single file.
    let ok = false;
    try {
      const buf = await exportSnapshots(ip, { pathWildcard: '*', snapshots: [] });
      if (buf && buf.length) {
        const file = `${date}__${label}__all.bin`;
        await writeAtomic(join(BACKUP_DIR, file), buf);
        written.push({ file, bytes: buf.length });
        ok = true;
      }
    } catch (e) {
      // fall through to per-folder
    }

    // Attempt 2 (fallback): per-folder exports.
    if (!ok) {
      const info = await getSnapshotInfo(ip);
      const entries = (info.snapshots || [])
        .map(normalizeSnapshotEntry)
        .filter((e) => e.uuid && e.deleted !== true);
      const folders = [...new Set(entries.map((e) => e.path || ''))];
      for (const folder of folders) {
        const wildcard = folder ? `${folder}*` : '*';
        try {
          const buf = await exportSnapshots(ip, { pathWildcard: wildcard, snapshots: [] });
          if (buf && buf.length) {
            const file = `${date}__${label}__${safe(folder || 'root')}.bin`;
            await writeAtomic(join(BACKUP_DIR, file), buf);
            written.push({ file, bytes: buf.length });
          }
        } catch {
          // skip this folder
        }
      }
    }

    status.lastRun = Date.now();
    status.lastError = written.length ? null : 'Export produced no files';
    status.lastFiles = written;
    console.log(`[backup] ${label} ${date}: wrote ${written.length} file(s)`);
    await prune(config);
  } catch (e) {
    status.lastError = e.message;
  }
  return status;
}

async function writeAtomic(path, buf) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
}

// Delete backups older than retentionDays (by file mtime).
async function prune(config) {
  const days = (config.backup && config.backup.retentionDays) || 30;
  const cutoff = Date.now() - days * 86400000;
  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.bin')) continue;
    try {
      const s = await stat(join(BACKUP_DIR, f));
      if (s.mtimeMs < cutoff) { await unlink(join(BACKUP_DIR, f)); console.log(`[backup] pruned ${f}`); }
    } catch {}
  }
}

export async function listBackups() {
  await ensureDir();
  let files;
  try { files = await readdir(BACKUP_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.bin')) continue;
    try {
      const s = await stat(join(BACKUP_DIR, f));
      out.push({ file: f, bytes: s.size, mtime: s.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function backupFilePath(file) {
  // Guard against path traversal — only allow plain .bin filenames.
  if (!/^[a-zA-Z0-9._-]+\.bin$/.test(file)) return null;
  return join(BACKUP_DIR, file);
}

// Scheduler: checks every minute whether the configured HH:MM has arrived today and the
// backup hasn't run yet today.
let lastRunDate = null;
export function startBackupScheduler() {
  const tick = async () => {
    status.nextCheck = Date.now();
    const config = await loadConfig();
    const bcfg = config.backup || {};
    if (!bcfg.enabled || !bcfg.target || !bcfg.timeHHMM) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const hhmm = `${p(now.getHours())}:${p(now.getMinutes())}`;
    const dateStr = todayStamp();
    if (hhmm === bcfg.timeHHMM && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      console.log(`[backup] scheduled trigger at ${hhmm}`);
      await runBackupNow();
    }
  };
  timer = setInterval(tick, 60000);
  timer.unref?.();
  console.log('[backup] scheduler started (checks each minute)');
}

export function backupStatus() {
  return { ...status };
}
