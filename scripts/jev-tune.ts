#!/usr/bin/env node
/**
 * TASK-0026 — run the Jev prompt/schema tuning probe, one variant at a time,
 * over the frozen synthetic probe fixtures (strong/weak/genuine tiers).
 *
 * Usage (from the pi-welder extension directory):
 *
 *   TYPESAFE_API_KEY=... node --experimental-strip-types scripts/jev-tune.ts probe \
 *     [--variant <baseline|v1-ambiguity-aware|v2-context-first>] [--out <dir>]
 *
 * Requires --execute to run (approval gate): real Jev API calls happen only
 * when the flag is passed AND TYPESAFE_API_KEY is non-blank. Sequential,
 * 2s timeout, zero retries, synthetic payloads only. Direction evidence only.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createTypeSafeJevClient } from "../src/infra/typesafe.ts";
import {
  BASELINE_VARIANT,
  TUNE_VARIANTS,
  decideRecommendation,
  renderTuneJson,
  renderTuneMarkdown,
  runTuneVariant,
  type JevVariant,
  type TuneReport,
  type VariantResult,
} from "../src/bench/jev-tune.ts";

interface Args {
  command: string;
  execute: boolean;
  variant?: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "probe",
    execute: false,
    out: path.join(".tmp", "jev-tune"),
  };
  for (let index = 1; index < argv.length; index++) {
    switch (argv[index]) {
      case "--execute": args.execute = true; break;
      case "--variant": args.variant = requireValue(argv, index++); break;
      case "--out": args.out = requireValue(argv, index++); break;
      default: throw new Error(`Unknown flag ${argv[index]}`);
    }
  }
  return args;
}

function requireValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Flag ${argv[index]} requires a value`);
  return value;
}

async function commandProbe(args: Args): Promise<void> {
  if (!args.execute) throw new Error("Real API probe requires --execute (approval gate).");
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("--execute requires TYPESAFE_API_KEY");

  const requested = TUNE_VARIANTS.find((variant) => variant.id === args.variant);
  if (args.variant !== undefined && !requested) {
    throw new Error(`Unknown variant ${args.variant} (use: baseline, ${TUNE_VARIANTS.map((variant) => variant.id).join(", ")})`);
  }
  const variants: JevVariant[] = [BASELINE_VARIANT, ...(args.variant ? [requested!] : [...TUNE_VARIANTS])];

  const results: VariantResult[] = [];
  for (const variant of variants) {
    const client = createTypeSafeJevClient({ apiKey, prompt: variant.prompt });
    results.push(await runTuneVariant({ variant, client }));
  }

  const report: TuneReport = {
    label: "direction evidence only",
    baseline: results[0]!,
    variants: results.slice(1),
    recommendation: decideRecommendation(results),
  };

  await fs.mkdir(args.out, { recursive: true });
  const markdown = renderTuneMarkdown(report);
  await fs.writeFile(path.join(args.out, "report.md"), markdown);
  await fs.writeFile(path.join(args.out, "report.json"), renderTuneJson(report));
  process.stdout.write(markdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "probe") await commandProbe(args);
else throw new Error(`Unknown command ${args.command} (use: probe)`);
