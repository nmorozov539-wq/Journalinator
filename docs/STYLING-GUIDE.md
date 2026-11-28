# Styling guide for code contributors

This describes the implementation on `main` at 0.10.0 (baseline `985a72e`), including dormant APIs and known mismatches. It is a source map, not a specification for new behavior or instructions for using the journal UI. The 0.10.1 note repair is separate work; do not treat its intended changes as already implemented here.

## Follow the data to the paint

There are three independent inputs: a client-wide theme, persisted note skin/layout, and persisted link cosmetics. Changing a theme does not rewrite note or link records.

| Input | Storage / definition | Consumer |
| --- | --- | --- |
| Selected background/theme ID | Client setting `fvtt-journalinator.boardTheme`, default `stylized` | `resolveThemeChoice` in `scripts/app/journal-app.mjs` |
| Custom theme source objects | Client setting `fvtt-journalinator.customThemes`; in-memory registry | `scripts/styles/themes.mjs`, startup in `scripts/init.mjs` |
| Note content, chosen layout, skin | Shared note page `system.body`, `system.layout`, `system.skin` | `scripts/app/card-view.mjs`, document parser, skin registry |
| Note position/size/rotation/anchors | Layout page `system.cards[noteId]` | Canvas, sizing and anchor modules |
| Note-to-note thread look | Source note `system.links[]` | `resolveLinkCosmetics`, canvas, thread renderer |
| Free-pin thread look | Layout `system.pinLinks`; pins in `system.pins` | Board-pin helpers and the same thread renderer |
| New-thread defaults / saved presets | Client `fvtt-journalinator.linkPen` (`current`, `presets`) | `scripts/link-pen.mjs`, `scripts/pen-store.mjs` |
| Private equivalents | Private workspace notes and `layout` object, saved by `scripts/store/private-store.mjs` | Shared canvas/view machinery, private write adapter |

The shared schemas are in `scripts/data/note-model.mjs` and `layout-model.mjs`. Follow existing socket/store writes for persisted edits; DOM style mutations are only presentation and disappear on re-render. Private writes must retain their owner/revision checks.

The CSS load order in `module.json` is `styles/journal.css`, `styles/fonts.css`, then `styles/stylized.css`. The last file overrides much of the older theme surface. Inline variables and measured sizes applied by canvas also matter. Search for a variable's **consumer**, not just its emitter, before promising a theme knob works.

## Theme API and normalization

The public API is installed during `init` in `scripts/init.mjs`:

```js
Hooks.on("journalinatorRegisterThemes", themes => {
  themes.register("studio", {
    name: "Studio",
    colors: { acc: "#8ca6ad", panel: "#25292b", text: "#f2eee4" },
    materials: {
      board: { cork: "#30383b", lightOpacity: 0.04 },
      paper: { document: "#eee7d8", memo: "#e0cba4", target: "#ded3b9" },
      fonts: { body: "alegreya", hand: "caveat", formal: "oldstandard" },
      threads: { dyes: ["#bd7265"], accent: "#d9cdb7" }
    },
    links: { colors: { link1: "#bd7265", link2: "#8ea891", link3: "#94a8c1" } }
  }, { persist: false });
});
```

This registers a theme; **it does not add a picker option or activate it** in 0.10.0. The app restricts its background picker and its selection handler to `BOARD_BACKGROUND_IDS`: `stylized`, `cork-photo`, `grey-paper`. For a development preview, set the client `boardTheme` setting to a registered ID and re-render the app. There is no public `themes.apply` method. To expose custom choices in product UI, change both the picker list and selection guard in `journal-app.mjs`, not merely registration.

`game.journalinator.themes` offers `register(id, source, options)`, `list()` and `get(id)`. Public registration defaults to `persist: true`; the lower-level exported `registerTheme` defaults to false. Persistence is client-local and asynchronous, not a world-wide theme deployment. A companion module can register the same theme on each client at `journalinatorRegisterThemes` (fired at ready). Hooks also include `journalinatorThemeRegistered` and `journalinatorThemeChanged`. Registration alone is not a render request.

Public IDs use the bounded alphanumeric/underscore/hyphen format validated by `isThemeId`. The built-in IDs `stylized`, `cork-photo`, `grey-paper`, `classic`, `fantasy`, `parchment` cannot be replaced through the public API. Unknown lookups fall back to Stylized.

