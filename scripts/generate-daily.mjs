// CurioVault — daily content generator for GitHub Actions.
// No dependencies: uses the Anthropic REST API and global fetch (Node 20+).
//
// Generates a themed "Daily Five" (3 real + 2 fabricated), verifies every
// statement, and writes:
//   content/daily/<YYYY-MM-DD>.json   (dated, committed → git = audit trail)
//   content/daily/latest.json         (what the app fetches)
//
// Env: ANTHROPIC_API_KEY (GitHub repo secret).

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODEL = "claude-opus-4-8";
const API = "https://api.anthropic.com/v1/messages";
const KEY = process.env.ANTHROPIC_API_KEY;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "content", "daily");

if (!KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

async function claude({ system, user, maxTokens }) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      system, messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

function extractJSON(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = (fenced ? fenced[1] : raw).trim();
  if (!s.startsWith("{")) {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b !== -1) s = s.slice(a, b + 1);
  }
  return JSON.parse(s);
}

async function pickTheme(dayNumber) {
  const themes = JSON.parse(await readFile(join(here, "themes.json"), "utf8"));
  return themes[dayNumber % themes.length];
}

async function generate(theme, dayNumber) {
  const text = await claude({
    maxTokens: 2000,
    system:
      "You author 'The Daily Five' for a knowledge game. Produce exactly 5 statements on the theme: " +
      "3 REAL (each with a real, citable reputable source URL) and 2 FABRICATED (plausible but false). " +
      "Assign rarity by how surprising/obscure a real fact is (common/rare/legendary). " +
      "Give each a stable kebab-case `key` and optional `constellation` id. " +
      "Respond ONLY with JSON: {dayNumber, theme, statements:[{id,key,text,truth,rarity,source,constellation}]}.",
    user: `Theme: ${theme}. dayNumber: ${dayNumber}.`,
  });
  return extractJSON(text);
}

async function urlResolves(url) {
  try { return (await fetch(url, { method: "HEAD" })).ok; } catch { return false; }
}

async function confirmsClaim(s) {
  const text = await claude({
    maxTokens: 10,
    system:
      "You are a fact-checker. Answer ONLY 'YES' if the statement is accurate and not an overstatement " +
      "of what reputable sources support, otherwise 'NO'.",
    user: s.text + (s.source ? `\nClaimed source: ${s.source.url}` : ""),
  });
  return text.trim().toUpperCase().startsWith("YES");
}

async function verifyAll(round) {
  let allPass = true;
  const perStatement = [];
  for (const s of round.statements) {
    let pass;
    if (s.truth === "real") {
      const resolves = s.source?.url ? await urlResolves(s.source.url) : false;
      const confirmed = await confirmsClaim(s);
      pass = resolves && confirmed;
      perStatement.push({ key: s.key, truth: s.truth, verdict: confirmed ? "YES" : "NO", source: s.source?.url ?? null });
    } else {
      const accidentallyTrue = await confirmsClaim({ ...s, truth: "real" });
      pass = !accidentallyTrue;
      perStatement.push({ key: s.key, truth: s.truth, verdict: accidentallyTrue ? "YES" : "NO", source: null });
    }
    if (!pass) allPass = false;
  }
  return { allPass, perStatement };
}

async function main() {
  const today = new Date();
  const dayDate = today.toISOString().slice(0, 10);
  const dayNumber = Math.floor(today.getTime() / 86_400_000);
  const theme = await pickTheme(dayNumber);

  let round = await generate(theme, dayNumber);
  let v = await verifyAll(round);
  let attempts = 0;
  while (!v.allPass && attempts < 3) {
    console.log(`Verification failed (attempt ${attempts + 1}), regenerating…`);
    round = await generate(theme, dayNumber);
    v = await verifyAll(round);
    attempts++;
  }

  const payload = { verified: v.allPass, generatedAt: new Date().toISOString(), round };

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${dayDate}.json`), JSON.stringify(payload, null, 2));
  if (payload.verified) {
    // Only publish `latest` when verified — the trust gate (PRD risk #1).
    await writeFile(join(outDir, "latest.json"), JSON.stringify(payload, null, 2));
  }

  console.log(JSON.stringify({ dayDate, theme, verified: payload.verified, audit: v.perStatement }, null, 2));
  if (!payload.verified) process.exit(1); // fail the run so it's visible; latest.json untouched
}

main().catch((e) => { console.error(e); process.exit(1); });
