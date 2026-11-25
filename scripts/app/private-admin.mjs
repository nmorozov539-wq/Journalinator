import { privateStore } from "../store/private-store.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

async function pickUser(title) {
  const options = [...game.users]
    .map(user => `<option value="${user.id}">${esc(user.name)}</option>`)
    .join("");
  if (!options) return null;
  return DialogV2.wait({
    window: { title },
    content: `<select name="userId">${options}</select>`,
    buttons: [
      {
        action: "ok",
        label: t("JN.Common.OK"),
        default: true,
        callback: (event, button) => button.form.elements.userId.value
      },
      { action: "cancel", label: t("JN.Common.Close") }
    ],
    rejectClose: false
  });
}

function linkedUserId(page) {
  return privateStore.flags(page).pendingOwnerUserId || privateStore.ownerId(page) || null;
}

export async function openPrivateAdmin() {
  await DialogV2.wait({
    window: { title: t("JN.Private.AdminTitle") },
    position: { width: 780, height: 560 },
    content: `<div class="jn-pa-root"></div>`,
    buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
    rejectClose: false,
    render: (event, dialog) => {
      const dialogElement = dialog.element;
      const root = dialogElement.querySelector(".jn-pa-root");
      const menu = document.createElement("div");
      menu.className = "jn-pa-menu";
      menu.hidden = true;
      root.appendChild(menu);

      const closeMenu = () => { menu.hidden = true; menu.innerHTML = ""; };
      const run = async job => {
        try {
          await job();
          closeMenu();
          render();
        } catch (err) {
          ui.notifications?.warn(err.message);
        }
      };

      const showMenu = (page, clientX, clientY) => {
        const rect = root.getBoundingClientRect();
        const target = linkedUserId(page);
        menu.innerHTML = `
          <button type="button" data-act="rename">${t("JN.Private.Rename")}</button>
          <button type="button" data-act="assign">${t("JN.Private.Assign")}</button>
          ${target ? `<button type="button" data-act="detach">${t("JN.Private.Detach")}</button>` : ""}
          <button type="button" data-act="delete">${t("JN.Common.Delete")}</button>`;
        menu.style.left = `${Math.max(4, clientX - rect.left)}px`;
        menu.style.top = `${Math.max(4, clientY - rect.top)}px`;
        menu.hidden = false;
        menu.querySelectorAll("button").forEach(button => {
          button.addEventListener("click", () => {
            const action = button.dataset.act;
            if (action === "rename") {
              run(async () => {
                const name = await DialogV2.prompt({
                  window: { title: t("JN.Private.Rename") },
                  content: `<input type="text" name="value" autofocus value="${esc(page.name)}" maxlength="100">`,
                  ok: { label: t("JN.Common.Save"), callback: (ev, ok) => ok.form.elements.value.value.trim() },
                  rejectClose: false
                });
                if (name) await privateStore.rename(page, name);
              });
            } else if (action === "assign") {
              run(async () => {
                const userId = await pickUser(t("JN.Private.AssignTitle"));
                if (userId) await privateStore.assign(page, userId);
              });
            } else if (action === "detach") {
              run(() => privateStore.detach(page));
            } else if (action === "delete") {
              run(async () => {
                const confirmed = await DialogV2.confirm({
                  window: { title: t("JN.Common.Delete") },
                  content: `<p>${t("JN.Private.DeleteWorkspaceConfirm", { name: esc(page.name) })}</p>`
                });
                if (confirmed) await privateStore.remove(page);
              });
            }
          });
        });
      };

      const drawLinks = () => {
        const columns = root.querySelector(".jn-pa-columns");
        const svg = root.querySelector(".jn-pa-links");
        if (!columns || !svg) return;
        const base = columns.getBoundingClientRect();
        svg.setAttribute("width", String(columns.scrollWidth));
        svg.setAttribute("height", String(columns.scrollHeight));
        const paths = [];
        for (const page of privateStore.pages()) {
          const userId = linkedUserId(page);
          if (!userId) continue;
          const player = root.querySelector(`.jn-pa-player[data-user-id="${CSS.escape(userId)}"]`);
          const journal = root.querySelector(`.jn-pa-journal[data-id="${CSS.escape(page.id)}"]`);
          if (!player || !journal) continue;
          const from = player.getBoundingClientRect();
          const to = journal.getBoundingClientRect();
          const x1 = from.right - base.left + columns.scrollLeft;
          const y1 = from.top - base.top + from.height / 2 + columns.scrollTop;
          const x2 = to.left - base.left + columns.scrollLeft;
          const y2 = to.top - base.top + to.height / 2 + columns.scrollTop;
          const user = game.users.get(userId);
          const color = user?.color ?? "#8d8d97";
          const dashed = privateStore.flags(page).state === "pending" ? ` stroke-dasharray="4 5"` : "";
          paths.push(`<path d="M${x1} ${y1} C${x1 + 24} ${y1} ${x2 - 24} ${y2} ${x2} ${y2}"
            fill="none" stroke="${esc(color)}" stroke-width="1.5"${dashed}/>`);
        }
        svg.innerHTML = paths.join("");
      };

      function render() {
        const users = [...game.users];
        const pages = privateStore.pages();
        const userIndex = new Map(users.map((user, index) => [user.id, index]));
        const linked = new Set(pages.map(linkedUserId).filter(Boolean));
        const sortedPages = pages.slice().sort((a, b) => {
          const ai = userIndex.get(linkedUserId(a));
          const bi = userIndex.get(linkedUserId(b));
          if (ai == null && bi == null) return a.name.localeCompare(b.name);
          if (ai == null) return 1;
          if (bi == null) return -1;
          return ai - bi || a.name.localeCompare(b.name);
        });
        let divider = false;
        const journals = sortedPages.map(page => {
          const userId = linkedUserId(page);
          if (!userId && !divider) {
            divider = true;
            return `<div class="jn-pa-divider">${t("JN.Private.Unassigned")}</div>${journalRow(page)}`;
          }
          return journalRow(page);
        }).join("");

        root.innerHTML = `
          <p class="journalinator-meta">${t("JN.Private.AdminHint")}</p>
          <div class="jn-pa-columns">
            <svg class="jn-pa-links" aria-hidden="true"></svg>
            <div class="jn-pa-column jn-pa-players">
              <div class="jn-pa-heading">${t("JN.Private.Players")}</div>
              ${users.map(user => `<div class="jn-pa-row jn-pa-player${linked.has(user.id) ? "" : " jn-pa-empty"}"
                data-user-id="${user.id}">
                <span class="jn-pa-color" style="background:${esc(user.color ?? "#8d8d97")}"></span>
                <span class="jn-pa-name">${esc(user.name)}</span>
                ${linked.has(user.id) ? "" : `<small>${t("JN.Private.NoJournal")}</small>`}
              </div>`).join("")}
            </div>
            <div class="jn-pa-column jn-pa-journals">
              <div class="jn-pa-heading">${t("JN.Private.Journals")}</div>
              ${journals || `<p class="journalinator-empty">${t("JN.Private.AdminEmpty")}</p>`}
            </div>
          </div>
          <div class="jn-pa-footer">
            <button type="button" class="jn-private-admin-create">${t("JN.Private.CreateForPlayer")}</button>
          </div>`;
        root.appendChild(menu);
        bind();
        requestAnimationFrame(drawLinks);
      }

      function journalRow(page) {
        return `<div class="jn-pa-row jn-pa-journal" data-id="${page.id}" title="${esc(page.name)}">
          <i class="fa-solid fa-lock" aria-hidden="true"></i>
          <span class="jn-pa-name">${esc(page.name)}</span>
          <button type="button" class="jn-pa-menu-button" aria-label="${t("JN.Private.JournalMenu")}">
            <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>
        </div>`;
      }

      function bind() {
        root.querySelector(".jn-private-admin-create")?.addEventListener("click", () => {
          run(async () => {
            const userId = await pickUser(t("JN.Private.CreateForPlayer"));
            const user = game.users.get(userId);
            if (user) await privateStore.createFor(user);
          });
        });
        root.querySelectorAll(".jn-pa-journal").forEach(row => {
          const page = privateStore.findById(row.dataset.id);
          if (!page) return;
          row.addEventListener("contextmenu", event => {
            event.preventDefault();
            showMenu(page, event.clientX, event.clientY);
          });
          row.querySelector(".jn-pa-menu-button")?.addEventListener("click", event => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            showMenu(page, rect.left, rect.bottom);
          });
        });
      }

      const onPointerDown = event => {
        if (!menu.hidden && !menu.contains(event.target)) closeMenu();
      };
      dialogElement.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("close", () => {
        dialogElement.removeEventListener("pointerdown", onPointerDown);
      });
      render();
    }
  });
}
