/**
 * TASK-0041 — workflow security invariants.
 *
 * These parse the workflow files and assert structural properties, so a change
 * that reintroduces untrusted interpolation into a shell body fails here rather
 * than shipping. The parser is validated by its own coverage assertions, which
 * keeps this from degrading into a test that silently matches nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extracts `run:` bodies from a workflow. Handles both inline values and block
 * scalars, which is what these workflows use.
 */
export function runBodies(source) {
  const lines = source.split("\n");
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const [, indent, inline] = match;
    if (inline !== "" && inline !== "|" && inline !== ">") {
      bodies.push({ line: index + 1, body: inline });
      continue;
    }
    const block = [];
    const blockIndent = indent.length + 2;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() !== "" && line.search(/\S/) < blockIndent) break;
      block.push(line.slice(blockIndent));
      index = cursor;
    }
    bodies.push({ line: index + 1, body: block.join("\n") });
  }
  return bodies;
}

/** Every `${{ … }}` expression in a workflow, with where it appears. */
export function workflowExpressions(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\$\{\{[^}]*\}\}/g)) found.push({ line: index + 1, text: match[0], context: line.trim() });
  });
  return found;
}

test("the parser really finds the workflow shell bodies", async () => {
  const release = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

  const releaseRuns = runBodies(release);
  assert.ok(releaseRuns.length >= 5, `expected several release run bodies, found ${releaseRuns.length}`);
  assert.ok(runBodies(ci).length >= 3, "expected several CI run bodies");
  assert.ok(releaseRuns.some(({ body }) => body.includes("release-publish.mjs")), "the publish body is parsed");
  assert.ok(releaseRuns.some(({ body }) => body.includes("npm pack")), "the pack body is parsed");
  assert.ok(workflowExpressions(release).length >= 4, "expressions are detected at all");
});

test("no workflow interpolates an expression inside a shell body", async () => {
  for (const name of ["release.yml", "ci.yml"]) {
    const source = await readFile(path.join(root, ".github", "workflows", name), "utf8");
    for (const { line, body } of runBodies(source)) {
      assert.equal(
        /\$\{\{/.test(body),
        false,
        `${name}:${line} interpolates an expression inside run; pass it through env instead`,
      );
    }
  }
});

test("release event values reach scripts only through the environment", async () => {
  const source = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const expressions = workflowExpressions(source);

  const eventValues = expressions.filter(({ text }) => text.includes("github.event."));
  assert.ok(eventValues.length >= 2, "the release tag and name are used");
  for (const { text } of eventValues) {
    assert.match(text, /github\.event\.release\.(tag_name|name|prerelease)\s*\}\}$/, `unexpected release value ${text}`);
  }

  assert.match(source, /RELEASE_NAME: \$\{\{ github\.event\.release\.name \}\}/, "the release name is passed by env");
  assert.match(source, /test -n "\$RELEASE_NAME"/, "and tested as a shell variable");
  assert.equal(source.includes('test "${{ github.event.release.name }}"'), false, "no inline release name in a script");
});

test("publication is reachable only from a published release", async () => {
  const source = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(source, /on:\n\s+release:\n\s+types:\s*\[published\]/, "the trigger is release.published");
  assert.match(source, /if: needs\.quality-gate\.result == 'success'/, "publish depends on the gate");
  assert.match(source, /id-token: write/, "OIDC is granted for provenance");
  assert.match(source, /contents: write/, "release assets can be attached");
  assert.equal(/npm publish/.test(source), false, "publishing goes through the tested script, not inline npm");
});
