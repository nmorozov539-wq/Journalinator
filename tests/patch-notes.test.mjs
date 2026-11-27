import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareVersions, groupPatchNotes, latestPatchNoteId, parsePatchNotes
} from "../scripts/app/patch-notes.mjs";

const SAMPLE = `# Patch notes

Intro text.

## Unreleased — Newest dev note

- Newest bullet.

## 0.9.0 — Next series

- Next series bullet.

## 0.8.4 — Keep the note type

- Copy and paste keeps the type.

## 0.8.0 — Private canvases

- Private notes and trash.

## 0.7.9 — Too old

- Ignored.

## UI polish and fixes

- Unversioned section; ignored too.
`;

test("parsePatchNotes keeps Unreleased and versions from 0.8.0 upward", () => {
  const sections = parsePatchNotes(SAMPLE);
  assert.deepEqual(sections.map(section => section.id), [
    "unreleased", "v0.9.0", "v0.8.4", "v0.8.0"
  ]);
  assert.equal(sections[0].title, "Newest dev note");
  assert.equal(sections[2].title, "Keep the note type");
  assert.match(sections[3].markdown, /Private notes and trash/);
  assert.ok(!sections.some(section => /UI polish/.test(section.title)));
});

test("groupPatchNotes folds by minor series and orders newest first", () => {
  const { unreleased, series } = groupPatchNotes(parsePatchNotes(SAMPLE));
  assert.deepEqual(unreleased.map(section => section.id), ["unreleased"]);
  assert.deepEqual(series.map(group => group.series), ["0.9", "0.8"]);
  assert.deepEqual(series[1].versions.map(section => section.version), ["0.8.4", "0.8.0"]);
});

test("latestPatchNoteId prefers Unreleased, then the highest version", () => {
  const withUnreleased = parsePatchNotes(SAMPLE);
  assert.equal(latestPatchNoteId(withUnreleased), "unreleased");

  const released = parsePatchNotes(SAMPLE.replace(/## Unreleased[\s\S]*?(?=## 0\.9\.0)/, ""));
  assert.equal(latestPatchNoteId(released), "v0.9.0");
});

test("the module changelog covers every version from 0.8.0", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const sections = parsePatchNotes(changelog);
  const versions = sections.filter(section => section.version).map(section => section.version);
  assert.equal(latestPatchNoteId(sections), "v0.9.5");
  for (const expected of ["0.8.0", "0.8.1", "0.8.2", "0.8.3", "0.8.4",
    "0.9.0", "0.9.1", "0.9.2", "0.9.3", "0.9.4", "0.9.5"]) {
    assert.ok(versions.includes(expected), `missing ${expected}`);
  }
  assert.ok(versions.every(version => compareVersions(version, "0.8.0") >= 0));
  assert.ok(sections.every(section => section.markdown.length > 0));
});
