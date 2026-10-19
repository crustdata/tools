import { test } from "node:test";
import assert from "node:assert/strict";
import { digestMessages, esc, jobChangeMessage } from "../src/slack.js";
import type { JobChange } from "../src/notification.js";

const change = (i: number, extra: Partial<JobChange> = {}): JobChange => ({
  id: `1:1:${i}`, kind: "new_company", watchId: 1, name: `Alexandra Featherstonehaugh-Montgomery ${i}`, profileUrl: `https://www.example.com/in/person-${i}`,
  previousTitle: "Senior Director of Global Revenue Operations and Enablement", previousCompany: "Contoso Cloud Infrastructure Holdings",
  newTitle: "Vice President of Worldwide Sales and Customer Success", newCompany: "Northwind Analytics International", raw: "{}", ...extra,
});

test("a busy digest is split into messages within Slack's limits, and counts what it left out exactly", () => {
  const changes = Array.from({ length: 1200 }, (_, i) => change(i));
  const parts = digestMessages(changes, "since Thu, 15 Oct 2026");
  assert.ok(parts.length > 1 && parts.length <= 20, `messages: ${parts.length}`);
  let bullets = 0;
  for (const { message } of parts) {
    const blocks = message.blocks as any[];
    assert.ok(blocks.length <= 50, `blocks: ${blocks.length}`);
    for (const b of blocks) if (b.type === "section") { assert.ok(b.text.text.length <= 3000); bullets += (b.text.text.match(/\n?• /g) ?? []).length; }
  }
  const footer = JSON.stringify((parts.at(-1)!.message.blocks as any[]).at(-1));
  const more = Number(/and (\d+) more/.exec(footer)?.[1] ?? 0);
  assert.equal(bullets + more, 1200);
  assert.equal(new Set(parts.flatMap(p => p.ids)).size, 1200, "every change is accounted for");
});

test("a small digest is one message", () => {
  assert.equal(digestMessages([change(1), change(2, { kind: "left_company", previousCompany: "Contoso" })], "today").length, 1);
});

test("profile text cannot ping a channel or plant a link", () => {
  const msg = jobChangeMessage(change(1, { name: "Eve|<!channel> <https://evil.example|click>" }));
  const text = JSON.stringify(msg);
  assert.doesNotMatch(text, /<!channel>/);
  assert.doesNotMatch(text, /<https:\/\/evil/);
  assert.equal(esc("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("each kind gets its own wording", () => {
  assert.match(jobChangeMessage(change(1)).text, /moved to Northwind/);
  assert.match(jobChangeMessage(change(1, { kind: "title_change", newCompany: "Acme" })).text, /new title at Acme/);
  assert.match(jobChangeMessage(change(1, { kind: "left_company", previousCompany: "Contoso" })).text, /left Contoso/);
  assert.match(jobChangeMessage(change(1, { kind: "added_role", newCompany: "TinyStartup" })).text, /added a role at TinyStartup/);
});

test("the owner is shown on the alert", () => {
  assert.match(JSON.stringify(jobChangeMessage(change(1, { owner: "sam@yourco.com" })).blocks), /Owner: sam@yourco.com/);
});

test("the email digest declares UTF-8 so arrows and accents render", async () => {
  const { digestHtml } = await import("../src/email.js");
  assert.match(digestHtml([change(1, { kind: "title_change" })], "today"), /<meta charset="utf-8">/);
});
