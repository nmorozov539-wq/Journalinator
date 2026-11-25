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

export function noteImageSource(input) {
  const external = noteImageUrl(input);
  if (external) return external;
  // Preserve paths already saved with Foundry's file picker.
  const path = typeof input === "string" ? input.trim() : "";
  if (path && path.length <= 1000 && !/[:\\\u0000-\u001f\u007f]/.test(path) && !path.startsWith("//")) return path;
  return null;
}
