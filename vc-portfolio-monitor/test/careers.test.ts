import assert from "node:assert/strict";
import { test } from "node:test";
import { countRoles } from "../src/careers.js";

const page = (body: string) => `<html><head><title>Careers at Acme</title></head><body><h1>Work with us</h1><p>We are hiring across the company.</p>${body}</body></html>`;
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;

test("counts board links once per job, including escaped links inside scripts", () => {
  const html = page(`
    <a href="https://jobs.ashbyhq.com/acme/${uuid(1)}">A</a><a href="https://jobs.ashbyhq.com/acme/${uuid(1)}/application">A apply</a>
    <script>{"url":"https:\\/\\/jobs.ashbyhq.com\\/acme\\/${uuid(2)}"}</script>
    <a href="https://boards.greenhouse.io/acme/jobs/4012345">G</a><a href="https://acme.example/careers?gh_jid=4012345">G again</a>
    <a href="https://jobs.lever.co/acme/${uuid(3)}">L</a><a href="https://apply.workable.com/acme/j/AB12CD34EF/">W</a>`);
  assert.equal(countRoles(html, "https://acme.example/careers")?.roles, 5);
});

test("counts same-site job pages and skips section pages, other sites and files", () => {
  const html = page(`<a href="/careers/senior-backend-engineer">1</a><a href="/careers/account-executive/">2</a><a href="/careers/benefits">x</a>
    <a href="/careers/">x</a><a href="https://other.example/careers/spy">x</a><a href="/careers/logo.png">x</a><a href="/en/jobs/designer">3</a>
    <a href="/careers/${uuid(7)}">4</a><a href="https://jobs.ashbyhq.com/acme/${uuid(7)}">same as 4</a>`);
  assert.equal(countRoles(html, "https://acme.example/careers")?.roles, 4);
});

test("a page with no roles is 0; an empty page or a bot check is unreadable", () => {
  assert.equal(countRoles(page("<p>No open roles right now.</p>"), "https://acme.example/careers")?.roles, 0);
  assert.equal(countRoles("", "https://acme.example/careers"), undefined);
  assert.equal(countRoles("<html><body></body></html>", "https://acme.example/careers"), undefined);
  assert.equal(countRoles("<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site, please wait.</body></html>", "https://acme.example/careers"), undefined);
});

test("an Ashby board page is read from its embedded postings; board links are found on a careers page", async () => {
  const { boardLinks } = await import("../src/careers.js");
  const board = `<html><head><title>Jobs</title></head><body><script>window.__appData = {"jobBoard":{"jobPostings":[{"id":"${uuid(1)}","title":"Engineer","teamId":"x"},{"id":"${uuid(2)}","title":"Designer","teamId":"x"}]}};</script><p>Open roles at Acme, apply below.</p></body></html>`;
  assert.equal(countRoles(board, "https://jobs.ashbyhq.com/acme")?.roles, 2);
  assert.deepEqual(boardLinks(page(`<a href="https://jobs.ashbyhq.com/acme">All jobs</a><script src="https://jobs.ashbyhq.com/embed?x"></script><a href="https://jobs.lever.co/acme/${uuid(3)}">L</a>`)), ["https://jobs.ashbyhq.com/acme", "https://jobs.lever.co/acme"]);
});
