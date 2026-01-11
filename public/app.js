/// <reference lib="dom" />
'use strict';
import {
  git,
  fs,
  pfs,
  dir,
  notesDir,
  clone,
  fetch,
  merge,
  refreshWorkingTree,
  applyConfigDefaults,
  ensureConfig,
  push,
  add,
  commit,
  remove,
  status,
  statusMatrix,
  formatStatusMatrix,
  isUpToDateWithRemote,
  logFileChanges,
  getHistoryContent,
  commitMergeConflictMarkers,
  resetToRemote,
  getErrorCode,
} from './git-api.js';
import {
  parseNoteBody,
  formatUpdatedAt,
  getLatestCommitTimestamp,
  getNoteUpdatedAt,
} from './note-utils.js';
import {
  setCurrentTagFilter,
} from './tags.js';
import {
  pushBtn,
  pullBtn,
  resetBtn,
  cloneBtn,
  emptyCloneBtn,
  deleteBtn,
  newBtn,
  tagFilterEl,
  historySelectEl,
  mobileMedia,
  coarsePointerMedia,
  // colorSchemeMedia,
  mobileBackBtn,
  setStatus as setStatusUi,
  setMissingConfig,
  isMobileLayout,
  applyMobileState,
  updateCurrentNoteState as updateCurrentNoteUiState,
  showListOnMobile as showListOnMobileUi,
  setHasLocalCommits as setHasLocalCommitsUi,
  renderNoteHistory,
} from './ui.js';
import { getNotesScrollContainer, handleNotesScroll, renderNotesList } from './notes-list.js';
import { openNote, registerNoteOpenedHandler, registerSaveAndCommit, showCurrentInEditor, showHistoryInEditor } from './note-detail.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js');
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'share-target') return;
    if (data.payload && typeof data.payload === 'object') {
      handleSharePayload(data.payload);
    }
  });
}

/** @typedef {{id: Readonly<string>; body: string; updatedAt?: number; edited?: boolean}} Note */


/** @type {Note[]} */
let notes = [];
/** @type {Note | null} */
let currentNote = null;
let isHandlingPopState = false;
let hasInitializedHistoryState = false;
const NOTES_LOAD_BATCH_SIZE = 40;
let hasHandledShareTarget = false;

function applyMobileUiState() {
  applyMobileState(currentNote != null);
}

function updateCurrentNoteState() {
  updateCurrentNoteUiState(currentNote != null);
}

/**
 * @param {{source?: string}} options 
 */
export function showListOnMobile(options = {}) {
  if (!isMobileLayout()) return;
  showListOnMobileUi();
  const source = options.source ?? 'system';
  if (source === 'history' || isHandlingPopState) return;
  if (history.state && history.state.view === 'note' && history.length > 1) {
    history.back();
    return;
  }
  replaceHistoryState({ view: 'list' });
}

/**
 * @param {Pick<Note, 'id'> & Partial<Note>} note
 */
function getNoteFilePath(note) {
  return `notes/${note.id}`;
}

/**
 * @param {import('./app').Note[]} sourceNotes
 * @returns {Promise<void>}
 */
async function buildNoteMarkers(sourceNotes) {
  const [localOid, remoteOid] = await Promise.all([
    git.resolveRef({ fs, dir, ref: 'refs/heads/main' }).catch(() => null),
    git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' }).catch(() => null),
  ]);
  const hasLocalCommits = await hasLocalCommitsToPush(localOid, remoteOid);
  setHasLocalCommitsUi(hasLocalCommits);
  const changedPaths = await getChangedNotePaths(localOid, remoteOid);

  for (const note of sourceNotes) {
    const filepath = getNoteFilePath(note);
    const edited = changedPaths.has(filepath);
    note.edited = edited;
  }
}

/**
 * @param {string | null} localOid
 * @param {string | null} remoteOid
 * @returns {Promise<boolean>}
 */
async function hasLocalCommitsToPush(localOid, remoteOid) {
  if (!localOid || !remoteOid) return false;
  if (localOid === remoteOid) return false;
  const localIsAncestor = await isOidInHistory('refs/remotes/origin/main', localOid);
  return !localIsAncestor;
}

