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
}

/** Thin injected adapter. Deterministic edit code depends only on JevClient. */
export function createTypeSafeJevClient(options: TypeSafeClientOptions): JevClient {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
  const model = options.model ?? "jev-latest";

  return {
    async choose(input, signal): Promise<JevSelectionResponse> {
      const criteria: Record<string, string> = {
        ...Object.fromEntries(input.candidates.map((candidate) => [`candidate-${candidate.ordinal}`, `Candidate ${candidate.ordinal}`])),
        abstain: "No candidate is sufficiently supported; do not select one.",
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
            instructions: "Which candidate is the intended exact edit target? Choose abstain when the evidence is insufficient.",
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
        });
      } catch (cause) {
        const error = new Error("TypeSafe request failed", { cause }) as JevClientError;
        error.kind = "transport";
        throw error;
      }
      if (response.status === 429) {
        const error = new Error("TypeSafe request was rate limited") as JevClientError;
        error.kind = "rate-limited";
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`TypeSafe request failed with status ${response.status}`) as JevClientError;
        error.kind = "transport";
        throw error;
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (cause) {
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