Pipeline: `normalizeTheme` → registry → app theme choice → `applyTheme(root, theme)` → `themeToVars` → CSS. `applyTheme` writes `data-theme`, forces `data-visual="stylized"` and `data-board-pattern="none"`, and sets custom properties. Normalization fills omissions, clamps numbers and drops unsupported fields. Most legacy values fall back to Classic; `materials` falls back to `STYLIZED_MATERIALS`. A partial theme is therefore not an inheritance operation from whatever theme was previously selected.

Supported color roles are `bg`, `panel`, `text`, `muted`, `line`, `acc`, `gm`, `hint`, `thread`, `danger`, `dangerBg`, `dangerText`, `onAccent`, `shadow`, `stamp`. They emit `--jn-*` variables (for example `dangerBg` → `--jn-danger-bg`, `stamp` → `--jn-stamp-bg`). Material/style color fields can reference a role such as `acc`; use literal values in the role table rather than building recursive aliases. Validation is bounded declarative data, not arbitrary CSS injection.

Theme asset paths pass `imagePath`: a relative Foundry data path, at most 200 characters, no leading slash, `..` or remote URL. A bundled asset should be `modules/fvtt-journalinator/assets/...`; `cssUrl` uses Foundry routing. Markdown content images and skin decoration have separate validation/write paths and are not governed by this theme path rule.

## Board backgrounds: use materials

The visible board is controlled primarily by `materials.board`, not the older `board` block:

| Material field | Emitted variable / actual role |
| --- | --- |
| `cork` | `--jn-sc-cork`, canvas base color |
| `corkTile` | `--jn-sc-cork-tile`, repeating canvas `::before` image |
| `size` (64–640) | `--jn-sc-cork-size`, tile size in board space |
| `border`, `radius` (0–24) | `--jn-sc-board-border`, `--jn-sc-board-radius` |
| `lightOpacity` (0–0.6) | Warm highlight in `--jn-sc-board-light` |
| `vignetteColor`, `vignetteStart` (0–90), `vignetteEnd` (0–100) | Canvas `::after` radial vignette |
| `grainTile` | `--jn-sc-grain`: despite its storage here, this textures **notes** |

Edit `STYLIZED_MATERIALS` for baseline defaults or the `CORK_PHOTO_THEME` / `GREY_PAPER_THEME` definitions for those backgrounds. Assets live in `assets/stylized/`. The canvas updates `--jn-board-zoom`, `--jn-board-pattern-pos` and tile sizing so texture follows pan/zoom. Avoid replacing the world-anchored layer with a viewport-fixed background unless that behavior is intentional.

For a flat background, change the material color and explicitly remove the `::before` texture in CSS. Passing `null` for `corkTile` or `grainTile` does not disable them: normalization falls back to the bundled default. A new supported no-texture setting needs normalization, emission and consumer changes together. The `::after` highlight/vignette is a separate layer.

The legacy `board` fields still normalize and emit `--jn-board-*` values: color, pattern, patternColor/Size/Opacity, image/Opacity/Size and vignette. However, `applyTheme` disables dots/grid, and later material CSS replaces the visible background layers. Setting `board.image` or `board.color` alone is not a reliable way to restyle the current board. Keep legacy API support distinct from actual paint behavior.

## Scene colors: retained code, incomplete visual connection

`scripts/scene-palette.mjs` still implements scene-derived themes. It samples a 64×64 image, clusters perceptual colors in OKLab/OKLCH, derives readable roles, and caches results. `activeSceneSource` reads the viewed/active scene, prefers the initial level's background source, then older background/image fields, with background-color fallback. Failed or CORS-tainted image reads do not produce a successful image palette.

`paletteToTheme` populates generic `colors`, legacy `board`, legacy `styles`, and `links.colors`. It does **not** populate scene-specific `materials`. Consequently normalizing a scene theme fills the material board, papers and thread defaults from Stylized. Scene-colored generic UI and explicit link color slots can respond; the material cork and note paper colors do not automatically follow the scene. This is why calculating a palette is not proof that every visual uses it.

