/* Viewer-side controller. Owns the tint state for this document and answers the
   popup; it draws no UI of its own. The popup is the extension's only surface,
   so it behaves like any other extension popup — anchored to the toolbar button,
   dismissed by clicking away — and the page stays just the document. */
/* Imported for its side effect: it shadows the canvas color accessors, and
   publishes window.Satin. It used to be injected into viewer.html as a classic
   script so it would run ahead of pdf.js, because anything painted before the
   accessors were in place escaped untinted. That is no longer necessary — this
   module opens the document itself (see boot), so nothing can be painted until
   after this import has run. */
import "./engine.js";
import * as pdfjsLib from "../pdfjs/build/pdf.mjs";

// See background.js: Chrome names the namespace `chrome`. Guarded rather than
// unconditional, because this viewer also has to run with no extension APIs at
// all (opened directly, or under the test harness).
globalThis.browser ??= globalThis.chrome;

const engine = window.Satin;
const getApp = () => window.PDFViewerApplication;

const DEFAULT_STATE = { black: 0, white: 1, overrides: {} };

let state = structuredClone(DEFAULT_STATE);
let history = [JSON.stringify(state)];
let historyAt = 0;
let saveTimer = null;

/* `src`, not pdf.js's `file` — see background.js. pdf.js never sees this URL as
   a parameter, so its same-origin guard never fires and stays unpatched; the
   document is opened from boot() below instead. */
const sourceUrl = new URL(location.href).searchParams.get("src") || "";
const storageKey = "doc:" + sourceUrl;

// ---------- state ----------

function applyState({ rerender = true } = {}) {
  engine.affine = { black: state.black, white: state.white };
  engine.overrides = new Map(Object.entries(state.overrides));
  engine.touch();
  document.documentElement.style.setProperty(
    "--satin-page-bg",
    engine.resolve("#ffffff")
  );
  if (rerender) scheduleRerender();
  queueSave();
}

function commit() {
  const snapshot = JSON.stringify(state);
  if (snapshot === history[historyAt]) return;
  history = history.slice(0, historyAt + 1);
  history.push(snapshot);
  if (history.length > 100) history.shift();
  historyAt = history.length - 1;
}

function travel(delta) {
  const next = historyAt + delta;
  if (next < 0 || next >= history.length) return;
  historyAt = next;
  state = JSON.parse(history[historyAt]);
  applyState();
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!sourceUrl) return;
    try {
      browser.storage.local.set({ [storageKey]: state })?.catch?.(() => {});
    } catch {
      /* no storage (e.g. the viewer opened outside an extension context) */
    }
  }, 400);
}

// ---------- re-rendering ----------

let rerenderQueued = false;

function scheduleRerender() {
  if (rerenderQueued) return;
  rerenderQueued = true;
  requestAnimationFrame(() => {
    rerenderQueued = false;
    const viewer = getApp()?.pdfViewer;
    if (!viewer) return;
    /* The same options pdf.js gives itself when re-rendering after a scale
       change. keepCanvasWrapper is the one that matters: the rendered page
       stays on screen while the replacement is drawn offscreen, and pdf.js
       swaps them with a single replaceWith() once it is complete. A bare
       reset() tears the canvas out first, so every change flashes blank. */
    for (const page of viewer._pages ?? []) {
      page.reset({
        keepAnnotationLayer: true,
        keepAnnotationEditorLayer: true,
        keepXfaLayer: true,
        keepTextLayer: true,
        keepCanvasWrapper: true,
      });
    }
    viewer.update();
    const thumbs = getApp()?.pdfThumbnailViewer;
    if (thumbs?._thumbnails) {
      for (const thumb of thumbs._thumbnails) thumb.reset?.();
      thumbs.forceRendering?.();
    }
  });
}

// ---------- palette ----------

/* Painting only reveals the colors on pages that have actually rendered, so the
   count used to climb as you scrolled and differ between sessions. Reading the
   operator lists instead yields the whole document's palette up front,
   independent of what is on screen. Colors reached only through patterns or
   shadings still arrive later, by being painted. */
