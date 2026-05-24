'use strict';
import {
  add,
  applyConfigDefaults,
  clone,
  commit,
  commitMergeConflictMarkers,
  createGitBundle,
  deleteNoteFile,
  ensureConfig,
  fetch,
  findMergeBase,
  getChangedNotePaths,
  getErrorCode,
  getHistoryContent,
  getRemoteRefs,
  init,
  isMergeConflictError,
  isPushRejectedError,
  isUnmergedPathsError,
  isUpToDateWithRemote,
  listNoteFiles,
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
  exportBundleBtn,
  historySelectEl,
  isMobileLayout,
  mobileBackBtn,
  mobileMedia,
  newBtn,
  pullBtn,
  pushBtn,
  renderNoteHistory,
  resetBtn,
  setActiveNoteInList,
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
  navigator.serviceWorker.addEventListener('message', async (event) => {
    if (event?.data?.type === 'share-target') {
      try {
        if (!await ensureConfig()) {
          throw new Error('クローンされていません。リポジトリをクローンしてください。');
        }

        const payload = event.data.payload;
        if (payload && typeof payload === 'object') {
          const hasContent = Boolean(
            payload.title?.trim() || payload.text?.trim() || payload.url?.trim()
          );
          setStatusUi(hasContent ? 'share received' : 'share target opened (empty)');

          await createNote(payload);
        }
      } finally {
        clearShareTargetParams();
      }
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
  const mergeBases = await findMergeBase({ oids: [localOid, remoteOid] });
  const localIsAncestor = mergeBases.includes(localOid);
  return !localIsAncestor;
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
    try {
      await clone();
    } catch (err) {
      console.warn('Clone failed, falling back to init:', err);
      // Fallback to init for any error (e.g. empty repo, missing main, etc.)
      await init();
    }
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
    if (!commits.length) {
      renderNoteHistory([], { emptyMessage: '履歴がありません' });
      return;
    }
    const entries = commits.map((entry) => ({
      oid: entry.oid,
      label: formatUpdatedAt(entry.commit.author.timestamp * 1000),
    }));
    renderNoteHistory(entries, { emptyMessage: '履歴がありません' });
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
 * @param {{source?: "user" | "history" | "system"}} [options]
 */
async function handleNoteOpened(note, options = {}) {
  currentNote = note;
  historySelectEl.value = '';
  await loadAndRenderHistory(note);
  if (options.source === 'user') {
    updateHistoryForNote(note.id);
  }
}

/**
 * @param {{title?: string; text?: string; url?: string} | undefined} payload
 */
function buildNoteBody(payload) {
  if (!payload) {
    return ['---', 'title: ', '---', '', ''].join('\n');
  }
  const sections = ['---'];
  if (payload.title) sections.push(`title: ${payload.title}`);
  sections.push('---', '');
  if (payload.text) sections.push(payload.text, '');
  if (payload.url) sections.push('', payload.url);
  return sections.join('\n');
}

/**
 * @param {{title?: string; text?: string; url?: string}} [payload]
 */
async function createNote(payload) {
  const id = randomId();
  const body = buildNoteBody(payload);
  /** @type {Note} */
  const note = {
    id,
    path: `notes/${id}`,
    body,
  };
  notes.unshift(note);
  refreshNotesList(notes);
  openNote(note, { source: 'user' });
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
  if (frontMatterUpdatedAt != null) {
    note.updatedAt = frontMatterUpdatedAt;
  }
  await saveNoteFile(note);
  notes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  await add({ filepath: note.path });
  const s = await status({ filepath: note.path });
  const modified = s === 'modified' || s === '*modified' || s === 'deleted' || s === '*deleted' || s === 'added' || s === '*added';
  if (modified) {
    await commit();
    if (frontMatterUpdatedAt != null) {
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
    try {
      await fetch();
    } catch (err) {
      if (getErrorCode(err) !== 'NotFoundError' && err.message !== 'Could not find HEAD' && err.message !== 'Could not find main') {
        throw err;
      }
    }

    const remoteRef = await resolveRef('refs/remotes/origin/main').catch(() => null);
    if (remoteRef) {
      await merge({ abortOnConflict: false });
      await refreshWorkingTree();
      await loadNotes();
      await refreshNotesList(notes);
    }
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
  // Check remote state without fetching first
  try {
    const remoteRefs = await getRemoteRefs();
    const hasRemoteMain = remoteRefs.some(r => r.ref === 'refs/heads/main');

    if (!hasRemoteMain) {
      const localHead = await resolveRef('refs/heads/main').catch(() => null);
      if (!localHead) {
        setStatusUi('initializing repo…');
        const oid = await commit({ message: 'initial commit' });
        // Ensure main ref exists before pushing
        if (oid) {
          await writeRef('refs/heads/main', oid, true);
        }
        await push();
      }
    }
  } catch (err) {
    // If listing refs fails (e.g. offline), we'll catch it here or let fetch handle it.
    console.warn('Failed to list remote refs, assuming offline or proceed to fetch', err);
  }

  let shouldMerge = false;
  try {
    await fetch();
    shouldMerge = true;
  } catch (err) {
    if (getErrorCode(err) === 'NotFoundError' || err.message === 'Could not find HEAD' || err.message === 'Could not find main') {
      // Ignore
    } else {
      setStatusUi('offline (local only)');
      console.warn('Fetch failed, proceeding offline:', err);
    }
  }

  try {
    if (shouldMerge) {
      try {
        await merge();
      } catch (err) {
        if (isMergeConflictError(err)) {
          throw err;
        }
        console.warn('Merge failed (likely empty remote), proceeding:', err);
      }
    }
    await refreshWorkingTree();
    await loadNotes({
      onBatch: () => {
        renderNotesList(notes, currentNote, openNote, { preserveScroll: true, skipAutoLoad: true });
      },
    });
    await refreshNotesList(notes);
    didLoadNotes = true;
    if (shouldMerge) {
      const committed = await commitMergeConflictMarkers();
      setStatusUi(committed ? 'merge conflict committed' : 'synced');
    }
  } catch (err) {
    if (isMergeConflictError(err)) {
      const committed = await commitMergeConflictMarkers();
      setStatusUi(committed ? 'merge conflict committed' : 'conflict');
    } else {
      throw err;
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

async function handleExportBundle() {
  try {
    const bundleUint8 = await createGitBundle((status) => {
      setStatusUi(status);
    });

    const timestamp = Temporal.Now.plainDateTimeISO().toString().split('.')[0].replace(/[-:]/g, '').replace('T', '_');
    const filename = `notig-${timestamp}.bundle`;

    const blob = new Blob([bundleUint8], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatusUi('bundle exported');
  } catch (err) {
    console.error('Failed to export bundle:', err);
    setStatusUi('export failed');
    alert(`Export failed: ${err.message}`);
  }
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

exportBundleBtn.addEventListener('click', () => {
  handleExportBundle();
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
    currentNote = null;
    updateCurrentNoteState();
    setActiveNoteInList(undefined);
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

bootstrap();
