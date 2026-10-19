// The AI key path: provider detection, and rendering the model's markdown brief. No network calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { providerFor } from "../lib/ai";
import { AiText } from "../components/Sections";

test("AI keys are told apart by prefix", () => {
  assert.equal(providerFor("sk-ant-api03-abc"), "anthropic");
  assert.equal(providerFor("sk-proj-abc"), "openai");
  assert.throws(() => providerFor("hello"));
});

test("the AI brief renders paragraphs, bold labels and lists", () => {
  const html = renderToStaticMarkup(createElement(AiText, {
    text: "Vercel is a developer platform with 1,014 people.\n\n**What changed lately**\n- Headcount up 29% in 12 months\n- Raised a $300M Series F\n\n**Three questions to ask**\n1. Where is the money going?\n2. Which team grows next?\n3. Why did postings fall?",
  }));
  assert.match(html, /<strong[^>]*>What changed lately<\/strong>/);
  assert.equal((html.match(/<li/g) ?? []).length, 5);
  assert.match(html, /<ol/);
  assert.match(html, /<ul/);
});
