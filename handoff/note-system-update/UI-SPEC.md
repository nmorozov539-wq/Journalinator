# Interface specification

Implement these states in the existing canvas shell. Do not redesign navigation, board backgrounds, pins or threads. `UI-REFERENCE.html` is a standalone illustrated state sheet: it demonstrates placement, hierarchy and copy, not a functioning Foundry editor.

## Common visual and input rules

Retain current bundled EN/RU fonts and paper textures. UI chrome uses the existing system UI font; note body uses selected paper font, 16 board px/1.5 line height; H1 title 26 px/1.15, H2 20 px/1.25. All headings wrap. Paper padding is 20 board px; title-to-body spacing 12 px. Underline has a 1 px line with 8 px spacing. Profile title/caption centered; Plain title/body left aligned. Plain without title does not reserve a title zone. Do not render author signatures on paper.

Controls and their labels are screen-sized, unaffected by canvas zoom, minimum 32 px target height; 44 px on coarse pointers. Use 13–14 px UI text and at least 12 px status/helper text. Text contrast at least 4.5:1; visible focus rings and labels in addition to colors. Dark UI panels use the existing canvas palette; paper remains readable. Decorative background images receive a paper-colored readability wash and never replace content images.

Keep controls within the viewport, 8 px inset. Overlay toolbars sit 12 px above their card, below if no space, and wrap into two rows if needed. They must not resize the paper. Popovers fit available height and scroll internally. Do not pan the board simply because another player types. The writer may locally scroll/pan to keep the caret visible; preserve zoom. Nothing animates card width, height, pins or thread endpoints during editing.

All visible strings, labels, tooltips, errors and accessible names have English and Russian localization keys. Preserve the module's existing language selection. Hidden placeholder text is not persisted. Hover reveals supplementary information only; essential actions remain keyboard/touch accessible.

## Creation

`+ Note` in the existing top toolbar and double-click on empty board both open the same small anchored menu. Existing board label/stamp creation remains separately available; remove Location and secret creation entries.

| Choice | Secondary text | Initial body | Layout/skin | Initial focus |
| --- | --- | --- | --- | --- |
| Blank | Start with an empty scrap | empty string | Plain / Amber | First body position |
| Document | Start with a title | `# ` | Plain / Cream | After the marker |
| Profile | Start with a title and portrait | `# ` | Profile / Parchment | After the marker |

Choose once to create and immediately request editing; creation failure does not leave an orphan card. Enter activates the focused choice, Escape closes without creating. New cards use current free-placement rules and a main pin. No modal asking for a separate name. Quick-switcher “Create” uses typed text as `# <query>` in Plain/Cream, properly represented as heading text; allow duplicate titles. Empty queries create Blank. Template marker `# ` is syntax, not fake title content; other viewers see no heading until actual title text exists.

## Selection and controls

Single-click selects an unlocked note. Double-click its text requests editing at the nearest text position; Enter on the focused selected card starts editing. Read-mode selected toolbar order: **Edit**, **Layout**, **Appearance**, **Auto**, **More**. Layout is a two-choice menu: Plain / Profile, with the selected item checked. Never list Document, Memo, Sticky, Location or Target as layouts.

Auto is a toggle button: pressed and labeled `Auto` in automatic mode; unpressed with tooltip `Use automatic sizing` in manual mode. A resize drag enters manual mode. Clicking Auto restores automatic dimensions. Selected untitled note shows the ghost `Add title…` at the top of the paper; it is an overlay excluded from geometry. Activation acquires a lock before inserting `# ` on a new first line, preserving existing content. If source already begins with empty `# `, focus it without inserting another. No ghost for remote-locked notes or ordinary unselected readers.

More contains **History**, **Send to…** where already supported, **Copy**, **Delete**. Keep existing destination eligibility and transfer confirmations. Unrelated board stamp actions stay available in their existing controls; apply lock guards to note-affecting actions. Remove all legacy rename, actor, secrets, hint, block and stats controls. Mixed selection offers only valid common actions; any locked note disables the whole mutating group action with explanation.

## Editing directly on the card

The body becomes a single continuous Markdown editing surface on the same paper. No separate panel, paragraph widgets, author badges, per-block controls or rich-text document model. Markdown syntax stays editable; title text gets the H1 font and its leading `#` is muted but legible. Other source lines use body typography with light syntax styling; images appear as editable Markdown source to the writer and rendered images to viewers. The card's dimensions are measured from rendered content, not the length of image URLs or Markdown markers.

Editing toolbar order: **Title**, **Divider**, **Portrait**, separator, **Layout**, **Appearance**, **Done**. Its secondary row shows `Editing · You` left and autosave state right. Use a local note-sized outline to indicate editing, no flashing/caret broadcast. Keep card rotation; do not straighten it and cause pin movement. The editor must support source fidelity, selection, native undo/redo, copy/paste and IME. Implementation may choose a source editor library or styled source surface after audit; a plain unstyled textarea does not meet title styling, and an HTML editor that rewrites Markdown does not meet source fidelity.

