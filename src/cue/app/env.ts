// Build flags. VITE_CUE_PREVIEW=1 builds a single-file, demo-only copy for
// sandboxed previews, where GitHub cannot be reached and downloads are blocked.
export const PREVIEW = import.meta.env.VITE_CUE_PREVIEW === '1';
export const SITE_URL = 'https://g904338.github.io/tnda-office-hour/cue/';
