// The addresses of a published site. No dependencies, so the browser bundle and the snippet share them.

/** The public page's path, and the base of its agent files. */
export const publishedPath = (host: string) => `/s/${host}`;
export const publishedUrl = (origin: string, host: string) => `${origin}${publishedPath(host)}`;
export const badgeUrl = (origin: string, host: string) => `${origin}/badge/${host}.svg`;
