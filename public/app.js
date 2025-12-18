import http from 'https://unpkg.com/isomorphic-git@beta/http/web/index.js'
import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm'

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

const fs = new LightningFS('notig-fs');
const pfs = fs.promises;

const dir = '/notig';
const notesDir = `${dir}/notes`;
const indexPath = `${notesDir}/index.json`;
const remoteUrl = `${window.location.origin}/git/notig.git`;

const author = {
  name: 'notig user',
  email: 'user@example.com',
};

const statusEl = document.getElementById('sync-status');
const listEl = document.getElementById('note-list');
const titleEl = document.getElementById('note-title');
const bodyEl = document.getElementById('note-body');
const saveBtn = document.getElementById('save-note');
const pushBtn = document.getElementById('push-notes');
const pullBtn = document.getElementById('pull-notes');
const newBtn = document.getElementById('new-note');

let notes = [];
let currentId = null;

function slugifyTitle(title) {
  const normalized = (title || '')
    .trim()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'untitled';
}

function buildFilePath(title, id) {
  const slug = slugifyTitle(title || 'Untitled');
  const suffix = id ? `-${String(id).slice(0, 8)}` : '';
  return `notes/${slug}${suffix}.json`;
}

function getNoteFilePath(note) {
  return note.filePath || `notes/${note.id}.json`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function randomId() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10)
  );
}

