# Canvas documentation pointer

The stylized canvas is part of the runtime inherited from v0.9.6 and remains in the implemented note-system rewrite. Its earlier experimental branch instructions are retired.

Current development instructions and the task ledger are in [handoff/note-system-update/](handoff/note-system-update/README.md). For packaged releases without the handover folder, use README and CHANGELOG. This short file remains because the current packaging script includes this filename; it is not an alternative specification.

The implemented rewrite keeps board backgrounds, pin mechanics and thread rendering while replacing note content, editing and sizing. Do not restore the old encrypted-vault, paragraph-lock, Location, actor-linking or migration requirements from historical code comments.
