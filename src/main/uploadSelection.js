// Upload selections from file managers (Thunar sends every selected file in one launch) and
// from the file pickers: every path is checked on its own, so one unusable item (a symlink
// that leaves the home folder, a broken link, a file deleted after it was selected) is
// refused by name and the rest still go ahead, as they do with Dolphin's one launch per file.
//
// No safety check is loosened here: each path still goes through assertSafePathInside under the
// home folder with mustExist, and only the paths that pass are ever granted or queued.
const path = require('node:path');
const { assertSafePathInside } = require('./pathSafety');

const MAX_UPLOAD_PATHS = 1000;

// Base name only, with control characters (new lines in particular) made harmless.
function displayName(localPath) {
  const base = path.basename(String(localPath ?? '')) || String(localPath ?? '');
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '?');
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function refusalReason(error) {
  const message = String(error?.message || '');
  if (/does not exist/.test(message)) return 'does not exist';
  if (/resolves outside|must stay inside/.test(message)) return 'is outside your home folder (or a link leading out of it)';
  if (/unsafe symbolic-link/.test(message)) return 'has an unsafe symbolic link';
  return 'cannot be uploaded';
}

// -> { good: [safe absolute paths, input order], refused: [{ name, reason }] }
function partitionUploadPaths(localPaths, { home, label = 'Upload path' }) {
  const good = [];
  const refused = [];
  for (const localPath of localPaths) {
    try {
      good.push(assertSafePathInside(localPath, home, label, { mustExist: true }));
    } catch (error) {
      refused.push({ name: displayName(localPath), reason: refusalReason(error) });
    }
  }
  return { good, refused };
}

// Names the refused items only, never the files that were fine.
function describeRefused(refused) {
  return refused.map(item => `${JSON.stringify(item.name)} ${item.reason}`);
}

function summariseRefused(refused) {
  return `${describeRefused(refused).join('; ')}`;
}

function assertWithinLimit(count) {
  if (count > MAX_UPLOAD_PATHS) {
    throw new Error(`Upload is limited to ${MAX_UPLOAD_PATHS} files per upload; ${count} were selected. Nothing was uploaded, select fewer files and try again.`);
  }
}

// The whole external upload command. Dependencies are passed in so the real flow can be run
// without Electron:
//   home    the home folder every path must stay inside
//   grant   (safePath) => void       records an approved path
//   enqueue (safePaths) => result    validates and queues ONE transfer
//   report  (refused, { announce }) => void   shows refused items; announce=false when the
//           caller is about to throw (the thrown message reaches the user already)
async function runUploadCommand(localPaths, { home, grant, enqueue, report }) {
  assertWithinLimit(localPaths.length);
  const { good, refused } = partitionUploadPaths(localPaths, { home });
  if (!good.length) {
    report(refused, { announce: false });
    throw new Error(`Nothing was uploaded: ${summariseRefused(refused)}`);
  }
  for (const safePath of good) grant(safePath);
  const result = enqueue(good);
  if (refused.length) report(refused, { announce: true });
  return { ...result, uploaded: good.length, refused: refused.length };
}

module.exports = {
  MAX_UPLOAD_PATHS,
  displayName,
  partitionUploadPaths,
  describeRefused,
  summariseRefused,
  assertWithinLimit,
  runUploadCommand
};
