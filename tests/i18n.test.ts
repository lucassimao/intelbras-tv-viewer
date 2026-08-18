import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import { en } from "../src/i18n/locales/en";
import { ptBR } from "../src/i18n/locales/pt-BR";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("localization", () => {
  it("keeps the Brazilian Portuguese and English catalogs in parity", () => {
    expect(leafKeys(ptBR).sort()).toEqual(leafKeys(en).sort());
  });

  it("defaults to Brazilian Portuguese and falls back safely", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(i18n.t("app.documentTitle")).toBe("Monitor residencial");
    await i18n.changeLanguage("en");
    expect(i18n.t("app.documentTitle")).toBe("Home camera monitor");
    await i18n.changeLanguage("pt-BR");
    expect(i18n.t("camera.locked")).toBe("Bloqueada");
    expect(i18n.t("missing.key")).toBe("missing.key");
  });
});
