/**
 * The skills the fit score looks for, in the CV and in each posting. One line per skill: the name shown, then the
 * spellings that count as the same skill. Matching is whole-word and case-insensitive, so "Go" does not match
 * "good" and "R" does not match every word with an r in it (see `findSkills`).
 *
 * Add your own: append a line to the list below, or put extra skills in profile.json "skills" (those count as
 * yours even when the CV does not spell them out). docs/customize.md has the details.
 */

export type Skill = { name: string; patterns: RegExp[] };

const RAW: Array<[string, ...string[]]> = [
  // Languages
  ["Python"], ["Java"], ["JavaScript", "javascript", "js", "ecmascript"], ["TypeScript", "typescript", "ts"],
  ["Go", "golang", "go lang"], ["Rust"], ["C++", "c\\+\\+", "cpp"], ["C#", "c#", "csharp"], ["C"],
  ["Ruby"], ["PHP"], ["Kotlin"], ["Swift"], ["Objective-C", "objective-c", "objc"], ["Scala"], ["Elixir"],
  ["Erlang"], ["Haskell"], ["Clojure"], ["R", "r language", "rstudio"], ["MATLAB"], ["Julia"], ["Perl"],
  ["Lua"], ["Dart"], ["Solidity"], ["Bash", "bash", "shell scripting"], ["SQL"], ["GraphQL"],
  ["Verilog"], ["VHDL"], ["CUDA"], ["Zig"], ["OCaml"], ["F#", "f#"],
  // Frontend and mobile
  ["React", "react", "react\\.js", "reactjs"], ["React Native", "react native"], ["Next.js", "next\\.js", "nextjs"],
  ["Vue", "vue", "vue\\.js", "vuejs"], ["Angular", "angular", "angularjs"], ["Svelte"], ["Redux"],
  ["HTML"], ["CSS"], ["Tailwind", "tailwind", "tailwindcss"], ["Webpack"], ["Vite"],
  ["iOS"], ["Android"], ["SwiftUI"], ["Flutter"], ["Jetpack Compose", "jetpack compose"],
  // Backend
  ["Node.js", "node\\.js", "nodejs", "node"], ["Express", "express\\.js", "expressjs"], ["NestJS", "nestjs"],
  ["Django"], ["Flask"], ["FastAPI"], ["Spring", "spring boot", "spring"], ["Rails", "ruby on rails", "rails"],
  ["Laravel"], ["gRPC", "grpc"], ["REST APIs", "rest api", "rest apis", "restful"], ["Microservices", "microservices"],
  ["Kafka", "kafka", "apache kafka"], ["RabbitMQ"], ["Redis"], ["Elasticsearch", "elasticsearch", "opensearch"],
  ["PostgreSQL", "postgresql", "postgres"], ["MySQL"], ["MongoDB", "mongodb", "mongo"], ["DynamoDB"],
  ["Cassandra"], ["SQLite"], ["Snowflake"], ["BigQuery"], ["Redshift"], ["ClickHouse"], ["Supabase"],
  ["Firebase"],
  // Cloud and infrastructure
  ["AWS", "aws", "amazon web services"], ["GCP", "gcp", "google cloud"], ["Azure"], ["Kubernetes", "kubernetes", "k8s"],
  ["Docker"], ["Terraform"], ["Ansible"], ["Helm"], ["Linux"], ["CI/CD", "ci/cd", "ci cd", "continuous integration"],
  ["GitHub Actions", "github actions"], ["Jenkins"], ["Prometheus"], ["Grafana"], ["Datadog"], ["Nginx"],
  ["Serverless", "serverless", "aws lambda", "lambda"], ["Distributed systems", "distributed systems"],
  ["Networking", "tcp/ip", "networking"], ["Observability"], ["Site reliability", "sre", "site reliability"],
  // Data and ML
  ["Spark", "spark", "apache spark", "pyspark"], ["Airflow"], ["dbt"], ["Pandas"], ["NumPy", "numpy"],
  ["PyTorch", "pytorch"], ["TensorFlow", "tensorflow"], ["JAX"], ["scikit-learn", "scikit-learn", "sklearn"],
  ["Machine learning", "machine learning", "ml"], ["Deep learning", "deep learning"],
  ["LLMs", "llm", "llms", "large language models?"], ["NLP", "nlp", "natural language processing"],
  ["Computer vision", "computer vision"], ["RAG", "rag", "retrieval augmented generation"],
  ["Data pipelines", "data pipelines?", "etl", "elt"], ["Statistics"], ["A/B testing", "a/b testing", "experimentation"],
  ["Tableau"], ["Looker"], ["Power BI", "power bi"], ["Excel"],
  // Security
  ["Security", "application security", "appsec", "security engineering"], ["OAuth"], ["Cryptography"],
  // Product, design and practice
  ["Figma"], ["Product management", "product management"], ["UX research", "user research", "ux research"],
  ["Agile", "agile", "scrum"], ["System design", "system design"], ["Testing", "unit testing", "test automation", "tdd"],
  ["Jest"], ["Cypress"], ["Playwright"], ["Prisma"], ["Sass", "sass", "scss"], ["Mongoose"], [".NET", "\\.net", "dotnet", "asp\\.net"],
  ["Git"], ["Embedded", "embedded systems", "embedded", "firmware"], ["Robotics"], ["Unity"], ["Unreal", "unreal engine"],
];

