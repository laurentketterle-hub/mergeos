#!/usr/bin/env node

/**
 * check-desktop-release.mjs — Gomi IDE desktop release checker
 *
 * Fetches the latest Gomi desktop release metadata from the public
 * download manifest and prints a summary table to stdout.
 *
 * Usage:
 *   node scripts/check-desktop-release.mjs
 *   node scripts/check-desktop-release.mjs --json
 *
 * Part of prj_0127 / tsk_0128 — MergeOS bounty #244
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MANIFEST_URL =
  'https://raw.githubusercontent.com/mergeos-bounties/Gomi/main/public/downloads/gomi-windows-latest.json';

/**
 * Fetch the latest release manifest from the Gomi repo.
 * @returns {Promise<object>}
 */
async function fetchManifest() {
  const resp = await fetch(MANIFEST_URL, {
    headers: { 'User-Agent': 'MergeOS-Gomi-ReleaseChecker/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

/**
 * Check if a local manifest file exists and compare versions.
 * @param {object} remote - the remote manifest
 * @returns {Promise<{localVersion: string|null, remoteVersion: string, upToDate: boolean}>}
 */
async function compareWithLocal(remote) {
  const localPath = resolve(REPO_ROOT, 'frontend', 'public', 'downloads', 'gomi-windows-latest.json');
  let localVersion = null;
  try {
    const localRaw = await readFile(localPath, 'utf-8');
    const local = JSON.parse(localRaw);
    localVersion = local.version || null;
  } catch {
    // No local manifest — first run
  }
  return {
    localVersion,
    remoteVersion: remote.version || 'unknown',
    upToDate: localVersion === remote.version,
  };
}

/**
 * Format bytes to human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes == null) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

// --- Main ---
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');

try {
  const remote = await fetchManifest();
  const comparison = await compareWithLocal(remote);

  if (jsonOutput) {
    console.log(JSON.stringify({
      remoteVersion: comparison.remoteVersion,
      localVersion: comparison.localVersion,
      upToDate: comparison.upToDate,
      releaseDate: remote.date || null,
      fileSize: remote.size || null,
      sha256: remote.sha256 || null,
      downloadUrl: remote.url || null,
    }, null, 2));
  } else {
    console.log('');
    console.log('  Gomi IDE Desktop Release Checker');
    console.log('  =================================');
    console.log(`  Remote version : ${comparison.remoteVersion}`);
    console.log(`  Local version  : ${comparison.localVersion || '(not cached)'}`);
    console.log(`  Up to date     : ${comparison.upToDate ? '✅ Yes' : '❌ No'}`);
    if (remote.date) console.log(`  Release date   : ${remote.date}`);
    if (remote.size) console.log(`  File size      : ${formatSize(remote.size)}`);
    if (remote.sha256) console.log(`  SHA256         : ${remote.sha256.substring(0, 16)}...`);
    if (remote.url) console.log(`  Download URL   : ${remote.url}`);
    console.log('');
  }
} catch (err) {
  console.error(`[check-desktop-release] Error: ${err.message}`);
  process.exit(1);
}
