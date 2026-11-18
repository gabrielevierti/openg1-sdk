import assert from "node:assert/strict";
import { test } from "node:test";
import { aiConfigured, ask, completionsUrl, textKey, translate } from "../src/features/assistant.ts";

const config = { endpoint: "https://ai.example/v1/", key: "sk-test", model: "small" };

test("the endpoint may be a base address or the full path", () => {
  assert.equal(completionsUrl("https://ai.example/v1/"), "https://ai.example/v1/chat/completions");
  assert.equal(completionsUrl("http://localhost:11434/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
  assert.equal(aiConfigured({ endpoint: "", key: "", model: "x" }), false);
  assert.equal(aiConfigured({ endpoint: "http://localhost:1234/v1", key: "", model: "x" }), true, "a local server needs no key");
});

test("ask and translate send a chat request and return the text", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "  Sunny, 21 degrees.  " } }] }));
  }) as never;
  const history = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `old ${i}` }));
  assert.equal(await ask(config, history, "Weather?", fake), "Sunny, 21 degrees.");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(calls[0]!.url, "https://ai.example/v1/chat/completions");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.equal(body.model, "small");
  assert.equal(body.messages.length, 10, "system + last eight turns + the question");
  assert.equal(body.messages.at(-1).content, "Weather?");
  assert.match(body.messages[0].content, /smart glasses/);

  await translate(config, "Dov'è la stazione?", "English", fake);
  const second = JSON.parse(String(calls[1]!.init.body));
  assert.match(second.messages[0].content, /into English/);
  assert.equal(second.messages[1].content, "Dov'è la stazione?");
});

test("failures say what to fix", async () => {
  const status = (code: number) => (async () => new Response("{}", { status: code })) as never;
  await assert.rejects(ask({ endpoint: "", key: "", model: "" }, [], "x"), /in Settings first/);
  await assert.rejects(ask(config, [], "x", status(401)), /refused the key/);
  await assert.rejects(ask(config, [], "x", status(404)), /no model by that name/);
  await assert.rejects(ask(config, [], "x", status(429)), /rate-limiting/);
  await assert.rejects(ask(config, [], "x", status(200)), /empty answer/);
  await assert.rejects(ask(config, [], "x", (async () => { throw new TypeError("offline"); }) as never), /Could not reach/);
});

test("text keys are stable and distinguish texts", () => {
  assert.equal(textKey("abc"), textKey("abc"));
  assert.notEqual(textKey("abc"), textKey("abd"));
});
