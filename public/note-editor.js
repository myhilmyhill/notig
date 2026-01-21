'use strict';
import { Editor } from '@toast-ui/editor';
import {
  editorHostEl,
  showEditorOnMobile,
  setActiveNoteInList,
  colorSchemeMedia,
  updateCurrentNoteState,
  historySelectEl,
} from './ui.js';

/** @type {Editor | null} */
let editor = null;

/** @type {((note: import('./app.js').Note) => Promise<boolean> | boolean | void) | null} */
let saveAndCommitHandler = null;
/** @type {((note: import('./app.js').Note, options?: any) => Promise<void> | void) | null} */
let noteOpenedHandler = null;

/**
 * @param {(note: import('./app.js').Note) => Promise<boolean> | boolean | void} handler
 */
export function registerSaveAndCommit(handler) {
  saveAndCommitHandler = handler;
}

/**
 * @param {(note: import('./app.js').Note, options?: any) => Promise<void> | void} handler
 */
export function registerNoteOpenedHandler(handler) {
  noteOpenedHandler = handler;
}

/**
 * @param {import('./app.js').Note} note
 */
function createEditor(note) {
  if (editor) {
    editor.destroy();
  }
  editor = Editor.factory({
    el: editorHostEl,
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    viewer: false,
    previewHighlight: false,
    usageStatistics: false,
    hideModeSwitch: false,
    theme: colorSchemeMedia.matches ? 'dark' : 'light',
    frontMatter: true,
    autofocus: false,
    initialValue: note.body,
    hooks: {
      addImageBlobHook: async (/** @type {Blob | File} */ blob, /** @type {(url: string, text?: string) => void} */ callback) => {
        if (!note) return;
        const imageUrl = await uploadImageToBlobs(blob, note.id);
        callback(imageUrl, 'name' in blob ? blob.name : '');
      },
    },
    events: {
      change: () => {
        if (!editor) return;
        note.body = editor.getMarkdown();
      },
      blur: () => {
        if (saveAndCommitHandler) {
          saveAndCommitHandler(note);
        }
      },
    },
  });
}

/**
 * @param {string} markdown
 */
function createViewer(markdown) {
  if (editor) {
    editor.destroy();
  }
  editor = Editor.factory({
    el: editorHostEl,
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    viewer: true,
    previewHighlight: false,
    usageStatistics: false,
    hideModeSwitch: false,
    theme: colorSchemeMedia.matches ? 'dark' : 'light',
    frontMatter: true,
    autofocus: false,
    initialValue: markdown,
  });
}

/**
 * @param {import('./app.js').Note} note
 */
export async function openNote(note, options = {}) {
  createEditor(note);
  updateCurrentNoteState(note.id != null);
  setActiveNoteInList(note.id);
  historySelectEl.value = '';
  showEditorOnMobile();
  if (noteOpenedHandler) {
    await noteOpenedHandler(note, options);
  }
}

/**
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function showHistoryInEditor(body) {
  createViewer(body);
}

/**
 * @param {import("./app.js").Note} note
 */
export function showCurrentInEditor(note) {
  createEditor(note);
}


/**
 * @param {Blob | File} blob
 * @param {string} noteId
 * @returns {Promise<string>}
 */
async function uploadImageToBlobs(blob, noteId) {
  const filename = getBlobFileName(blob);
  const url = `/blobs/${encodeURIComponent(noteId)}/${encodeURIComponent(filename)}`;
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
  const contentType = response.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    const payload = await response.clone().json();
    if (payload && typeof payload.url === 'string' && payload.url.trim()) {
      return payload.url.trim();
    }
  }

  const bodyText = await response.text().catch(() => '');
  const trimmedBody = bodyText.trim();
  if (trimmedBody) {
    return trimmedBody;
  }

  const locationHeader = response.headers.get('Location');
  if (locationHeader && locationHeader.trim()) {
    return locationHeader.trim();
  }

  throw new Error('upload failed: invalid response');
}

/**
 * @param {Blob | File} blob
 * @returns {string}
 */
function getBlobFileName(blob) {
  if ('name' in blob) {
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
