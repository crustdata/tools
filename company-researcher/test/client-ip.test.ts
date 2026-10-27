import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../lib/http";

const req = (h: Record<string, string>) => new Request("https://example.com/api/research", { headers: h });

test("the CloudFront viewer address is trusted only with the shared origin secret", () => {
  process.env.ORIGIN_SECRET = "a-long-shared-secret-value";
  assert.equal(clientIp(req({ "x-origin-secret": "a-long-shared-secret-value", "cloudfront-viewer-address": "203.0.113.9:4431", "x-real-ip": "130.176.1.1" })), "203.0.113.9");
  assert.equal(clientIp(req({ "x-origin-secret": "wrong", "cloudfront-viewer-address": "203.0.113.9:4431", "x-real-ip": "130.176.1.1" })), "130.176.1.1");
  delete process.env.ORIGIN_SECRET;
  assert.equal(clientIp(req({ "cloudfront-viewer-address": "203.0.113.9:4431", "x-real-ip": "130.176.1.1" })), "130.176.1.1");
});
