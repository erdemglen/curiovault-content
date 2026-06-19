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

// Canonical constellation ids — keep in sync with the client's Constellations.all
// and the Worker's CONSTELLATION_IDS. Generators may only use these (or null).
const CONSTELLATION_IDS = [
  "human-machine", "strange-creatures", "sonic-universe", "silicon-minds", "pixel-legends",
  "pale-blue-dot", "human-limits", "edible-alchemy", "digital-dawn", "ancient-engineers",
  "word-worlds", "warming-world", "terra-incognita", "quantum-realm", "miracle-cures",
  "inner-cosmos", "dream-atlas", "digital-gold", "cosmic-extremes", "hidden-waters",
  "extremes-of-earth", "cartographers-secrets",
];
const CONSTELLATION_SET = new Set(CONSTELLATION_IDS);
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
      "3 REAL (each with a real, citable reputable source) and 2 FABRICATED (plausible but false). " +
      "Use lowercase for `truth` (\"real\"|\"fabricated\") and `rarity` (\"common\"|\"rare\"|\"legendary\"). " +
      "`source` MUST be an object {\"publication\":\"NASA\",\"url\":\"https://...\"} for real statements, and null for fabricated ones. " +
      "Give each a stable kebab-case `key`. " +
      "`constellation` MUST be one of these ids (pick the best thematic fit) or null: " +
      CONSTELLATION_IDS.join(", ") + ". " +
      "Respond ONLY with JSON: {dayNumber, theme, statements:[{id,key,text,truth,rarity,source,constellation}]}.",
    user: `Theme: ${theme}. dayNumber: ${dayNumber}.`,
  });
  return normalize(extractJSON(text), theme, dayNumber);
}

// Coerce model output into the exact shape the Swift app decodes, regardless of
// how the model formatted it (uppercase enums, string-vs-object source, etc.).
function normalize(round, theme, dayNumber) {
  round.theme ??= theme;
  round.dayNumber ??= dayNumber;
  round.statements = (round.statements ?? []).map((s, i) => {
    const truth = String(s.truth ?? "").toLowerCase().startsWith("fab") ? "fabricated" : "real";
    let source = s.source ?? null;
    if (typeof source === "string") {
      source = source.trim() ? { publication: hostOf(source), url: source } : null;
    } else if (source && typeof source === "object" && !source.url) {
      source = null;
    }
    if (truth === "fabricated") source = null; // fakes never carry a source
    return {
      id: Number(s.id) || i + 1,
      key: s.key ?? `stmt-${i + 1}`,
      text: s.text ?? "",
      truth,
      rarity: String(s.rarity ?? "common").toLowerCase(),
      source,
      // Only allow canonical constellation ids through — drop anything off-list.
      constellation: CONSTELLATION_SET.has(s.constellation) ? s.constellation : null,
    };
  });
  return round;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; }
}

async function urlResolves(url) {
  const ua = { headers: { "user-agent": "Mozilla/5.0 (compatible; CurioVaultBot/1.0)" } };
  try {
    let r = await fetch(url, { method: "HEAD", redirect: "follow", ...ua });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { redirect: "follow", ...ua });
    return r.status < 400;
  } catch { return false; }
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
      // Hard gate: must cite a source AND pass the fact-check. URL HTTP-resolution
      // is logged but NOT a hard gate — many reputable sites block bot requests,
      // which would wrongly reject good facts.
      const hasSource = Boolean(s.source?.url);
      const confirmed = await confirmsClaim(s);
      const resolves = hasSource ? await urlResolves(s.source.url) : false;
      pass = hasSource && confirmed;
      perStatement.push({ key: s.key, truth: s.truth, verdict: confirmed ? "YES" : "NO",
                          source: s.source?.url ?? null, resolves });
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
