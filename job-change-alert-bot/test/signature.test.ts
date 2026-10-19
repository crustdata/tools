import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { looksLikeEmail, normalizeProfileUrl, signatureProblem, verifySignature } from "../src/crustdata.js";

const secret = "test-api-key";
const body = '{"metadata":{"watch_id":1},"results":[]}';
const hex = (t: number, b = body) => createHmac("sha256", secret).update(`${t}.${b}`).digest("hex");
const now = 1_790_000_000;

test("accepts a valid, fresh signature, including when several v1 values are sent", () => {
  assert.equal(verifySignature(`t=${now},v1=${hex(now)}`, body, secret, 300, now), true);
  assert.equal(verifySignature(`t=${now}, v1=${"0".repeat(64)}, v1=${hex(now)}`, body, secret, 300, now), true);
});

test("rejects a tampered body, a wrong key, an old timestamp, bad hex and a missing header, with a reason", () => {
  assert.equal(verifySignature(`t=${now},v1=${hex(now)}`, body + " ", secret, 300, now), false);
  assert.equal(verifySignature(`t=${now},v1=${hex(now)}`, body, "other-key", 300, now), false);
  assert.match(signatureProblem(`t=${now - 301},v1=${hex(now - 301)}`, body, secret, 300, now)!, /window/);
  assert.match(signatureProblem(`t=${now * 1000},v1=${hex(now)}`, body, secret, 300, now)!, /milliseconds/);
  assert.equal(verifySignature(`t=${now},v1=${hex(now).slice(0, 62)}zz`, body, secret, 300, now), false);
  assert.match(signatureProblem(undefined, body, secret, 300, now)!, /missing/);
});

test("screens addresses the API would reject", () => {
  assert.equal(looksLikeEmail("jane@acme.com"), true);
  assert.equal(looksLikeEmail("not-an-email"), false);
  assert.equal(looksLikeEmail("someone@example.com"), false);
  assert.equal(looksLikeEmail("a@b.com; c@d.com"), false);
});

test("profile URLs are normalised so one person is never watched twice", () => {
  const a = normalizeProfileUrl("linkedin.com/in/Example-Sherry-Robinson/");
  const b = normalizeProfileUrl("https://www.linkedin.com/in/example-sherry-robinson?trk=x");
  assert.equal(a, b);
  assert.equal(a, "https://www.linkedin.com/in/example-sherry-robinson");
});

test("a watch's rule is recognised however Crustdata echoes it back", async () => {
  const { tracksJobChanges, JOB_CHANGE_TRACK } = await import("../src/crustdata.js");
  const echoed = { conditions: [...JOB_CHANGE_TRACK.conditions].reverse().map(c => ({ type: c.type, value: null, field: c.field })), op: "or" };
  assert.equal(tracksJobChanges({ id: 1, status: "active", entities: { professional_network_profile_urls: [] }, track: echoed }), true);
  const older = { op: "or", conditions: JOB_CHANGE_TRACK.conditions.slice(0, 2) };
  assert.equal(tracksJobChanges({ id: 1, status: "active", entities: { professional_network_profile_urls: [] }, track: older }), false);
});
