'use strict';
import LightningFS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

const fs = new LightningFS('notig-fs');
const pfs = fs.promises;

const dir = '/notig';
const notesDir = `${dir}/notes`;
const url = `${window.location.origin}/git/notig.git`;
const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

const author = {
  name: 'notig user',
  email: 'user@example.com',
};

/**
 * @param {string} [remote]
 * @returns {Promise<import('isomorphic-git').ServerRef[]>}
 */
export function getRemoteRefs(remote = 'origin') {
  return git.listServerRefs({
    http,
    url,
    prefix: 'refs/heads',
  });
}

/**
 * @param {object} options
 * @param {string} [options.url]
 * @param {string} [options.ref]
 * @param {boolean} [options.singleBranch]
 * @param {number} [options.depth]
 * @param {Date} [options.since]
 * @param {string[]} [options.exclude]
 * @param {boolean} [options.relative]
 * @param {Object<string, string>} [options.headers]
 * @returns {Promise<void>}
 */
export function clone(options = {}) {
  const defaults = {
    fs,
    http,
    dir,
    url,
    dir,
    url,
    singleBranch: true,
  };
  return git.clone({ ...defaults, ...options });
}

/**
 * @param {object} options
 * @param {string} [options.defaultBranch]
 * @param {boolean} [options.bare]
 * @returns {Promise<void>}
 */
export function init(options = {}) {
  const defaults = { fs, dir, defaultBranch: 'main' };
  return git.init({ ...defaults, ...options });
}

/**
 * @param {{ filepath?: string; ref?: string; depth?: number; since?: Date }} options
 * @typedef {{message: string; tree: string; parent: string[]; author: {name: string; email: string; timestamp: number; timezoneOffset: number}; committer: {name: string; email: string; timestamp: number; timezoneOffset: number}}} CommitObject
 * @returns {Promise<{oid: string; commit: CommitObject; payload: string}[]>}
 */
export function log(options = {}) {
  const defaults = { fs, dir };
  const nextOptions = { ...options };
  if (nextOptions.filepath) {
    nextOptions.filepath = toRepoPath(nextOptions.filepath);
  }
  return git.log({ ...defaults, ...nextOptions });
}

/**
 * @param {{ filepath?: string }} options
 * @returns {Promise<void>}
 */
export function add(options = {}) {
  const defaults = { fs, dir };
  const nextOptions = { ...options };
  if (nextOptions.filepath) {
    nextOptions.filepath = toRepoPath(nextOptions.filepath);
  }
  return git.add({ ...defaults, ...nextOptions });
}

/**
 * @param {object} options
 * @param {string} [options.message]
 * @param {Object} [options.author]
 * @param {string} [options.author.name]
 * @param {string} [options.author.email]
 * @param {Object} [options.committer]
 * @param {string} [options.committer.name]
 * @param {string} [options.committer.email]
 * @param {string} [options.signingKey]
 * @returns {Promise<string>} The SHA-1 object id of the commit
 */
export function commit(options = {}) {
  const defaults = { fs, dir, author, message: 'update' };
  return git.commit({ ...defaults, ...options });
}

/**
 * @param {{ filepath?: string }} options
 * @returns {Promise<void>}
 */
export function remove(options = {}) {
  const defaults = { fs, dir };
  const nextOptions = { ...options };
  if (nextOptions.filepath) {
    nextOptions.filepath = toRepoPath(nextOptions.filepath);
  }
  return git.remove({ ...defaults, ...nextOptions });
}

/**
 * @param {object} options
 * @param {string} [options.remote]
 * @param {string} [options.ref]
 * @param {string} [options.remoteRef]
 * @param {boolean} [options.force]
 * @returns {Promise<import('isomorphic-git').PushResult>}
 */
export async function push(options = {}) {
  const defaults = { fs, dir, http, url, remote: 'origin' };
  let ref = options.ref;

  if (!ref) {
    const branch = await git.currentBranch({ fs, dir });
    if (branch) {
      ref = branch;
    }
  }

  return git.push({ ...defaults, ...options, ref });
}

