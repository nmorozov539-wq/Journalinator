# Canvas documentation pointer

The stylized canvas is part of the v0.9.6 runtime baseline. Its earlier experimental branch instructions are retired.

Current development instructions are in [handoff/note-system-update/README.md](handoff/note-system-update/README.md). For packaged releases without the handover folder, use README and CHANGELOG. This short file remains because the current packaging script includes this filename; it is not an alternative specification.

The note-system rewrite preserves board backgrounds, pin mechanics and thread rendering while changing note content, editing and sizing. Do not restore the old encrypted-vault, paragraph-lock, Location, actor-linking or migration requirements from historical code comments.
