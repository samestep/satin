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
const VIEWER = "pdfjs/web/viewer.html";
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
const setPopup = (tabId, on) =>
  browser.action
    .setPopup({ tabId, popup: on ? "popup.html" : "" })
    .catch(() => {});

// The viewer is the only page of ours that runs in a tab.
const holdsViewer = (tabId) =>
  browser.runtime
    .getContexts({ contextTypes: ["TAB"], tabIds: [tabId] })
    .then((contexts) => contexts.length > 0)
    .catch(() => false);

const sync = async (tabId) => setPopup(tabId, await holdsViewer(tabId));

// Recomputed, not toggled, on both edges of a navigation: at "loading" the old
// document is still there and at "complete" the new one is. pdf.js also drives
// the history API as the document loads, which Chrome reports as another
// loading/complete pair on the same document.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status) sync(tabId);
});

// The viewer also announces itself as it starts, so the popup is in place
// before "complete" and the first click is never a dud.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "satin-viewer" && sender.tab) {
    setPopup(sender.tab.id, true);
  }
});

// Viewers already open when this script starts (session restore, reload).
browser.runtime
  .getContexts({ contextTypes: ["TAB"] })
  .then((contexts) => contexts.forEach((c) => setPopup(c.tabId, true)))
  .catch(() => {});

browser.action.onClicked.addListener(async (tab) => {
  const url = tab.url || "";

  if (isViewer(url)) {
    // Only reachable in the moment between a viewer starting to load and its
    // message arriving, and only on Firefox, which shows us the URL. Wire the
    // popup up and show it, so the click is not a dud.
    await setPopup(tab.id, true);
    // Chrome 127+ and Firefox both have this, but it can reject *or* throw
    // synchronously when there is no window to anchor to; a dud click is a far
    // better outcome than an exception out of the listener.
    try {
      await browser.action.openPopup?.();
    } catch {}
    return;
  }

  if (/^(https?|file):/.test(url)) {
    await browser.tabs.update(tab.id, { url: viewerFor(url) });
  } else {
    // Nothing openable in this tab (about:, moz-extension:, …) — start empty so
    // the user can still drop or pick a file. Genuinely empty: without the bare
    // `file=`, pdf.js falls back to its bundled sample document.
    await browser.tabs.create({ url: viewerFor(null) });
  }
});
