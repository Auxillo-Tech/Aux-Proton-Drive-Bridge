const MAX_WAITERS = 1000;

let tail = Promise.resolve();
let waiters = 0;

function abortError() {
  return Object.assign(new Error('Proton Drive operation cancelled'), { name: 'AbortError', cancelled: true });
}

function withProtonProcessLock(task, signal) {
  if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
  if (signal?.aborted) return Promise.reject(abortError());
  if (waiters >= MAX_WAITERS) return Promise.reject(new Error(`Proton Drive process queue is full (${MAX_WAITERS})`));

  waiters++;
  const previous = tail.catch(() => {});
  let release;
  tail = new Promise(resolve => { release = resolve; });

  return previous
    .then(() => {
      if (signal?.aborted) throw abortError();
      return task();
    })
    .finally(() => {
      waiters--;
      release();
    });
}

function getProtonProcessLockState() {
  return { waiters };
}

module.exports = { withProtonProcessLock, getProtonProcessLockState };
