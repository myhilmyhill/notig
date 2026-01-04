'use strict';
import { parseNoteBody, getNoteTitle, getNoteTags } from './note-utils.js';

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
export const statusEl = getRequiredElement('sync-status');
export const bodyEl = document.body;
/** @type {HTMLElement | null} */
const headerEl = document.querySelector('header');
/** @type {HTMLUListElement} */
export const listEl = getRequiredElement('note-list');
/** @type {HTMLUListElement} */
export const currentNoteHistoryEl = getRequiredElement('current-note-history');
/** @type {HTMLDivElement} */
export const editorHostEl = getRequiredElement('editor-host');
/** @type {HTMLButtonElement} */
export const pushBtn = getRequiredElement('push-notes');
/** @type {HTMLButtonElement} */
export const pullBtn = getRequiredElement('pull-notes');
/** @type {HTMLButtonElement | null} */
export const cloneBtn = document.getElementById('clone');
/** @type {HTMLButtonElement} */
export const emptyCloneBtn = getRequiredElement('empty-clone');
/** @type {HTMLButtonElement} */
export const deleteBtn = getRequiredElement('delete');
/** @type {HTMLButtonElement} */
export const newBtn = getRequiredElement('new-note');
/** @type {HTMLSelectElement} */
export const tagFilterEl = getRequiredElement('tag-filter');
/** @type {HTMLButtonElement} */
export const toggleHistoryBtn = getRequiredElement('toggle-history');
/** @type {HTMLElement} */
export const historySectionEl = getRequiredElement('history-section');
/** @type {HTMLElement} */
export const notesSectionEl = getRequiredElement('notes-section');
export const mobileMedia = window.matchMedia('(max-width: 1024px)');
export const coarsePointerMedia = window.matchMedia('(pointer: coarse)');
export const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

/** @type {HTMLButtonElement | null} */
export let mobileBackBtn = null;
if (headerEl) {
  mobileBackBtn = document.createElement('button');
  mobileBackBtn.id = 'mobile-back';
  mobileBackBtn.type = 'button';
  mobileBackBtn.textContent = 'Notes';
  headerEl.insertBefore(mobileBackBtn, headerEl.firstChild);
}

let baseStatusText = 'offline';
let hasUnsavedChanges = false;

export function setStatus(statusText) {
  baseStatusText = statusText;
  renderStatus();
}

export function setHasUnsavedChanges(next) {
  hasUnsavedChanges = next;
  renderStatus();
}

function renderStatus() {
  const suffix = hasUnsavedChanges ? ' (unsaved)' : '';
  statusEl.textContent = `${baseStatusText}${suffix}`;
}

export function setMissingConfig(isMissing) {
  bodyEl.classList.toggle('missing-config', isMissing);
}

export function isMobileLayout() {
  return mobileMedia.matches || coarsePointerMedia.matches;
}

export function applyMobileState(hasCurrentNote) {
  const isMobile = isMobileLayout();
  bodyEl.classList.toggle('is-mobile', isMobile);
  if (!isMobile) {
    bodyEl.classList.remove('show-editor');
    return;
  }
  if (!hasCurrentNote) {
    bodyEl.classList.remove('show-editor');
  }
}

export function updateCurrentNoteState(hasCurrentNote) {
  bodyEl.classList.toggle('has-current-note', hasCurrentNote);
  if (!hasCurrentNote) {
    bodyEl.classList.remove('show-editor');
  }
}

export function showEditorOnMobile() {
  if (!isMobileLayout()) return;
  bodyEl.classList.add('show-editor');
}

export function showListOnMobile() {
  if (!isMobileLayout()) return;
  bodyEl.classList.remove('show-editor');
}

export function setActiveNoteInList(currentId) {
  const items = listEl.querySelectorAll('li');
  items.forEach((item) => {
    item.classList.toggle('active', item.dataset.id === currentId);
  });
}

export function setEditorReadOnly(readOnly) {
  const editableNodes = editorHostEl.querySelectorAll('[contenteditable]');
  editableNodes.forEach((node) => {
    if (readOnly) {
      node.setAttribute('contenteditable', 'false');
      return;
    }
    node.setAttribute('contenteditable', 'true');
  });
}

export function updateHistoryToggleButton(isHistoryVisible) {
  historySectionEl.toggleAttribute('hidden', !isHistoryVisible);
  notesSectionEl.toggleAttribute('hidden', isHistoryVisible);
  toggleHistoryBtn.setAttribute('aria-pressed', String(isHistoryVisible));
  toggleHistoryBtn.textContent = isHistoryVisible ? 'Notes' : 'History';
}

/**
 * @param {{id: string; body: string}[]} notes
 * @param {string | null} currentId
 * @param {(note: {id: string; body: string}) => Promise<void> | void} onOpenNote
 */
export function renderNotes(notes, currentId, onOpenNote) {
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
      await onOpenNote(note);
    });
    listEl.appendChild(li);
  });
}

/**
 * @param {{oid: string; label: string}[]} entries
 * @param {{emptyMessage: string; onSelect?: (oid: string) => void}} options
 */
export function renderNoteHistory(entries, options) {
  currentNoteHistoryEl.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = options.emptyMessage;
    currentNoteHistoryEl.appendChild(li);
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = entry.label;
    li.dataset.oid = entry.oid;
    li.addEventListener('click', () => {
      const siblings = currentNoteHistoryEl.querySelectorAll('li');
      siblings.forEach((other) => {
        if (other === li) return;
        other.classList.remove('active');
      });
      li.classList.add('active');
      if (options.onSelect) {
        options.onSelect(entry.oid);
      }
    });
    currentNoteHistoryEl.appendChild(li);
  });
}
