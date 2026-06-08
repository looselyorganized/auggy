const STORAGE_KEY = "auggy-theme";
const LEGACY_STORAGE_KEY = "auggy-admin-theme";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === "light" || legacy === "dark") return legacy;
  } catch {
    /* localStorage unavailable */
  }
  return preferredTheme();
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* localStorage unavailable */
  }
  apply(theme);
}

export function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

export function subscribeSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (!hasStoredTheme()) onChange();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

function hasStoredTheme(): boolean {
  try {
    const t = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return t === "light" || t === "dark";
  } catch {
    return false;
  }
}

function preferredTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
