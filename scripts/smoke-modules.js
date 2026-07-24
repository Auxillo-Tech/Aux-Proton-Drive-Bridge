#!/usr/bin/env node
/**
 * smoke-modules.js — Verify every module loads without errors
 * Does NOT touch the real proton-drive CLI or Proton Drive data.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');

console.log('=== Module smoke test ===\n');

// 1. Core modules (no deps past node built-ins)
console.log('1. Loading core modules…');
require(path.join(root, 'src/main/protonCli'));
console.log('   ✓ protonCli');
require(path.join(root, 'src/main/operationStore'));
console.log('   ✓ operationStore');
require(path.join(root, 'src/main/profileStore'));
console.log('   ✓ profileStore');
require(path.join(root, 'src/main/progressParser'));
console.log('   ✓ progressParser');

// 2. syncDb (needs better-sqlite3)
console.log('\n2. Loading syncDb…');
const { createSyncDb } = require(path.join(root, 'src/main/syncDb'));
const tmpDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sync-')), 'smoke.db');
const syncDb = createSyncDb(tmpDbPath);
console.log('   ✓ syncDb created');
const stats = syncDb.getStats();
console.log(`   DB: ${stats.fileCount} files, ${stats.eventCount} events, ${(stats.dbSize / 1024).toFixed(0)} KB`);

// 3. Transfer queue
console.log('\n3. Loading transferQueue…');
const { createTransferQueue } = require(path.join(root, 'src/main/transferQueue'));
const tq = createTransferQueue({ concurrency: 2, syncDb });
console.log('   ✓ transferQueue created');
console.log(`   concurrency: ${tq.getState().concurrency}`);

// 4. Conflict store
console.log('\n4. Loading conflictStore…');
const { createConflictStore } = require(path.join(root, 'src/main/conflictStore'));
const cs = createConflictStore(syncDb);
console.log('   ✓ conflictStore created');
console.log(`   types: ${Object.keys(cs.CONFLICT_TYPES).join(', ')}`);

// 5. Sync engine (no touch real CLI)
console.log('\n5. Loading syncEngine…');
const { createSyncEngine, SYNC_MODES } = require(path.join(root, 'src/main/syncEngine'));
const se = createSyncEngine({ syncDb, transferQueue: tq, conflictStore: cs });
console.log('   ✓ syncEngine created');
console.log(`   modes: ${Object.values(SYNC_MODES).join(', ')}`);
se.stop(); // ensure clean

// 6. Auto-updater
console.log('\n6. Loading autoUpdater…');
const { createAutoUpdater } = require(path.join(root, 'src/main/autoUpdater'));
const au = createAutoUpdater({ currentVersion: '0.3.0' });
console.log(`   ✓ autoUpdater created (version ${au.parseVersion('0.3.0').major}.${au.parseVersion('0.3.0').minor}.${au.parseVersion('0.3.0').patch})`);

// 7. FUSE mount
console.log('\n7. Loading fuseMount…');
const { createFuseMount, MOUNT_STATE } = require(path.join(root, 'src/main/fuseMount'));
const fm = createFuseMount({ mountPoint: path.join(os.tmpdir(), 'smoke-fuse-test') });
console.log('   ✓ fuseMount created');
console.log(`   status: ${fm.getStatus().state}, mounts: ${Object.values(MOUNT_STATE).join(', ')}`);

// 8. Cleanup
console.log('\n8. Cleanup…');
syncDb.close();
fm.destroy();
tq.destroy();
try { fs.rmSync(path.dirname(tmpDbPath), { recursive: true }); } catch {}

console.log('\n=== ALL MODULES LOADED SUCCESSFULLY ===');
console.log('No real Proton Drive CLI or data was accessed.');
