'use strict';
import LightningFS from 'https://esm.sh/@isomorphic-git/lightning-fs';
import * as git from 'https://esm.sh/isomorphic-git@beta';
import http from 'https://esm.sh/isomorphic-git@beta/http/web';
import { Buffer } from 'https://esm.sh/buffer@6.0.3';

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

/** @typedef {{id: string; body: string}} Note */
/** @typedef {{frontMatter: Record<string, string | string[]>; content: string}} ParsedNote */

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
/** @type {HTMLTextAreaElement} */
const bodyEl = getRequiredElement('note-body');
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

/** @type {Note[]} */
let notes = [];
/** @type {Note['id'] | null} */
let currentId = null;

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
 * @param {Note} note
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
 * @param {string} body
 * @returns {ParsedNote}
 */
function parseNoteBody(body) {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontMatter: {}, content: body };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, content: body };
  }

  const frontMatterLines = lines.slice(1, endIndex);
  const content = lines.slice(endIndex + 1).join('\n');
  return { frontMatter: parseFrontMatter(frontMatterLines), content };
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
    try {
      /** @type {string} */
      const body = await pfs.readFile(filePath, 'utf8');
      loadedNotes.push({
        id: entry,
        body,
      });
    } catch (err) {
      if (getErrorCode(err) === 'ENOENT') continue;
      console.warn(`failed to read note ${filePath}`, err);
    }
  }

  notes = loadedNotes;
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
 * @param {Note} note
 */
async function openNote(note) {
  currentId = note.id;
  bodyEl.value = note.body;
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
  const filepath = getNoteFilePath({ id: currentId, body: '' });
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
  await add({ filepath });
  const s = await status({ filepath });
  const modified = s === 'modified' || s === '*modified' || s === 'deleted' || s === '*deleted' || s === 'added' || s === '*added';
  if (modified) {
    await commit();
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

bootstrap().catch((err) => {
  console.error(err);
  setStatus('failed to start');
});