/**
 * @param {string} ref
 * @param {string} targetOid
 * @returns {Promise<boolean>}
 */
async function isOidInHistory(ref, targetOid) {
  const step = 100;
  let depth = step;
  let lastCount = 0;
  while (depth <= 2000) {
    const entries = await git.log({ fs, dir, ref, depth });
    if (entries.some((entry) => entry.oid === targetOid)) {
      return true;
    }
    if (entries.length < depth || entries.length === lastCount) {
      return false;
    }
    lastCount = entries.length;
    depth += step;
  }
  return false;
}

/**
 * @param {string | null} localOid
 * @param {string | null} remoteOid
 * @returns {Promise<Set<string>>}
 */
async function getChangedNotePaths(localOid, remoteOid) {
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
 * @param {import("./app").Note[]} notes
 */
export async function refreshNotesList(notes) {
  await buildNoteMarkers(notes);
  renderNotesList(notes, currentNote?.id ?? null, openNote);
}

function randomId() {
  return crypto.randomUUID();
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function getNoteIdFromPath(filePath) {
  return filePath.startsWith(`${notesDir}/`)
    ? filePath.slice(notesDir.length + 1)
    : filePath;
}

async function cloneRepo() {
  if (!await ensureConfig()) {
    await clone();
    await applyConfigDefaults();
    await bootstrap();
  }
}

/**
 * @param {string} rootDir
 * @returns {Promise<{path: string}[]>}
 */
async function listNoteFiles(rootDir) {
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
        files.push({ path: filePath });
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * @param {{onBatch?: () => void}} [options]
 */
async function loadNotes(options = {}) {
  const { onBatch } = options;
  const useCommitTimestamp = true;
  const files = await listNoteFiles(notesDir);

  /** @type {Note[]} */
  const loadedNotes = [];
  /** @type {{path: string}[]} */
  let batch = [];

  /**
   * @param {{ path: any; }[]} entries
   */
  async function loadBatch(entries) {
    const results = await Promise.all(entries.map(async ({ path }) => {
      const relId = getNoteIdFromPath(path);
      const relPath = getNoteFilePath({ id: relId });
      try {
        /** @type {string} */
        const body = await pfs.readFile(path, 'utf8');
        const parsed = parseNoteBody(body);
        const frontMatterUpdatedAt = getNoteUpdatedAt(parsed);
        let updatedAt = frontMatterUpdatedAt;
        if (typeof updatedAt !== 'number' && useCommitTimestamp) {
          updatedAt = await getLatestCommitTimestamp(relPath);
        }
        return {
          id: relId,
          body,
          updatedAt,
        };
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') return null;
        throw err;
      }
    }));

    results.forEach((note) => {
      if (note) {
        loadedNotes.push(note);
      }
    });
    if (onBatch) {
      notes = loadedNotes
        .slice()
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      onBatch();
    }
  }

  for (const entry of files) {
    batch.push(entry);
    if (batch.length >= NOTES_LOAD_BATCH_SIZE) {
      const nextBatch = batch;
      batch = [];
      await loadBatch(nextBatch);
    }
  }
  if (batch.length) {
    await loadBatch(batch);
  }

  notes = loadedNotes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * @param {Note} note
 * @returns {Promise<void>}
 */
async function loadAndRenderHistory(note) {
  if (!note.updatedAt) {
    renderNoteHistory([], { emptyMessage: '履歴がありません' });
    return;
  }
  renderNoteHistory([], { emptyMessage: '履歴を読み込んでいます' });

  try {
    const filepath = getNoteFilePath(note);
    const commits = await logFileChanges(filepath);
    const validCommits = commits.filter(
      (entry) => typeof entry.commit?.author?.timestamp === 'number'
    );
    if (!validCommits.length) {
      renderNoteHistory([], { emptyMessage: '履歴がありません' });
      return;
    }

    const entries = validCommits.map((entry) => {
      const ts = entry.commit?.author?.timestamp;
      return {
        oid: entry.oid,
        label: typeof ts === 'number' ? formatUpdatedAt(ts * 1000) : entry.oid,
      };
    });
    renderNoteHistory(entries, { emptyMessage: '履歴がありません' });
    return;
  } catch (err) {
    renderNoteHistory([], { emptyMessage: '履歴を取得できません' });
    throw err;
  }
}

/**
 * @param {Note} note
 */
async function saveNoteFile(note) {
  const relPath = getNoteFilePath(note);
  await pfs.writeFile(`${dir}/${relPath}`, note.body, 'utf8');
  return relPath;
}

/**
 * @param {{ view: string; id: any; }} state
 */
function pushHistoryState(state) {
  if (isHandlingPopState) return;
  history.pushState(state, '');
}

/**
 * @param {{ view: string; id?: any; }} state
 */
function replaceHistoryState(state) {
  if (isHandlingPopState) return;
  history.replaceState(state, '');
}

/**
 * @param {string} noteId
 * @param {{replace?: boolean}} [options={}] 
 */
function updateHistoryForNote(noteId, options = {}) {
  let replace = options.replace ?? false;
  if (!replace && isMobileLayout()) {
    if (!history.state || history.state.view !== 'list') {
      replace = true;
    }
  }
  const state = { view: 'note', id: noteId };
  if (replace) {
    replaceHistoryState(state);
  } else {
    pushHistoryState(state);
  }
  hasInitializedHistoryState = true;
}

// /**
//  * @param {{eager?: boolean}} options 
//  */
/**
 * @param {Note} note
 */
async function handleNoteOpened(note) {
  currentNote = note;
  historySelectEl.value = '';
  await loadAndRenderHistory(note);
}

async function createNote() {
  const id = randomId();
  /** @type {Note} */
  const note = {
    id, body: '---\ntitle: \n---\n\n'
  };
  notes.unshift(note);
  await saveNoteFile(note);
  refreshNotesList(notes);
  openNote(note, { source: 'user' });
}

/**
 * @param {{title?: string; text?: string; url?: string; rawQuery?: string}} payload
 * @returns {string}
 */
function buildSharedNoteBody(payload) {
  const title = payload.title?.trim() ?? '';
  const titleLine = title ? `title: ${JSON.stringify(title)}` : 'title: ';
  const url = getShareUrlFromPayload(payload);
  const urlLine = url ? `url: ${url.replace(/\r?\n/g, ' ')}` : '';
  const rawQuery = payload.rawQuery?.trim() ?? '';
  const queryHash = rawQuery ? hashString(rawQuery) : '';
  const parts = [];
  if (queryHash) {
    parts.push(`query_hash: ${queryHash}`);
  }
  if (payload.text?.trim()) {
    parts.push(payload.text.trim());
  }
  if (payload.url?.trim()) {
    parts.push(payload.url.trim());
  }
  const content = parts.join('\n\n');
  const frontMatterLines = ['---', titleLine];
  if (urlLine) {
    frontMatterLines.push(urlLine);
  }
  if (queryHash) {
    frontMatterLines.push(`query_hash: ${queryHash}`);
  }
  frontMatterLines.push('---');
  return `${frontMatterLines.join('\n')}\n\n${content}\n`;
}

/**
 * @returns {{title?: string; text?: string; url?: string; rawQuery?: string} | null}
 */
function getShareTargetPayloadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const title = params.get('title') ?? '';
  const text = params.get('text') ?? '';
  const url = params.get('url') ?? '';
  if (!title.trim() && !text.trim() && !url.trim()) return null;
  return { title, text, url, rawQuery: window.location.search };
}

/**
 * @param {{title?: string; text?: string; url?: string; rawQuery?: string}} payload
 * @returns {string}
 */
function getShareUrlFromPayload(payload) {
  const direct = payload.url?.trim() ?? '';
  if (direct) return direct;
  const text = payload.text?.trim() ?? '';
  if (!text) return '';
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : '';
}

/**
 * @param {string} value
 * @returns {string}
 */
function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * @param {Note} note
 * @returns {string}
 */
function getNoteShareUrl(note) {
  const parsed = parseNoteBody(note.body);
  const urlValue = parsed.frontMatter.url ?? parsed.frontMatter.Url ?? '';
  return typeof urlValue === 'string' ? urlValue.trim() : '';
}

function clearShareTargetParams() {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('title');
  nextUrl.searchParams.delete('text');
  nextUrl.searchParams.delete('url');
  if (nextUrl.href !== window.location.href) {
    history.replaceState(history.state, '', nextUrl);
  }
}

/**
 * @param {{title?: string; text?: string; url?: string}} payload
 */
async function createSharedNote(payload) {
  const id = randomId();
  const note = {
    id,
    body: buildSharedNoteBody(payload),
  };
  notes.unshift(note);
  await saveNoteFile(note);
  await refreshNotesList(notes);
  await openNote(note, { source: 'user' });
}

/**
 * @param {{title?: string; text?: string; url?: string}} payload
 */
async function handleSharePayload(payload) {
  if (hasHandledShareTarget) return;
  if (!payload || typeof payload !== 'object') return;
  const shareUrl = getShareUrlFromPayload(payload);
  if (shareUrl) {
    const matched = notes.find((note) => getNoteShareUrl(note) === shareUrl) ?? null;
    if (matched) {
      hasHandledShareTarget = true;
      setStatusUi('share opened existing');
      clearShareTargetParams();
      await openNote(matched, { source: 'user' });
      return;
    }
  }
  hasHandledShareTarget = true;
  const hasContent = Boolean(
    payload.title?.trim() || payload.text?.trim() || payload.url?.trim()
  );
  setStatusUi(hasContent ? 'share received' : 'share target opened (empty)');
  clearShareTargetParams();
  await createSharedNote(payload);
}

async function handleShareTarget() {
  const payload = getShareTargetPayloadFromUrl();
  if (!payload) return;
  await handleSharePayload(payload);
}

async function deleteCurrentNote() {
  if (!currentNote) return;
  const targetIndex = notes.findIndex((note) => note === currentNote);
  const filepath = getNoteFilePath(currentNote);
  const prevStatus = await status({ filepath });

  try {
    await pfs.unlink(`${dir}/${filepath}`);
  } catch (err) {
    if (getErrorCode(err) !== 'ENOENT') throw err;
  }

  try {
    await remove({ filepath });
  } catch (err) {
    // Ignore if the file was never tracked
    if (getErrorCode(err) !== 'NotFoundError') throw err;
  }

  const wasTracked = prevStatus !== 'untracked' && prevStatus !== 'absent';
  if (wasTracked) {
    await commit();
    setStatusUi('deleted');
  } else {
    setStatusUi('removed locally');
  }

  if (targetIndex !== -1) {
    notes.splice(targetIndex, 1);
  }
  currentNote = null;
  await refreshNotesList(notes);
  updateCurrentNoteState();
  renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
  historySelectEl.value = '';
  showListOnMobile();
}

/**
 * @returns {Promise<boolean>}
 * @param {Note} note
 */
async function saveAndCommit(note) {
  const parsed = parseNoteBody(note.body);
  const frontMatterUpdatedAt = getNoteUpdatedAt(parsed);
  if (typeof frontMatterUpdatedAt === 'number') {
    note.updatedAt = frontMatterUpdatedAt;
  }
  const filepath = await saveNoteFile(note);
  notes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  await add({ filepath });
  const s = await status({ filepath });
  const modified = s === 'modified' || s === '*modified' || s === 'deleted' || s === '*deleted' || s === 'added' || s === '*added';
  if (modified) {
    await commit();
    if (typeof frontMatterUpdatedAt === 'number') {
      note.updatedAt = frontMatterUpdatedAt;
    } else {
      note.updatedAt = await getLatestCommitTimestamp(filepath);
    }
    await loadNotes();
  }
  setStatusUi(modified ? 'committed locally' : 'no changes');

  await refreshNotesList(notes);
  return modified;
}

async function pushChanges() {
  if (currentNote) {
    await saveAndCommit(currentNote);
  }
  let conflictCommitted = false;
  try {
    setStatusUi('syncing…');
    await fetch();
    await merge({ abortOnConflict: false });
    await refreshWorkingTree();
    await loadNotes();
    await refreshNotesList(notes);
  } catch (err) {
    if (
      err instanceof git.Errors.MergeConflictError ||
      err instanceof git.Errors.UnmergedPathsError
    ) {
      await loadNotes();
      await refreshNotesList(notes);
      if (currentNote) {
        await openNote(currentNote, { source: 'system' });
      }

      conflictCommitted = await commitMergeConflictMarkers();
      if (!conflictCommitted) {
        setStatusUi('merge conflict (markers created)');
        return;
      }
    } else {
      throw err;
    }
  }

  setStatusUi('pushing…');
  try {
    await push();
    const [postLocalOid, postRemoteOid] = await Promise.all([
      git.resolveRef({ fs, dir, ref: 'refs/heads/main' }).catch(() => null),
      git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' }).catch(() => null),
    ]);
    if (postLocalOid) {
      await git.writeRef({
        fs,
        dir,
        ref: 'refs/remotes/origin/main',
        value: postLocalOid,
        force: true,
      });
    }
    setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
    await refreshNotesList(notes);
  } catch (err) {
    if (err instanceof git.Errors.PushRejectedError) {
      const upToDate = await isUpToDateWithRemote();
      if (upToDate) {
        setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
        return;
      }
    }
    throw err;
  }
}

async function pullChanges() {
  setStatusUi('pulling…');
  try {
    await fetch();
    await merge({ abortOnConflict: false });
    // if (!hasUnsavedChanges) {
      await refreshWorkingTree();
    // }
    await loadNotes();
    await refreshNotesList(notes);
    if (currentNote) {
      await openNote(currentNote, { source: 'system' });
    }
    const committed = await commitMergeConflictMarkers();
    if (committed) {
      setStatusUi('merge conflict committed');
      return;
    }
    setStatusUi('pulled');
  } catch (err) {
    if (err instanceof git.Errors.MergeConflictError) {
      // if (!hasUnsavedChanges) {
        await resetToRemote();
        await loadNotes();
        await refreshNotesList(notes);
        setStatusUi('pulled (remote)');
        return;
      // }
      
      const committed = await commitMergeConflictMarkers();
      setStatusUi(committed ? 'merge conflict committed' : 'merge conflict (markers created)');
      
    } else {
      throw err;
    }
  }
}

async function resetNotesToOrigin() {
  if (!window.confirm('ローカルの内容をすべて破棄してoriginに戻します。よろしいですか？')) return;

  setStatusUi('resetting…');
  await resetToRemote();
  await refreshWorkingTree();
  await removeLocalOnlyNotes();
  await loadNotes();
  currentNote = null;
  updateCurrentNoteState();
  renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
  historySelectEl.value = '';
  showListOnMobile();
  await refreshNotesList(notes);
  setStatusUi('reset to origin');
}

async function removeLocalOnlyNotes() {
  const matrix = await statusMatrix();
  const localOnly = matrix.filter(([path, head]) => head === 0 && path.startsWith('notes/'));
  for (const [path] of localOnly) {
    await pfs.unlink(`${dir}/${path}`);
    await remove({ filepath: path });
  }
}

async function bootstrap() {
  setStatusUi('preparing…');
  const hasConfig = await ensureConfig();
  if (!hasConfig) {
    setStatusUi('missing config');
    setMissingConfig(true);
    return;
  }
  setMissingConfig(false);

  let didLoadNotes = false;
  try {
    await fetch();
  } catch (err) {
    setStatusUi('offline (local only)');
    throw err;
  }

  try {
    await merge();
    await refreshWorkingTree();
    await loadNotes({
      onBatch: () => {
        renderNotesList(notes, currentNote?.id ?? null, openNote, { preserveScroll: true, skipAutoLoad: true });
      },
    });
    await refreshNotesList(notes);
    didLoadNotes = true;
    const committed = await commitMergeConflictMarkers();
    setStatusUi(committed ? 'merge conflict committed' : 'synced');
  } catch (err) {
    if (err instanceof git.Errors.MergeConflictError) {
      const committed = await commitMergeConflictMarkers();
      setStatusUi(committed ? 'merge conflict committed' : 'conflict');
    }
  }

  if (!didLoadNotes) {
    await loadNotes({
      onBatch: () => {
        renderNotesList(notes, currentNote?.id ?? null, openNote, { preserveScroll: true, skipAutoLoad: true });
      },
    });
    await refreshNotesList(notes);
  }
  updateCurrentNoteState();
  if (!hasInitializedHistoryState) {
    if (currentNote) {
      updateHistoryForNote(currentNote.id, { replace: true });
    } else {
      replaceHistoryState({ view: 'list' });
      hasInitializedHistoryState = true;
    }
  }
}

function handleCloneAction() {
  cloneRepo();
}

pushBtn.addEventListener('click', () => {
  pushChanges();
});

pullBtn.addEventListener('click', () => {
  pullChanges();
});

resetBtn.addEventListener('click', () => {
  resetNotesToOrigin();
});

if (cloneBtn) {
  cloneBtn.addEventListener('click', handleCloneAction);
}
if (emptyCloneBtn) {
  emptyCloneBtn.addEventListener('click', handleCloneAction);
}

newBtn.addEventListener('click', () => {
  createNote();
});

tagFilterEl.addEventListener('change', () => {
  setCurrentTagFilter(tagFilterEl.value);
  renderNotesList(notes, currentNote?.id ?? null, openNote, { resetVisibleCount: true, scrollToTop: true });
});

deleteBtn.addEventListener('click', () => {
  deleteCurrentNote();
});

historySelectEl.addEventListener('change', async () => {
  if (!currentNote) return;
  const oid = historySelectEl.value;
  if (!oid || oid === '__empty') {
    showCurrentInEditor(currentNote);
    return;
  }
  const filepath = getNoteFilePath(currentNote);
  const body = await getHistoryContent(oid, filepath);
  showHistoryInEditor(body);
});
applyMobileUiState();

const notesScrollContainer = getNotesScrollContainer();
notesScrollContainer.addEventListener('scroll', () => handleNotesScroll(notes, currentNote?.id ?? null, openNote));

if (mobileBackBtn) {
  mobileBackBtn.addEventListener('click', () => {
    showListOnMobile({ source: 'user' });
  });
}

// colorSchemeMedia.addEventListener('change', () => {
//   const markdown = isViewingHistorySnapshot
//     ? historyMarkdown
//     : editor
//       ? editor.getMarkdown()
//       : currentMarkdown;
//   createEditor(markdown, {
//     viewer: isViewingHistorySnapshot,
//     preserveCurrentMarkdown: isViewingHistorySnapshot,
//   });
//   setEditorReadOnly(isViewingHistorySnapshot);
// });

mobileMedia.addEventListener('change', applyMobileUiState);
coarsePointerMedia.addEventListener('change', applyMobileUiState);

/**
 * @param {PopStateEvent} event
 */
async function handlePopState(event) {
  isHandlingPopState = true;
  try {
    const state = event.state;
    if (state && state.view === 'note' && typeof state.id === 'string') {
      const note = notes.find((entry) => entry.id === state.id);
      if (note) {
        await openNote(note, { source: 'history' });
        return;
      }
    }
    if (isMobileLayout()) {
      showListOnMobile({ source: 'history' });
    }
  } finally {
    isHandlingPopState = false;
  }
}

window.addEventListener('popstate', (event) => {
  handlePopState(event);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event);
  alert(`${String(event.reason.message)}`);
});

registerSaveAndCommit(saveAndCommit);
registerNoteOpenedHandler(handleNoteOpened);

bootstrap()
  .finally(() => {
    handleShareTarget();
  });