let scanToken = 0;

async function scanDocument() {
  const token = ++scanToken;
  const doc = getApp()?.pdfDocument;
  if (!doc) return;
  const { OPS } = pdfjsLib;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (token !== scanToken) return; // a new document was opened
    let ops;
    try {
      const page = await doc.getPage(pageNumber);
      ops = await page.getOperatorList();
    } catch {
      continue; // a page that will not parse should not stop the scan
    }
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn !== OPS.setFillRGBColor && fn !== OPS.setStrokeRGBColor) continue;
      // The evaluator has already resolved these to "#rrggbb" strings:
      //   args = [ColorSpaceUtils.rgb.getRgbHex(args, 0)]
      const [hex] = ops.argsArray[i] ?? [];
      if (typeof hex === "string") engine.observe(hex.toLowerCase());
    }
  }
}

function snapshot() {
  return {
    ready: true,
    source: sourceUrl,
    black: state.black,
    white: state.white,
    canUndo: historyAt > 0,
    canRedo: historyAt < history.length - 1,
    tweaks: Object.keys(state.overrides).length,
    colors: engine.sortedPalette().map((entry) => ({
      key: entry.key,
      count: entry.count,
      mapped: engine.resolve(entry.key),
      tweaked: state.overrides[entry.key] !== undefined,
    })),
  };
}

// ---------- popup API ----------

const commands = {
  affine({ black, white }) {
    if (black !== undefined) state.black = black;
    if (white !== undefined) state.white = white;
    applyState();
  },
  override({ key, color }) {
    state.overrides[key] = color;
    applyState();
  },
  revert({ key }) {
    delete state.overrides[key];
    applyState();
    commit();
  },
  clear() {
    state.overrides = {};
    applyState();
    commit();
  },
  commit() {
    commit();
  },
  undo() {
    travel(-1);
  },
  redo() {
    travel(1);
  },
};

/** Run a command and answer with the new state, so the popup never has to model
    the document itself. Exposed on the window as well as over messaging: it is
    the seam the tests drive, and a usable handle when debugging the viewer. */
function handle(message) {
  commands[message.cmd]?.(message.args ?? {});
  return snapshot();
}

window.SatinController = { handle, snapshot };

if (typeof browser !== "undefined" && browser.runtime?.onMessage) {
  /* Answering by calling sendResponse rather than by returning a promise:
     returning one is a Firefox extension to the API that Chrome does not
     implement. handle() is synchronous, so responding before the listener
     returns is well-defined in both. */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "satin") return undefined;
    sendResponse(handle(message));
    return undefined;
  });
}

// ---------- boot ----------

async function ready() {
  if (document.readyState === "loading") {
    await new Promise((resolve) =>
      document.addEventListener("DOMContentLoaded", resolve, { once: true })
    );
  }
  await getApp()?.initializedPromise?.catch(() => {});
}

async function boot() {
  if (sourceUrl) {
    try {
      const stored = await browser.storage.local.get(storageKey);
      if (stored[storageKey]) {
        state = { ...structuredClone(DEFAULT_STATE), ...stored[storageKey] };
        history = [JSON.stringify(state)];
        historyAt = 0;
      }
    } catch {
      /* storage unavailable: fall back to defaults */
    }
  }

  applyState({ rerender: false });

  getApp()?.eventBus?.on("documentloaded", () => {
    engine.resetPalette();
    scanDocument();
  });

  /* Opened here rather than by pdf.js, so that the URL never passes through
     validateFileURL. Listeners are attached first: open() resolves after
     "documentloaded" has already fired. */
  if (sourceUrl) {
    try {
      await getApp()?.open({ url: sourceUrl });
    } catch {
      /* pdf.js has already shown its own error for an unreachable or
         unparseable document; there is nothing useful to add. */
    }
  }

  if (getApp()?.pdfDocument) scanDocument();
}

ready().then(boot);
