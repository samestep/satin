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
import "./colors.js";
import * as pdfjsLib from "../pdfjs/build/pdf.mjs";

// See background.js: Chrome names the namespace `chrome`. Guarded rather than
// unconditional, because this viewer also has to run with no extension APIs at
// all (opened directly, or under the test harness).
globalThis.browser ??= globalThis.chrome;

const engine = window.Satin;
const getApp = () => window.PDFViewerApplication;

/* Dark by default: the document's black goes to 90% lightness and its white to
   20%, which is the reading setting in practice. Only new documents see this;
   one that has been opened before keeps whatever was saved for it. */
const DEFAULT_STATE = { black: 0.9, white: 0.2, overrides: {} };

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
  // Tell the background this tab now holds the viewer, so it attaches the
  // popup; see background.js for why it cannot tell from the tab's URL.
  browser.runtime.sendMessage({ type: "satin-viewer" })?.catch?.(() => {});
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

/* Local files are a platform split. Chrome grants an extension file:// access
   once the user ticks "Allow access to file URLs" on its details page, and then
   the open below simply works. Firefox has no such switch and refuses from
   every context — fetch, XMLHttpRequest, page or background, even with
   file:///* granted — so there the only way in is the user handing the file
   over, which the picker and drag-and-drop both do. */
const sourceIsLocal = sourceUrl.startsWith("file:");
// getBrowserInfo exists only on Firefox.
const isFirefox = !!globalThis.browser?.runtime?.getBrowserInfo;

async function chromeFileAccessOff() {
  try {
    return (await chrome.extension.isAllowedFileSchemeAccess()) === false;
  } catch {
    return false;
  }
}

/* What went wrong, in the user's terms, for each way of arriving with nothing
   to show. `back` offers a way out of a page that was never a PDF. */
function describe(kind, name) {
  switch (kind) {
    case "local-firefox":
      return {
        title: `Open ${name}`,
        body:
          "Firefox does not let extensions read local files, so Satin cannot " +
          "open it by itself. Choose it below, or drop it onto this page.",
      };
    case "local-chrome":
      return {
        title: `Open ${name}`,
        body:
          'Satin needs permission to read local files. Turn on "Allow access ' +
          'to file URLs" on its details page under chrome://extensions, and ' +
          `${name} will open straight away from then on. Or choose it below.`,
      };
    case "local-failed":
      return {
        title: `Could not read ${name}`,
        body: "Choose it below, or drop it onto this page.",
      };
    case "not-pdf":
      return {
        title: "That page is not a PDF",
        body: "Satin tried to read it as one and could not. Go back, or open a PDF instead.",
        back: true,
      };
    case "unreachable":
      return {
        title: "The document could not be fetched",
        body: "Go back and try again, or open a PDF from this computer instead.",
        back: true,
      };
    default:
      return { title: "Open a PDF", body: "Choose a file to read it here." };
  }
}

/* Everything that leaves the viewer with nothing to show ends up here: a screen
   that says what happened and offers the two ways to a document. The picker is
   pdf.js's own hidden file input, the one its toolbar "Open" button clicks, and
   dropping a file anywhere on the page is handled by pdf.js already. The screen
   lives inside the viewer container so that drops on it still reach that
   listener, and it goes away when a document loads. */
function showEmptyState(kind) {
  const name = decodeURIComponent(sourceUrl).split("/").pop();
  const { title, body, back } = describe(kind, name);
  const make = (tag, props, text) =>
    Object.assign(document.createElement(tag), props, text && { textContent: text });

  const open = make("button", { type: "button", className: "open" }, "Open PDF…");
  open.addEventListener("click", () => {
    // Must happen inside the click: the picker needs a user gesture.
    document.getElementById("fileInput")?.click();
  });

  const screen = make("section", { id: "satinEmpty" });
  screen.append(
    make("img", { src: "../../icon-128.png", alt: "" }),
    make("h1", {}, title),
    make("p", {}, body),
    open,
    make("p", { className: "hint" }, "…or drop a PDF anywhere on this page.")
  );
  if (back && history.length > 1) {
    const button = make("button", { type: "button", className: "back" }, "Go back");
    button.addEventListener("click", () => history.back());
    screen.append(button);
  }
  (document.getElementById("viewerContainer") ?? document.body).append(screen);
  getApp()?.eventBus?.on("documentloaded", () => screen.remove());
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
  if (!sourceUrl) {
    showEmptyState("none");
  } else {
    try {
      await getApp()?.open({ url: sourceUrl });
    } catch (error) {
      /* pdf.js has logged the failure; this says it where the user is looking.
         A local file the browser will not let us read comes first, because
         that is the browser's rule rather than anything wrong with the file. */
      showEmptyState(
        sourceIsLocal
          ? isFirefox
            ? "local-firefox"
            : (await chromeFileAccessOff())
              ? "local-chrome"
              : "local-failed"
          : error instanceof pdfjsLib.InvalidPDFException
            ? "not-pdf"
            : "unreachable"
      );
    }
  }

  if (getApp()?.pdfDocument) scanDocument();
}

ready().then(boot);
