import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { ptBR } from "./locales/pt-BR";

export const LANGUAGE_STORAGE_KEY = "intelbras-viewer-language";
export type SupportedLanguage = "pt-BR" | "en";

function storedLanguage(): SupportedLanguage {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "pt-BR";
  } catch {
    return "pt-BR";
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    "pt-BR": { translation: ptBR },
    en: { translation: en },
  },
  lng: storedLanguage(),
  fallbackLng: "pt-BR",
  supportedLngs: ["pt-BR", "en"],
  interpolation: { escapeValue: false },
  initAsync: false,
});

export default i18n;
