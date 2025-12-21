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
/** @type {HTMLDialogElement} */
const updateDialogEl = getRequiredElement('update-dialog');
/** @type {HTMLTextAreaElement} */
const bodyEl = getRequiredElement('note-body');
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
const togglePlainBtn = getRequiredElement('toggle-plain');
/** @type {HTMLButtonElement} */
const showUpdatesBtn = getRequiredElement('show-updates');
/** @type {HTMLButtonElement} */
const closeUpdatesBtn = getRequiredElement('close-updates');

/** @type {Note[]} */
let notes = [];
/** @type {Note['id'] | null} */
let currentId = null;
/** @type {string | null} */
let currentFrontMatterRaw = null;
/** @type {Editor | null} */
let editor = null;
let isPlainText = false;
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
 * @param {string} body
 * @returns {ParsedNote}
 */
function parseNoteBody(body) {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontMatter: {}, frontMatterRaw: null, content: body };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, frontMatterRaw: null, content: body };
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
 * @param {string} body
 * @param {string | null} frontMatterRaw
 * @returns {string}
 */
function composeNoteBody(body, frontMatterRaw) {
  if (!frontMatterRaw) return body;
  if (!body) return `${frontMatterRaw}\n`;
  return `${frontMatterRaw}\n${body}`;
}

/**
 * @param {string} markdown
 */
function updateNoteBody(markdown) {
  bodyEl.value = composeNoteBody(markdown, currentFrontMatterRaw);
}

function updateEditorModeUI() {
  document.body.classList.toggle('plain-text', isPlainText);
  togglePlainBtn.textContent = isPlainText ? 'WYSIWYG' : 'Plain Text';
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
    hideModeSwitch: true,
    theme: colorSchemeMedia.matches ? 'dark' : 'light',
    events: {
      change: () => {
        if (!editor) return;
        updateNoteBody(editor.getMarkdown());
      },
    },
  });
  editor.setMarkdown(markdown);
  if (!isPlainText) {
    updateNoteBody(markdown);
  }
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

async function ensureConfig() {
  const remoteUrl = await getConfig({ path: 'remote.origin.url' });
  const fetchRefspec = await getConfig({ path: 'remote.origin.fetch' });
  const existingName = await getConfig({ path: 'user.name' });
  const existingEmail = await getConfig({ path: 'user.email' });
  return (
    remoteUrl === url &&
    fetchRefspec === FETCH_REFSPEC &&
    Boolean(existingName) &&
    Boolean(existingEmail)
  );
}

async function applyConfigDefaults() {
  const remoteUrl = await getConfig({ path: 'remote.origin.url' });
  if (remoteUrl !== url) {
    await setConfig({ path: 'remote.origin.url', value: url });
  }
  const fetchRefspec = await getConfig({ path: 'remote.origin.fetch' });
  if (fetchRefspec !== FETCH_REFSPEC) {
    await setConfig({ path: 'remote.origin.fetch', value: FETCH_REFSPEC });
  }
  const existingName = await getConfig({ path: 'user.name' });
  if (!existingName) {
    await setConfig({ path: 'user.name', value: author.name });
  }
  const existingEmail = await getConfig({ path: 'user.email' });
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
 * @param {string} oid
 * @param {HTMLPreElement} contentEl
 * @returns {Promise<void>}
 */
async function renderHistoryContent(oid, contentEl) {
  if (!currentId) return;
  const filepath = getNoteFilePath({ id: currentId });
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    const decoder = new TextDecoder();
    const body = decoder.decode(blob);
    contentEl.textContent = body;
  } catch (err) {
    console.warn('failed to load history content', err);
    contentEl.textContent = '内容を取得できません';
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
      const details = document.createElement('details');
      details.className = 'history-details';
      const summary = document.createElement('summary');
      summary.textContent = date;
      const content = document.createElement('pre');
      content.className = 'history-content';
      content.textContent = 'クリックで読み込み';
      details.appendChild(summary);
      details.appendChild(content);
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        const siblings = currentNoteHistoryEl.querySelectorAll('details');
        siblings.forEach((other) => {
          if (other !== details) {
            other.removeAttribute('open');
          }
        });
        if (!details.dataset.loaded) {
          renderHistoryContent(entry.oid, content).catch((err) => {
            console.warn('failed to render history content', err);
          });
          details.dataset.loaded = 'true';
        }
      });
      li.appendChild(details);
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
  bodyEl.value = note.body;
  const parsed = parseNoteBody(note.body);
  currentFrontMatterRaw = parsed.frontMatterRaw;
  if (editor) {
    editor.setMarkdown(parsed.content ?? '');
  }
  if (!isPlainText) {
    updateNoteBody(parsed.content ?? '');
  }
  setActiveNoteInList();
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
    bodyEl.value = '';
    currentFrontMatterRaw = null;
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
    body: bodyEl.value,
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
  setStatus('pushing…');
  try {
    await push();
    setStatus('pushed');
  } catch (err) {
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

togglePlainBtn.addEventListener('click', () => {
  isPlainText = !isPlainText;
  if (isPlainText) {
    updateEditorModeUI();
    bodyEl.focus();
    return;
  }
  const parsed = parseNoteBody(bodyEl.value);
  currentFrontMatterRaw = parsed.frontMatterRaw;
  if (editor) {
    editor.setMarkdown(parsed.content ?? '');
  }
  updateNoteBody(parsed.content ?? '');
  updateEditorModeUI();
});

showUpdatesBtn.addEventListener('click', async () => {
  await renderCurrentNoteHistory();
  updateDialogEl.showModal();
});

closeUpdatesBtn.addEventListener('click', () => {
  updateDialogEl.close();
});

bodyEl.addEventListener('input', () => {
  if (!isPlainText) return;
  const parsed = parseNoteBody(bodyEl.value);
  currentFrontMatterRaw = parsed.frontMatterRaw;
});

createEditor('');
updateEditorModeUI();

colorSchemeMedia.addEventListener('change', () => {
  const markdown = isPlainText
    ? parseNoteBody(bodyEl.value).content
    : editor
        ? editor.getMarkdown()
        : '';
  createEditor(markdown);
  updateEditorModeUI();
});

bootstrap().catch((err) => {
  console.error(err);
  setStatus('failed to start');
});
