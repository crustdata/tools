/** The optional AI analysis, offline: model choice, the request it sends, and dash clean-up. No real key is used. */

import { test } from "node:test";
process.env.DSA_NO_DOTENV = "1";
for (const k of ["ANTHROPIC_MODEL", "OPENAI_MODEL"]) delete process.env[k];
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPipeline } from "../src/pipeline.js";
import { mergeSpec, parseSentence } from "../src/thesis.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/seed-pipeline.json", import.meta.url), "utf8"));
const today = new Date("2026-10-21T12:00:00Z");
const deal = buildPipeline(fx.inputs, mergeSpec({ thesis: fx.thesis }, parseSentence(fx.thesis, today)), today).deals[0];

test("model choice: newest general model, small and special-purpose models skipped", async () => {
  const { chooseModel } = await import("../src/ai.js");
  assert.equal(chooseModel("anthropic", ["claude-haiku-9", "claude-sonnet-4-9", "claude-sonnet-4-10", "claude-opus-5"]), "claude-sonnet-4-10");
  assert.equal(chooseModel("openai", ["gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-4o"]), "gpt-5.2");
  assert.equal(chooseModel("openai", ["whisper-1"]), undefined);
});

test("analyse: Anthropic request carries the editable prompt and the memo's facts only", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  delete process.env.OPENAI_API_KEY;
  const sent: Array<{ url: string; body?: any; headers: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers });
    if (String(url).includes("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-10" }, { id: "claude-haiku-9" }], has_more: false }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Strong team \u2014 fast growth, 2024\u20132026." }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const { analyse } = await import("../src/ai.js");
    const r = await analyse(deal, "2026-10-21");
    assert.equal(r.model, "claude-sonnet-4-10");
    assert.equal(r.text, "Strong team, fast growth, 2024 to 2026.");
    const msg = sent.find(s => s.url.endsWith("/v1/messages"))!;
    assert.equal(msg.headers["x-api-key"], "sk-ant-test");
    assert.equal(msg.body.system, readFileSync(new URL("../prompts/memo-analysis.md", import.meta.url), "utf8"));
    assert.match(msg.body.messages[0].content, /"name":"Relaywise"/);
    assert.doesNotMatch(msg.body.messages[0].content, /contact_email|team@/);
  } finally {
    globalThis.fetch = real;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("analyse: a rejected key says so plainly", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "gpt-test";
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  try {
    const { analyse } = await import("../src/ai.js");
    await assert.rejects(analyse(deal, "2026-10-21"), /OpenAI key was not accepted/);
  } finally {
    globalThis.fetch = real;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  }
});

test("model choice ignores date suffixes and skips pro and preview models", async () => {
  const { chooseModel } = await import("../src/ai.js");
  assert.equal(chooseModel("anthropic", ["claude-sonnet-4-20250514", "claude-sonnet-4-5-20250929"]), "claude-sonnet-4-5-20250929");
  assert.equal(chooseModel("openai", ["gpt-5.1", "gpt-5-2025-08-07"]), "gpt-5.1");
  assert.equal(chooseModel("openai", ["gpt-5.2-pro", "gpt-5-chat-latest", "gpt-5.1"]), "gpt-5.1");
});
