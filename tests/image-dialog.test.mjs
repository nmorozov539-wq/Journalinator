import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of ["document", "window", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
  globalThis[key] = dom.window[key];
}

const {
  buildImageDialog,
  buildImageMarkdown,
  validateImageSource
} = await import("../scripts/app/image-dialog.mjs");
const { parseDocument } = await import("../scripts/document/parse.mjs");

const STRINGS = {
  "JN.Editor.ReplacePortrait": "Replace portrait",
  "JN.Editor.InsertPortrait": "Insert portrait",
  "JN.Editor.ImageURLOrPath": "Image URL or file path",
  "JN.Editor.AltText": "Alt text",
  "JN.Editor.Browse": "Browse…",
  "JN.Editor.ImageEmptyReason": "Enter an image URL or file path.",
  "JN.Editor.ImageUnsafeReason": "Use an HTTP(S) URL or a Foundry file path.",
  "JN.Editor.Insert": "Insert",
  "JN.Editor.Replace": "Replace",
  "JN.Common.Cancel": "Cancel"
};
const t = (key, data) => {
  const value = STRINGS[key] ?? key;
  if (!data) return value;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? ""));
};

function clearBody() {
  document.body.replaceChildren();
}

function setValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("empty and unsafe sources disable insert with an inline generic reason", async () => {
  clearBody();
  const dialog = buildImageDialog({ t });
  document.body.appendChild(dialog.element);
  assert.equal(dialog.insertButton.disabled, true);
  assert.equal(dialog.reasonElement.hidden, false);
  assert.equal(dialog.reasonElement.textContent, "Enter an image URL or file path.");

  const unsafe = [
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//evil.example/x.png",
    "file:///etc/passwd"
  ];
  for (const value of unsafe) {
    setValue(dialog.urlInput, value);
    assert.equal(dialog.insertButton.disabled, true, value);
    assert.equal(dialog.reasonElement.textContent, "Use an HTTP(S) URL or a Foundry file path.");
    // The unsafe source is never echoed into the dialog's markup.
    assert.equal(dialog.element.textContent.includes(value), false);
  }

  setValue(dialog.urlInput, "https://example.com/portrait.png");
  assert.equal(dialog.insertButton.disabled, false);
  assert.equal(dialog.reasonElement.hidden, true);

  setValue(dialog.urlInput, "worlds/campaign/portraits/mara.webp");
  assert.equal(dialog.insertButton.disabled, false);
  dialog.close();
  await dialog.promise;
});

test("validateImageSource accepts HTTP(S) and Foundry paths", () => {
  assert.deepEqual(validateImageSource(" https://example.com/a.png "), {
    ok: true,
    src: "https://example.com/a.png",
    reason: null
  });
  assert.equal(validateImageSource("worlds/w/a.webp").src, "worlds/w/a.webp");
  assert.equal(validateImageSource("").reason, "JN.Editor.ImageEmptyReason");
  assert.equal(validateImageSource("javascript:alert(1)").reason, "JN.Editor.ImageUnsafeReason");
});

test("Markdown escaping round-trips through the parser", async () => {
  clearBody();
  const src = "worlds/w/my portrait (1).webp";
  const alt = "A [bracket] \\ alt";
  const dialog = buildImageDialog({ t, initialSrc: src, initialAlt: alt });
  document.body.appendChild(dialog.element);
  assert.equal(dialog.insertButton.disabled, false);
  dialog.insertButton.click();
  const result = await dialog.promise;

  assert.equal(result.src, src);
  assert.equal(result.alt, alt);
  assert.match(result.markdown, /^!\[A \\\[bracket\\\] \\\\ alt\]\(<worlds\/w\/my portrait \(1\)\.webp>\)$/);

  const parsed = parseDocument(result.markdown);
  assert.deepEqual(parsed.imageSources, [src]);
  assert.equal(parsed.blocks[0].type, "image");
  assert.equal(parsed.blocks[0].alt, alt);
});

test("buildImageMarkdown escapes backslash and parentheses", () => {
  const markdown = buildImageMarkdown({ src: "worlds/w/a(b).webp", alt: "x" });
  assert.equal(markdown, "![x](<worlds/w/a(b).webp>)");
  const parsed = parseDocument(markdown);
  assert.deepEqual(parsed.imageSources, ["worlds/w/a(b).webp"]);
});

test("Browse uses the Foundry file picker and revalidates the field", () => {
  clearBody();
  let options = null;
  globalThis.foundry = {
    applications: {
      apps: {
        FilePicker: class {
          constructor(config) { options = config; }
          browse() { options.callback("worlds/w/picked.webp"); }
        }
      }
    }
  };
  const dialog = buildImageDialog({ t });
  document.body.appendChild(dialog.element);
  assert.equal(dialog.insertButton.disabled, true);
  dialog.browseButton.click();
  assert.equal(options.type, "image");
  assert.equal(dialog.urlInput.value, "worlds/w/picked.webp");
  assert.equal(dialog.insertButton.disabled, false);
  dialog.close();
  return dialog.promise;
});

test("Cancel and Escape resolve null without producing Markdown", async () => {
  clearBody();
  const first = buildImageDialog({ t, initialSrc: "worlds/w/old.webp" });
  document.body.appendChild(first.element);
  first.cancelButton.click();
  assert.equal(await first.promise, null);
  assert.equal(first.element.isConnected, false);

  const second = buildImageDialog({ t, initialSrc: "worlds/w/old.webp" });
  document.body.appendChild(second.element);
  second.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(await second.promise, null);
});

test("Replace mode uses Replace portrait title and action", () => {
  clearBody();
  const dialog = buildImageDialog({ t, mode: "replace", initialSrc: "worlds/w/old.webp" });
  document.body.appendChild(dialog.element);
  assert.equal(dialog.element.querySelector(".jn-image-dialog-title").textContent, "Replace portrait");
  assert.equal(dialog.insertButton.textContent, "Replace");
  dialog.close();
  return dialog.promise;
});
