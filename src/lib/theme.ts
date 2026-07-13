export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

export function getThemePreference(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "dark";
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
}

export function applyTheme(preference: ThemePreference = getThemePreference()): void {
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

// Keeps a "system" preference live when the OS theme changes.
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
