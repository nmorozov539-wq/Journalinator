import { renderMarkdown } from "../markdown.mjs";
import { t } from "../i18n.mjs";

const CHANGELOG_ROUTE = "modules/fvtt-journalinator/CHANGELOG.md";
const MIN_VERSION = "0.8.0";

const escapeHtml = text => {
  const escape = globalThis.foundry?.utils?.escapeHTML;
  return typeof escape === "function"
    ? escape(String(text ?? ""))
    : String(text ?? "").replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
};

function versionParts(value) {
  return String(value ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
}

/** Numeric semver-ish comparison; enough for the changelog's x.y.z headings. */
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function splitTitle(heading) {
  return heading
    .replace(/^(?:unreleased|\d+\.\d+\.\d+)\s*(?:[—–-]\s*)?/i, "")
    .trim();
}

/**
 * Parses the `##` sections of CHANGELOG.md into version entries. Headings before 0.8.0
 * and unversioned historical sections are ignored; `Unreleased` is kept as the newest entry.
 */
export function parsePatchNotes(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let current = null;
  let unreleasedCount = 0;

  const finish = () => {
    if (!current) return;
    const heading = current.heading.trim();
    const markdownBody = current.lines.join("\n").trim();
    if (/^unreleased\b/i.test(heading)) {
      const id = unreleasedCount ? `unreleased-${unreleasedCount + 1}` : "unreleased";
      unreleasedCount++;
      sections.push({
        id, unreleased: true, version: null, series: "unreleased",
        title: splitTitle(heading), markdown: markdownBody
      });
      return;
    }
    const match = /^(\d+\.\d+\.\d+)\b/.exec(heading);
    if (!match || compareVersions(match[1], MIN_VERSION) < 0) return;
    const version = match[1];
    sections.push({
      id: `v${version}`,
      unreleased: false,
      version,
      series: version.split(".").slice(0, 2).join("."),
      title: splitTitle(heading),
      markdown: markdownBody
    });
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      finish();
      current = { heading: match[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  finish();
  return sections;
}

/** Unreleased entries first, then descending minor series with descending patch versions. */
export function groupPatchNotes(sections) {
  const groups = new Map();
  for (const section of sections) {
    if (section.unreleased) continue;
    if (!groups.has(section.series)) groups.set(section.series, []);
    groups.get(section.series).push(section);
  }
  return {
    unreleased: sections.filter(section => section.unreleased),
    series: [...groups.entries()]
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([series, versions]) => ({
        series,
        versions: [...versions].sort((a, b) => compareVersions(b.version, a.version))
      }))
  };
}

/** The entry selected when the panel opens: Unreleased, else the highest released version. */
export function latestPatchNoteId(sections) {
  const unreleased = sections.find(section => section.unreleased);
  if (unreleased) return unreleased.id;
  return [...sections]
    .filter(section => section.version)
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.id ?? null;
}

/** Fetches the module's changelog through Foundry's route helper. */
export async function fetchPatchNotes(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const route = globalThis.foundry?.utils?.getRoute?.(CHANGELOG_ROUTE) ?? CHANGELOG_ROUTE;
  const response = await fetchImpl(route, { cache: "no-cache" });
  if (!response?.ok) throw new Error(`Patch notes request failed (${response?.status ?? "no response"})`);
  return parsePatchNotes(await response.text());
}

/** A self-contained canvas overlay: bottom-left button, foldable version list, one reader. */
export default class PatchNotesPanel {
  constructor({ load = fetchPatchNotes } = {}) {
    this.load = load;
    this.sections = [];
    this.selectedId = null;
    this.loading = null;

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "jn-patch-notes-button";
    this.button.setAttribute("aria-expanded", "false");
    this.button.innerHTML = `<i class="fa-solid fa-scroll" aria-hidden="true"></i>
      <span>${escapeHtml(t("JN.PatchNotes.Button"))}</span>`;
    this.button.title = t("JN.PatchNotes.Button");
    this.button.setAttribute("aria-label", t("JN.PatchNotes.Button"));

    this.root = document.createElement("div");
    this.root.className = "jn-patch-notes";
    this.root.hidden = true;
    this.root.innerHTML = `
      <section class="jn-patch-notes-dialog" role="dialog" aria-modal="true"
        aria-label="${escapeHtml(t("JN.PatchNotes.Title"))}">
        <header class="jn-patch-notes-header">
          <h2>${escapeHtml(t("JN.PatchNotes.Title"))}</h2>
          <button type="button" class="jn-patch-notes-close"
            title="${escapeHtml(t("JN.PatchNotes.Close"))}"
            aria-label="${escapeHtml(t("JN.PatchNotes.Close"))}">&#10005;</button>
        </header>
        <div class="jn-patch-notes-body">
          <nav class="jn-patch-notes-nav" aria-label="${escapeHtml(t("JN.PatchNotes.Versions"))}"></nav>
          <div class="jn-patch-notes-reader" tabindex="0"></div>
        </div>
      </section>`;
    this.dialog = this.root.querySelector(".jn-patch-notes-dialog");
    this.nav = this.root.querySelector(".jn-patch-notes-nav");
    this.reader = this.root.querySelector(".jn-patch-notes-reader");
    this.closeButton = this.root.querySelector(".jn-patch-notes-close");

    this.button.addEventListener("click", () => this.open());
    this.closeButton.addEventListener("click", () => this.close());
    this.root.addEventListener("click", event => {
      if (event.target === this.root) this.close();
    });
    this.root.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.root.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
  }

  appendTo(parent) {
    parent.append(this.button, this.root);
  }

  async open() {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.closeButton.focus({ preventScroll: true });
    await this.reload();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.button.focus({ preventScroll: true });
  }

  async reload() {
    if (this.loading) return this.loading;
    this.reader.innerHTML = `<p class="jn-patch-notes-status">${escapeHtml(t("JN.PatchNotes.Loading"))}</p>`;
    this.loading = Promise.resolve()
      .then(() => this.load())
      .then(sections => {
        this.sections = Array.isArray(sections) ? sections : [];
        if (!this.sections.length) throw new Error("patch notes are empty");
        this.#renderNav();
        this.select(latestPatchNoteId(this.sections));
      })
      .catch(err => {
        console.error("Journalinator: could not load patch notes", err);
        this.reader.innerHTML = `<p class="jn-patch-notes-error">${escapeHtml(t("JN.PatchNotes.Unavailable"))}</p>`;
      })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  #renderNav() {
    const { unreleased, series } = groupPatchNotes(this.sections);
    const fragment = document.createDocumentFragment();
    for (const section of unreleased) fragment.append(this.#versionButton(section));

    const latestSeries = series[0]?.series;
    for (const group of series) {
      const details = document.createElement("details");
      details.className = "jn-patch-series";
      details.dataset.series = group.series;
      details.open = group.series === latestSeries;
      const summary = document.createElement("summary");
      summary.textContent = group.series;
      details.append(summary);
      const list = document.createElement("div");
      list.className = "jn-patch-series-list";
      for (const section of group.versions) list.append(this.#versionButton(section));
      details.append(list);
      fragment.append(details);
    }
    this.nav.replaceChildren(fragment);
  }

  #versionButton(section) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jn-patch-version";
    button.dataset.versionId = section.id;
    button.textContent = section.unreleased ? t("JN.PatchNotes.Unreleased") : section.version;
    button.addEventListener("click", () => this.select(section.id));
    return button;
  }

  select(id) {
    const section = this.sections.find(item => item.id === id);
    if (!section) return;
    this.selectedId = id;
    for (const button of this.nav.querySelectorAll(".jn-patch-version")) {
      const selected = button.dataset.versionId === id;
      button.classList.toggle("on", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    const details = [...this.nav.querySelectorAll("details.jn-patch-series")]
      .find(element => element.dataset.series === section.series);
    if (details) details.open = true;

    const versionLabel = section.unreleased ? t("JN.PatchNotes.Unreleased") : section.version;
    const title = section.title ? `${versionLabel} — ${section.title}` : versionLabel;
    const body = section.markdown ? renderMarkdown(section.markdown, { interactiveTasks: false }) : "";
    this.reader.innerHTML = `<h3>${escapeHtml(title)}</h3>
      <div class="jn-patch-notes-markdown">${body}</div>`;
    this.reader.scrollTop = 0;
  }
}