async function repoExists() {
  try {
    await pfs.stat(`${dir}/.git`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function cloneRepo() {
  setStatus('cloning…');
  await git.clone({
    fs,
    http,
    dir,
    url: remoteUrl,
    singleBranch: true,
    depth: 1,
    ref: 'main',
  });
}

async function initRepo() {
  setStatus('initializing…');
  await pfs.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: 'main' });
  try {
    await git.addRemote({ fs, dir, remote: 'origin', url: remoteUrl });
  } catch (err) {
    // ignore if remote already exists
  }
}

async function ensureRepo() {
  const exists = await repoExists();
  if (!exists) {
    try {
      await cloneRepo();
    } catch (err) {
      console.warn('clone failed, falling back to init', err);
      await initRepo();
    }
  }
  await ensureUserConfig();
}

async function ensureUserConfig() {
  const existingName = await git.getConfig({ fs, dir, path: 'user.name' }).catch(() => null);
  const existingEmail = await git.getConfig({ fs, dir, path: 'user.email' }).catch(() => null);
  if (!existingName) {
    await git.setConfig({ fs, dir, path: 'user.name', value: author.name });
  }
  if (!existingEmail) {
    await git.setConfig({ fs, dir, path: 'user.email', value: author.email });
  }
}

async function ensureNotesDir() {
  try {
    await pfs.mkdir(notesDir, { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const stat = await pfs.stat(notesDir);
      if (stat && stat.isDirectory()) return;
    }
    throw err;
  }
}

async function readNotesIndex() {
  try {
    const raw = await pfs.readFile(indexPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeNotesIndex(nextNotes) {
  await ensureNotesDir();
  await pfs.writeFile(indexPath, JSON.stringify(nextNotes, null, 2), 'utf8');
}

async function loadNote(id) {
  const meta = notes.find((n) => n.id === id);
  if (!meta) return null;

  const candidates = [];
  const storedPath = getNoteFilePath(meta);
  candidates.push(storedPath);
  const derivedPath = buildFilePath(meta.title || 'Untitled', meta.id);
  if (!candidates.includes(derivedPath)) candidates.push(derivedPath);

  for (const filePath of candidates) {
    try {
      const raw = await pfs.readFile(`${dir}/${filePath}`, 'utf8');
      const note = JSON.parse(raw);
      note.filePath = filePath;
      const index = notes.findIndex((n) => n.id === id);
      if (index !== -1) {
        notes[index] = { ...notes[index], filePath };
      }
      return note;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }

  return null;
}

async function saveNoteFile(note, previousFilePath) {
  await ensureNotesDir();
  const relPath = note.filePath || buildFilePath(note.title, note.id);
  await pfs.writeFile(`${dir}/${relPath}`, JSON.stringify(note, null, 2), 'utf8');
  if (previousFilePath && previousFilePath !== relPath) {
    try {
      await pfs.unlink(`${dir}/${previousFilePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return relPath;
}

async function commitIfNeeded(message, filepaths) {
  const matrix = await git.statusMatrix({ fs, dir, filepaths });
  const hasChanges = matrix.some(
    ([, head, workdir, stage]) => !(head === workdir && workdir === stage)
  );
  if (!hasChanges) return false;

  for (const filepath of filepaths) {
    await git.add({ fs, dir, filepath });
  }
  await git.commit({ fs, dir, message, author });
  return true;
}

function renderNotes() {
  listEl.innerHTML = '';
  notes.forEach((note) => {
    const li = document.createElement('li');
    li.textContent = note.title || 'Untitled';
    li.dataset.id = note.id;
    if (note.id === currentId) li.classList.add('active');
    li.addEventListener('click', async () => {
      await openNote(note.id);
    });
    listEl.appendChild(li);
  });
}

async function openNote(id) {
  const note = await loadNote(id);
  if (!note) return;
  currentId = id;
  titleEl.value = note.title || '';
  bodyEl.value = note.body || '';
  renderNotes();
}

async function createNote() {
  const id = randomId();
  const note = {
    id,
    title: 'New note',
    body: '',
    updatedAt: new Date().toISOString(),
  };
  note.filePath = buildFilePath(note.title, note.id);
  notes.unshift(note);
  await saveNoteFile(note);
  await writeNotesIndex(notes);
  currentId = id;
  renderNotes();
  titleEl.value = note.title;
  bodyEl.value = note.body;
}

async function saveAndCommit() {
  await ensureRepo();
  const id = currentId || randomId();
  const note = {
    id,
    title: titleEl.value.trim() || 'Untitled',
    body: bodyEl.value,
    updatedAt: new Date().toISOString(),
  };

  const existingIndex = notes.findIndex((n) => n.id === id);
  const previousNote = existingIndex === -1 ? null : notes[existingIndex];
  const previousFilePath = previousNote ? getNoteFilePath(previousNote) : null;
  note.filePath = buildFilePath(note.title, note.id);

  if (existingIndex === -1) {
    notes.unshift(note);
  } else {
    notes[existingIndex] = note;
  }

  const changedFiles = [];
  const relPath = await saveNoteFile(note, previousFilePath);
  changedFiles.push(relPath);
  if (previousFilePath && previousFilePath !== relPath) {
    changedFiles.push(previousFilePath);
  }
  await writeNotesIndex(notes);
  changedFiles.push('notes/index.json');

  const committed = await commitIfNeeded(`chore: update ${note.title}`, changedFiles);
  setStatus(committed ? 'committed locally' : 'no changes');

  currentId = id;
  renderNotes();
}

async function pushChanges() {
  setStatus('pushing…');
  try {
    await ensureRepo();
    await git.push({ fs, http, dir, remote: 'origin', ref: 'main' });
    setStatus('pushed');
  } catch (err) {
    console.error(err);
    setStatus('push failed');
    alert(`Push failed: ${err.message}`);
  }
}

async function pullChanges() {
  setStatus('pulling…');
  try {
    await ensureRepo();
    await git.fetch({ fs, http, dir, remote: 'origin', ref: 'main', singleBranch: true });
    await git.merge({ fs, dir, ours: 'main', theirs: 'origin/main' });
    notes = await readNotesIndex();
    renderNotes();
    if (notes[0]) await openNote(notes[0].id);
    setStatus('pulled');
  } catch (err) {
    console.error(err);
    setStatus('pull failed');
    alert(`Pull failed: ${err.message}`);
  }
}

async function bootstrap() {
  setStatus('preparing…');
  await ensureRepo();

  try {
    await git.fetch({ fs, http, dir, remote: 'origin', ref: 'main', singleBranch: true });
    await git.merge({ fs, dir, ours: 'main', theirs: 'origin/main' });
    setStatus('synced');
  } catch (err) {
    console.warn('initial fetch failed; continuing offline', err);
    setStatus('offline (local only)');
  }

  notes = await readNotesIndex();
  renderNotes();
  if (notes[0]) {
    await openNote(notes[0].id);
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

newBtn.addEventListener('click', () => {
  createNote().catch((err) => {
    console.error(err);
    setStatus('new note failed');
  });
});

bootstrap().catch((err) => {
  console.error(err);
  setStatus('failed to start');
});
