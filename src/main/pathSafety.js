const fs = require('node:fs');
const path = require('node:path');

function isPathInside(candidate, root) {
  if (typeof candidate !== 'string' || !candidate.trim() || typeof root !== 'string' || !root.trim()) return false;
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathInside(candidate, root, label = 'Path') {
  if (!isPathInside(candidate, root)) throw new Error(`${label} must stay inside ${path.resolve(root)}`);
  return path.resolve(candidate);
}

function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for ${candidate}`);
    current = parent;
  }
  return current;
}

function assertSafePathInside(candidate, root, label = 'Path', { mustExist = false } = {}) {
  const resolved = assertPathInside(candidate, root, label);
  const rootReal = fs.realpathSync(path.resolve(root));
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`${label} does not exist`);
  if (!fs.existsSync(resolved) && (fs.lstatSync(resolved, { throwIfNoEntry: false })?.isSymbolicLink() ||
      fs.lstatSync(path.dirname(resolved), { throwIfNoEntry: false })?.isSymbolicLink())) {
    throw new Error(`${label} has an unsafe symbolic-link parent`);
  }
  const existing = nearestExistingAncestor(resolved);
  const realExisting = fs.realpathSync(existing);
  if (!isPathInside(realExisting, rootReal)) throw new Error(`${label} resolves outside ${rootReal}`);
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved);
    if (!isPathInside(realResolved, rootReal)) throw new Error(`${label} resolves outside ${rootReal}`);
  }
  return resolved;
}

module.exports = { isPathInside, assertPathInside, assertSafePathInside };