Tool behavior:

- **Title:** If a first-line title exists, focus/select its text without duplicating it. If only an empty marker exists, focus after it. Otherwise prepend `# ` plus a newline, leave the old body untouched and focus the new title. Selecting text elsewhere does not remove it.
- **Divider:** Insert standalone `---` at the caret line boundary. Split at caret if necessary, preserving both sides with newlines. If immediately after a heading, it displays as an underline; otherwise a rule. Do not insert inside code/comment regions: disable with `Move the cursor outside code or a comment to insert a divider.`
- **Portrait:** Open the image dialog below. In Profile with valid title and no portrait, insert the chosen image after the title/optional underline, before the existing rest, and preserve intervening source. In other cases insert a standalone image at the caret on its own line. An already valid Profile portrait can be replaced through an explicit `Replace portrait` action in the dialog; never silently replace an unrelated image. Disable insertion when caret is in code/comment unless using the explicit missing-Profile-portrait action.
- **Done:** Flush pending autosave, then leave editing and release the lock after acknowledgment. It means finish, not “save only when clicked.” Failed save keeps the editor/draft and offers recovery actions.

Enter inserts a newline; blank lines do not split documents. Backspace never merges note objects. Ctrl/Cmd+Z and redo stay within editor text while focused, not board deletion undo. Ctrl/Cmd+S prevents browser Save Page and flushes autosave without closing. Escape closes an open menu/dialog first; otherwise performs Done. Clicking another note or changing canvas performs Done before entering another shared editing session. Pan/zoom and toolbar focus do not finish editing. Clicking empty board can leave the note editing; use Done/Escape to finish explicitly. Never trap the user after disconnection: allow Close and keep a draft with a visible notice.

During composition (IME), do not replace the input DOM, trigger shortcuts, or publish partial composition text; update after compositionend. Toolbar clicks preserve the intended selection/caret. With a file picker open, keep the edit session heartbeat alive.

## Profile helpers

Helper is a compact, wrapping row below the editing toolbar, maximum 340 screen px wide, only for the current editor when Profile is selected but invalid. It sits outside paper content. Show the first applicable message, not a checklist or multiple errors. Optional caption/divider never generate warnings.

| Priority and condition | Exact English copy | Action |
| --- | --- | --- |
| No first-line nonempty title, no usable later title | Profile needs a title on the first line. | Add title → title insertion/focus |
| A title exists later (including image-first order) | Move the title to the first line. | No automatic reorder action |
| Title present, no standalone image candidate | Profile needs a portrait after the title. | Insert portrait → image dialog |
| Standalone image exists but visible text breaks required order | Move the portrait directly below the title or its divider. | No automatic reorder action |
| Image markup is incomplete/invalid in expected portrait position | Complete the portrait image or choose an image. | Choose image → explicit repair/insertion dialog; preserve old text unless user selects replacement |

Below the issue, show muted `Showing Plain until the structure is complete.` The Layout menu still checks Profile. Allow blank lines/comments between slots, not before the first-line title. A valid structure immediately removes helper and uses Profile; switching to Plain removes helper immediately without changing text. A broken URL in valid image syntax uses the image-error state, not structure fallback. Never show these hints to viewers or store them in body text.

## Image dialog

Reuse Foundry file browsing and existing URL/path validation. Dialog title `Insert portrait` or `Replace portrait`; fields **Image URL or file path** and optional **Alt text**. Row actions **Browse…**, **Cancel**, **Insert** (or **Replace**). Insert disabled for empty/unsafe source, with inline reason. Accept existing supported HTTP(S) and Foundry file paths; reject script URLs. Escape special Markdown characters/parentheses so the resulting image round-trips through the parser. Keep source URL out of error HTML interpolation.

After insertion return focus to the following line. Cancel leaves body unchanged and restores previous caret. Failure to load shows `Image unavailable` and alt text, with an editing-only `Choose image` action. No image makes a note Profile automatically. Caption is ordinary `## Caption` typed after a portrait; an empty optional caption appears nowhere to viewers.

## Appearance popover

Rows in this order: **Paper** (Cream, Amber, Parchment swatches with labels), **Font** (Default, Serif, Handwritten, Display using existing bundled font mapping), **Torn edges** checkbox, **Background image** (Choose / Remove). Close on Escape/outside click and return focus to Appearance. Changes persist immediately through a validated mutation and do not edit body. Holder may change appearance/layout during editing; others cannot.

