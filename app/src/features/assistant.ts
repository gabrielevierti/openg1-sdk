/**
 * The assistant and the translator, without anyone's cloud but yours.
 *
 * Both talk to any service that speaks the OpenAI chat-completions format
 * (most hosted models do, and so do local servers such as Ollama or LM
 * Studio). Nothing is preconfigured: you enter the address, key and model in
 * Settings, and the key stays in this phone's storage.
 *
 * Questions are typed or dictated with the phone's keyboard. The glasses'
 * microphone sends LC3 audio, which the SDK cannot decode yet, so "hold the
 * touch bar and speak" is not here.
 */
export interface AiConfig {
  endpoint: string;
  key: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function aiConfigured(config: AiConfig): boolean {
  return Boolean(config.endpoint.trim() && config.model.trim());
}

/** Accept a base address ("https://host/v1") or the full path. */
export function completionsUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export async function chat(config: AiConfig, messages: ChatMessage[], fetcher: typeof fetch = fetch): Promise<string> {
  if (!aiConfigured(config)) throw new Error("Set the AI service address and model in Settings first.");
  let response: Response;
  try {
    response = await fetcher(completionsUrl(config.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.3 }),
    });
  } catch {
    throw new Error("Could not reach the AI service. Check the address and that the phone is online.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("The AI service refused the key.");
  if (response.status === 404) throw new Error("The AI service has nothing at that address, or no model by that name.");
  if (response.status === 429) throw new Error("The AI service is rate-limiting you. Try again in a moment.");
  if (!response.ok) throw new Error(`The AI service answered ${response.status}.`);
  const data = await response.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("The AI service sent an empty answer.");
  return text.trim();
}

const GLASSES = "The answer is read on smart glasses with a small monochrome display: reply in plain text, no markdown, no lists, at most three short sentences unless asked for more.";

export function ask(config: AiConfig, history: ChatMessage[], question: string, fetcher?: typeof fetch): Promise<string> {
  return chat(config, [{ role: "system", content: `You are a concise assistant. ${GLASSES}` }, ...history.slice(-8), { role: "user", content: question }], fetcher);
}

export function translate(config: AiConfig, text: string, to: string, fetcher?: typeof fetch): Promise<string> {
  return chat(
    config,
    [
      { role: "system", content: `Translate the user's text into ${to}. Detect the source language yourself. Output only the translation, with no notes and no quotation marks.` },
      { role: "user", content: text },
    ],
    fetcher,
  );
}

/** A short stable key for a text, to remember where its reading stopped. */
export function textKey(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
