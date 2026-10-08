// Code surface: the shared piece behind every place this app shows source.
//
// Two file viewers exist (the Files tab's modal and the Files screen's workspace viewer) and a
// third surface is coming (the Changes-tab diff). They do not show the same thing -- the diff gets
// a patch, not a file, and needs +/- gutters and hunk folding -- so what lives here is deliberately
// only the part they genuinely share:
//
//   render()  a row per line: a sticky, dim gutter number plus the line's content, in a
//             scrollable monospace container, with an optional soft-wrap mode.
//   load()    the fetch dance both file viewers repeat: loading state, binary check, plain text,
//             and an error state. An optional highlight endpoint is asked first; without one, or
//             when it gives nothing usable, the plain URL is read instead.
//
// The diff view will use render() with its own row content and skip load() entirely.
//
// IIFE for the same reason files-tab.js and artifacts.js are: these are classic scripts sharing one
// global scope, so everything is private behind a single published name.

(function () {

const WRAP_KEY = "pidroid.codewrap";

/** Soft wrap is a reading preference, so it survives leaving the file and coming back. */
function prefersWrap() {
  try { return localStorage.getItem(WRAP_KEY) === "1"; } catch { return false; }
}
function setPrefersWrap(on) {
  try { localStorage.setItem(WRAP_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

/**
 * One row of a code surface. `label` is whatever goes in the gutter (a line number for a file, two
 * line numbers and a +/- mark for a diff); `content` is already-escaped HTML, or plain text when
 * `html` is false. Callers that need a different row shape -- the diff viewer adds a change marker
 * and a second line number -- pass extraClass and build the label themselves.
 */
function row(label, content, extraClass, isHtml) {
  const cls = extraClass ? ` class="${extraClass}"` : "";
  const body = isHtml === false ? escapeHtml(content) : content;
  return `<span class="code-row${cls}"><span class="code-ln">${label}</span><span class="code-lc">${body}</span></span>`;
}

/** Prepare a container as a code surface, without painting rows into it. */
function surface(container, opts) {
  if (!container) return;
  container.className = `code-block${opts && opts.wrap ? " is-wrapped" : ""}${opts && opts.highlighted ? " is-highlighted" : ""}`;
}

/**
 * Paint `container` with one row per line.
 *
 * `rows` is the server's per-line HTML (already escaped there, so it goes in as markup on purpose);
 * `text` is the plain fallback, used when there is nothing coloured to show. Passing rows without
 * text, or the other way round, both work -- whichever is present wins.
 */
function render(container, opts) {
  if (!container) return;
  const rows = Array.isArray(opts.rows) && opts.rows.length ? opts.rows : null;
  const text = typeof opts.text === "string" ? opts.text : null;
  const source = rows || (text !== null ? text.split("\n") : []);
  surface(container, { wrap: opts.wrap, highlighted: !!rows });
  let html = "";
  for (let i = 0; i < source.length; i++) {
    // `i + 1` is the line number in the file, which is not the same as the row index once a diff
    // has folded or skipped lines -- callers that skip rows pass their own numbering via opts.numbers.
    const n = Array.isArray(opts.numbers) ? opts.numbers[i] : i + 1;
    html += row(n, rows ? source[i] : source[i], "", !rows);
  }
  container.innerHTML = html;
}

/**
 * Load a file into `container`.
 *
 * `highlightUrl`, when given, should return { content, rows?, lang? }; `url` is the plain-text
 * fallback and is only fetched when that call did not produce usable content. `stillCurrent()` lets
 * a caller abandon a load when the user has navigated on -- both file viewers need that, because a
 * large file takes a moment to read.
 */
async function load(container, opts) {
  const { highlightUrl, url, stillCurrent, errorLabel = "Could not open file" } = opts;
  if (!container) return;
  container.innerHTML = `<p class="code-status">Loading...</p>`;
  let json = null;
  if (highlightUrl) {
    try {
      json = await fetch(highlightUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    } catch { json = null; }
  }
  if (stillCurrent && !stillCurrent()) return;

  let content = json && typeof json.content === "string" ? json.content : null;
  if (content === null && url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      content = await res.text();
    } catch (err) {
      container.innerHTML = `<p class="code-status is-error">${escapeHtml(errorLabel)}: ${escapeHtml(err.message || err)}</p>`;
      return;
    }
  }
  if (content === null) {
    container.innerHTML = `<p class="code-status is-error">${escapeHtml(errorLabel)}.</p>`;
    return;
  }
  if (stillCurrent && !stillCurrent()) return;

  if (content.slice(0, 4096).includes("\u0000")) {
    container.innerHTML = `<p class="code-status">Binary file, no preview.</p>`;
    return;
  }
  render(container, {
    rows: json && Array.isArray(json.rows) ? json.rows : null,
    text: content,
    wrap: prefersWrap(),
  });
}

/** Flip soft wrap on the open code surface and remember the choice. */
function toggleWrap() {
  const on = !prefersWrap();
  setPrefersWrap(on);
  document.querySelectorAll(".code-block").forEach((el) => el.classList.toggle("is-wrapped", on));
  return on;
}

/** Keep a toolbar button's state in sync with the stored preference. */
function syncWrapButton(button) {
  if (button) button.classList.toggle("is-active", prefersWrap());
}

window.CodeView = { render, row, surface, load, toggleWrap, syncWrapButton, prefersWrap };

})();