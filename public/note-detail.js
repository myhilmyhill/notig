import { Editor } from 'https://esm.sh/@toast-ui/editor@3.2.2';
import {
  editorHostEl,
  showEditorOnMobile,
  setActiveNoteInList,
  colorSchemeMedia,
  setEditorReadOnly,
  updateCurrentNoteState,
  setHasUnsavedChanges,
  historySelectEl,
} from './ui.js';

/** @type {Editor | null} */
let editor = null;
let currentMarkdown = '';
let lastSavedMarkdown = '';
let isApplyingMarkdown = false;
let historyMarkdown = '';

/** @type {((noteId: string) => Promise<boolean> | boolean | void) | null} */
let saveAndCommitHandler = null;
/** @type {((note: import('./app.js').Note) => Promise<void> | void) | null} */
let renderCurrentNoteHistoryHandler = null;

/**
 * @param {(noteId: string) => Promise<boolean> | boolean | void} handler
 */
export function registerSaveAndCommit(handler) {
  saveAndCommitHandler = handler;
}

/**
 * @param {(note: import('./app.js').Note) => Promise<void> | void} handler
 */
export function registerRenderCurrentNoteHistoryHandler(handler) {
  renderCurrentNoteHistoryHandler = handler ?? null;
}

/**
 * @param {string} currentId
 * @param {string} markdown
 * @param {{viewer?: boolean; preserveCurrentMarkdown?: boolean;}} options
 */
function createEditor(currentId, markdown, options = {}) {
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
      addImageBlobHook: async (/** @type {Blob | File} */ blob, /** @type {(url: string, text?: string) => void} */ callback) => {
        if (!currentId) return;
        const imageUrl = await uploadImageToBlobs(blob, currentId);
        callback(imageUrl, 'name' in blob ? blob.name : '');
      },
    },
    events: {
      change: () => {
        if (!editor || isApplyingMarkdown || options.viewer) return;
        currentMarkdown = editor.getMarkdown();
        setHasUnsavedChanges(currentMarkdown !== lastSavedMarkdown);
      },
      blur: () => {
        if (!options.viewer && saveAndCommitHandler) {
          saveAndCommitHandler(currentId);
        }
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
 * @param {import('./app.js').Note} note
 * @param {{viewer?: boolean; source?: 'user' | 'history' | 'system'; }} [options]
 */
export async function openNote(note, { viewer, source,  } = {}) {
  currentMarkdown = note.body;
  historyMarkdown = '';
  lastSavedMarkdown = note.body;
  createEditor(note.id, note.body, { viewer });
  setEditorReadOnly(viewer ?? false);
  updateCurrentNoteState(note.id != null);
  setActiveNoteInList(note.id);
  historySelectEl.value = '';
  showEditorOnMobile();
  if (renderCurrentNoteHistoryHandler) {
    await renderCurrentNoteHistoryHandler(note);
  }
  // if (source !== 'history' && updateHistoryForNoteHandler) {
  //   const shouldReplace = shouldReplaceHistoryStateHandler
  //     ? shouldReplaceHistoryStateHandler(source)
  //     : source === 'system';
  //   updateHistoryForNoteHandler(note.id, { replace: shouldReplace });
  // }
}

export function clearEditorMarkdown() {
  currentMarkdown = '';
  if (editor) {
    editor.setMarkdown('');
  }
}

export function getCurrentEditorMarkdown() {
  return currentMarkdown;
}

/**
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function showHistoryInEditor(body) {
  historyMarkdown = body;
  setEditorReadOnly(true);
  if (editor) {
    isApplyingMarkdown = true;
    editor.setMarkdown(body);
    isApplyingMarkdown = false;
  }
}

export function showCurrentInEditor() {
  if (!editor) return;
  historyMarkdown = '';
  setEditorReadOnly(false);
  isApplyingMarkdown = true;
  editor.setMarkdown(currentMarkdown);
  setHasUnsavedChanges(currentMarkdown !== lastSavedMarkdown);
  isApplyingMarkdown = false;
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
