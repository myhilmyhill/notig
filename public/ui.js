'use strict';
import {
  parseNoteBody,
  getNoteTitle,
  getNoteTags,
  getUpdatedAtGroupLabel,
} from './note-utils.js';

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
/** @type {HTMLDivElement} */
export const editorHostEl = getRequiredElement('editor-host');
/** @type {HTMLButtonElement} */
export const pushBtn = getRequiredElement('push-notes');
/** @type {HTMLButtonElement} */
export const pullBtn = getRequiredElement('pull-notes');
/** @type {HTMLButtonElement} */
export const resetBtn = getRequiredElement('reset-notes');
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
/** @type {HTMLSelectElement} */
export const historySelectEl = getRequiredElement('history-select');
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
let hasLocalCommits = false;

export function setStatus(statusText) {
  baseStatusText = statusText;
  renderStatus();
}

export function setHasUnsavedChanges(next) {
  hasUnsavedChanges = next;
  renderStatus();
}

export function setHasLocalCommits(next) {
  hasLocalCommits = next;
  pushBtn.classList.toggle('has-local-commits', hasLocalCommits);
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
    if (item.dataset.role !== 'note') return;
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

/**
 * @param {{id: string; body: string; updatedAt?: number}[]} notes
 * @param {string | null} currentId
 * @param {(note: {id: string; body: string; updatedAt?: number}) => Promise<void> | void} onOpenNote
 * @param {Record<string, {diffFromOrigin?: boolean; locallyCommitted?: boolean}>} [noteMarkers]
 */
export function renderNotes(notes, currentId, onOpenNote, noteMarkers = {}) {
  listEl.innerHTML = '';
  let currentGroupLabel = '';
  notes.forEach((note) => {
    const groupLabel = getUpdatedAtGroupLabel(note.updatedAt);
    if (groupLabel !== currentGroupLabel) {
      currentGroupLabel = groupLabel;
      const groupEl = document.createElement('li');
      groupEl.className = 'note-group';
      groupEl.dataset.role = 'group';
      groupEl.textContent = groupLabel;
      listEl.appendChild(groupEl);
    }
    const parsed = parseNoteBody(note.body);
    const title = getNoteTitle(parsed);
    const tags = getNoteTags(parsed);

    const li = document.createElement('li');
    li.dataset.role = 'note';
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
    const markers = noteMarkers[note.id];
    if (markers && (markers.diffFromOrigin || markers.locallyCommitted)) {
      li.classList.add('has-marker');
      if (markers.locallyCommitted && markers.diffFromOrigin) {
        li.classList.add('marker-both');
      } else if (markers.locallyCommitted) {
        li.classList.add('marker-local');
      } else if (markers.diffFromOrigin) {
        li.classList.add('marker-origin');
      }
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
 * @param {HTMLSelectElement} selectEl
 * @param {{value: string; label: string; disabled?: boolean}[]} entries
 * @param {{placeholder?: {value: string; label: string}; emptyMessage?: string; selectedValue?: string}} options
 */
function renderSelectOptions(selectEl, entries, options = {}) {
  selectEl.innerHTML = '';
  if (options.placeholder) {
    const placeholderOption = document.createElement('option');
    placeholderOption.value = options.placeholder.value;
    placeholderOption.textContent = options.placeholder.label;
    selectEl.appendChild(placeholderOption);
  }
  if (!entries.length && options.emptyMessage) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '__empty';
    emptyOption.textContent = options.emptyMessage;
    emptyOption.disabled = true;
    selectEl.appendChild(emptyOption);
  } else {
    entries.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (entry.disabled) {
        option.disabled = true;
      }
      selectEl.appendChild(option);
    });
  }
  if (typeof options.selectedValue === 'string') {
    selectEl.value = options.selectedValue;
  }
}

/**
 * @param {string[]} tags
 * @param {string} currentTagFilter
 */
export function renderTagFilterOptions(tags, currentTagFilter) {
  const entries = tags.map((tag) => ({ value: tag, label: tag }));
  renderSelectOptions(tagFilterEl, entries, {
    placeholder: { value: '', label: 'All tags' },
    selectedValue: currentTagFilter,
  });
}

/**
 * @param {{oid: string; label: string}[]} entries
 * @param {{emptyMessage: string; onSelect?: (oid: string) => void}} options
 */
export function renderNoteHistory(entries, options) {
  renderSelectOptions(
    historySelectEl,
    entries.map((entry) => ({ value: entry.oid, label: entry.label })),
    {
      placeholder: { value: '', label: '現在' },
      emptyMessage: options.emptyMessage,
      selectedValue: '',
    }
  );
}