Cream: warm light paper, flat orientation. Amber: muted yellow paper, seeded tilt in -2 to +2 degrees. Parchment: warm beige textured paper, seeded tilt in -1 to +1 degree. Derive tilt once from stable seed and skin, never randomize per render. Preserve manually set rotation if existing controls support it; skin switching must not overwrite a manual rotation override. Use current paper assets/procedural rendering; exact tokens should be centralized. Torn edges and background affect appearance only. No independent Picture layout, Force extended or Heading fields.

## Autosave and lock states

| State | Writer copy/actions | Other viewers |
| --- | --- | --- |
| Acquiring | `Opening editor…`; paper read-only until grant | Existing rendered body |
| Editing clean | `Saved` | `Alex is editing` above the card; rendered content |
| Dirty/in flight | `Saving…` | Same lock badge; live rendered preview |
| No transport or no active GM | `Offline — saved locally` only if local write succeeded; Close / Copy text | Saved body after preview invalidation; lock expires or clears on failover |
| Local storage failure | `Recovery copy unavailable in this browser.` plus actual server save state; Copy text | No extra notice |
| Save rejected/failed | `Couldn’t save. Your draft is kept on this device.` Retry / Copy text, only if local draft succeeded | Last accepted preview while lease valid; saved body when revoked |
| Force-unlocked | `The GM ended this editing session. Your unsaved text is kept locally.` Close / Copy text | Last saved body, unlocked |
| Lease lost | `Editing connection lost. Reopen the note to recover your draft.` Close / Copy text | Last saved body, unlocked |

Use actual user's name, safely escaped, and neutral fallback `Someone is editing`. Badge is screen-space, attached above paper. A remote-locked note cannot be selected for mutation, dragged, resized, deleted, copied/transferred, restyled, receive checkbox toggles, pins or connection edits. It can be read; the board can pan/zoom. In the GM view the badge includes **Unlock**. Clicking opens `End Alex’s editing session?` with text `Unsaved changes will remain on their device. The note will return to its last saved version.` Buttons Cancel / Unlock note. No passphrase or vault permission check. Inform the editor without displaying their draft to the GM.

No-GM banner for shared canvas: `A GM must be connected to edit shared notes.` Keep navigation/read controls working. Do not show fake Saved when there is only a preview or local draft. Do not announce every save/keystroke to screen readers; announce errors, lock changes and completed actions.

## Recovery and history

On opening a note with a different local draft, show a compact dialog `Recover unsaved text?` with timestamp and a scrollable escaped source preview. Actions **Recover draft**, **Copy text**, **Discard**. Discard requires an explicit click, never closing the dialog. If newer saved text exists, show saved text and draft in labeled side-by-side panes (stack on narrow screens), copy `This note changed since your draft. Recovering it will replace the current text.` and action **Replace with draft**. Acquire lock and recheck revision at action time; another change refreshes the comparison rather than overwriting. Escape defers recovery without discarding. Missing/deleted note offers Copy text / Discard only. Recovery dialog is local to its author.

History opens from More in a modal titled **Note history**, width 720 px or viewport minus 32 px. Left list 190 px: date/time and editor; right pane read-only rendered selected version. On narrow viewports stack list and preview. Show `Current version` distinctly, newest first, and **Restore this version** / **Close** footer. Disable restore on current version or another user's lock, with reason; viewing is allowed. Restore confirmation: `Replace this note’s text with the selected version? The current text will remain in history.` Cancel / Restore. Acquire/revalidate lock, save current checkpoint, restore text and close; toast `Version restored`. Empty state: `No earlier versions yet.` History does not restore threads, pins, appearance or geometry.

## Search, trash and miscellaneous states

Search and trash use derived title/excerpt, never Foundry's internal name. Untitled image-only notes display `Image note`; entirely empty notes display `Empty note`. Show secondary excerpt (if distinct), creator and date for duplicate labels. No uniqueness error or forced numbered names. Search reads confirmed data, not another player's uncommitted preview. Filters are All / Plain / Profile, using selected layout; remove Location/style-as-type filters and preserve useful author filtering.

Checkbox clicks outside editing acquire a short note lock and perform one revisioned body update; blocked when another editor owns the note. Inside editor they remain source text edits. No auto-created wikilink notes or navigation on `[[...]]`.

For incompatible stored format, show a read-only notice in the journal: `These notes use an older development format. This build needs a fresh Journalinator workspace.` Secondary text: `Existing data has not been changed. Use a fresh test world or ask the host to reset Journalinator data.` Action Close only; no automatic destructive reset. This is a clean-break guard, not migration UI.

Private canvas uses the same creation/editor/layout/appearance/history controls. Hide shared editing badges from other users; no broadcast of private previews or recovery. Keep existing canvas name and inbox/admin controls. Shared activity and removed stats/vault interfaces never appear here.