/**
 * @param {object} options
 * @param {string} [options.remote]
 * @param {string} [options.ref]
 * @param {boolean} [options.singleBranch]
 * @param {boolean} [options.fastForward]
 * @param {Object<string, string>} [options.headers]
 * @param {Object} [options.author]
 * @returns {Promise<void>}
 */
export function pull(options = {}) {
  const defaults = {
    fs,
    dir,
    http,
    url,
    remote: 'origin',
    ref: 'main',
    abortOnConflict: false,
  };
  return git.pull({ ...defaults, ...options });
}

/**
 * @param {object} options
 * @param {string} [options.remote]
 * @param {string} [options.ref]
 * @param {boolean} [options.singleBranch]
 * @param {number} [options.depth]
 * @param {boolean} [options.relative]
 * @param {Object<string, string>} [options.headers]
 * @returns {Promise<import('isomorphic-git').FetchResult>}
 */
export function fetch(options = {}) {
  const defaults = {
    fs,
    dir,
    http,
    remote: 'origin',
    ref: 'main',
    singleBranch: true,
  };
  return git.fetch({ ...defaults, ...options });
}

/**
 * @param {object} options
 * @param {string} [options.ours]
 * @param {string} [options.theirs]
 * @param {boolean} [options.fastForward]
 * @param {boolean} [options.abortOnConflict]
 * @param {Object} [options.author]
 * @returns {Promise<import('isomorphic-git').MergeResult>}
 */
export function merge(options = {}) {
  const defaults = {
    fs,
    dir,
    ours: 'main',
    theirs: 'origin/main',
    abortOnConflict: false,
  };
  return git.merge({ ...defaults, ...options });
}

/**
 * @param {string} ref
 * @returns {Promise<string>}
 */
export function resolveRef(ref) {
  return git.resolveRef({ fs, dir, ref });
}

/**
 * @param {string} ref
 * @param {string} value
 * @param {boolean} [force]
 */
export function writeRef(ref, value, force = false) {
  return git.writeRef({ fs, dir, ref, value, force });
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMergeConflictError(err) {
  return err instanceof git.Errors.MergeConflictError;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUnmergedPathsError(err) {
  return err instanceof git.Errors.UnmergedPathsError;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPushRejectedError(err) {
  return err instanceof git.Errors.PushRejectedError;
}

/**
 * @param {string | null} localOid
 * @param {string | null} remoteOid
 * @returns {Promise<Set<string>>}
 */
export async function getChangedNotePaths(localOid, remoteOid) {
  const changed = new Set();
  if (!localOid || !remoteOid) return changed;
  if (localOid === remoteOid) return changed;
  const results = await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: localOid }), git.TREE({ ref: remoteOid })],
    map: async (filepath, [localEntry, remoteEntry]) => {
      if (filepath === '.') return undefined;
      if (!filepath.startsWith('notes/')) return undefined;
      const [localType, remoteType] = await Promise.all([
        localEntry ? localEntry.type() : null,
        remoteEntry ? remoteEntry.type() : null,
      ]);
      if (localType === 'tree' || remoteType === 'tree') {
        return undefined;
      }
      if (!localEntry || !remoteEntry) return filepath;
      const [localEntryOid, remoteEntryOid] = await Promise.all([
        localEntry.oid(),
        remoteEntry.oid(),
      ]);
      if (localEntryOid !== remoteEntryOid) return filepath;
      return undefined;
    },
  });
  results.forEach((/** @type {any} */ filepath) => {
    if (typeof filepath === 'string') {
      changed.add(filepath);
    }
  });
  return changed;
}

/**
 * @param {{ filepath?: string; oid?: string; }} options
 * @returns {Promise<import('isomorphic-git').ReadBlobResult>}
 */
export function readBlob(options = {}) {
  const defaults = { fs, dir };
  const nextOptions = { ...options };
  if (nextOptions.filepath) {
    nextOptions.filepath = toRepoPath(nextOptions.filepath);
  }
  return git.readBlob({ ...defaults, ...nextOptions });
}

/**
 * @param {{ filepath: string; }} options
 * @returns {Promise<string>} 'ignored'|'unmodified'|'modified'|'added'|'deleted'|'absent'|'*text'
 */
