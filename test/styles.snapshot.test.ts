import { describe, expect, it } from "vitest";
import { STYLE_IDS } from "../src/styles.js";
import { cli } from "./cli-helpers.js";

const fixtures = ["widget", "pyapp"] as const;

describe("CLI style snapshots", () => {
  it.each(
    fixtures.flatMap((fixture) =>
      STYLE_IDS.map((style) => [fixture, style] as const),
    ),
  )("%s with %s style", async (fixture, style) => {
    const repository =
      fixture === "widget"
        ? "https://github.com/acme/widget"
        : "https://github.com/someone/pyapp";
    const result = await cli(
      [repository, "--style", style, "--dry-run", "--provider", "fixture"],
      { fixture },
    );

    expect(result.code).toBe(0);
    await expect(result.out).toMatchFileSnapshot(
      `__snapshots__/${fixture}-${style}.md`,
    );
  });
});
