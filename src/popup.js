/* The popup is the whole UI. It holds no state: every interaction is a command
   to the viewer tab, which answers with the new state, and the popup just draws
   whatever came back. */
globalThis.browser ??= globalThis.chrome; // see background.js

const engine = window.Satin; // loaded for its Oklch helpers only
const $ = (sel) => document.querySelector(sel);

let tabId = null;
let poll = null;

async function send(cmd, args) {
  if (tabId === null) return null;
  try {
    return await browser.tabs.sendMessage(tabId, { type: "satin", cmd, args });
  } catch {
    return null; // viewer navigated away or is still loading
  }
}

async function refresh(cmd = "state", args) {
  const snapshot = await send(cmd, args);
  // The viewer may still be loading when the popup opens, so an empty answer is
  // a "not yet", not a verdict — the poll below keeps asking.
  $("#unavailable").hidden = !!snapshot?.ready;
  $("#ui").hidden = !snapshot?.ready;
  if (snapshot?.ready) render(snapshot);
}

// ---------- rendering ----------

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "text") el.textContent = value;
    else el[key] = value;
  }
  el.append(...children);
  return el;
}

const rows = new Map();

function createRow(key) {
  const swatch = h("span", { class: "sw" });
  swatch.style.background = key;
  const target = h("button", {
    type: "button",
    class: "target",
    dataset: { act: "edit", key },
    title: "Edit this color",
  });
  const code = h("code", {});
  const revert = h("button", {
    type: "button",
    dataset: { act: "revert", key },
    text: "↺",
    title: "Drop this tweak",
  });
  /* Firefox's own color picker only reports a value once its dialog is
     dismissed, so dragging it gives no feedback. These fire continuously, and
     lightness/chroma/hue are the useful axes: two of them move without
     dragging the third along. */
  const slider = (axis, max, step, label) =>
    h("label", { class: "oklch" }, [
      h("span", { text: label }),
      h("input", {
        type: "range",
        min: "0",
        max: String(max),
        step: String(step),
        dataset: { axis, key },
      }),
    ]);
  const editor = h("div", { class: "editor", hidden: true }, [
    slider("L", 1, 0.005, "L"),
    slider("C", 0.37, 0.002, "C"),
    slider("h", 360, 1, "H"),
  ]);
  const el = h("div", { class: "entry", dataset: { key } }, [
    h("div", { class: "entryMain" }, [
      swatch,
      h("span", { class: "arrow", text: "→" }),
      target,
      code,
      revert,
    ]),
    editor,
  ]);
  return { el, target, code, revert, editor };
}

function render(snapshot) {
  for (const end of ["black", "white"]) {
    const input = $(`[data-end="${end}"]`);
    if (document.activeElement !== input) input.value = snapshot[end];
    $(`[data-for="${end}"]`).textContent = Number(snapshot[end]).toFixed(2);
  }
  $('[data-act="undo"]').disabled = !snapshot.canUndo;
  $('[data-act="redo"]').disabled = !snapshot.canRedo;
  $('[data-act="clear"]').disabled = snapshot.tweaks === 0;

  const list = $(".palette");
  const keys = new Set(snapshot.colors.map((c) => c.key));
  for (const [key, row] of rows) {
    if (!keys.has(key)) {
      row.el.remove();
      rows.delete(key);
    }
  }
  snapshot.colors.forEach((color, index) => {
    let row = rows.get(color.key);
    if (!row) {
      row = createRow(color.key);
      rows.set(color.key, row);
    }
    row.el.classList.toggle("tweaked", color.tweaked);
    row.code.textContent = color.mapped;
    row.revert.disabled = !color.tweaked;
    row.target.style.background = color.mapped;
    row.target.title = `${color.key} → ${color.mapped} (${color.count} uses)`;
    if (!row.editor.contains(document.activeElement)) {
      const lch = engine.hexToOklch(color.mapped);
      for (const input of row.editor.querySelectorAll("input")) {
        input.value = lch[input.dataset.axis];
      }
    }
    if (list.children[index] !== row.el) {
      list.insertBefore(row.el, list.children[index] || null);
    }
  });

  $(".empty").hidden = snapshot.colors.length > 0;
  $(".count").textContent = `${snapshot.colors.length} color${
    snapshot.colors.length === 1 ? "" : "s"
  }`;
}

// ---------- events ----------

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.end) {
    refresh("affine", { [target.dataset.end]: Number(target.value) });
    $(`[data-for="${target.dataset.end}"]`).textContent = Number(
      target.value
    ).toFixed(2);
  } else if (target.dataset.axis) {
    const row = rows.get(target.dataset.key);
    const lch = {};
    for (const input of row.editor.querySelectorAll("input")) {
      lch[input.dataset.axis] = Number(input.value);
    }
    refresh("override", {
      key: target.dataset.key,
      color: engine.oklchToHex(lch),
    });
  }
});

// A drag is one undo step, so history is recorded when it ends.
document.addEventListener("change", (event) => {
  if (event.target.dataset.end || event.target.dataset.axis) refresh("commit");
});

document.addEventListener("click", (event) => {
  const { act, key } = event.target.dataset ?? {};
  if (!act) return;
  if (act === "edit") {
    const row = rows.get(key);
    if (row) row.editor.hidden = !row.editor.hidden;
  } else {
    refresh(act, { key });
  }
});

// ---------- boot ----------

(async function boot() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  await refresh();
  // The viewer may still be loading, and its palette is still being scanned, so
  // keep pulling until both settle.
  poll = setInterval(refresh, 500);
  window.addEventListener("pagehide", () => clearInterval(poll));
})();
