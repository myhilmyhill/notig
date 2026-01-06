'use strict';
import { Editor } from 'https://esm.sh/@toast-ui/editor@3.2.2';
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
  getNoteTags,
  getNoteUpdatedAt,
} from './note-utils.js';
import {
  editorHostEl,
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
  colorSchemeMedia,
  mobileBackBtn,
  setStatus as setStatusUi,
  setHasUnsavedChanges as setHasUnsavedChangesUi,
  setMissingConfig,
  isMobileLayout,
  applyMobileState,
  updateCurrentNoteState as updateCurrentNoteUiState,
  showEditorOnMobile,
  showListOnMobile as showListOnMobileUi,
  setActiveNoteInList,
  setEditorReadOnly,
  renderNotes,
  renderTagFilterOptions,
  renderNoteHistory,
} from './ui.js';

/** @typedef {{id: string; body: string; updatedAt?: number}} Note */


/** @type {Note[]} */
let notes = [];
/** @type {Record<string, {diffFromOrigin?: boolean; locallyCommitted?: boolean}>} */
let noteMarkersById = {};
/** @type {Note['id'] | null} */
let currentId = null;
/** @type {Editor | null} */
let editor = null;
let currentMarkdown = '';
let lastSavedMarkdown = '';
let hasUnsavedChanges = false;
let isApplyingMarkdown = false;
let isViewingHistorySnapshot = false;
let isHandlingPopState = false;
let hasInitializedHistoryState = false;
let currentTagFilter = '';
let historyMarkdown = '';

/**
 * @param {boolean} next
 */
function setHasUnsavedChanges(next) {
  if (hasUnsavedChanges === next) return;
  hasUnsavedChanges = next;
  setHasUnsavedChangesUi(hasUnsavedChanges);
}

function applyMobileUiState() {
  applyMobileState(Boolean(currentId));
}

function updateCurrentNoteState() {
  updateCurrentNoteUiState(Boolean(currentId));
}

/**
 * @param {Note} note
 * @returns {string[]}
 */
function getTagsForNote(note) {
  const parsed = parseNoteBody(note.body);
  return getNoteTags(parsed);
}

/**
 * @param {Note[]} sourceNotes
 * @returns {string[]}
 */
