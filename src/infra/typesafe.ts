export interface JevSelectionRequest {
  candidates: readonly { ordinal: number; window: string }[];
  requestedEditText: string;
}

export interface JevSelectionResponse {
  choice: number | null;
  confidence?: number;
  model?: string;
}

export interface JevClientError extends Error {
  kind: "rate-limited" | "transport" | "malformed";
}

export interface JevClient {
  choose(request: JevSelectionRequest, signal: AbortSignal): Promise<JevSelectionResponse>;
}

interface TypeSafeClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  /** Question/instructions override for offline eval tuning. Defaults preserve live behavior exactly. */
  prompt?: JevPromptSpec;
}

/** The question/instructions surface a probe may tune. Schema keys stay fixed. */
export interface JevPromptSpec {
  instructions: string;
  abstainCriteria: string;
  candidateCriteria: (ordinal: number) => string;
}

/** Frozen default — the live shadow pipeline depends on this byte-for-byte. */
export const DEFAULT_JEV_PROMPT: JevPromptSpec = {
  instructions: "Which candidate is the intended exact edit target? Choose abstain when the evidence is insufficient.",
  abstainCriteria: "No candidate is sufficiently supported; do not select one.",
  candidateCriteria: (ordinal) => `Candidate ${ordinal}`,
};

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Reads the response body only up to a fixed byte cap; overflow fails closed. */
async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw transport("TypeSafe response body is unavailable");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => {});
      throw transport("TypeSafe response exceeded the byte cap");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function transport(message: string): JevClientError {
  const error = new Error(message) as JevClientError;
  error.kind = "transport";
  return error;
}

/** Thin injected adapter. Deterministic edit code depends only on JevClient. */
export function createTypeSafeJevClient(options: TypeSafeClientOptions): JevClient {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
  const model = options.model ?? "jev-latest";
  const prompt = options.prompt ?? DEFAULT_JEV_PROMPT;

  return {
    async choose(input, signal): Promise<JevSelectionResponse> {
      const criteria: Record<string, string> = {
        ...Object.fromEntries(input.candidates.map((candidate) => [`candidate-${candidate.ordinal}`, prompt.candidateCriteria(candidate.ordinal)])),
        abstain: prompt.abstainCriteria,
      };
      const body = {
        state: {
          candidates: input.candidates,
          requestedEditText: input.requestedEditText,
        },
        model,
        questions: {
          selection: {
            type: "choice",
            instructions: prompt.instructions,
            criteria,
          },
        },
      };

      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
          // Never follow redirects: the key must not be replayed elsewhere.
          redirect: "error",
        });
      } catch (cause) {
        const error = new Error("TypeSafe request failed", { cause }) as JevClientError;
        error.kind = "transport";
        throw error;
      }
      if (response.status === 429 || response.status === 529) {
        const error = new Error("TypeSafe request was rate limited") as JevClientError;
        error.kind = "rate-limited";
        throw error;
      }
      if (!response.ok) throw transport(`TypeSafe request failed with status ${response.status}`);

      let raw: unknown;
      try {
        raw = JSON.parse(await readBoundedBody(response));
      } catch (cause) {
        if ((cause as Partial<JevClientError>)?.kind === "transport") throw cause;
        const error = new Error("TypeSafe response was not JSON", { cause }) as JevClientError;
        error.kind = "malformed";
        throw error;
      }
      return parseSelectionResponse(raw);
    },
  };
}

function parseSelectionResponse(raw: unknown): JevSelectionResponse {
  if (!raw || typeof raw !== "object") throw malformed();
  const root = raw as Record<string, unknown>;
  const answers = root.answers;
  if (!answers || typeof answers !== "object") throw malformed();
  const answer = (answers as Record<string, unknown>).selection;
  if (!answer || typeof answer !== "object") throw malformed();
  const value = answer as Record<string, unknown>;
  if (value.type !== "choice" || typeof value.choice !== "string") throw malformed();
  let choice: number | null;
  if (value.choice === "abstain") choice = null;
  else {
    const match = /^candidate-(\d+)$/.exec(value.choice);
    if (!match) throw malformed();
    choice = Number(match[1]);
    if (!Number.isSafeInteger(choice) || choice < 1) throw malformed();
  }
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw malformed();
  return {
    choice,
    ...(confidence === undefined ? {} : { confidence }),
    model: typeof root.model === "string" ? root.model : undefined,
  };
}

function malformed(): JevClientError {
  const error = new Error("TypeSafe response was malformed") as JevClientError;
  error.kind = "malformed";
  return error;
}