The `scene` ID is absent from the current picker. `resolveThemeChoice("scene")` still calls `sceneTheme()` and falls back to Stylized if unavailable. `canvasReady` and relevant `updateScene` changes clear the cache/re-render only when the saved choice is `scene`. Thus this is dormant selectable functionality with a retained resolution path, not wholly deleted code.

To revive scene-aware material styling in a future change: map palette roles to `materials.board`, `materials.paper`, and default thread dye/accent as well as `links.colors`; expose/allow `scene` in both picker paths; retain fallback/contrast behavior; extend `tests/scene-palette.test.mjs` and theme tests. Do not merely re-enable the menu and claim the papers now use scene colors.

Other unused/misleading outputs: six material dye variables are emitted, but current default-thread CSS consumes dye 1; it does not offer dye 2–6 as six selectable colors. Legacy `styles.sticky/document/torn/wanted/memo` tokens remain emitted, but v2 cards use Plain/Profile and skin classes. `gm`/`hint` names surviving in the palette do not restore the removed GM-vault features.

## Notes: layout, skin, content and geometry

Read `scripts/templates.mjs` for creation defaults. Blank, Document and Profile are templates, not three persisted note types. In this baseline Document and Profile both seed `# `; this guide does not claim their placeholder UX is correct.

`system.layout` is `plain` or `profile`; `system.skin` contains `paper`, `font`, `torn`, `backgroundImage`, `tiltSeed`. The Markdown `body` is the content authority. Title, portrait and caption are derived, never separate persistent display fields.

Render path:

1. `scripts/app/card-view.mjs:createCardView` selects the stored body or live preview, parses it using the selected layout, resolves skin/rotation, creates classes and CSS variables, and renders sanitized Markdown.
2. `scripts/document/parse.mjs` determines title/profile slots and effective layout. At 0.10.0 Profile is explicitly selected; invalid structure falls back to Plain. Adding image syntax alone does not select Profile in this baseline.
3. `scripts/document/render.mjs` renders the body, title and caption semantics; `scripts/app/canvas.mjs` applies the view, tags the profile portrait and installs geometry.
4. DOM is `.jn-card > .jn-card-paper > .jn-note-body`. Root classes include `.jn-card-plain` / `.jn-card-profile`, `.jn-skin-paper-*`, `.jn-skin-font-*`, `.jn-torn`, and `.jn-profile-fallback` when appropriate.

The active paper selector is `.jn-canvas .jn-card > .jn-card-paper` near the v2 overrides in `styles/stylized.css`. Older comments/selectors for `.jn-card-main` describe the previous structure. Editing those alone will miss current notes.

| Skin choice | Registry mapping in `scripts/skins/registry.mjs` |
| --- | --- |
| Cream | `materials.paper.document` → `--jn-sc-paper-document` |
| Amber | `materials.paper.memo` → `--jn-sc-paper-memo` |
| Parchment | `materials.paper.target` → `--jn-sc-paper-target` |
| Default / serif / handwritten / display fonts | Material font roles `body` / `formal` / `hand` / `display` |

`skinToCssVars` emits `--jn-skin-paper-token`, `--jn-note-font`, `--jn-note-rotation`, `--jn-skin-torn`, `--jn-skin-bg`. Material font values are bounded keys `alegreya`, `caveat`, `fell`, `oldstandard`, mapped to bundled stacks in themes and `styles/fonts.css`. A new selectable paper/font requires registry/schema-compatible choices, controls/localization and tests; a new color for an existing paper usually needs only its material token.

Current paper borders, shadows, radius, body size (16px), line height (1.5), and profile centering are CSS decisions, not all exposed theme fields. `materials.paper.ink` / `inkFace` feed current ink variables. Legacy `styles.document.type.bodySize` is not the active control for this body text. Change heading, paragraph, portrait and caption selectors in the current `.jn-note-body` rules, preserving sanitization and parser semantics.

A skin background image is a low-opacity decorative wash on `.jn-card-paper::before` (opacity .16 in `journal.css`). A Markdown image is content and participates in layout/measurement. They are not interchangeable. Current paper grain is an additional `--jn-sc-grain` background layer with multiply blending in `stylized.css`; removing that layer is separate from removing decoration or board cork. This documents the existing grain, not an endorsement of it.

The paper alone is torn/clipped; the root stays available for pins, selection and resizing. `scripts/tear.mjs` generates deterministic tear geometry. Tilt derives from skin seed unless a finite card rotation overrides it: Cream 0°, Amber ±2°, Parchment ±1°.

