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
  getNoteUpdatedAt,
} from './note-utils.js';
import {
  editorHostEl,
  pushBtn,
  pullBtn,
  cloneBtn,
  emptyCloneBtn,
  deleteBtn,
  newBtn,
  toggleHistoryBtn,
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
  updateHistoryToggleButton,
  renderNotes,
  renderNoteHistory,
} from './ui.js';

/** @typedef {{id: string; body: string; updatedAt?: number}} Note */


/** @type {Note[]} */
let notes = [];
/** @type {Note['id'] | null} */
let currentId = null;
/** @type {Editor | null} */
let editor = null;
let isHistoryVisible = false;
let currentMarkdown = '';
let lastSavedMarkdown = '';
let hasUnsavedChanges = false;
let isApplyingMarkdown = false;
let isViewingHistorySnapshot = false;
let isHandlingPopState = false;
let hasInitializedHistoryState = false;

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

function randomId() {
  return crypto.randomUUID();
}

/**
 * @param {string} markdown
 * @param {{viewer?: boolean}} [options]
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
  currentMarkdown = markdown;
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

function updateHistoryToggleUI() {
  updateHistoryToggleButton(isHistoryVisible);
  if (currentId) {
    createEditor(currentMarkdown, { viewer: isHistoryVisible });
  }
  setEditorReadOnly(isHistoryVisible);
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
    currentMarkdown = body;
    isViewingHistorySnapshot = true;
    if (editor) {
      editor.setMarkdown(body);
    }
  } catch (err) {
    console.warn('failed to load history content in editor', err);
  }
}

async function renderCurrentNoteHistory() {
  if (!currentId) {
    renderNoteHistory([], { emptyMessage: 'メモが選択されていません' });
    return;
  }

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
    renderNoteHistory(entries, {
      emptyMessage: '履歴がありません',
      onSelect: (oid) => {
        if (!isHistoryVisible) return;
        showHistoryInEditor(oid).catch((err) => {
          console.warn('failed to show history in editor', err);
        });
      },
    });
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
  lastSavedMarkdown = note.body;
  createEditor(note.body, { viewer: isHistoryVisible });
  updateCurrentNoteState();
  setActiveNoteInList(currentId);
  if (isHistoryVisible) {
    await renderCurrentNoteHistory();
  }
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
  renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
  renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
  if (notes[0]) {
    await openNote(notes[0], { source: 'system' });
  } else {
    currentMarkdown = '';
    if (editor) {
      editor.setMarkdown('');
    }
    updateCurrentNoteState();
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
  }
  setStatusUi(modified ? 'committed locally' : 'no changes');

  renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
    renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
  } catch (err) {
    if (
      err instanceof git.Errors.MergeConflictError ||
      err instanceof git.Errors.UnmergedPathsError
    ) {
      console.error(err);
      await loadNotes();
      renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
    console.log('[push] refs:after', { postLocalOid, postRemoteOid });
    setStatusUi(conflictCommitted ? 'pushed (conflict committed)' : 'pushed');
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
    renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
  renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
    renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
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
  renderNotes(notes, currentId, (note) => openNote(note, { source: 'user' }));
  }
  updateCurrentNoteState();
  if (isHistoryVisible) {
    await renderCurrentNoteHistory();
  }
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

deleteBtn.addEventListener('click', () => {
  deleteCurrentNote().catch((err) => {
    console.error(err);
    setStatusUi('delete failed');
  });
});

toggleHistoryBtn.addEventListener('click', () => {
  isHistoryVisible = !isHistoryVisible;
  updateHistoryToggleUI();
  if (isHistoryVisible) {
    showListOnMobile();
    renderCurrentNoteHistory().catch((err) => {
      console.error(err);
    });
    return;
  }
  if (currentId) {
    const note = notes.find((entry) => entry.id === currentId);
    if (note) {
      openNote(note, { source: 'system' }).catch((err) => {
        console.error(err);
      });
    }
  }
});

  updateHistoryToggleUI();
  applyMobileUiState();

if (mobileBackBtn) {
  mobileBackBtn.addEventListener('click', () => {
    showListOnMobile({ source: 'user' });
  });
}

colorSchemeMedia.addEventListener('change', () => {
  const markdown = editor ? editor.getMarkdown() : currentMarkdown;
  createEditor(markdown, { viewer: isHistoryVisible });
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