export function status(options) {
  const defaults = { fs, dir };
  const nextOptions = { ...options };
  if (typeof nextOptions.filepath === 'string') {
    nextOptions.filepath = toRepoPath(nextOptions.filepath);
  }
  return git.status({ ...defaults, ...nextOptions });
}

/**
 * @param {{ filter?: (path: string) => boolean; dirs?: string[]; ref?: string; }} options
 * @returns {Promise<Array<[string, number, number, number]>>}
 */
export function statusMatrix(options = {}) {
  const defaults = { fs, dir };
  return git.statusMatrix({ ...defaults, ...options });
}

/**
 * @param {{ oids: string[] }} options
 * @returns {Promise<string[]>}
 */
export function findMergeBase(options) {
  const defaults = { fs, dir };
  return git.findMergeBase({ ...defaults, ...options });
}

/**
 * @param {{ oid: string; }} options
 * @returns {Promise<import('isomorphic-git').ReadCommitResult>}
 */
export function readCommit(options) {
  const defaults = { fs, dir };
  return git.readCommit({ ...defaults, ...options });
}

/**
 * @param {{ path: string; }} options
 * @returns {Promise<any>}
 */
export function getConfig(options = {}) {
  const defaults = { fs, dir };
  return git.getConfig({ ...defaults, ...options });
}

/**
 * @param {{ path: string; value: any; }} options
 * @returns {Promise<void>}
 */
export function setConfig(options = {}) {
  const defaults = { fs, dir };
  return git.setConfig({ ...defaults, ...options });
}

/**
 * @returns {Promise<boolean>}
 */
export async function isUpToDateWithRemote() {
  try {
    await fetch();
  } catch (err) {
    console.error(err);
    return false;
  }

  const localRef = 'refs/heads/main';
  const remoteRef = 'refs/remotes/origin/main';
  const [localOid, remoteOid] = await Promise.all([
    git.resolveRef({ fs, dir, ref: localRef }).catch(() => null),
    git.resolveRef({ fs, dir, ref: remoteRef }).catch(() => null),
  ]);
  return Boolean(localOid && remoteOid && localOid === remoteOid);
}

/**
 * @param {string} oid
 * @param {string} filepath
 * @returns {Promise<string | null>}
 */
