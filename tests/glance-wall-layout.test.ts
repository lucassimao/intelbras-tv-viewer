import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

describe("glance wall responsive layout contract", () => {
  it("keeps the wall balanced and cards image-stable on larger displays", () => {
    expect(styles).toContain("grid-template-columns: minmax(0, 1.45fr) minmax(420px, 0.95fr);");
    expect(styles).toContain("grid-template-columns: minmax(0, 1.4fr) minmax(560px, 0.9fr);");
    expect(styles).toContain(".glance-tile__media {");
    expect(styles).toContain("aspect-ratio: 16 / 9;");
  });

  it("stacks the live feed and wall without removing touch-sized pagination", () => {
    expect(styles).toContain("@media (max-width: 900px) {");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(styles).toContain(".glance-wall__pagination button,");
    expect(styles).toContain("min-height: 44px;");
  });
});
