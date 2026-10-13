// Supabase project the app talks to. The publishable key is meant to be
// public: it only lets the browser call the oh_* functions, which check
// every request themselves.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? '';
export const HAS_CLOUD = Boolean(SUPABASE_URL && SUPABASE_KEY);
