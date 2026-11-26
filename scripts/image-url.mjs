/** Image links are loaded by the client, with no server-side download. */
export function noteImageUrl(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > 1000 || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.href.length > 1000) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The canonical stored value for a note image: an external http(s) URL, or a path inside
 * Foundry's data folder (what the FilePicker returns, e.g. "worlds/…/portrait.webp").
 *
 * Paths are deliberately conservative — no scheme, no backslashes, no protocol-relative
 * "//host" values and no control characters — so a stored value can only ever be an ordinary
 * relative asset path or a plain http(s) URL.
 */
export function noteImagePath(input) {
  const external = noteImageUrl(input);
  if (external) return external;
  const path = typeof input === "string" ? input.trim() : "";
  if (path && path.length <= 1000 && !/[:\\\u0000-\u001f\u007f]/.test(path) && !path.startsWith("//")) return path;
  return null;
}

/** Render-time alias: the same accepted values as {@link noteImagePath}. */
export const noteImageSource = noteImagePath;