export async function getBlobOidAtCommit(oid, filepath) {
  try {
    const result = await readBlob({ oid, filepath: toRepoPath(filepath) });
    return result.oid ?? null;
  } catch (err) {
    const code = getErrorCode(err);
    if (code === 'NotFoundError' || code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * @param {string} oid
 * @param {string} filepath
 * @returns {Promise<string>}
 */
export async function getHistoryContent(oid, filepath) {
  const { blob } = await git.readBlob({ fs, dir, oid, filepath: toRepoPath(filepath) });
  const decoder = new TextDecoder();
  return decoder.decode(blob);
}

/**
 * @param {string} filepath
 * @param {number} [depth]
 * @returns {Promise<Awaited<ReturnType<typeof log>>>}
 */
export async function logFileChanges(filepath, depth) {
  const repoPath = toRepoPath(filepath);
  const commits = await log({ filepath: repoPath, depth });
  /** @type {Awaited<ReturnType<typeof log>>} */
  const filtered = [];
  for (const entry of commits) {
    const parentOid = entry.commit?.parent?.[0] ?? null;
    const currentBlob = await getBlobOidAtCommit(entry.oid, filepath);
    const parentBlob = parentOid
      ? await getBlobOidAtCommit(parentOid, filepath)
      : null;
    if (currentBlob !== parentBlob) {
      filtered.push(entry);
    }
  }
  return filtered;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function toRepoPath(filePath) {
  if (filePath.startsWith(`${dir}/`)) {
    return filePath.slice(dir.length + 1);
  }
  return filePath;
}

/**
 * @param {string} repoPath
 * @returns {string}
 */
function toFsPath(repoPath) {
  if (repoPath.startsWith(`${dir}/`)) {
    return repoPath;
  }
  if (repoPath.startsWith('/')) {
    return `${dir}${repoPath}`;
  }
  return `${dir}/${repoPath}`;
}

/**
 * @param {string} repoPath
 * @returns {Promise<string>}
 */
export function readNoteFile(repoPath) {
  return pfs.readFile(toFsPath(repoPath), 'utf8');
}

/**
 * @param {string} repoPath
 * @param {string} contents
 * @param {string} [encoding]
 * @returns {Promise<void>}
 */
export function writeNoteFile(repoPath, contents, encoding = 'utf8') {
  return pfs.writeFile(toFsPath(repoPath), contents, encoding);
}

/**
 * @param {string} repoPath
 * @returns {Promise<void>}
 */
export function deleteNoteFile(repoPath) {
  return pfs.unlink(toFsPath(repoPath));
}

/**
 * @returns {Promise<{path: string}[]>}
 */
export async function listNoteFiles() {
  /** @type {{path: string}[]} */
  const files = [];

  /**
   * @param {string} currentDir
   */
  async function walk(currentDir) {
    const entries = await pfs.readdir(currentDir);

    for (const entry of entries) {
      const filePath = `${currentDir}/${entry}`;
      const stats = await pfs.stat(filePath);
      if (stats.isDirectory()) {
        await walk(filePath);
      } else if (stats.isFile()) {
        files.push({ path: toRepoPath(filePath) });
      }
    }
  }

  try {
    await pfs.mkdir(notesDir);
  } catch (err) {
    if (getErrorCode(err) !== 'EEXIST') throw err;
  }

  await walk(notesDir);
  return files;
}

const STATUS_MATRIX_LABELS = {
  head: {
    0: 'absent',
    1: 'present',
  },
  workdir: {
    0: 'absent',
    1: 'same',
    2: 'modified',
  },
  stage: {
    0: 'absent',
    1: 'same',
    2: 'modified',
    3: 'conflicted',
  },
};

/**
 * @param {[string, number, number, number]} entry
 * @returns {string}
 */
function summarizeStatusMatrixEntry(entry) {
  const [, head, workdir, stage] = entry;
  if (head === 0 && workdir === 2 && stage === 0) return 'new, untracked';
  if (head === 0 && workdir === 2 && stage === 2) return 'added, staged';
  if (head === 0 && workdir === 2 && stage === 3) return 'added, staged, unstaged changes';
  if (head === 1 && workdir === 1 && stage === 1) return 'clean';
  if (head === 1 && workdir === 2 && stage === 1) return 'modified, unstaged';
  if (head === 1 && workdir === 2 && stage === 2) return 'modified, staged';
  if (head === 1 && workdir === 2 && stage === 3) return 'modified, staged, unstaged changes';
  if (head === 1 && workdir === 0 && stage === 1) return 'deleted, unstaged';
  if (head === 1 && workdir === 0 && stage === 0) return 'deleted, staged';
  if (head === 1 && workdir === 2 && stage === 0) return 'deleted, staged, unstaged changes';
  if (head === 1 && workdir === 1 && stage === 0) return 'deleted, staged, unstaged changes';
  return 'unknown';
}

/**
 * @param {Awaited<ReturnType<typeof statusMatrix>>} matrix
 */
export function formatStatusMatrix(matrix) {
  return matrix.map((entry) => {
    const [path, head, workdir, stage] = entry;
    return {
      path,
      head: STATUS_MATRIX_LABELS.head[head] ?? `?(${head})`,
      workdir: STATUS_MATRIX_LABELS.workdir[workdir] ?? `?(${workdir})`,
      stage: STATUS_MATRIX_LABELS.stage[stage] ?? `?(${stage})`,
      summary: summarizeStatusMatrixEntry(entry),
    };
  });
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function getErrorCode(err) {
  if (!err || typeof err !== 'object') return undefined;
  if (!('code' in err)) return undefined;
  const code = /** @type {{code?: unknown}} */ (err).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function safeGetConfig(path) {
  try {
    const value = await getConfig({ path });
    return typeof value === 'string' ? value : null;
  } catch (err) {
    return null;
  }
}

/**
 * @returns {Promise<boolean>}
 */
export async function ensureConfig() {
  const remoteUrl = await safeGetConfig('remote.origin.url');
  const fetchRefspec = await safeGetConfig('remote.origin.fetch');
  const existingName = await safeGetConfig('user.name');
  const existingEmail = await safeGetConfig('user.email');
  return (
    remoteUrl === url &&
    fetchRefspec === FETCH_REFSPEC &&
    Boolean(existingName) &&
    Boolean(existingEmail)
  );
}

/**
 * @returns {Promise<void>}
 */
export async function applyConfigDefaults() {
  const remoteUrl = await safeGetConfig('remote.origin.url');
  if (remoteUrl !== url) {
    await setConfig({ path: 'remote.origin.url', value: url });
  }
  const fetchRefspec = await safeGetConfig('remote.origin.fetch');
  if (fetchRefspec !== FETCH_REFSPEC) {
    await setConfig({ path: 'remote.origin.fetch', value: FETCH_REFSPEC });
  }
  const existingName = await safeGetConfig('user.name');
  if (!existingName) {
    await setConfig({ path: 'user.name', value: author.name });
  }
  const existingEmail = await safeGetConfig('user.email');
  if (!existingEmail) {
    await setConfig({ path: 'user.email', value: author.email });
  }
}

/**
 * @returns {Promise<boolean>}
 */
export async function commitMergeConflictMarkers() {
  const matrix = await statusMatrix();
  const conflicted = matrix
    .filter((entry) => entry[3] === 3)
    .map(([path]) => path);
  if (!conflicted.length) return false;
  for (const filepath of conflicted) {
    await add({ filepath });
  }
  const localRef = 'refs/heads/main';
  const remoteRef = 'refs/remotes/origin/main';
  const [localOid, remoteOid] = await Promise.all([
    git.resolveRef({ fs, dir, ref: localRef }).catch(() => null),
    git.resolveRef({ fs, dir, ref: remoteRef }).catch(() => null),
  ]);
  if (localOid && remoteOid && localOid !== remoteOid) {
    await commit({ message: 'merge conflict', parent: [localOid, remoteOid] });
  } else if (localOid) {
    await commit({ message: 'merge conflict', parent: localOid });
  } else {
    await commit({ message: 'merge conflict' });
  }
  return true;
}

/**
 * @returns {Promise<void>}
 */
export async function resetToRemote() {
  const remoteRef = 'refs/remotes/origin/main';
  const localRef = 'refs/heads/main';
  const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });
  await git.writeRef({ fs, dir, ref: localRef, value: remoteOid, force: true });
  await git.checkout({ fs, dir, ref: 'main', force: true });
}

/**
 * @returns {Promise<void>}
 */
export async function refreshWorkingTree() {
  await git.checkout({ fs, dir, ref: 'main', force: true });
}

export async function createGitBundle(onProgress) {
  if (onProgress) onProgress('resolving branch…');
  const branchName = await git.currentBranch({ fs, dir });
  const ref = `refs/heads/${branchName}`;
  const oid = await git.resolveRef({ fs, dir, ref });

  if (onProgress) onProgress('counting commits…');
  const oids = new Set();
  const commits = await git.log({
    fs,
    dir,
    ref
  });

  let index = 0;
  for (const entry of commits) {
    index++;
    if (onProgress) {
      const percentage = Math.round((index / commits.length) * 100);
      onProgress(`collecting objects (${percentage}%)`);
    }
    oids.add(entry.oid);
    if (entry.commit?.tree) {
      oids.add(entry.commit.tree);
    }

    // Walk the entire tree at this commit to find all nested trees and blobs
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: entry.oid })],
      map: async (filepath, [treeEntry]) => {
        if (treeEntry) {
          const treeOid = await treeEntry.oid();
          if (treeOid) {
            oids.add(treeOid);
          }
        }
        return filepath;
      }
    });
  }

  if (onProgress) onProgress('generating packfile…');
  const { packfile } = await git.packObjects({
    fs,
    dir,
    oids: Array.from(oids),
    write: false
  });

  const header = `# v2 git bundle\n${oid} ${ref}\n\n`;
  const encoder = new TextEncoder();
  const headerUint8 = encoder.encode(header);

  // 5. Concatenate header and packfile
  const bundleUint8 = new Uint8Array(headerUint8.byteLength + packfile.byteLength);
  bundleUint8.set(headerUint8, 0);
  bundleUint8.set(packfile, headerUint8.byteLength);

  return bundleUint8;
}
