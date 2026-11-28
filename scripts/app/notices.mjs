/**
 * Read-only format and connection notices.
 *
 * These are deliberately non-destructive: no migration, reset or write is offered. All copy is
 * localized through `t()`; T12 owns the final EN/RU strings.
 */

function escapeHTML(value) {
  const escape = globalThis.foundry?.utils?.escapeHTML;
  if (typeof escape === "function") return String(escape(value));
  return String(value ?? "").replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

/** True when a `notesStore.getSchemaStatus()` result means the shared journal is read-only. */
export function isIncompatibleStatus(status) {
  return status?.current !== true;
}

/** Exact read-only notice for older/corrupt shared note data. Close is the only action. */
export function incompatibleNoticeHTML(t) {
  return `<div class="jn-format-notice" role="alert" data-notice="incompatible">
    <p class="jn-format-notice-title">${escapeHTML(t("JN.Notices.Incompatible"))}</p>
    <p class="jn-format-notice-hint">${escapeHTML(t("JN.Notices.IncompatibleHint"))}</p>
    <div class="jn-format-notice-actions">
      <button type="button" class="jn-format-notice-close" data-notice-close="app">${escapeHTML(t("JN.Common.Close"))}</button>
    </div>
  </div>`;
}

/** Read-only notice for an older/corrupt private workspace. Never migrates or deletes it. */
export function privateIncompatibleNoticeHTML(t) {
  return `<div class="jn-format-notice jn-private-format-notice" role="alert" data-notice="private-incompatible">
    <p class="jn-format-notice-title">${escapeHTML(t("JN.Notices.PrivateIncompatible"))}</p>
    <p class="jn-format-notice-hint">${escapeHTML(t("JN.Notices.PrivateIncompatibleHint"))}</p>
    <div class="jn-format-notice-actions">
      <button type="button" class="jn-format-notice-close" data-notice-close="private">${escapeHTML(t("JN.Common.Close"))}</button>
    </div>
  </div>`;
}

/** Exact no-GM banner; navigation and read-only canvas controls stay available. */
export function noGmBannerHTML(t) {
  return `<div class="journalinator-offline-banner" role="status">${escapeHTML(t("JN.Notices.NoGM"))}</div>`;
}
