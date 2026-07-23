# Investigation — Reported Issues (2026-07-22)

Investigation only — no code has been changed. Each section states the reported symptom,
the confirmed root cause with file/line references, and possible fix directions for later.

---

## 1. Read-only mode is still editable (and shows editor chrome)

**Symptom:** With `readOnly = true`, users can still click into the editor and type. The
control also shows the status bar with a "READ ONLY" badge instead of just rendering the
formatted text.

**Root cause — confirmed:** `readOnly` is cosmetic. It is computed in
`index.ts:110` and passed down, but the Milkdown/ProseMirror view is **never configured
with `editable: () => false`** — ProseMirror defaults to editable. The only effects of
`readOnly` today are:

- Toolbar hidden: JSX guard `showToolbar && !readOnly` (`MarkdownEditor.tsx:522`) plus a
  redundant CSS rule `.read-only .markdown-toolbar { display: none }` (`MarkdownEditor.css:654`).
- `cursor: default` on the editor (`MarkdownEditor.css:658`) — visual only.
- A "Read Only" badge rendered in the status bar (`MarkdownEditor.tsx:903-907`).

Because the contenteditable stays live, edits made in read-only mode flow through the
listener → `onUpdate` → `notifyOutputChanged` and can dirty the record. Additionally, the
paste interceptor (`MarkdownEditor.tsx:499-506`) and the global Ctrl+F handler
(`useFindReplace.ts:218-231`) remain active in read-only mode.

**Desired behavior (per Enrique):** read-only = just the formatted text. No toolbar, no
status bar, no badge, not editable.

**Fix direction (later):** set the ProseMirror `editable` option via Milkdown's
`editorViewOptionsCtx` (`editable: () => !readOnly`); hide the entire status bar when
read-only; skip attaching paste/keyboard handlers. Note: the editor is created once with
`useEditor(..., [])`, so a runtime `readOnly` toggle needs a ctx update (or editor
recreation), not just a prop change.

---

## 2. Page scroll gets trapped by the control (model-driven forms)

**Symptom:** Scrolling down a form, as soon as the pointer passes over the PCF, the wheel
scrolls the editor's inner pane and the page stops scrolling.

**Root cause — confirmed:** Two things combine:

1. The control has a **fixed height** (inline `height/minHeight/maxHeight` set at
   `MarkdownEditor.tsx:520`, value computed at `index.ts:127-129` as `editorHeight` or
   `rows * 54 + 50`), which makes `.markdown-editor-wrapper` an inner scroll container
   (`overflow-y: auto`, `MarkdownEditor.css:318`).
2. `.markdown-editor-wrapper` sets **`overscroll-behavior: contain`**
   (`MarkdownEditor.css:323`). This explicitly **disables scroll chaining**: normally,
   when an inner scrollable reaches its top/bottom, further wheel input hands off to the
   page. With `contain`, the wheel is swallowed at the boundary — so the page genuinely
   cannot scroll while the pointer is over the editor.

So this is not a timing issue needing "a delay" — it is a deliberate CSS opt-out of scroll
hand-off, plus an always-scrollable fixed-height pane sitting in the wheel path.

**Fix directions (later, pick one or combine):**
- Remove `overscroll-behavior: contain` — scroll chains to the page again once the inner
  pane hits its end (smallest change, standard behavior).
- "Click to interact" pattern (what the requested "delay" usually means, as on embedded
  maps): keep the inner pane `overflow: hidden` until the editor has focus
  (`:focus-within`), so casual page-scrolling passes straight through.
- Auto-height: let the control grow with content up to a max, so there is no inner
  scrollbar for typical documents.

Related: `scroll-behavior: smooth` on the same wrapper (`MarkdownEditor.css:322`) animates
scroll adjustments; combined with typing at the bottom of a long document this can add to
the "laggy" feel.

---

## 3. Record appears to be patched without clicking Save

**Symptom:** Changes seem to persist to the record without the user pressing Save.

