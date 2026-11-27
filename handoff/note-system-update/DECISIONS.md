# Agreed decisions and design defaults

## Owner decisions

| ID | Decision |
| --- | --- |
| D01 | One note is one Markdown body with a permanent ID. No separate user-facing name, label, title, caption, portrait/image field, or paragraph blocks. Foundry's required page name is a hidden stable ID-based value. |
| D02 | Only a nonempty H1 on physical line 1 is the title. Later H1s render as H2 without rewriting the source. Duplicate and empty titles are allowed. |
| D03 | A heading followed by `---` gets an underline. Elsewhere `---` is a divider. Plain text followed by `---` must never become a setext heading. Code and comments do not trigger note syntax. |
| D04 | No user-facing wikilinks. `[[text]]` remains literal. Saving body text never creates, removes, or reconciles threads. |
| D05 | Two layouts: Plain and Profile. Plain derives scrap/document presentation from absence/presence of a title. Profile is explicitly selected, never inferred or auto-promoted. |
| D06 | Profile requires first-line title, optional divider, then image, optional H2 caption, then body. Blank lines between slots are allowed. Invalid structure renders as Plain while Profile remains selected. Editor-only hints explain the first problem. |
| D07 | Blank, Document and Profile are creation templates, not stored types. Blank and Document use Plain layout. No placeholder prose or empty sections shown to readers. |
| D08 | Skins control appearance only: paper, font, torn edge, seeded tilt, decorative background. Layout changes never reorder, remove, or rewrite body text. |
| D09 | Edit directly on the card. Title is styled with a faint visible `#`. Provide Title, Divider, Portrait tools and an Add title ghost for a selected/edited untitled note. |
| D10 | Autosave. Other viewers watch the rendered text update as the single editor types. No simultaneous multi-author text editing and no manual Save workflow. |
| D11 | One whole-note editing lock. Other users cannot mutate the note while locked. Connected, open editors retain locks even when idle. Close releases; disconnected sessions expire; GM can force-unlock. Revoked sessions cannot continue saving or broadcasting. |
| D12 | Cards widen live up to a cap, then grow vertically, and shrink with deletion. No deferred-width rule. Manual resize overrides Auto. Main pin stays fixed during automatic size changes. |
| D13 | Remove the complete GM secret/vault system: encryption, secret notes/paragraphs/links/labels, hints, keys, passphrases, GM/player secret-view switches. No annotation replacement. Ordinary GM administration remains. |
| D14 | Keep private canvases, ownership/admin rules, transfers, clipboard, publishing and trash. They are UI-private, not encrypted. Do not broaden access because the vault is gone. |
| D15 | Remove Location semantics and Foundry actor linking entirely. Actor linking was an unwanted experimental feature. |
| D16 | Clean break: no migration or backward compatibility work. No need to carry the party's few old notes forward. Do not silently reset actual world data on module startup. |
| D17 | Keep a shared-canvas activity recording foundation, but no statistics screens or rankings. No private writing in shared activity. |
| D18 | Keep note recovery history and local browser recovery drafts. Recovery never silently overwrites newer work. |
| D19 | Preserve board background choices, pin mechanics, thread appearance/rendering, free-pin selection/transfer behavior and route-note operations. Only the integration needed for new bodies, sizing and lock enforcement changes. |
| D20 | Owner authorizes detailed interface design in this package. OpenCode must implement the specified interface, not invent it. Coordinator-reviewed sub-agent tasks commit after approval. |

## Authorized design defaults

These values were selected while preparing the handover under D20. They are implementation requirements unless a demonstrated conflict is reported, not another round of open questions.

- Title recognition is strict physical line 1, with up to three leading spaces and normal Markdown ATX syntax; `#` or `# ` alone is an empty editing affordance, not a title. Leading blank/comment lines prevent a title. Ignore H1s nested in quotes/lists for title recognition. Only top-level headings participate in Profile slots.
- Blank lines are tolerated between Profile slots, not before the required first-line title. A standalone image paragraph accepts inline Markdown or resolved reference-image syntax. Raw HTML images render safely as ordinary content but do not qualify as a Profile portrait. Comments between slots are ignored; visible intervening text breaks Profile.
- Plain dimensions start at 220 board pixels; automatic steps are 220, 300 and 380. Valid Profile starts at 300 and caps at 380. The sizing algorithm is in IMPLEMENTATION. Manual sizes use width plus a minimum height, never crop content.
- Text previews are coalesced to at most one per 150 ms per editor. Autosave after 700 ms without input and at least every 3 seconds while continuously dirty. No-op saves do not write or increment activity. Local recovery persistence is coalesced to 150 ms and flushed at lifecycle boundaries.
- Heartbeat every 5 seconds while the editor is open, including while unfocused. Lease expiry after 30 seconds without heartbeat; no typing-idle timeout. A returning throttled tab must revalidate its lease before sending changes.
- Paper presets: Cream, Amber and Parchment. Template defaults: Blank → Amber; Document → Cream; Profile → Parchment. Torn edges default off; font default follows skin. Reuse existing bundled fonts/assets. No external font downloads or new image-generation dependency.
- Search/result display: derived title, otherwise first 70 characters of plain visible text, otherwise `Empty note` or `Image note`. Duplicate labels are allowed; a secondary excerpt, creator and date distinguish them. Internal IDs remain hidden in ordinary UI.
- History: newest 20 distinct snapshots per note, session-start checkpoint, periodic checkpoint at most once per 60 seconds of saved changes, session-end checkpoint, and mandatory pre-restore checkpoint. Private history stays in its workspace.
- Shared activity uses UTC date buckets and Unicode code points for character counts. No historical text in activity records. Large paste means at least 500 inserted code points in one paste event. Template events are counted independently.
- Private note editing uses the same UI and body semantics, with no shared preview broadcasts. Retain the existing private write permission path; protect multiple tabs with workspace revision checks and local edit-session coordination. Do not add a GM requirement to owner-only editing merely to reuse shared locks.

## Removed versus preserved

Remove note `kind`, old style-as-type, `label`, `nameGenerated`, `heading`/`targetHeading`, content `image`, `formerNames`, `forceExtended`, `pictureLayout`, `blocks`, paragraph attribution and contribution-ranking fields from the new note schema. Move the useful visual settings into a skin object. Keep author/created timestamps as metadata, permanent IDs, thread relationships, attachment/pin configuration, deletion/trash state and layout geometry.

`label` on a thread and board text labels are unrelated to the removed note label. `kind` on an anchor is unrelated to Location. Do not remove these by global search-and-replace. Background images remain skin decoration, not Markdown portraits. No need to remove cryptographic libraries used for unrelated platform functions; remove the module's secret subsystem and its imports/settings.

Old data is unsupported, not automatically deleted. On incompatible data, show the non-destructive message specified in UI-SPEC and stop note writes. A disposable fresh world is the default test target. Reset of the party's data remains an owner action outside this task.
