/**
 * ponytail: assert-based check for model catalog merge rules.
 * Run: npx tsx scripts/check-models.ts
 */
import { CATALOG, resolveModel } from "../src/lib/models.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const catalogHit = resolveModel("openai", "gpt-4o-mini");
assert(catalogHit.label === "GPT-4o mini", "catalog label should win");
assert(catalogHit.webSearch === true, "catalog capabilities should win");

const custom = resolveModel("openai", "gpt-6-astra", [
  {
    id: "gpt-6-astra",
    label: "my astra",
    provider: "openai",
    vision: true,
    webSearch: false,
  },
]);
assert(custom.label === "my astra", "custom label used when not in catalog");

// Simulate catalog catching up with same id — catalog wins.
const afterShip = resolveModel(
  "openai",
  "gpt-4o-mini",
  [
    {
      id: "gpt-4o-mini",
      label: "old custom",
      provider: "openai",
      vision: false,
      webSearch: false,
    },
  ],
);
assert(afterShip.label === "GPT-4o mini", "catalog overrides matching custom id");
assert(afterShip.vision === true, "catalog vision wins on id match");

assert(CATALOG.length >= 3, "catalog should have models");

console.log("check-models: ok");
