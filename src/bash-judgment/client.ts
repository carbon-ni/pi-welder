/**
 * TASK-0038 — dedicated TypeSafe client for bash classification.
 *
 * Single request, single fetch, zero retry, abort-aware. It builds its own body
 * (`questions.bash`, `answers.bash`) and never touches the edit-selection
 * client's request or response shape. The only content it sends is the
 * documented candidate string.
 */

import { BASH_JUDGMENT_PROMPT, type BashJudgmentClient, type BashJudgmentRequest } from "./contract.ts";

export interface BashJudgeClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const BASH_JUDGE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function createTypeSafeBashJudgeClient(options: BashJudgeClientOptions): BashJudgmentClient {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? BASH_JUDGE_ENDPOINT;
  const model = options.model ?? "jev-latest";
  const timeoutMs = options.timeoutMs ?? 8_000;

  return {
    async judge(input: BashJudgmentRequest, signal?: AbortSignal): Promise<unknown> {
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const response = await request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model,
          state: { attemptedTool: input.attemptedTool, key: input.key, candidate: input.candidate },
          questions: {
            bash: {
              type: "choice",
              instructions: BASH_JUDGMENT_PROMPT,
              criteria: {
                bash: "The value is meant to be executed as a shell command.",
                "not-bash": "The value is not a shell command (prose, path, identifier, code, or other).",
              },
            },
          },
        }),
        signal: combined,
        // Never follow a redirect: the key must not travel to another origin.
        redirect: "error",
      });
      if (!response.ok) throw new Error(`bash judge failed: ${response.status}`);
      return response.json();
    },
  };
}
