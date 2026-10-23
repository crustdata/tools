import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPost, keySentence, loadKeywords, posterLabel, postItems, watchKeywords, type PostRecord } from "../src/posts.js";

const kw = loadKeywords();
const company = { actor_type: "company", name: "Northwind", crustdata_entity_id: 1 };
const ceo = { actor_type: "person", name: "Jane Doe", title: "CEO", company_name: "Northwind" };
const ae = { actor_type: "person", name: "Sam Roe", title: "Account Executive", company_name: "Northwind" };
let n = 0;
const post = (text: string, extra: Partial<PostRecord> = {}): PostRecord => ({ text, share_url: `https://social.example/posts/example-${++n}`, date_posted: "2026-10-22T09:00:00Z", actor: company, ...extra });
const kind = (text: string, actor: PostRecord["actor"] = company, extra: Partial<PostRecord> = {}) => classifyPost(post(text, { actor, ...extra }), kw, "Northwind");

test("keyword file loads and feeds the watch filter with specific words only", () => {
  const words = watchKeywords(kw);
  assert.ok(words.includes("introducing"));
  assert.ok(words.includes("M ARR"));
  for (const broad of ["customers", "users", "revenue", "funding", "partnership", "webinar"]) assert.ok(!words.includes(broad), broad);
  // The watcher matches plain text anywhere ("ARR" would match "carry"): every word is a phrase or 6+ characters.
  for (const w of words) assert.ok(w.length >= 6 || w.includes(" "), `"${w}" is too short for a substring match`);
});

test("money posts must be the competitor's own round or acquisition", () => {
  assert.equal(kind("Congrats to our customer Acme on closing their $20M Series A!"), null);
  assert.equal(kind("So proud of our customer Fabrikam, who just raised a $300M Series D.", ae), null);
  assert.equal(kind("This quarter we acquired 500 new customers across Europe."), "number", "a growth figure, not M&A");
  assert.equal(kind("Our partner Zapier is launching a new integration today."), "launch", "a partner integration on their own page is news about them, and it is not reported as money");
  assert.equal(kind("Northwind has raised $40M to expand into Europe."), "money");
  assert.equal(kind("Today we acquired Tailspin Toys to add forecasting to Northwind."), "money");
  assert.equal(kind("We have raised the bar on CRM speed with the new release.", ceo), null, "no funding word, no round");
  assert.equal(kind("Thrilled to share our Series B: $40M to build the next Northwind.", ceo), "money");
  assert.equal(kind("Big news: Northwind was acquired by Contoso today.", ceo), "money");
});

test("announcements are kept and classified", () => {
  assert.equal(kind("Introducing Northwind Agents, now available to every Pro customer."), "launch");
  assert.equal(kind("We just crossed $10M ARR with 1,200 customers.", ceo), "number");
  assert.equal(kind("Thrilled to share we raised a $40M Series B led by Example Ventures.", ceo), "money");
  assert.equal(kind("Welcome aboard Hooli, our newest customer in the enterprise segment.", ae), "customer");
  assert.equal(kind("Northwind crossed 10,000 users this month, a milestone for the team.", ae), "number");
});

test("announcements with a question, a hiring line or an event after them are still kept", () => {
  assert.equal(kind("Introducing Northwind Agents, now available to everyone. Want to see it in action?"), "launch");
  assert.equal(kind("We raised our Series B to build faster. We're hiring across engineering!", ceo), "money");
  assert.equal(kind("Welcome aboard Globex, our newest customer! Join us at our webinar next week."), "customer");
});

test("opinions, promos, questions, reshares, personal news and tiny posts are dropped", () => {
  assert.equal(kind("Join us for a webinar on Thursday: launching your first agent in 20 minutes. Register below."), null);
  assert.equal(kind("Should CRMs have launched agents earlier? Curious what revenue leaders think.", ceo), null);
  assert.equal(kind("Introducing Northwind Agents, now available.", company, { reposter: { name: "Someone" } }), null);
  assert.equal(kind("Introducing Northwind Agents, now available.", company, { post_type: "repost" }), null);
  assert.equal(kind("Introducing!"), null);
  assert.equal(kind("I just launched my personal newsletter about sales craft. Subscribe below.", ae), null);
  assert.equal(kind("Introducing our new office dog, Biscuit. He is a very good boy.", ae), null);
  assert.equal(kind("Our customers are the best. Happy Thanksgiving from all of us.", company), null);
  assert.equal(kind("Raised $5k for charity at the team run this weekend.", company), null);
});

