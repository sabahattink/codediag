const DEFAULT_REDIRECT = '/projects';

/** Only same-site paths, so a crafted login link cannot send users elsewhere. */
export function safeRedirect(
  to: FormDataEntryValue | string | null | undefined,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) {
    return fallback;
  }
  return to;
}
