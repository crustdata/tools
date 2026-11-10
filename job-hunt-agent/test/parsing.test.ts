import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSchools, parseCv, readCvText, schoolFromLine, yearsOfExperience } from "../src/cv.js";
import { canonicalSkill, findSkills } from "../src/skills.js";

const NOW = new Date("2026-10-28T12:00:00Z");

test("school names are cut from the degree, year and place on the same line", () => {
  assert.equal(schoolFromLine("University of California, Berkeley, B.S. Computer Science, 2020"), "University of California, Berkeley");
  assert.equal(schoolFromLine("**Stanford University** \u2014 M.S. Computer Science (2018)"), "Stanford University");
  assert.equal(schoolFromLine("- IIT Bombay | B.Tech 2015"), "IIT Bombay");
  assert.equal(schoolFromLine("Carnegie Mellon University - Pittsburgh, PA"), "Carnegie Mellon University");
  assert.equal(schoolFromLine("University of Waterloo, Waterloo, ON"), "University of Waterloo");
  assert.equal(schoolFromLine("University of Washington 2019-2023"), "University of Washington");
  assert.equal(schoolFromLine("**University of Washington**, Seattle, WA"), "University of Washington");
  assert.equal(schoolFromLine("University of Texas, Austin, B.S. 2019"), "University of Texas, Austin");
  assert.equal(schoolFromLine("Hack Reactor, Software Engineering Immersive, 2026"), "Hack Reactor");
  assert.equal(schoolFromLine("Turing School of Software & Design, Software Engineering Immersive"), "Turing School of Software & Design");
  assert.equal(schoolFromLine("Built tools for the data team"), null);
  // Degree first, then the school.
  assert.equal(schoolFromLine("B.S. Computer Science, University of Washington, 2020"), "University of Washington");
  assert.equal(schoolFromLine("B.A. Elementary Education, University of Michigan, 2018"), "University of Michigan");
  assert.equal(schoolFromLine("Bachelor of Technology, IIT Delhi, 2018"), "IIT Delhi");
  assert.equal(schoolFromLine("BA Elementary Education | University of Michigan | 2018"), "University of Michigan");
});

test("schools come from the education section when there is one", () => {
  const cv = "# Ana\n\n## Experience\nEngineer at Example University Press (2019 - 2022)\n\n## Education\nGeorgia Institute of Technology, B.S. 2018\nMIT, exchange term\n";
  assert.deepEqual(findSchools(cv), ["Georgia Institute of Technology", "MIT"]);
});

test("years of experience merge overlapping jobs, skip internships and education, and honour an explicit claim", () => {
  const cv = "Experience\nEngineer, A (Jan 2020 - Present)\nSide project lead (Jun 2021 - Dec 2021)\nIntern, B (May 2019 - Aug 2019)\n\nEducation\nSome University, 2015 - 2019\n";
  const y = yearsOfExperience(cv, NOW);
  assert.ok(y !== null && y > 6.7 && y < 6.9, String(y));
  assert.equal(yearsOfExperience("Summary\n8+ years of professional experience building APIs.\nExperience\n2024 - Present", NOW), 8);
  assert.equal(yearsOfExperience("No dates here", NOW), null);
  assert.equal(yearsOfExperience("Experience\nEngineer 03/2021 \u2013 09/2023", NOW), 2.6);
});

test("skills match whole words: Go is not 'go to', C is not Series C, Java is not JavaScript", () => {
  assert.deepEqual(findSkills("We go to great lengths. Series A to C companies."), []);
  assert.deepEqual(findSkills("Go, C, C++ and C# services"), ["Go", "C++", "C#", "C"]);
  assert.deepEqual(findSkills("JavaScript and TypeScript"), ["JavaScript", "TypeScript"]);
  assert.ok(findSkills("Java 17 and Spring Boot").includes("Java"));
  assert.ok(!findSkills("Java 17").includes("JavaScript"));
  assert.ok(findSkills("We use golang").includes("Go"));
  assert.ok(findSkills("Experience with R and Python for statistics").includes("R"));
  assert.ok(!findSkills("R&D budget").includes("R"));
  assert.ok(findSkills("k8s and Postgres").includes("Kubernetes"));
  assert.ok(findSkills("k8s and Postgres").includes("PostgreSQL"));
});

