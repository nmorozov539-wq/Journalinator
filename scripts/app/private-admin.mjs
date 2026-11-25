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

/** Content-blind manager: the list contains workspace names only. */
export async function openPrivateAdmin() {
  const pages = privateStore.pages();
  const rows = pages.map(page => `<div class="jn-private-admin-row" data-id="${page.id}">
    <span class="jn-private-admin-name">${esc(page.name)}</span>
    <span class="jn-private-admin-actions">
      <button type="button" data-act="rename" title="${t("JN.Private.Rename")}">${t("JN.Private.Rename")}</button>
      <button type="button" data-act="assign" title="${t("JN.Private.Assign")}">${t("JN.Private.Assign")}</button>
      <button type="button" data-act="detach" title="${t("JN.Private.Detach")}">${t("JN.Private.Detach")}</button>
      <button type="button" data-act="archive" title="${t("JN.Private.Archive")}">${t("JN.Private.Archive")}</button>
      <button type="button" data-act="delete" title="${t("JN.Common.Delete")}">${t("JN.Common.Delete")}</button>
    </span>
  </div>`).join("") || `<p class="journalinator-empty">${t("JN.Private.AdminEmpty")}</p>`;

  await DialogV2.wait({
    window: { title: t("JN.Private.AdminTitle") },
    content: `<p class="journalinator-meta">${t("JN.Private.AdminHint")}</p>
      <div class="jn-private-admin-list">${rows}</div>
      <button type="button" class="jn-private-admin-create">${t("JN.Private.CreateForPlayer")}</button>`,
    buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
    rejectClose: false,
    render: (event, dialog) => {
      const run = async (job, close = true) => {
        try {
          await job();
          if (close) dialog.close();
        } catch (err) {
          ui.notifications?.warn(err.message);
        }
      };
      dialog.element.querySelectorAll(".jn-private-admin-row").forEach(row => {
        const page = privateStore.findById(row.dataset.id);
        if (!page) return;
        row.querySelectorAll("[data-act]").forEach(button => {
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
            } else if (action === "archive") {
              run(() => privateStore.archive(page));
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
      });

      dialog.element.querySelector(".jn-private-admin-create")?.addEventListener("click", () => {
        run(async () => {
          const userId = await pickUser(t("JN.Private.CreateForPlayer"));
          const user = game.users.get(userId);
          if (user) await privateStore.createFor(user);
        });
      });
    }
  });
}