Geometry lives in `system.cards[noteId]`: position, rotation, `sizing.mode`, manual `width`/`minHeight`, `autoSizeOrigin`, ports and anchors. Automatic dimensions are measured rather than saved as a second note type. `scripts/layouts/registry.mjs` defines Plain widths 220/300/380 and Profile 300/380; `scripts/sizing/measure.mjs` and `geometry.mjs` handle content measurement and anchored coordinates. Keep font metrics, padding, measurement fixture and painted dimensions consistent. Changing only visual paper height can leave the selection box and resize handle detached from it—the reported 0.10.0 geometry bug must not be hidden by documentation.

## Links: palette versus saved cosmetics versus geometry

`resolveLinkCosmetics` in `scripts/presentation.mjs` validates each saved look:

| Field | Supported values |
| --- | --- |
| `material` | `linen`, `double` |
| `thickness` | 0.8–5, default 2.6 |
| `slack` | 0–0.25, default .09 |
| `pattern` | `continuous`, `interrupted`, `alternating` |
| `ends` | `standard`, `loose` |
| `color`, `secondaryColor` | Empty default or `link1`, `link2`, `link3` |

`link-colors.mjs` maps three historical hex values to slot IDs; arbitrary new hex colors are not accepted as stored link colors. Change theme slot values to recolor existing slot-based links. `styles/stylized.css` maps default primary color to `--jn-sc-thread-1`, explicit slots to `--jn-link-1/2/3`, and default secondary to `--jn-sc-thread-accent`. This split matters: changing `links.colors.link1` does not change an unassigned/default thread that takes material dye 1.

The `links` theme block also emits older width, selectedWidth, dash, dimOpacity, shadow, arrowScale, pinRadius/fill/stroke, labelSize/color, halo/width and selectColor variables. Some are supporting decoration or legacy controls, not a replacement for per-link thickness/material. `direction` is retained in records but is not rendered as a semantic arrow. Do not promise arrows by changing `arrowScale`.

The actual layered thread recipe is `scripts/link-thread.mjs:threadLayerSpecs`; sag/path/tangent and loose ends also live there. `scripts/thread-render.mjs` creates classes, inline layer variables, primary/accent strokes and tails for both note and free-pin links. CSS under `.jn-thread-*`, `.jn-link-material-*`, `.jn-link-pattern-*`, `.jn-link-ends-*` paints those layers. Canvas owns groups, hit paths, masks, selection, animation and fast geometry updates. Change this shared renderer for a new visual treatment rather than patching only one kind of link.

Material `threads.shadow`, `fade` (0–1), and `fadeTime` (0–400ms) control thread material effects. Mask fade emits a luminance paint (`--jn-sc-thread-fade-fill`) as well as an opacity number; changing only one can break masking. Preserve hit areas, endpoint placement and zoom compensation when changing visible stroke width. Geometry/slack belongs in the path code, not a CSS translation that separates the thread from its pins.

New-thread defaults and built-in presets originate in `link-thread.mjs` and `link-pen.mjs`. `pen-store.mjs` maintains a client cache and debounced setting write. Editing the pen changes future links; it does not restyle every existing link. Extending the palette/material enums requires matching model fields, normalization, shared socket validation, private persistence, controls, renderer and tests.

## Working on appearance without losing the data model

Use `rg` to trace each field through normalization, CSS emission, DOM assignment and stylesheet consumption. Check both `journal.css` and later `stylized.css`; check inline styles before increasing selector specificity. Keep source Markdown, skin and geometry independent. Do not store derived colors or rendered HTML in note content to solve a stylesheet problem.

Relevant focused test files include `theme.test.mjs`, `scene-palette.test.mjs`, `paper-contrast.test.mjs`, `fonts.test.mjs`, `sizing.test.mjs`, `note-geometry.test.mjs`, `link-thread.test.mjs`, and `link-colors.test.mjs` under `tests/`. Use the applicable subset and syntax check for code changes. Pure normalization/DOM tests cannot certify physical alignment or visual quality. This documentation task was source-audited; no Foundry session was launched. Future changes to the 0.10.1 rendering contract must update this guide to match the code that actually lands.