const escape = (s: string) => s.replace(/[.*?^${}()|[\]]/g, m => (m === "." ? "\\." : `\\${m}`));

/** Whole-word, case-insensitive: letters or digits next to the match mean it is part of a longer word. */
function wordPattern(spelling: string, raw: boolean): RegExp {
  const body = raw ? spelling : escape(spelling);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_+#])`, "iu");
}

export const SKILLS: Skill[] = RAW.map(([name, ...spellings]) => {
  const list = spellings.length ? spellings : [name];
  // Spellings written in the list above are regular-expression snippets; the bare name is taken literally.
  return { name, patterns: list.map(s => wordPattern(s, spellings.length > 0)) };
});

/**
 * Single letters and short words that are also ordinary words: they only count when written the way a CV or a
 * posting writes a skill (capital C or R standing alone, "Go" capitalised), never inside a sentence by accident.
 */
const STRICT: Record<string, RegExp> = {
  // Not an initial ("Jane C. Doe", "Washington, D.C."), not "Series A to C".
  C: /(?<![\p{L}\p{N}_.])(?<!\p{Lu}\.\s?)(?<!(?:Series|[Tt]o|[Aa]nd|[Oo]r|Plan|Type|Vitamin|Class) )(?<!-)C(?![\p{L}\p{N}_+#-])(?!\.)(?!\s*(?:level|suite|corp|round|series|\+\+))/u,
  R: /(?<![\p{L}\p{N}_.])(?<!\p{Lu}\.\s?)R(?![\p{L}\p{N}_&'\u2019])(?!\.)(?!\s*&)/u,
  Go: /(?<![\p{L}\p{N}_])(?:Go(?![\p{L}\p{N}_-])(?!\s+(?:to|back|beyond|above|live|deep|forward|through|out|over)\b)|[Gg]olang)/u,
  Swift: /(?<![\p{L}\p{N}_])Swift(?![\p{L}\p{N}_])(?!\s+(?:delivery|response|action|turnaround|execution|feedback))/u,
  Rust: /(?<![\p{L}\p{N}_])Rust(?![\p{L}\p{N}_])(?!\s+Belt)/u,
  Spring: /(?<![\p{L}\p{N}_])(?:Spring Boot|Spring(?= (?:Framework|MVC|Cloud|Data)))/u,
  Express: /(?<![\p{L}\p{N}_])(?:Express\.js|ExpressJS|Express(?![\p{L}\p{N}_])(?!\s+(?:delivery|shipping|lane|mail|entry|checkout|interest|consent|written|your|my|our|their|yourself)))(?<!(?:American|Federal|Pacific|Global) Express)/u,
  "Node.js": /(?<![\p{L}\p{N}_])(?:Node\.js|NodeJS|Node(?=\s*(?:\/|,|and|or)\s*(?:TypeScript|JavaScript|Express|Deno)))/u,
  Agile: /(?<![\p{L}\p{N}_])(?:Agile|Scrum)(?![\p{L}\p{N}_])/u,
  Statistics: /(?<![\p{L}\p{N}_])[Ss]tatistics(?![\p{L}\p{N}_])/u,
  Security: /(?<![\p{L}\p{N}_])(?:[Aa]pplication security|AppSec|[Ss]ecurity engineering)(?![\p{L}\p{N}_])/u,
  Networking: /(?<![\p{L}\p{N}_])(?:TCP\/IP|[Nn]etwork protocols|[Nn]etworking (?:protocols|stack))(?![\p{L}\p{N}_])/u,
  Testing: /(?<![\p{L}\p{N}_])(?:[Uu]nit test(?:s|ing)|[Tt]est automation|TDD)(?![\p{L}\p{N}_])/u,
  Excel: /(?<![\p{L}\p{N}_])(?:Microsoft )?Excel(?![\p{L}\p{N}_])(?!\s+(?:at|in)\b)/u,
  Unity: /(?<![\p{L}\p{N}_])Unity(?=\s*(?:3D|engine|game|,|\/))/u,
  Embedded: /(?<![\p{L}\p{N}_])(?:[Ee]mbedded (?:systems|software|C|Linux)|[Ff]irmware)(?![\p{L}\p{N}_])/u,
  "Machine learning": /(?<![\p{L}\p{N}_])(?:[Mm]achine [Ll]earning|ML(?![\p{L}\p{N}_])(?!\s*(?:Kit)))/u,
  RAG: /(?<![\p{L}\p{N}_])(?:RAG(?![\p{L}\p{N}_])|[Rr]etrieval[- ]augmented generation)/u,
  JAX: /(?<![\p{L}\p{N}_])JAX(?![\p{L}\p{N}_])/u,
  Serverless: /(?<![\p{L}\p{N}_])(?:[Ss]erverless|AWS Lambda)(?![\p{L}\p{N}_])/u,
  Git: /(?<![\p{L}\p{N}_])Git(?![\p{L}\p{N}_]|Hub|Lab)/u,
  Linux: /(?<![\p{L}\p{N}_])Linux(?![\p{L}\p{N}_])/u,
  Docker: /(?<![\p{L}\p{N}_])[Dd]ocker(?![\p{L}\p{N}_])/u,
  Dart: /(?<![\p{L}\p{N}_])Dart(?![\p{L}\p{N}_])/u,
  Julia: /(?<![\p{L}\p{N}_])Julia(?= (?:language|programming)|,|\/)/u,
  Perl: /(?<![\p{L}\p{N}_])Perl(?![\p{L}\p{N}_])/u,
  Lua: /(?<![\p{L}\p{N}_])Lua(?![\p{L}\p{N}_])/u,
  Rails: /(?<![\p{L}\p{N}_])(?:Ruby on Rails|Rails(?![\p{L}\p{N}_]))/u,
  Helm: /(?<![\p{L}\p{N}_])Helm(?![\p{L}\p{N}_])/u,
  Vite: /(?<![\p{L}\p{N}_])Vite(?![\p{L}\p{N}_])/u,
  Spark: /(?<![\p{L}\p{N}_])(?:Apache Spark|PySpark|Spark(?![\p{L}\p{N}_]))/u,
  Redux: /(?<![\p{L}\p{N}_])Redux(?![\p{L}\p{N}_])/u,
  Angular: /(?<![\p{L}\p{N}_])(?:Angular(?:JS)?)(?![\p{L}\p{N}_])/u,
  React: /(?<![\p{L}\p{N}_])(?:React(?:\.js|JS)?)(?![\p{L}\p{N}_]| Native)/u,
  Vue: /(?<![\p{L}\p{N}_])(?:Vue(?:\.js|JS)?)(?![\p{L}\p{N}_])/u,
  Svelte: /(?<![\p{L}\p{N}_])Svelte(?:Kit)?(?![\p{L}\p{N}_])/u,
  Elixir: /(?<![\p{L}\p{N}_])Elixir(?![\p{L}\p{N}_])/u,
  Scala: /(?<![\p{L}\p{N}_])Scala(?![\p{L}\p{N}_])/u,
  Ruby: /(?<![\p{L}\p{N}_])Ruby(?![\p{L}\p{N}_])(?! on Rails)/u,
  Java: /(?<![\p{L}\p{N}_])Java(?![\p{L}\p{N}_]|Script)/u,
  Python: /(?<![\p{L}\p{N}_])[Pp]ython(?![\p{L}\p{N}_])/u,
};

/** Skills that are practices rather than tools: left out of the "I've spent N years building with X" line in notes. */
export const PRACTICES = new Set(["Distributed systems", "Networking", "Observability", "Site reliability", "Machine learning", "Deep learning", "NLP", "Computer vision", "Data pipelines", "Statistics", "A/B testing", "Security", "Cryptography", "Product management", "UX research", "Agile", "System design", "Testing", "Embedded", "Robotics", "CI/CD", "Microservices", "REST APIs", "Serverless", "LLMs", "RAG"]);

/** The skill names found in a text, each once, in list order. */
export function findSkills(text: string): string[] {
  const found: string[] = [];
  for (const s of SKILLS) {
    const strict = STRICT[s.name];
    if (strict ? strict.test(text) : s.patterns.some(p => p.test(text))) found.push(s.name);
  }
  return found;
}

const FULL = RAW.map(([name, ...spellings]) => ({
  name,
  full: (spellings.length ? spellings : [escape(name)]).map(x => new RegExp(`^(?:${x})$`, "iu")),
}));

/** A skill name as written by a person ("golang", "k8s") to the name used here, or the text itself if unknown. */
export function canonicalSkill(name: string): string {
  const t = name.trim();
  const hit = FULL.find(s => s.name.toLowerCase() === t.toLowerCase() || s.full.some(r => r.test(t)));
  return hit ? hit.name : t;
}