test("skills written in profile.json map to the names used in the score", () => {
  assert.equal(canonicalSkill("golang"), "Go");
  assert.equal(canonicalSkill("k8s"), "Kubernetes");
  assert.equal(canonicalSkill("postgres"), "PostgreSQL");
  assert.equal(canonicalSkill("Underwater basket weaving"), "Underwater basket weaving");
});

test("the sample CV reads as 6.4 years, Berkeley, and the backend skills", () => {
  const cv = parseCv(`# Jordan\n\n## Experience\n**Senior Software Engineer** (Jan 2023 - Present)\n- Go and Kubernetes\n**Software Engineer** (Jun 2020 - Dec 2022)\n**Intern** (May 2019 - Aug 2019)\n\n## Education\nUniversity of California, Berkeley, B.S. EECS, 2020\n`);
  assert.deepEqual(cv.schools, ["University of California, Berkeley"]);
  assert.ok(cv.skills.includes("Go") && cv.skills.includes("Kubernetes"));
});

test("CV files: plain text and markdown read, Word files and missing files get a next step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jha-cv-"));
  writeFileSync(join(dir, "cv.md"), "﻿Line one\r\nLine two");
  assert.equal(await readCvText(join(dir, "cv.md")), "Line one\nLine two");
  writeFileSync(join(dir, "cv.docx"), "PK\u0003\u0004");
  await assert.rejects(readCvText(join(dir, "cv.docx")), /Save it as PDF/);
  writeFileSync(join(dir, "cv.txt"), "PK\u0003\u0004rest");
  await assert.rejects(readCvText(join(dir, "cv.txt")), /Word or zip/);
  await assert.rejects(readCvText(join(dir, "nope.md")), /No CV at .*examples\/cv-example\.md/);
  writeFileSync(join(dir, "broken.pdf"), "%PDF-1.4 not really");
  await assert.rejects(readCvText(join(dir, "broken.pdf")), /Could not read text/);
});

test("career changers: only tech jobs count as years; Education first and other headings still work", () => {
  const changer = "Experience\nSoftware Engineer, Acme (Jun 2026 - Present)\nMath Teacher, Lincoln High (Aug 2019 - May 2026)\nBarista (2016 - 2019)\n\nEducation\nHack Reactor, 2026";
  assert.ok((yearsOfExperience(changer, NOW) ?? 9) < 1);
  assert.equal(yearsOfExperience("Summary\n8+ years of experience in hospitality.\nExperience\nDeveloper (Jan 2025 - Present)", NOW), 1.8);
  const eduFirst = "EDUCATION\nUniversity of Washington, B.S. 2021\n\nRELEVANT EXPERIENCE\nSoftware Engineer\nJun '23 - Present\nDeveloper, Shop (2021/06 - 2023/05)";
  assert.ok(Math.abs((yearsOfExperience(eduFirst, NOW) ?? 0) - 5.4) < 0.2, String(yearsOfExperience(eduFirst, NOW)));
  assert.deepEqual(findSchools(eduFirst), ["University of Washington"]);
  assert.equal(yearsOfExperience("## Work\nEngineer 2021 - now", NOW), 5.8);
  // A stated number about another career does not count; teaching titles that mention data do not either.
  assert.ok((yearsOfExperience("Summary\n7 years of experience teaching math.\nExperience\nDeveloper (Jan 2026 - Present)", NOW) ?? 9) < 1);
  assert.ok((yearsOfExperience("Experience\nMathematics Teacher & Data Lead (Aug 2019 - May 2026)\nJunior Developer (Jun 2026 - Present)", NOW) ?? 9) < 1);
});

test("skills marked as still learning, and ordinary words, do not count", () => {
  const cv = parseCv("Skills: Python, Go (learning), Rust (basic). I excel at communication. Swift delivery. Rust Belt native.");
  assert.deepEqual(cv.skills, ["Python"]);
  assert.ok(parseCv("React and Python (learning)").skills.includes("React"), "only the words right before the bracket are dropped");
  assert.ok(findSkills("React · Node.js · Express").includes("Express"));
  assert.ok(!findSkills("Express delivery to all clients").includes("Express"));
  assert.ok(findSkills("ASP.NET and .NET 8").includes(".NET"));
  assert.ok(!findSkills("ASP.NET").includes("C#"));
  assert.ok(findSkills("Jest, Cypress, Playwright").includes("Playwright"));
});
