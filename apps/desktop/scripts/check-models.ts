/**
 * ponytail: assert-based check for model catalog merge rules.
 * Run: pnpm check
 */
import { CATALOG, resolveModel } from "../src/lib/models.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const catalogHit = resolveModel("openai", "gpt-5.6-luna");
assert(catalogHit.label === "GPT-5.6 Luna", "catalog label should win");
assert(catalogHit.webSearch === true, "catalog capabilities should win");

assert(
  CATALOG.some((m) => m.id === "gpt-6-astra"),
  "openai latest present",
);
assert(
  CATALOG.some((m) => m.id === "claude-fable-5-1"),
  "anthropic latest present",
);
assert(
  CATALOG.some((m) => m.id === "gemini-3.8-flash"),
  "google latest present",
);

const custom = resolveModel("openai", "gpt-experimental", [
  {
    id: "gpt-experimental",
    label: "my exp",
    provider: "openai",
    vision: true,
    webSearch: false,
  },
]);
assert(custom.label === "my exp", "custom label used when not in catalog");

const afterShip = resolveModel("openai", "gpt-5.6-luna", [
  {
    id: "gpt-5.6-luna",
    label: "old custom",
    provider: "openai",
    vision: false,
    webSearch: false,
  },
]);
assert(afterShip.label === "GPT-5.6 Luna", "catalog overrides matching custom id");
assert(afterShip.vision === true, "catalog vision wins on id match");

console.log("check-models: ok");
