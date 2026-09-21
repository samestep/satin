/* Open the current tab's PDF in the bundled pdf.js viewer, and give that tab a
 * popup.
 *
 * Firefox does not run content scripts in its built-in PDF viewer
 * (bugzilla 1454760), so recoloring has to happen in a viewer we ship
 * ourselves. Deliberately no ".pdf" URL sniffing: the user clicked the button,
 * so take them at their word — that heuristic is exactly what fails on arXiv,
 * whose PDF URLs carry no extension.
 *
 * The popup is set per tab rather than in the manifest, because the button has
 * two jobs. On an ordinary page there is nothing to show yet, so the click has
 * to run this script and navigate. Once the tab holds the viewer, the button
 * should behave like every other extension button: open its panel, and close it
 * again on the next click or on a click outside. A tab-scoped popup gets both,
 * and Back still returns to the original document.
 */
// Chrome exposes only `chrome`, Firefox exposes both. Chrome's MV3 APIs already
// return promises for everything used here, so aliasing is enough — no polyfill.
globalThis.browser ??= globalThis.chrome;

/* The document to open is passed as `src`, not as pdf.js's own `file`, and
 * `file` is handed over deliberately empty.
 *
 * pdf.js reads `file` and runs it through validateFileURL, which refuses any
 * origin but its own — fatal here, since the whole job is opening a document
 * from wherever the user found it. An empty `file` short-circuits that check
 * (it returns early on a falsy value) and also skips pdf.js's auto-open (`if
 * (file)`), which would otherwise load the sample PDF bundled in the dist.
 * reader.js then opens `src` itself. The alternative was patching the guard out
 * of pdf.js's minified bundle, which is both worse to review and worse to trust.
 */
const VIEWER = "reader.html";
const viewerUrl = browser.runtime.getURL(VIEWER);
const isViewer = (url) => typeof url === "string" && url.startsWith(viewerUrl);

/** Viewer URL for a document, or for an empty viewer when `src` is omitted. */
const viewerFor = (src) =>
  `${viewerUrl}?file=${src ? `&src=${encodeURIComponent(src)}` : ""}`;

/* Which tabs hold the viewer is asked of the runtime, not read off tab URLs:
 * runtime.getContexts lists this extension's own documents by tab, whereas tab
 * URLs would need the "tabs" permission (Chrome hides even an extension's own
 * chrome-extension:// tab URLs without it), and "tabs" costs a "Read your
 * browsing history" warning at install time for nothing else.
 */
const PANEL = "popup.html";
// The same page in its other mode: what the button offers on a tab that is not
// showing a PDF (see popup.js).
const NOT_PDF = "popup.html#not-pdf";

const setPopup = (tabId, popup) =>
  browser.action.setPopup({ tabId, popup }).catch(() => {});

// The viewer is the only page of ours that runs in a tab.
const holdsViewer = (tabId) =>
  browser.runtime
    .getContexts({ contextTypes: ["TAB"], tabIds: [tabId] })
    .then((contexts) => contexts.length > 0)
    .catch(() => false);

const sync = async (tabId) =>
  setPopup(tabId, (await holdsViewer(tabId)) ? PANEL : "");

// Recomputed, not toggled, on both edges of a navigation: at "loading" the old
// document is still there and at "complete" the new one is. pdf.js also drives
// the history API as the document loads, which Chrome reports as another
// loading/complete pair on the same document.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status) sync(tabId);
});

/* Tabs that a click on the button sent to the viewer. When the viewer in one
 * of them reports ready, the panel is opened for it, so the one click both
 * switches to Satin and shows the controls. Firefox let an extension open its
 * own popup without a user gesture starting in 149, hence strict_min_version.
 */
const panelPending = new Set();
browser.tabs.onRemoved.addListener((tabId) => panelPending.delete(tabId));

// The viewer also announces itself as it starts, so the popup is in place
// before "complete" and the first click is never a dud.
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message?.type === "satin-viewer" && sender.tab) {
    await setPopup(sender.tab.id, PANEL);
    if (panelPending.delete(sender.tab.id) && sender.tab.active) {
      try {
        await browser.action.openPopup({ windowId: sender.tab.windowId });
      } catch {}
    }
  }
  // The two offers on the not-a-PDF popup.
  if (message?.type === "satin-open") {
    panelPending.add(message.tabId);
    browser.tabs.update(message.tabId, { url: viewerFor(message.src) });
  }
  if (message?.type === "satin-open-file") {
    browser.tabs.create({ url: viewerFor(null) });
  }
});

// Viewers already open when this script starts (session restore, reload).
browser.runtime
  .getContexts({ contextTypes: ["TAB"] })
  .then((contexts) => contexts.forEach((c) => setPopup(c.tabId, PANEL)))
  .catch(() => {});

/* Whether the tab is showing something other than a PDF, judged by the
 * document's MIME type, which a one-line script reads. The script cannot run in
 * either browser's built-in PDF viewer, nor on restricted pages, so a failure
 * to run it means "possibly a PDF" and the click proceeds as usual: the viewer
 * is where a wrong guess gets explained.
 */
async function isNotPdf(tabId) {
  try {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType,
    });
    return typeof result === "string" && !/pdf/i.test(result);
  } catch {
    return false;
  }
}

async function onClicked(tab) {
  const url = tab.url || "";

  if (isViewer(url)) {
    // Only reachable in the moment between a viewer starting to load and its
    // message arriving, and only on Firefox, which shows us the URL. Wire the
    // popup up and show it, so the click is not a dud.
    await setPopup(tab.id, PANEL);
    // Chrome 127+ and Firefox both have this, but it can reject *or* throw
    // synchronously when there is no window to anchor to; a dud click is a far
    // better outcome than an exception out of the listener.
    try {
      await browser.action.openPopup?.();
    } catch {}
    return;
  }

  if (/^(https?|file):/.test(url)) {
    if (await isNotPdf(tab.id)) {
      // Rather than replace a page the user is reading with an error, offer
      // the ways forward in the popup, and keep offering them on later clicks.
      await setPopup(tab.id, NOT_PDF);
      try {
        await browser.action.openPopup({ windowId: tab.windowId });
      } catch {}
      return;
    }
    panelPending.add(tab.id);
    await browser.tabs.update(tab.id, { url: viewerFor(url) });
  } else {
    // Nothing openable in this tab (about:, moz-extension:, …) — start empty so
    // the user can still drop or pick a file. Genuinely empty: without the bare
    // `file=`, pdf.js falls back to its bundled sample document.
    await browser.tabs.create({ url: viewerFor(null) });
  }
}

browser.action.onClicked.addListener(onClicked);
