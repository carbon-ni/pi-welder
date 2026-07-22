export interface EditRecoveryDecision {
  decision: "repair" | "abstain";
  confidence: number;
  repairs: Array<{ oldText: string }>;
}

interface CallInput {
  model: string;
  prompt: string;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function callEditRecoveryModel(input: CallInput): Promise<EditRecoveryDecision> {
  const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json", "X-Title": "Pi Welder" },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      stream: false,
      messages: [{ role: "user", content: input.prompt }],
      response_format: { type: "json_object" },
    }),
    signal: input.signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 300)}`);

  const envelope = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = envelope.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenRouter response did not include assistant text.");
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Model recovery response was not valid JSON."); }
  return validateDecision(value);
}

function validateDecision(value: unknown): EditRecoveryDecision {
  if (!value || typeof value !== "object") throw new Error("Model recovery response was not valid JSON object.");
  const input = value as Record<string, unknown>;
  if (input.decision !== "repair" && input.decision !== "abstain") throw new Error("Model recovery decision is invalid.");
  if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1) throw new Error("Model recovery confidence is invalid.");
  if (!Array.isArray(input.repairs)) throw new Error("Model recovery repairs are invalid.");
  const repairs = input.repairs.map((repair) => {
    if (!repair || typeof repair !== "object") throw new Error("Model recovery repair is invalid.");
    const item = repair as Record<string, unknown>;
    if (typeof item.oldText !== "string" || !item.oldText) throw new Error("Model recovery repair is invalid.");
    return { oldText: item.oldText };
  });
  return { decision: input.decision, confidence: input.confidence, repairs };
}
