'use strict';
import LightningFS from 'https://esm.sh/@isomorphic-git/lightning-fs';
import * as git from 'https://esm.sh/isomorphic-git@beta';
import http from 'https://esm.sh/isomorphic-git@beta/http/web';
import { Buffer } from 'https://esm.sh/buffer@6.0.3';
import { Editor } from 'https://esm.sh/@toast-ui/editor@3.2.2';

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

/** @typedef {{id: string; body: string; updatedAt?: number}} Note */
/** @typedef {{frontMatter: Record<string, string | string[]>; frontMatterRaw: string | null; content: string}} ParsedNote */

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
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function getRequiredElement(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element: ${id}`);
  }
  return /** @type {T} */ (el);
}

/** @type {HTMLParagraphElement} */
const statusEl = getRequiredElement('sync-status');
/** @type {HTMLUListElement} */
const listEl = getRequiredElement('note-list');
/** @type {HTMLUListElement} */
const currentNoteHistoryEl = getRequiredElement('current-note-history');
/** @type {HTMLDivElement} */
const editorHostEl = getRequiredElement('editor-host');
/** @type {HTMLButtonElement} */
const saveBtn = getRequiredElement('save-note');
/** @type {HTMLButtonElement} */
const pushBtn = getRequiredElement('push-notes');
/** @type {HTMLButtonElement} */
const pullBtn = getRequiredElement('pull-notes');
/** @type {HTMLButtonElement} */
const cloneBtn = getRequiredElement('clone');
/** @type {HTMLButtonElement} */
const deleteBtn = getRequiredElement('delete');
/** @type {HTMLButtonElement} */
const newBtn = getRequiredElement('new-note');
/** @type {HTMLButtonElement} */
const toggleHistoryBtn = getRequiredElement('toggle-history');
/** @type {HTMLElement} */
const historySectionEl = getRequiredElement('history-section');
/** @type {HTMLElement} */
const notesSectionEl = getRequiredElement('notes-section');

/** @type {Note[]} */
let notes = [];
/** @type {Note['id'] | null} */
let currentId = null;
/** @type {Editor | null} */
let editor = null;
let isHistoryVisible = false;
let currentMarkdown = '';
const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

const DATE_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function clone(options = {}) {
  const defaults = {
    fs,
    http,
    dir,
    url,
    ref: 'main',
    singleBranch: true,
  };
  return git.clone({ ...defaults, ...options });
}

export function add(options = {}) {
  const defaults = { fs, dir };
  return git.add({ ...defaults, ...options });
}

export function commit(options = {}) {
  const defaults = { fs, dir, author, message: 'update' };
  return git.commit({ ...defaults, ...options });
}

export function remove(options = {}) {
  const defaults = { fs, dir };
  return git.remove({ ...defaults, ...options });
}

export function push(options = {}) {
  const defaults = { fs, dir, http, url, remote: 'origin', ref: 'main' };
  return git.push({ ...defaults, ...options });
}

export function pull(options = {}) {
  const defaults = { fs, dir, http, url, remote: 'origin', ref: 'main' };
  return git.pull({ ...defaults, ...options });
}

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

export function merge(options = {}) {
  const defaults = { fs, dir, ours: 'main', theirs: 'origin/main' };
  return git.merge({ ...defaults, ...options });
}

export function log(options = {}) {
  const defaults = { fs, dir };
  return git.log({ ...defaults, ...options });
}

async function isUpToDateWithRemote() {
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
async function getBlobOidAtCommit(oid, filepath) {
  try {
    const result = await git.readBlob({ fs, dir, oid, filepath });
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
async function getHistoryContent(oid, filepath) {
  const { blob } = await git.readBlob({ fs, dir, oid, filepath });
  const decoder = new TextDecoder();
  return decoder.decode(blob);
}

/**
 * @param {string} filepath
 * @returns {Promise<Awaited<ReturnType<typeof log>>>}
 */
async function logFileChanges(filepath) {
  const commits = await log({ filepath });
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

export function status(options = {}) {
  const defaults = { fs, dir };
  return git.status({ ...defaults, ...options });
}

export function getConfig(options = {}) {
  const defaults = { fs, dir };
  return git.getConfig({ ...defaults, ...options });
}

export function setConfig(options = {}) {
  const defaults = { fs, dir };
  return git.setConfig({ ...defaults, ...options });
}

/**
 * @param {string} message
 */
function setStatus(message) {
  statusEl.textContent = message;
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
 * @param {string[]} lines
 * @returns {Record<string, string | string[]>}
 */
function parseFrontMatter(lines) {
  /** @type {Record<string, string | string[]>} */
  const data = {};
  /** @type {string | null} */
  let listKey = null;

  lines.forEach((line) => {
    if (!line.trim()) return;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && listKey) {
      const entry = listMatch[1].trim();
      if (entry) {
        /** @type {string[]} */ (data[listKey]).push(entry);
      }
      return;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) {
      listKey = null;
      return;
    }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (!value) {
      data[key] = [];
      listKey = key;
      return;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else {
      data[key] = value;
    }
    listKey = null;
  });

  return data;
}

/**
 * @param {number | undefined} timestamp
 * @returns {string}
 */
function formatUpdatedAt(timestamp) {
  if (!timestamp) return 'unknown';
  return DATE_FORMATTER.format(new Date(timestamp));
}

/**
 * @param {string} filepath
 * @returns {Promise<number | undefined>}
 */
async function getLatestCommitTimestamp(filepath) {
  try {
    const commits = await logFileChanges(filepath);
    const ts = commits[0]?.commit?.author?.timestamp;
    if (typeof ts !== 'number') return undefined;
    return ts * 1000;
  } catch (err) {
    return undefined;
  }
}

/**
 * @param {string | null | undefined} body
 * @returns {ParsedNote}
 */
function parseNoteBody(body) {
  const safeBody = typeof body === 'string' ? body : '';
  const lines = safeBody.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontMatter: {}, frontMatterRaw: null, content: safeBody };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, frontMatterRaw: null, content: safeBody };
  }

  const frontMatterLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join('\n');
  return {
    frontMatter: parseFrontMatter(frontMatterLines),
    frontMatterRaw: lines.slice(0, endIndex + 1).join('\n'),
    content,
  };
}

/**
 * @param {ParsedNote} parsed
 * @returns {string}
 */
function getNoteTitle(parsed) {
  if (typeof parsed.frontMatter.title === 'string') {
    const title = parsed.frontMatter.title.trim();
    if (title) return title;
  }
  const fallback = parsed.content
    .split(/\r?\n/)
    .find((line) => line.trim());
  return fallback ? fallback.trim() : 'Untitled';
}

/**
 * @param {ParsedNote} parsed
 * @returns {string[]}
 */
function getNoteTags(parsed) {
  const tags = parsed.frontMatter.tags;
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag === 'string' && tag.trim());
  }
  if (typeof tags === 'string' && tags.trim()) {
    return [tags.trim()];
  }
  return [];
}

function setActiveNoteInList() {
  const items = listEl.querySelectorAll('li');
  items.forEach((item) => {
    item.classList.toggle('active', item.dataset.id === currentId);
  });
}

/**
 * @param {string} markdown
 */
function createEditor(markdown) {
  if (editor) {
    editor.destroy();
  }
  editor = new Editor({
    el: editorHostEl,
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    usageStatistics: false,
    hideModeSwitch: false,
    theme: colorSchemeMedia.matches ? 'dark' : 'light',
    frontMatter: true,
    events: {
      change: () => {
        if (!editor ) return;
        currentMarkdown = editor.getMarkdown();
      },
      blur: () => {
        saveAndCommit();
      },
    },
  });
  editor.setMarkdown(markdown);
  currentMarkdown = markdown;
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function getErrorCode(err) {
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

async function ensureConfig() {
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

async function applyConfigDefaults() {
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

async function cloneRepo() {
  if (!await ensureConfig()) {
    await clone();
    await applyConfigDefaults();
    await bootstrap();
  }
}

async function loadNotes() {
  let entries = [];
  try {
    entries = await pfs.readdir(notesDir);
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      notes = [];
      return;
    }
    throw err;
  }

  /** @type {Note[]} */
  const loadedNotes = [];
  for (const entry of entries) {
    const filePath = `${notesDir}/${entry}`;
    const relPath = getNoteFilePath({ id: entry });
    try {
      /** @type {string} */
      const body = await pfs.readFile(filePath, 'utf8');
      const updatedAt = await getLatestCommitTimestamp(relPath);
      loadedNotes.push({
        id: entry,
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

function renderNotes() {
  listEl.innerHTML = '';
  notes.forEach((note) => {
    const parsed = parseNoteBody(note.body);
    const title = getNoteTitle(parsed);
    const tags = getNoteTags(parsed);

    const li = document.createElement('li');
    const titleEl = document.createElement('div');
    titleEl.className = 'note-title';
    titleEl.textContent = title;
    li.appendChild(titleEl);
    if (tags.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'note-tags';
      tagsEl.textContent = tags.join(', ');
      li.appendChild(tagsEl);
    }
    li.dataset.id = note.id;
    if (note.id === currentId) {
      li.classList.add('active');
    }
    li.addEventListener('click', async () => {
      await openNote(note);
    });
    listEl.appendChild(li);
  });
}

/**
 * @param {boolean} readOnly
 */
function setEditorReadOnly(readOnly) {
  const editableNodes = editorHostEl.querySelectorAll('[contenteditable]');
  editableNodes.forEach((node) => {
    if (readOnly) {
      node.setAttribute('contenteditable', 'false');
      return;
    }
    node.setAttribute('contenteditable', 'true');
  });
}

function updateHistoryToggleUI() {
  historySectionEl.toggleAttribute('hidden', !isHistoryVisible);
  notesSectionEl.toggleAttribute('hidden', isHistoryVisible);
  toggleHistoryBtn.setAttribute('aria-pressed', String(isHistoryVisible));
  toggleHistoryBtn.textContent = isHistoryVisible ? 'Notes' : 'History';
  setEditorReadOnly(isHistoryVisible);
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
    if (editor) {
      editor.setMarkdown(body);
    }
  } catch (err) {
    console.warn('failed to load history content in editor', err);
  }
}

async function renderCurrentNoteHistory() {
  currentNoteHistoryEl.innerHTML = '';
  if (!currentId) {
    const li = document.createElement('li');
    li.textContent = 'メモが選択されていません';
    currentNoteHistoryEl.appendChild(li);
    return;
  }

  try {
    const filepath = getNoteFilePath({ id: currentId });
    const commits = await logFileChanges(filepath);
    const validCommits = commits.filter(
      (entry) => typeof entry.commit?.author?.timestamp === 'number'
    );
    if (!validCommits.length) {
      const li = document.createElement('li');
      li.textContent = '履歴がありません';
      currentNoteHistoryEl.appendChild(li);
      return;
    }

    validCommits.forEach((entry) => {
      const ts = entry.commit?.author?.timestamp;
      if (typeof ts !== 'number') return;
      const date = formatUpdatedAt(ts * 1000);
      const li = document.createElement('li');
      li.textContent = date;
      li.dataset.oid = entry.oid;
      li.addEventListener('click', () => {
        const siblings = currentNoteHistoryEl.querySelectorAll('li');
        siblings.forEach((other) => {
          if (other === li) return;
          other.classList.remove('active');
        });
        li.classList.add('active');
        if (isHistoryVisible) {
          showHistoryInEditor(entry.oid).catch((err) => {
            console.warn('failed to show history in editor', err);
          });
        }
      });
      currentNoteHistoryEl.appendChild(li);
    });
  } catch (err) {
    console.warn('failed to load note history', err);
    const li = document.createElement('li');
    li.textContent = '履歴を取得できません';
    currentNoteHistoryEl.appendChild(li);
  }
}

/**
 * @param {Note} note
 */
async function openNote(note) {
  currentId = note.id;
  currentMarkdown = note.body;
  if (editor) {
    editor.setMarkdown(note.body);
  }
  setActiveNoteInList();
  if (isHistoryVisible) {
    await renderCurrentNoteHistory();
  }
}

async function createNote() {
  const id = randomId();
  /** @type {Note} */
  const note = {
    id, body: ''
  };
  notes.unshift(note);
  await saveNoteFile(note);
  currentId = id;
  renderNotes();
  openNote(note);
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
    setStatus('deleted');
  } else {
    setStatus('removed locally');
  }

  if (targetIndex !== -1) {
    notes.splice(targetIndex, 1);
  }
  currentId = notes[0]?.id ?? null;
  renderNotes();
  if (notes[0]) {
    await openNote(notes[0]);
  } else {
    currentMarkdown = '';
    if (editor) {
      editor.setMarkdown('');
    }
  }
}

async function saveAndCommit() {
  if (!currentId) return;
  /** @type {Note} */
  const note = {
    id: currentId,
    body: currentMarkdown,
  };
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
    note.updatedAt = await getLatestCommitTimestamp(filepath);
  }
  setStatus(modified ? 'committed locally' : 'no changes');

  renderNotes();
}

async function pushChanges() {
  try {
    setStatus('syncing…');
    await fetch();
    await merge();
    await loadNotes();
    renderNotes();
  } catch (err) {
    if (getErrorCode(err) === 'MergeConflictError') {
      console.error(err);
      setStatus('merge conflict');
      return;
    }
    console.error(err);
    setStatus('push failed');
    return;
  }

  setStatus('pushing…');
  try {
    await push();
    setStatus('pushed');
  } catch (err) {
    if (getErrorCode(err) === 'PushRejectedError') {
      const upToDate = await isUpToDateWithRemote();
      if (upToDate) {
        setStatus('pushed');
        return;
      }
    }
    console.error(err);
    setStatus('push failed');
  }
}

async function pullChanges() {
  setStatus('pulling…');
  try {
    await pull();
    await loadNotes();
    renderNotes();
    setStatus('pulled');
  } catch (err) {
    console.error(err);
    setStatus('pull failed');
  }
}

async function bootstrap() {
  setStatus('preparing…');
  const hasConfig = await ensureConfig();
  if (!hasConfig) {
    setStatus('missing config');
    return;
  }

  try {
    await pull();
    setStatus('synced');
  } catch (err) {
    console.warn('initial fetch failed; continuing offline', err);
    setStatus('offline (local only)');
  }

  await loadNotes();
  renderNotes();
  if (notes[0]) {
    await openNote(notes[0]);
  } else if (isHistoryVisible) {
    await renderCurrentNoteHistory();
  }
}

saveBtn.addEventListener('click', () => {
  saveAndCommit().catch((err) => {
    console.error(err);
    setStatus('save failed');
  });
});

pushBtn.addEventListener('click', () => {
  pushChanges().catch((err) => {
    console.error(err);
    setStatus('push failed');
  });
});

pullBtn.addEventListener('click', () => {
  pullChanges().catch((err) => {
    console.error(err);
    setStatus('pull failed');
  });
});

cloneBtn.addEventListener('click', () => {
  cloneRepo().catch((err) => {
    console.error(err);
    setStatus('new note failed');
  });
});

newBtn.addEventListener('click', () => {
  createNote().catch((err) => {
    console.error(err);
    setStatus('new note failed');
  });
});

deleteBtn.addEventListener('click', () => {
  deleteCurrentNote().catch((err) => {
    console.error(err);
    setStatus('delete failed');
  });
});

toggleHistoryBtn.addEventListener('click', () => {
  isHistoryVisible = !isHistoryVisible;
  updateHistoryToggleUI();
  if (isHistoryVisible) {
    renderCurrentNoteHistory().catch((err) => {
      console.error(err);
    });
    return;
  }
  if (currentId) {
    const note = notes.find((entry) => entry.id === currentId);
    if (note) {
      openNote(note).catch((err) => {
        console.error(err);
      });
    }
  }
});

createEditor('');
updateHistoryToggleUI();

colorSchemeMedia.addEventListener('change', () => {
  const markdown = editor ? editor.getMarkdown() : currentMarkdown;
  createEditor(markdown);
});

bootstrap().catch((err) => {
  console.error(err);
  setStatus('failed to start');
});