test("a staff post about someone else's news is not this competitor's announcement", () => {
  assert.equal(kind("Contoso just raised a Series B. Here's why our customers don't care.", ae), null);
  assert.equal(kind("Congrats to Contoso, who just launched a new feature today.", ae), null);
});

test("keySentence quotes the sentence that carries the figure", () => {
  const text = "Big week for us. We just crossed $10M ARR, with 1,200 customers on Northwind. Thank you to the team.";
  assert.equal(keySentence(text, kw), "We just crossed $10M ARR, with 1,200 customers on Northwind.");
});

test("posterLabel shows titles, and names only when asked", () => {
  assert.equal(posterLabel(post("x", { actor: ceo })), "CEO");
  assert.equal(posterLabel(post("x", { actor: ceo }), true), "CEO (Jane Doe)");
  assert.equal(posterLabel(post("x", { actor: { actor_type: "person", name: "Jo" } })), "An employee");
  assert.equal(posterLabel(post("x")), "Company page");
});

test("postItems: newest first, deduplicated, title only, source link and date", () => {
  const items = postItems([
    post("Introducing Northwind Agents, now available to every Pro customer.", { date_posted: "2026-10-22T09:00:00Z", share_url: "https://social.example/posts/example-1" }),
    post("We just crossed $10M ARR with 1,200 customers.", { actor: ceo, date_posted: "2026-10-23T09:00:00Z", share_url: "https://social.example/posts/example-2" }),
    post("We just crossed $10M ARR with 1,200 customers.", { actor: ceo, date_posted: "2026-10-23T09:00:00Z", share_url: "https://social.example/posts/example-2" }),
  ], kw, { companyName: "Northwind" });
  assert.equal(items.length, 2);
  assert.match(items[0].text, /^CEO posted: "We just crossed \$10M ARR/);
  assert.ok(!items[0].text.includes("Jane Doe"), "no names by default");
  assert.equal(items[0].date, "2026-10-23");
  assert.equal(items[0].url, "https://social.example/posts/example-2");
  assert.match(items[1].text, /^Company page posted:/);
  assert.match(postItems([post("We just crossed $10M ARR.", { actor: ceo })], kw, { companyName: "Northwind", showNames: true })[0].text, /^CEO \(Jane Doe\) posted/);
});

test("postItems caps the list", () => {
  const many = Array.from({ length: 12 }, (_, i) => post(`Introducing feature number ${i}, now available to everyone today.`));
  assert.equal(postItems(many, kw, { max: 6 }).length, 6);
});

test("real-world announcements that mention customers, partners or investors are kept", () => {
  assert.equal(kind("Introducing Northwind Agents for our customers, now available."), "launch");
  assert.equal(kind("We raised $40M from our investors at Example Ventures to build faster.", ceo), "money");
  assert.equal(kind("Thanks to our partners at Example Ventures, we've raised $40M.", ceo), "money");
  assert.equal(kind("Thank you to our customers: we crossed 10,000 users this month."), "number");
  assert.equal(kind("Excited to announce our $40M Series B round led by Example Ventures.", ceo), "money");
  assert.equal(kind("Northwind raises $40M Series B to expand in Europe."), "money");
  assert.equal(kind("Northwind, the AI CRM, has raised $40M."), "money");
  assert.equal(kind("Northwind Inc. has raised a $12M seed round."), "money");
  assert.equal(kind("Big news: we've been acquired by Contoso.", ceo), "money");
  assert.equal(kind("Today we are thrilled to announce our acquisition of Tailspin."), "money");
  assert.equal(kind("Please welcome our new customers Hooli and Globex aboard."), "customer");
  assert.equal(kind("Two new case studies are live: see how Hooli uses Northwind."), "customer");
  assert.equal(kind("Our new integrations with Slack and Zoom are now live."), "launch");
});

test("a round followed by another sentence is still the competitor's own money; a year closed with ARR is a number", () => {
  assert.equal(kind("Northwind just raised a $40M Series A. Join us at our launch party next week to celebrate, register here."), "money");
  assert.equal(kind("We closed our Series B. We're hiring across every team, come build with us.", ceo), "money");
  assert.equal(kind("We closed a $12M seed round led by Example Ventures.", ceo), "money");
  assert.equal(kind("We closed 2025 with 1,200 customers and $10M ARR.", ceo), "number");
  assert.equal(kind("Northwind is now available to every team in the U.S. and Canada today."), "launch");
});