**Root cause — confirmed (it's platform autosave, triggered eagerly by the control):**
The control itself makes **no direct WebAPI calls** — `external-service-usage` is disabled
and the WebAPI feature block is commented out in `ControlManifest.Input.xml`; there is no
`context.webAPI` usage anywhere in the source.

What actually happens: every keystroke → Milkdown listener → 150 ms serialize debounce
(`MarkdownEditor.tsx:190`, `DEBOUNCE_SERIALIZE_MS`) → `handleChange` → 50 ms debounce →
`notifyOutputChanged()` (`index.ts:174-177`) → the platform reads `getOutputs()` and
writes the value into the bound attribute → **the form is now dirty**. Model-driven apps
have auto-save enabled by default: dirty forms are saved every 30 seconds and on
navigate-away. So the record is being PATCHed by standard form autosave, which the control
arms ~200 ms after every keystroke burst.

**Is that fair?** It is standard, expected PCF behavior — bound controls are supposed to
notify the framework of changes, and autosave is an org/app-level setting. What is
debatable is how *eagerly* this control notifies (near-continuous).

**DECISION (Enrique, 2026-07-22): switch to notify-on-blur.** Users are instructed to
only rely on explicitly saved data, so continuous notification isn't needed. Side
benefit: the form no longer goes dirty mid-typing, so autosave stops persisting partial
edits — this also resolves the "patching without Save" symptom itself.

Design implications to respect when implementing:

1. **Blur must flush synchronously.** On blur, serialize immediately (do not wait for the
   150 ms debounce) and call `notifyOutputChanged()` in the same tick — otherwise a
   Save-button click (which blurs the control first) can read the attribute before the
   value lands.
2. **`destroy()` must also flush** (currently it *discards* pending work — issue 5c).
   Navigation/tab-switch tears the control down without a blur in some paths; destroy is
   the last chance to hand the value over.
3. **Keyboard save with focus still in the editor** (Ctrl+S in model-driven) does not
   blur. Either accept the documented "count only on explicit save after leaving the
   field" behavior, or additionally flush on a save-shortcut keydown.
4. "Blur" must mean focus leaving the whole control (`focusout` where `relatedTarget` is
   outside the container), not moving from the editor to a toolbar button — otherwise
   clicking Bold would trigger a notify.

---

## 4. Delay while writing + blue circle around the text

**Symptom:** Perceptible typing delay; a blue ring appears around the writing area.

**Blue circle — confirmed:** `MarkdownEditor.css:688-691`:

```css
.milkdown .editor:focus {
    outline: 2px solid var(--fluent-brand-primary);
    outline-offset: 4px;
}
```

The editing surface has focus the entire time the user types, so this draws a permanent
2 px blue outline around the whole writing area. (Table cells get additional blue
outlines/insets from `MarkdownEditor.css:504-522`.) If a focus indicator is still wanted
for keyboard accessibility, scope it to `:focus-visible` (mouse focus won't trigger it);
otherwise remove.

**Typing delay — causes, ranked by impact:**

1. **Dev-mode bundle is what's deployed.** `out/controls/MarkdownEditorControl/bundle.js`
   is a webpack *development* build (`eval` devtool banner at the top, 2.8 MB unminified,
   development React with extra runtime checks), and the only packaged solutions are in
   `Solution/bin/Debug/`. A production build (`pcf-scripts build --buildMode production` /
   `dotnet build -c Release`) is the single biggest speed fix.
2. **Full-document work every pause:** after each 150 ms typing pause the entire document
   is re-serialized to markdown and re-counted (`MarkdownEditor.tsx:190-216`).
3. **Re-render echo loop:** the notify → `updateView` cycle `JSON.stringify`s the entire
   document (up to 100 KB) into a props signature (`index.ts:86-97`); since the value
   changed, it calls `root.render` and re-renders the whole React tree — per keystroke
   burst — to deliver a value the editor already has and ignores.
4. `scroll-behavior: smooth` (see issue 2) can make the caret-follow scroll feel delayed
   when typing at the bottom of long documents.

---

## 5. Users can't clear the field — deleted content comes back

**Symptom:** Deleting all content doesn't stick; the old text reappears.

**Confirmed mechanisms (three, likely acting together):**

**(a) First-`updateView` clobber — `index.ts:68-71`.** `_initialLoadComplete` is only set
inside `updateView`, and that first branch overwrites `_currentValue` with the platform
value **without checking `_hasUserEdited`**. If the user clears the field before the first
`updateView` fires (or between init and the first echo), the stale platform value
overwrites the cleared state — and then mechanism (b) visibly re-inserts it.

**(b) The "empty editor resync" effect — `MarkdownEditor.tsx:263-287`.** This is the
literal "writes them back in" code:

```ts
// Only sync if editor is currently empty but props have content
const currentContent = currentMarkdownRef.current;
if (currentContent && currentContent.trim() !== '') return;
...
const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
```

It was written to handle late-arriving Dataverse data, but its trigger condition —
"editor is empty and the incoming value is non-empty" — is **exactly the state after a
user deliberately clears everything**. Any re-render that carries a stale non-empty
`initialValue` (e.g. via mechanism (a)) force-repopulates the document.

**(c) Debounce flush loss on save/close — `index.ts:196-200` + `MarkdownEditor.tsx:142-150`.**
Clearing the field and then saving/navigating within ~200 ms silently drops the empty
value: both the 150 ms serialize timeout and the 50 ms notify timeout are *cleared* on
teardown, never flushed. The platform never learns the field was emptied, so the old text
is still there on reload.

**Related asymmetry:** empty values are systematically disadvantaged — the external-update
branch requires `newValue` to be truthy (`index.ts:72`), so even a legitimate external
clear (another user, a business rule) is never accepted; and `?.raw || ""` conflates
null with empty throughout.

**Runtime check still needed:** confirm what Milkdown serializes for a fully cleared
document. If an "empty" doc serializes to something non-empty (e.g. `<br />` or a
whitespace entity) rather than `""`, clearing could *never* produce an empty output value.
Verify by logging the serializer output in the listener (`MarkdownEditor.tsx:194`) after
Select-All + Delete in the test harness.

---

## 6. Rounded corners lost in model-driven app (read-only)

**Symptom:** In the model-driven app the control's corners render square (screenshot:
read-only field "Escalation Instructions" — top corners squared, scrollbar running into
the corner), even though the container is styled with an 8 px radius.

**Root cause — confirmed:** corner rounding is **manually assigned per child section**
instead of being clipped by the container:

- `.markdown-editor-container` has `border-radius: 8px` but **`overflow: visible`**
  (`MarkdownEditor.css:153-154`) — visible so the table-picker dropdown can escape the
  container. With `overflow: visible`, the container's radius does NOT clip children.
- To compensate, the **toolbar** hard-codes rounded *top* corners
  (`MarkdownEditor.css:169`) and the **status bar** hard-codes rounded *bottom* corners
  (`MarkdownEditor.css:558`).

This only works for the exact child composition toolbar + editor + status bar. In
**read-only mode the toolbar is hidden**, so `.markdown-editor-wrapper` — which has no
border-radius and an opaque background, plus an unstyled square scrollbar — becomes the
topmost child and squares off the container's top corners. The same breakage will occur
at the *bottom* once the status bar is removed (decision 7/8), and today for anyone who
sets `showToolbar = false`.

**Fix direction (later):** stop rounding per-section. Either (a) put the radius +
`overflow: hidden` on an inner wrapper that contains toolbar/editor/status but not the
dropdown (dropdown stays anchored to the outer container), or (b) keep per-child rounding
but drive it structurally (`:first-child` gets top radius, `:last-child` gets bottom
radius) and style the scrollbar or inset it. Must be validated against the planned
read-only layout (editor wrapper as the only child → all four corners) and
toolbar-hidden config.

---

## Decision log (Enrique, 2026-07-22)

| # | Topic | Decision |
|---|-------|----------|
| 1 | Notify timing | **Notify-on-blur** (see issue 3 above for implementation constraints). |
| 2 | Scroll capture | **"Click to interact"**: the editor does not scroll internally until it has focus; page scroll passes through otherwise. |
| 3 | External update policy | **Accept outside values whenever there are no un-flushed local edits.** While the user has pending edits (pre-blur), the editor is source of truth; after blur/flush, the platform is. External empty values must also be accepted (fixes the "external clear never shows" asymmetry). Replaces both the "ignore forever after first edit" rule (`index.ts:72-77`) and the empty-editor resync effect (`MarkdownEditor.tsx:263-287`), which gets deleted. |
| 4 | maxLength | **Hard-block input at the limit.** Property stays optional; code default is 100,000 chars. Makers should set it to match the bound column's configured max length (Dataverse multiline text defaults to 2,000, configurable up to 1,048,576) — otherwise the control can accept text the platform will reject on save. |
| 5 | Image paste | **Leave as-is for now** (base64 into the field, 5 MB cap). Revisit later — links/attachments are likely the better long-term approach. |
| 6 | Find & Replace | **Remove the feature entirely** (deletes `useFindReplace.ts`, the panel UI, the global Ctrl+F handler, and the paste-hijack surface). |
| 7 | Save-status indicator | **Remove it.** Users are instructed to rely only on explicit saves; the indicator can never know about the actual record save anyway. |
| 8 | Read-only mode | **Pure renderer/label** — no toolbar, no status bar (no word/character count, no save status, no "Read Only" badge), truly non-editable. Just the formatted markdown, with all four corners rounded (see issue 6). |
| 9 | Theme toggle button | **Remove** (see item K below). |
| 10 | Theming | **Light only.** Remove the `theme` property and all theme machinery: manifest property, validation in `index.ts`, prop threading, `matchMedia`/`auto` logic, `themeOverride` state, Sun/Moon icons, `.dark` CSS variable block, `effectiveTheme` class names. `high-contrast` (never styled) also gone (see item K2 below). |

## Additional improvement opportunities (found later; not yet decided/scheduled)

**A. Global CSS leakage into the host app — significant.** `@milkdown/theme-nord/style.css`
(imported in `MarkdownEditor.tsx:11`, injected into the page `<head>` by webpack at
runtime) contains an **unscoped Tailwind preflight**: global rules such as
`h1..h6 { font-size: inherit; font-weight: inherit }`, `a { color/text-decoration: inherit }`,
`ol, ul, menu { list-style: none }`, `img, svg, video... { display: block }`
(`node_modules/@milkdown/theme-nord/lib/style.css`). PCF CSS applies to the whole
model-driven form page, so this can silently restyle unrelated page content (plain-HTML
web resources, embedded HTML, anything relying on UA defaults). The `@layer base`
wrapping softens specificity conflicts but does not stop the reset from applying where no
other style exists. Fix options: scope the theme CSS under `.milkdown` at build time, or
**drop theme-nord entirely** — the project already ships 1,340 lines of custom editor CSS
that duplicates much of it (also removes ~1 dependency and shrinks the bundle).

**B. Toolbar tooltips promise keyboard shortcuts that don't exist.** Verified against the
installed presets: Ctrl+B/I and Ctrl+Alt+0–3 are real (Milkdown registers `Mod-b`,
`Mod-i`, `Mod-Alt-0..6`), but **"Strikethrough (Ctrl+Shift+S)" and "Insert Link (Ctrl+K)"
are not registered by any preset** — the tooltips are fiction. ("Redo (Ctrl+Y)" needs a
runtime check against plugin-history.) Fix or remove the claims.

**C. `window.prompt`/`window.alert` for link/image insertion and errors.** Blocking
native dialogs; in some embedded/webview contexts prompts are suppressed entirely, making
Insert Link silently do nothing. Replace with a small inline popover (matches the
existing table-picker pattern).

**D. Replace the hand-rolled markdown-paste heuristic with `@milkdown/plugin-clipboard`.**
The 14-regex `looksLikeMarkdown` + manual doc surgery (`MarkdownEditor.tsx:366-496`) is
what causes the paste bugs; the official clipboard plugin (already present transitively)
handles markdown copy/paste properly. Image paste handling stays custom.

**E. Focus not returned to the editor after toolbar clicks.** Every command except Insert
Link leaves focus on the toolbar button; the user must click back into the text.

**F. Accessibility & localization gaps.** The contenteditable region has no accessible
name/role; the status bar is not `aria-live`; every UI string is hardcoded English while
PCF supports `.resx` localization (relevant for multi-language orgs).

**G. Repo hygiene.** A literal `~/Library/Microsoft/PowerAppsCli/usersettings.json`
directory sits inside the project (misfired `pac` CLI invocation) — delete it. `out/`
(dev bundle) and `Solution/bin/` zips should be gitignored/cleaned.

**H. No tests, no CI.** The value-flow logic (`index.ts` — where every data-loss bug
lives) is pure and easily unit-testable; the notify-on-blur rework is the right moment to
add tests + lint in CI.

**I. package.json metadata points at the upstream repo** (`Sahib-Sawhney-WH/Live-Markdown-Editor-PCF`,
author "HAP"). If this is a fork, repository/bugs/author should be corrected.

**J. Word count counts markdown syntax as words** (`#`, `|`, `---`, raw URLs all match
`/\S+/g` on the serialized source). Counting from `doc.textContent` matches what users see.

**K. Theme toggle button — DECIDED (Enrique, 2026-07-22): remove.** Rationale: the org
doesn't use dark theming in Power Platform, and the override was per-session, unpersisted,
and fought the maker-configured setting. Deletes the `themeOverride` state, `toggleTheme`,
and the inline Sun/Moon SVG icons.

**K2. Follow-up — DECIDED (Enrique, 2026-07-22): light only, remove all theme machinery.**
The `theme` property goes away entirely (manifest, index.ts validation, prop threading,
`matchMedia`, `.dark` CSS block, `effectiveTheme` class names). Same rationale
extends further: the `theme` property still accepts `dark` and `auto`, and `auto` follows
the *OS* preference — a user with Windows dark mode gets a dark editor embedded in a light
form. If the org never themes dark, simplifying to light-only removes the `.dark`
variable-override block (`MarkdownEditor.css:102-135` — theming is CSS-custom-property
based, so the win is ~40 lines of CSS, not hundreds), the `matchMedia` logic, the
`effectiveTheme` class threading through five components, and two accepted-but-useless
property values (`dark`, `auto`; `high-contrast` is already being dropped).
(Note: model-driven dark mode exists as a Microsoft preview feature, so keeping the
property is defensible if adoption is expected; dropping it is the lighter choice.)

**L. CSS pruning after feature removals.** Removing Find & Replace (~200 lines of panel
CSS), the save-status styles, and unused Fluent tokens/animations should meaningfully
shrink the 1,340-line stylesheet.

**M. Version-bump discipline.** Dataverse caches controls by manifest version; every
deploy needs a version bump or users keep the stale bundle (current `out/` is from April).

**N. Responsive breakpoints may never trigger in model-driven (verify at runtime).**
`getResponsiveClass` depends on `context.mode.allocatedWidth`, which model-driven hosts
often report as -1; if so, compact modes never activate there. `ResizeObserver` on the
container is the robust alternative.

---

## Lightness plan (explicit goal, Enrique 2026-07-22)

Weight reduction is a first-class goal of the implementation pass, measured, not assumed:
build a **production** bundle before touching code to get the true baseline (the 2.8 MB
`out/` bundle is a dev build and not a meaningful number), then re-measure after each
removal wave and record both figures here.

Levers, largest first:

1. Production build (minify, prod React, no eval wrappers) — biggest single win.
2. Drop `@milkdown/theme-nord` (+ its Tailwind runtime CSS) — also fixes the global CSS
   leak (item A).
3. Feature removals already decided: Find & Replace (hook + panel + CSS), save-status,
   theme machinery, `SimpleMarkdownEditor`, dead utils/helpers.
4. Fewer lucide icons after removals (Search/Chevrons/X, CheckCircle/RefreshCw/Circle,
   Sun/Moon inline SVGs all go).
5. Import `callCommand` from `@milkdown/utils` instead of `@milkdown/kit/utils` and
   declare real deps — avoids any chance of pulling kit's aggregate exports.
6. CSS pruning (item L) — find/replace, status bar, dark block, unused tokens/animations.
7. Kill the per-keystroke `JSON.stringify`/re-render echo (runtime lightness; falls out
   of the notify-on-blur rework anyway).

Floor: the Milkdown + ProseMirror editor engine itself stays and is the irreducible core
of the bundle; the target is everything *around* it.

**Baseline (prod build, pre-changes):** 740,122 bytes minified (216,609 bytes gzip) — measured 2026-07-22, webpack production mode. (The oft-cited 2.8 MB was the dev build.)
**Result (prod build, post-changes):** 735,667 bytes minified (215,540 bytes gzip) —
measured 2026-07-22, webpack production mode, after `npm ci` for a clean reproducible
install. Delta vs baseline: **-4,455 bytes minified (-0.60%)**, **-1,069 bytes gzip
(-0.49%)**. Smaller than the removed-feature surface (Find & Replace, save-status,
theme machinery, theme-nord) would suggest on its own — the Milkdown/ProseMirror engine
itself dominates the bundle and is unaffected, and this pass also added code (WHATWG-based
URL validation, popovers replacing prompts, `@milkdown/plugin-clipboard` paste handling)
that partially offsets the removals. The win is real but modest in raw bytes; the larger
value of this pass was correctness (notify-on-blur, true read-only, hardened validation)
and removing the theme-nord global CSS leak into the host form, not bundle size alone.

**Result (prod build, post fix-wave-5):** 736,247 bytes minified (215,732 bytes gzip) —
measured 2026-07-22 via `npm run build:prod` (new script added this pass; see below),
`ls -l out/controls/MarkdownEditorControl/bundle.js` for the minified size and
`gzip -c out/controls/MarkdownEditorControl/bundle.js | wc -c` for gzip. Delta vs the
original pre-changes baseline: **-3,875 bytes minified (-0.52%)**, **-877 bytes gzip
(-0.40%)**. Essentially flat vs the prior post-changes measurement above (+580 bytes
minified / +192 bytes gzip) — fix wave 5 was correctness/hardening (maxLength-vs-external-
apply race, stale isDirtyRef gate, control-character URL rejection, CSS host-page leak
scoping, readOnly-toggle try/finally) plus a new `build:prod` script and doc corrections,
none of which meaningfully move bundle weight either direction; the Milkdown/ProseMirror
engine continues to dominate the total.

## Cross-reference to the full code review

The broader review (same date) found additional issues not reported here, most notably:
Replace/Replace All broken by case-sensitivity mismatch, paste interception hijacking the
Find/Replace inputs, global Ctrl+F capture, hardcoded DOM ids breaking multi-instance,
`enableSpellCheck` and `maxLength` being no-ops, the fake "Saved" status, a
`high-contrast` theme with no CSS, undeclared `@milkdown/preset-gfm` / `plugin-history` /
`kit` dependencies, a tab/newline URL-protocol validation bypass, and ~500 lines of dead
code (`SimpleMarkdownEditor.tsx`, unused error/security helpers).