function collectTagsFromNotes(sourceNotes) {
  const tags = new Set();
  sourceNotes.forEach((note) => {
    getTagsForNote(note).forEach((tag) => {
      tags.add(tag);
    });
  });
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function updateTagFilterOptions() {
  const tags = collectTagsFromNotes(notes);
  if (currentTagFilter && !tags.includes(currentTagFilter)) {
    currentTagFilter = '';
  }
  renderTagFilterOptions(tags, currentTagFilter);
}

/**
 * @returns {Note[]}
 */
function getFilteredNotes() {
  if (!currentTagFilter) return notes;
  return notes.filter((note) => getTagsForNote(note).includes(currentTagFilter));
}

function renderNotesList() {
  updateTagFilterOptions();
  renderNotes(
    getFilteredNotes(),
    currentId,
    (note) => openNote(note, { source: 'user' }),
    noteMarkersById
  );
}

function showListOnMobile(options = {}) {
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
 * @param {Note[]} sourceNotes
 * @returns {Promise<Record<string, {diffFromOrigin?: boolean; locallyCommitted?: boolean}>>}
 */
async function buildNoteMarkers(sourceNotes) {
  /** @type {Record<string, {diffFromOrigin?: boolean; locallyCommitted?: boolean}>} */
  const markers = {};
  const [localOid, remoteOid] = await Promise.all([
    git.resolveRef({ fs, dir, ref: 'refs/heads/main' }).catch(() => null),
    git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' }).catch(() => null),
  ]);
  console.log('[markers] refs', { localOid, remoteOid });
  const changedPaths = await getChangedNotePaths(localOid, remoteOid);
  console.log('[markers] changed paths', Array.from(changedPaths));

  for (const note of sourceNotes) {
    const filepath = getNoteFilePath(note);
    const locallyCommitted = changedPaths.has(filepath);
    console.log('[markers] note', {
      id: note.id,
      filepath,
      locallyCommitted,
    });
    const diffFromOrigin = locallyCommitted;
    if (diffFromOrigin || locallyCommitted) {
      markers[note.id] = { diffFromOrigin, locallyCommitted };
    }
  }
  return markers;
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
  try {
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
    results.forEach((filepath) => {
      if (typeof filepath === 'string') {
        changed.add(filepath);
      }
    });
  } catch (err) {
    console.warn('walk diff failed', err);
  }
  return changed;
}

async function refreshNoteMarkers() {
  noteMarkersById = await buildNoteMarkers(notes);
}

async function refreshNotesList() {
  await refreshNoteMarkers();
  renderNotesList();
}

function randomId() {
  return crypto.randomUUID();
}

/**
 * @param {string} markdown
 * @param {{viewer?: boolean; preserveCurrentMarkdown?: boolean}} [options]
 */
function createEditor(markdown, options = {}) {
  if (editor) {
    editor.destroy();
  }
  editor = new Editor({
    el: editorHostEl,
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    viewer: Boolean(options.viewer),
    previewHighlight: false,
    usageStatistics: false,
    hideModeSwitch: false,
    theme: colorSchemeMedia.matches ? 'dark' : 'light',
    frontMatter: true,
    autofocus: false,
    hooks: {
      addImageBlobHook: async (blob, callback) => {
        try {
          const imageUrl = await uploadImageToBlobs(blob, currentId);
          callback(imageUrl, blob.name);
        } catch (err) {
          console.error('image upload failed', err);
        }
      },
    },
    events: {
      change: () => {
        if (!editor || isApplyingMarkdown || isViewingHistorySnapshot) return;
        currentMarkdown = editor.getMarkdown();
        setHasUnsavedChanges(currentMarkdown !== lastSavedMarkdown);
      },
      blur: () => {
        if (isViewingHistorySnapshot || !hasUnsavedChanges) return;
        saveAndCommit();
      },
    },
  });
  isApplyingMarkdown = true;
  editor.setMarkdown(markdown);
  if (!options.preserveCurrentMarkdown) {
    currentMarkdown = markdown;
  }
  setHasUnsavedChanges(currentMarkdown !== lastSavedMarkdown);
  isApplyingMarkdown = false;
}

/**
 * @param {Blob} blob
 * @param {string | null} noteId
 * @returns {Promise<string>}
 */
async function uploadImageToBlobs(blob, noteId) {
  const filename = getBlobFileName(blob);
  const safeNoteId = noteId || 'misc';

  const url = `/blobs/${encodeURIComponent(safeNoteId)}/${encodeURIComponent(filename)}`;
  const response = await globalThis.fetch(url, {
    method: 'POST',
    body: blob,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const status = typeof response.status === 'number' ? response.status : 'unknown';
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    const detail = errorBody ? ` ${errorBody}` : '';
    throw new Error(`upload failed: ${status}${statusText}${detail}`);
  }

  return getUploadUrlFromResponse(response);
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function getUploadUrlFromResponse(response) {
  const locationHeader =
    response.headers.get('Location') ?? response.headers.get('location');
  const contentType = response.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    try {
      const payload = await response.clone().json();
      if (payload && typeof payload.url === 'string' && payload.url.trim()) {
        return payload.url.trim();
      }
    } catch (err) {
      // Fall through to plain text / Location handling.
    }
  }

  const bodyText = await response.text().catch(() => '');
  const trimmedBody = bodyText.trim();
  if (trimmedBody) {
    return trimmedBody;
  }

  if (locationHeader && locationHeader.trim()) {
    return locationHeader.trim();
  }

  throw new Error('upload failed: invalid response');
}

/**
 * @param {Blob} blob
 * @returns {string}
 */
function getBlobFileName(blob) {
  if ('name' in blob && typeof blob.name === 'string' && blob.name) {
    return blob.name;
  }
  let ext = 'bin';
  if (blob.type && blob.type.startsWith('image/')) {
    const [, subtype] = blob.type.split('/');
    if (subtype) {
      ext = subtype;
    }
  }
  return `image-${Date.now()}.${ext}`;
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
 * @returns {Promise<string[]>}
 */
async function listNoteFiles(rootDir) {
  /** @type {string[]} */
  const files = [];

  async function walk(currentDir) {
    /** @type {string[]} */
    let entries = [];
    try {
      entries = await pfs.readdir(currentDir);
    } catch (err) {
      if (getErrorCode(err) === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const filePath = `${currentDir}/${entry}`;
      let stats;
      try {
        stats = await pfs.stat(filePath);
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') continue;
        throw err;
      }
      if (stats.isDirectory()) {
        await walk(filePath);
      } else if (stats.isFile()) {
        files.push(filePath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function loadNotes() {
  const files = await listNoteFiles(notesDir);

  /** @type {Note[]} */
  const loadedNotes = [];
  for (const filePath of files) {
    const relId = filePath.startsWith(`${notesDir}/`)
      ? filePath.slice(notesDir.length + 1)
      : filePath;
    const relPath = getNoteFilePath({ id: relId });
    try {
      /** @type {string} */
      const body = await pfs.readFile(filePath, 'utf8');
      const parsed = parseNoteBody(body);
      const frontMatterUpdatedAt = getNoteUpdatedAt(parsed);
      const updatedAt =
        typeof frontMatterUpdatedAt === 'number'
          ? frontMatterUpdatedAt
          : await getLatestCommitTimestamp(relPath);
      loadedNotes.push({
        id: relId,
        body,
        updatedAt,
      });
    } catch (err) {
      if (getErrorCode(err) === 'ENOENT') continue;
      console.warn(`failed to read note ${filePath}`, err);
    }
  }

  notes = loadedNotes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * @param {Note} note
 */
async function saveNoteFile(note) {
  const relPath = getNoteFilePath(note);
  await pfs.writeFile(`${dir}/${relPath}`, note.body, 'utf8');
  return relPath;
}

function pushHistoryState(state) {
  if (isHandlingPopState) return;
  history.pushState(state, '');
}

function replaceHistoryState(state) {
  if (isHandlingPopState) return;
  history.replaceState(state, '');
}

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
 * @param {string} oid
 * @returns {Promise<void>}
 */
async function showHistoryInEditor(oid) {
  if (!currentId) return;
  const filepath = getNoteFilePath({ id: currentId });
  try {
    const body = await getHistoryContent(oid, filepath);
    historyMarkdown = body;
    isViewingHistorySnapshot = true;
    setEditorReadOnly(true);
    if (editor) {
      isApplyingMarkdown = true;
      editor.setMarkdown(body);
      isApplyingMarkdown = false;
    }
  } catch (err) {
    console.warn('failed to load history content in editor', err);
  }
}

function showCurrentInEditor() {
  if (!currentId || !editor) return;
  isViewingHistorySnapshot = false;
  historyMarkdown = '';
  setEditorReadOnly(false);
  isApplyingMarkdown = true;
  editor.setMarkdown(currentMarkdown);
  setHasUnsavedChanges(currentMarkdown !== lastSavedMarkdown);
  isApplyingMarkdown = false;
}

async function renderCurrentNoteHistory() {
  if (!currentId) {
    renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
    historySelectEl.value = '';
    historySelectEl.disabled = true;
    return;
  }
  historySelectEl.disabled = false;

  try {
    const filepath = getNoteFilePath({ id: currentId });
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
  } catch (err) {
    console.warn('failed to load note history', err);
    renderNoteHistory([], { emptyMessage: '履歴を取得できません' });
  }
}

/**
 * @param {Note} note
 * @param {{source?: 'user' | 'history' | 'system'}} [options]
 */
async function openNote(note, options = {}) {
  currentId = note.id;
  currentMarkdown = note.body;
  isViewingHistorySnapshot = false;
  historyMarkdown = '';
  lastSavedMarkdown = note.body;
  createEditor(note.body, { viewer: false });
  setEditorReadOnly(false);
  updateCurrentNoteState();
  setActiveNoteInList(currentId);
  await renderCurrentNoteHistory();
  historySelectEl.value = '';
  showEditorOnMobile();
  if (options.source !== 'history') {
    const shouldReplace = options.source === 'system' || !hasInitializedHistoryState;
    updateHistoryForNote(note.id, { replace: shouldReplace });
  }
}

async function createNote() {
  const id = randomId();
  /** @type {Note} */
  const note = {
    id, body: '---\ntitle: \n---\n\n'
  };
  lastSavedMarkdown = note.body;
  notes.unshift(note);
  await saveNoteFile(note);
  currentId = id;
  await refreshNotesList();
  openNote(note, { source: 'user' });
}

async function deleteCurrentNote() {
  if (!currentId) return;
  const targetIndex = notes.findIndex((note) => note.id === currentId);
  const filepath = getNoteFilePath({ id: currentId });
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
  currentId = notes[0]?.id ?? null;
  await refreshNotesList();
  if (notes[0]) {
    await openNote(notes[0], { source: 'system' });
  } else {
    currentMarkdown = '';
    if (editor) {
      editor.setMarkdown('');
    }
    updateCurrentNoteState();
    renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
    historySelectEl.value = '';
    historySelectEl.disabled = true;
    showListOnMobile();
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function saveAndCommit() {
  if (!currentId) return false;
  /** @type {Note} */
  const note = {
    id: currentId,
    body: currentMarkdown,
  };
  const parsed = parseNoteBody(note.body);
  const frontMatterUpdatedAt = getNoteUpdatedAt(parsed);
  if (typeof frontMatterUpdatedAt === 'number') {
    note.updatedAt = frontMatterUpdatedAt;
  }
  const filepath = await saveNoteFile(note);
  const existing = notes.find((entry) => entry.id === currentId);
  if (existing) {
    existing.body = note.body;
    if (note.updatedAt) {
      existing.updatedAt = note.updatedAt;
    }
  } else {
    notes.unshift(note);
  }
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

  await refreshNotesList();
  lastSavedMarkdown = currentMarkdown;
  setHasUnsavedChanges(false);
  return modified;
}

async function pushChanges() {
  if (hasUnsavedChanges && currentId && !isViewingHistorySnapshot) {
    try {
      await saveAndCommit();
    } catch (err) {
      console.error(err);
      setStatusUi('commit failed');
      return;
    }
  }
  const [preLocalOid, preRemoteOid] = await Promise.all([
    git.resolveRef({ fs, dir, ref: 'refs/heads/main' }).catch(() => null),
    git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' }).catch(() => null),
  ]);
  console.log('[push] refs:before', { preLocalOid, preRemoteOid });
  try {
    const matrix = await statusMatrix();
    console.log('[push] statusMatrix', formatStatusMatrix(matrix));
  } catch (err) {
    console.warn('[push] statusMatrix failed', err);
  }
  let conflictCommitted = false;
  try {
    setStatusUi('syncing…');
    await fetch();
    await merge({ abortOnConflict: false });
    await refreshWorkingTree();
    await loadNotes();
    await refreshNotesList();
  } catch (err) {
    if (
      err instanceof git.Errors.MergeConflictError ||
      err instanceof git.Errors.UnmergedPathsError
    ) {
      console.error(err);
      await loadNotes();
      await refreshNotesList();
      if (currentId) {
        const note = notes.find((entry) => entry.id === currentId);
        if (note) {
          await openNote(note, { source: 'system' });
        }
      }
      try {
        conflictCommitted = await commitMergeConflictMarkers();
      } catch (commitErr) {
        console.error(commitErr);
        setStatusUi('merge conflict commit failed');
        return;
      }
      if (!conflictCommitted) {
        setStatusUi('merge conflict (markers created)');
        return;
      }
    } else {
      console.error(err);
      setStatusUi('push failed');
      return;
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
      try {
        await git.writeRef({
          fs,
          dir,
          ref: 'refs/remotes/origin/main',
          value: postLocalOid,
          force: true,
        });
      } catch (err) {
        console.warn('failed to update origin tracking ref', err);
      }
    }
    console.log('[push] refs:after', { postLocalOid, postRemoteOid });
    setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
    await refreshNotesList();
  } catch (err) {
    if (err instanceof git.Errors.PushRejectedError) {
      const upToDate = await isUpToDateWithRemote();
      if (upToDate) {
        setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
        return;
      }
    }
    console.error(err);
    setStatusUi('push failed');
  }
}

async function pullChanges() {
  setStatusUi('pulling…');
  try {
    await fetch();
    await merge({ abortOnConflict: false });
    if (!hasUnsavedChanges) {
      await refreshWorkingTree();
    }
    await loadNotes();
    await refreshNotesList();
    const [localOid, remoteOid] = await Promise.all([
      git.resolveRef({ fs, dir, ref: 'refs/heads/main' }).catch(() => null),
      git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' }).catch(() => null),
    ]);
    console.log('[pull] refs', { localOid, remoteOid });
    console.log('[pull] notes', {
      count: notes.length,
      first: notes[0]?.id ?? null,
      firstUpdatedAt: notes[0]?.updatedAt ?? null,
      currentId,
    });
    if (!hasUnsavedChanges && currentId) {
      const note = notes.find((entry) => entry.id === currentId);
      if (note) {
        await openNote(note, { source: 'system' });
      }
    }
    const committed = await commitMergeConflictMarkers();
    if (committed) {
      setStatusUi('merge conflict committed');
      return;
    }
    setStatusUi('pulled');
  } catch (err) {
    if (err instanceof git.Errors.MergeConflictError) {
      console.log(err);
      if (!hasUnsavedChanges) {
        try {
          await resetToRemote();
          await loadNotes();
          await refreshNotesList();
          setStatusUi('pulled (remote)');
          return;
        } catch (resetErr) {
          console.error(resetErr);
        }
      }
      try {
        const committed = await commitMergeConflictMarkers();
        setStatusUi(committed ? 'merge conflict committed' : 'merge conflict (markers created)');
      } catch (commitErr) {
        console.error(commitErr);
        setStatusUi('merge conflict commit failed');
      }
    } else {
      console.error(err);
      setStatusUi('pull failed');
    }
  }
}

async function resetNotesToOrigin() {
  const hasLocalEdits = hasUnsavedChanges || isViewingHistorySnapshot;
  const message = hasLocalEdits
    ? '未保存の変更を含むローカルの内容をすべて破棄してoriginに戻します。よろしいですか？'
    : 'ローカルの内容をすべて破棄してoriginに戻します。よろしいですか？';
  if (!window.confirm(message)) return;

  setStatusUi('resetting…');
  try {
    await fetch();
    await resetToRemote();
    await refreshWorkingTree();
    await removeLocalOnlyNotes();
    await loadNotes();
    currentId = notes[0]?.id ?? null;
    isViewingHistorySnapshot = false;
    historyMarkdown = '';
    if (currentId) {
      const note = notes.find((entry) => entry.id === currentId);
      if (note) {
        await openNote(note, { source: 'system' });
      }
    } else {
      currentMarkdown = '';
      lastSavedMarkdown = '';
      if (editor) {
        editor.setMarkdown('');
      }
      updateCurrentNoteState();
      renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
      historySelectEl.value = '';
      historySelectEl.disabled = true;
      showListOnMobile();
    }
    await refreshNotesList();
    setHasUnsavedChanges(false);
    setStatusUi('reset to origin');
  } catch (err) {
    console.error(err);
    setStatusUi('reset failed');
  }
}

async function removeLocalOnlyNotes() {
  let matrix = [];
  try {
    matrix = await statusMatrix();
  } catch (err) {
    console.warn('statusMatrix failed', err);
    return;
  }
  const localOnly = matrix.filter(([path, head]) => head === 0 && path.startsWith('notes/'));
  for (const [path] of localOnly) {
    try {
      await pfs.unlink(`${dir}/${path}`);
    } catch (err) {
      if (getErrorCode(err) !== 'ENOENT') {
        console.warn('failed to remove local note', err);
      }
    }
    try {
      await remove({ filepath: path });
    } catch (err) {
      if (getErrorCode(err) !== 'NotFoundError') {
        console.warn('failed to unstage local note', err);
      }
    }
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
    console.warn('initial fetch failed; continuing offline', err);
    setStatusUi('offline (local only)');
  }

  try {
    await merge();
    await refreshWorkingTree();
    await loadNotes();
    await refreshNotesList();
    didLoadNotes = true;
    const committed = await commitMergeConflictMarkers();
    setStatusUi(committed ? 'merge conflict committed' : 'synced');
  } catch (err) {
    if (err instanceof git.Errors.MergeConflictError) {
      try {
        const committed = await commitMergeConflictMarkers();
        setStatusUi(committed ? 'merge conflict committed' : 'conflict');
      } catch (commitErr) {
        console.error(commitErr);
        setStatusUi('merge conflict commit failed');
      }
    }
  }

  if (!didLoadNotes) {
    await loadNotes();
    await refreshNotesList();
  }
  updateCurrentNoteState();
  await renderCurrentNoteHistory();
  if (!hasInitializedHistoryState) {
    if (currentId) {
      updateHistoryForNote(currentId, { replace: true });
    } else {
      replaceHistoryState({ view: 'list' });
      hasInitializedHistoryState = true;
    }
  }
}

function handleCloneAction() {
  cloneRepo().catch((err) => {
    console.error(err);
    setStatusUi('new note failed');
  });
}

pushBtn.addEventListener('click', () => {
  pushChanges().catch((err) => {
    console.error(err);
    setStatusUi('push failed');
  });
});

pullBtn.addEventListener('click', () => {
  pullChanges().catch((err) => {
    console.error(err);
    setStatusUi('pull failed');
  });
});

resetBtn.addEventListener('click', () => {
  resetNotesToOrigin().catch((err) => {
    console.error(err);
    setStatusUi('reset failed');
  });
});

if (cloneBtn) {
  cloneBtn.addEventListener('click', handleCloneAction);
}
if (emptyCloneBtn) {
  emptyCloneBtn.addEventListener('click', handleCloneAction);
}

newBtn.addEventListener('click', () => {
  createNote().catch((err) => {
    console.error(err);
    setStatusUi('new note failed');
  });
});

tagFilterEl.addEventListener('change', () => {
  currentTagFilter = tagFilterEl.value;
  renderNotesList();
});

deleteBtn.addEventListener('click', () => {
  deleteCurrentNote().catch((err) => {
    console.error(err);
    setStatusUi('delete failed');
  });
});

historySelectEl.addEventListener('change', () => {
  if (!currentId) return;
  const oid = historySelectEl.value;
  if (!oid || oid === '__empty') {
    showCurrentInEditor();
    return;
  }
  showHistoryInEditor(oid).catch((err) => {
    console.warn('failed to show history in editor', err);
  });
});
applyMobileUiState();

if (mobileBackBtn) {
  mobileBackBtn.addEventListener('click', () => {
    showListOnMobile({ source: 'user' });
  });
}

colorSchemeMedia.addEventListener('change', () => {
  const markdown = isViewingHistorySnapshot
    ? historyMarkdown
    : editor
      ? editor.getMarkdown()
      : currentMarkdown;
  createEditor(markdown, {
    viewer: isViewingHistorySnapshot,
    preserveCurrentMarkdown: isViewingHistorySnapshot,
  });
  setEditorReadOnly(isViewingHistorySnapshot);
});

mobileMedia.addEventListener('change', applyMobileUiState);
coarsePointerMedia.addEventListener('change', applyMobileUiState);

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
  handlePopState(event).catch((err) => {
    console.error('failed to handle history navigation', err);
  });
});

bootstrap().catch((err) => {
  console.error(err);
  setStatusUi('failed to start');
});
