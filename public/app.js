/// <reference lib="dom" />
'use strict';
import {
  add,
  applyConfigDefaults,
  clone,
  commit,
  commitMergeConflictMarkers,
  deleteNoteFile,
  ensureConfig,
  fetch,
  getChangedNotePaths,
  getErrorCode,
  getHistoryContent,
  isMergeConflictError,
  isPushRejectedError,
  isUnmergedPathsError,
  isUpToDateWithRemote,
  listNoteFiles,
  log,
  logFileChanges,
  merge,
  push,
  readNoteFile,
  refreshWorkingTree,
  remove,
  resetToRemote,
  resolveRef,
  status,
  statusMatrix,
  writeNoteFile,
  writeRef,
} from './git-api.js';
import { openNote, registerNoteOpenedHandler, registerSaveAndCommit, showCurrentInEditor, showHistoryInEditor } from './note-editor.js';
import {
  formatUpdatedAt,
  getLatestCommitTimestamp,
  getNoteUpdatedAt,
  parseNoteBody,
} from './note-utils.js';
import { getNotesScrollContainer, handleNotesScroll, renderNotesList } from './notes-list.js';
import {
  setCurrentTagFilter,
} from './tags.js';
import {
  applyMobileState,
  coarsePointerMedia,
  colorSchemeMedia,
  deleteBtn,
  emptyCloneBtn,
  historySelectEl,
  isMobileLayout,
  mobileBackBtn,
  mobileMedia,
  newBtn,
  pullBtn,
  pushBtn,
  renderNoteHistory,
  resetBtn,
  setHasLocalCommits as setHasLocalCommitsUi,
  setMissingConfig,
  setStatus as setStatusUi,
  showListOnMobile as showListOnMobileUi,
  tagFilterEl,
  updateCurrentNoteState as updateCurrentNoteUiState,
} from './ui.js';

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

/** @typedef {{id: Readonly<string>; path: Readonly<string>; body: string; updatedAt?: number; edited?: boolean}} Note */


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
 * @param {import('./app').Note[]} sourceNotes
 * @returns {Promise<void>}
 */
async function buildNoteMarkers(sourceNotes) {
  const [localOid, remoteOid] = await Promise.all([
    resolveRef('refs/heads/main').catch(() => null),
    resolveRef('refs/remotes/origin/main').catch(() => null),
  ]);
  const hasLocalCommits = await hasLocalCommitsToPush(localOid, remoteOid);
  setHasLocalCommitsUi(hasLocalCommits);
  const changedPaths = await getChangedNotePaths(localOid, remoteOid);

  for (const note of sourceNotes) {
    const edited = changedPaths.has(note.path);
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
    const entries = await log({ ref, depth });
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
/**
 * @param {import("./app").Note[]} notes
 */
export async function refreshNotesList(notes) {
  await buildNoteMarkers(notes);
  renderNotesList(notes, currentNote, openNote);
}

function randomId() {
  return crypto.randomUUID();
}

async function cloneRepo() {
  if (!await ensureConfig()) {
    await clone();
    await applyConfigDefaults();
    await bootstrap();
  }
}

/**
 * @param {{onBatch?: () => void}} [options]
 */
async function loadNotes(options = {}) {
  const { onBatch } = options;
  const files = await listNoteFiles();

  /** @type {Note[]} */
  const loadedNotes = [];
  /** @type {{path: string}[]} */
  let batch = [];

  /**
   * @param {{ path: string; }[]} entries
   */
  async function loadBatch(entries) {
    const results = await Promise.all(entries.map(async ({ path }) => {
      const relId = path.slice('notes/'.length);
      try {
        const body = await readNoteFile(path);
        const parsed = parseNoteBody(body);
        return {
          id: relId,
          path,
          body,
          updatedAt: getNoteUpdatedAt(parsed) ?? await getLatestCommitTimestamp(path),
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
    const commits = await logFileChanges(note.path);
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
  if (!note.path) throw new Error('Missing note.path');
  await writeNoteFile(note.path, note.body);
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
    id,
    path: `notes/${id}`,
    body: '---\ntitle: \n---\n\n',
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
    path: `notes/${id}`,
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
  const prevStatus = await status({ filepath: currentNote.path });

  try {
    await deleteNoteFile(currentNote.path);
  } catch (err) {
    if (getErrorCode(err) !== 'ENOENT') throw err;
  }

  try {
    await remove({ filepath: currentNote.path });
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
  await saveNoteFile(note);
  notes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  await add({ filepath: note.path });
  const s = await status({ filepath: note.path });
  const modified = s === 'modified' || s === '*modified' || s === 'deleted' || s === '*deleted' || s === 'added' || s === '*added';
  if (modified) {
    await commit();
    if (typeof frontMatterUpdatedAt === 'number') {
      note.updatedAt = frontMatterUpdatedAt;
    } else {
      note.updatedAt = await getLatestCommitTimestamp(note.path);
    }
    await loadNotes();
  }
  setStatusUi(modified ? 'committed locally' : 'no changes');

  loadAndRenderHistory(note);
  refreshNotesList(notes);
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
    if (isMergeConflictError(err) || isUnmergedPathsError(err)) {
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
      resolveRef('refs/heads/main').catch(() => null),
      resolveRef('refs/remotes/origin/main').catch(() => null),
    ]);
    if (postLocalOid) {
      await writeRef('refs/remotes/origin/main', postLocalOid, true);
    }
    setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
    await refreshNotesList(notes);
  } catch (err) {
    if (isPushRejectedError(err)) {
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
    if (isMergeConflictError(err)) {
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
    await deleteNoteFile(path);
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
        renderNotesList(notes, currentNote, openNote, { preserveScroll: true, skipAutoLoad: true });
      },
    });
    await refreshNotesList(notes);
    didLoadNotes = true;
    const committed = await commitMergeConflictMarkers();
    setStatusUi(committed ? 'merge conflict committed' : 'synced');
  } catch (err) {
    if (isMergeConflictError(err)) {
      const committed = await commitMergeConflictMarkers();
      setStatusUi(committed ? 'merge conflict committed' : 'conflict');
    }
  }

  if (!didLoadNotes) {
    await loadNotes({
      onBatch: () => {
        renderNotesList(notes, currentNote, openNote, { preserveScroll: true, skipAutoLoad: true });
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

if (emptyCloneBtn) {
  emptyCloneBtn.addEventListener('click', handleCloneAction);
}

newBtn.addEventListener('click', () => {
  createNote();
});

tagFilterEl.addEventListener('change', () => {
  setCurrentTagFilter(tagFilterEl.value);
  renderNotesList(notes, currentNote, openNote, { resetVisibleCount: true, scrollToTop: true });
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
  const body = await getHistoryContent(oid, currentNote.path);
  showHistoryInEditor(body);
});
applyMobileUiState();

const notesScrollContainer = getNotesScrollContainer();
notesScrollContainer.addEventListener('scroll', () => handleNotesScroll(notes, currentNote, openNote));

if (mobileBackBtn) {
  mobileBackBtn.addEventListener('click', () => {
    showListOnMobile({ source: 'user' });
  });
}

colorSchemeMedia.addEventListener('change', () => {
  
});

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
