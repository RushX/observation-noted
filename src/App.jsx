import React, { useState, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Policy Gap Hunt — a GRC judgment trainer.
// The model generates a realistic, structured (but intentionally flawed) policy
// document + a hidden answer key. You read it and list the gaps. The model then
// grades your findings on substance: recall (weighted by severity) and precision.
// ---------------------------------------------------------------------------

// Calls go to your local server (server.js), which holds the Gemini key.
const PROXY_URL = "/api/gemini";

const SCENARIOS = [
  { key: "Access Control Policy", blurb: "Who gets access, how it's granted, reviewed, revoked." },
  { key: "Incident Response Policy", blurb: "Detect, report, escalate, recover, learn." },
  { key: "Vendor / Third-Party Risk Policy", blurb: "Onboarding, assessment, monitoring of suppliers." },
  { key: "Data Retention & Disposal Policy", blurb: "What's kept, how long, how it's destroyed." },
];

const DIFFICULTY = [
  { key: "Trainee", gaps: 4, note: "Obvious omissions" },
  { key: "Analyst", gaps: 5, note: "Realistic mix" },
  { key: "Auditor", gaps: 6, note: "Subtle & layered" },
];

const SEV = {
  HIGH: { label: "HIGH", color: "var(--high)" },
  MEDIUM: { label: "MED", color: "var(--med)" },
  LOW: { label: "LOW", color: "var(--low)" },
};

async function callModel(system, user) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, user }),
  });
  if (!res.ok) throw new Error("Proxy error " + res.status);
  const data = await res.json(); // proxy returns { text }
  const text = data.text || "";
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in response");
  return JSON.parse(clean.slice(start, end + 1));
}

// Flatten the structured policy to plain text for the grader, so it sees
// everything (metadata + every section) when judging the findings.
function policyToText(p) {
  if (!p) return "";
  const meta =
    `Company: ${p.company}\nTitle: ${p.title}\nDocument ID: ${p.docId}\n` +
    `Version: ${p.version}\nEffective: ${p.effectiveDate}\n` +
    `Owner: ${p.owner}\nClassification: ${p.classification}`;
  const secs = (p.sections || [])
    .map((s, i) => `${i + 1}. ${s.heading}\n${s.body}`)
    .join("\n\n");
  return `${meta}\n\n${secs}`;
}

const GEN_SYS = `You are a GRC training content generator. Produce a realistic but INTENTIONALLY FLAWED internal policy document for a fictional company. It must read as a genuine corporate policy — formal tone, proper structure — yet contain EXACTLY the requested number of distinct, defensible gaps a skilled reviewer should catch (missing elements, vague/unenforceable language, missing owners or timeframes, scope holes, no review cadence, undefined terms, missing roles/responsibilities, no exceptions/enforcement process, etc.). Do NOT signpost or comment on the gaps anywhere in the text.
Return ONLY valid JSON, no markdown fences, with this EXACT shape:
{
 "company": string (invented but plausible company name),
 "title": string (e.g. "Access Control Policy"),
 "docId": string (e.g. "POL-IT-014"),
 "version": string (e.g. "1.3"),
 "effectiveDate": string (YYYY-MM-DD),
 "owner": string (owning team or role),
 "classification": string (e.g. "Internal" or "Confidential"),
 "sections": [ { "heading": string, "body": string (1-3 short paragraphs; separate paragraphs with \\n\\n) } ],
 "gaps": [ { "id":"G1", "summary": string (<=12 words), "severity":"HIGH"|"MEDIUM"|"LOW", "explanation": string (<=25 words) } ]
}
Include 5 to 8 sections typical of a real policy (e.g. Purpose, Scope, Definitions, Policy Statements, Roles & Responsibilities, Compliance & Enforcement, Review). Keep total section body text under ~450 words.`;

const GRADE_SYS = `You are a strict but fair GRC examiner grading a policy-gap-review exercise. You receive the policy, the official gap key, and the candidate's findings.
Rules: (1) Match each finding to a key gap if it captures the same issue (semantic, not wording). (2) If a finding is a VALID gap NOT in the key, mark it "novel" and give credit. (3) If it is not a real gap, mark "false_positive". (4) List key gaps the candidate missed. Be generous on phrasing, strict on substance.
Return ONLY valid JSON, no fences: {"findings":[{"text":string,"verdict":"matched"|"novel"|"false_positive","gapId":string|null,"note":string (<=18 words)}],"missed":[{"id":string,"summary":string,"severity":string}],"recall_pct":int,"precision_pct":int,"severity_weighted_pct":int,"verdict_line":string (<=20 words)}.
recall_pct = % of key gaps caught. severity_weighted_pct = same but weight HIGH=3, MED=2, LOW=1. precision_pct = valid findings / total findings.`;

export default function PolicyGapHunt() {
  const [stage, setStage] = useState("setup"); // setup | reviewing | results
  const [scenario, setScenario] = useState(SCENARIOS[0].key);
  const [difficulty, setDifficulty] = useState(DIFFICULTY[1]);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState("");

  const [policy, setPolicy] = useState(null); // {company,title,docId,...,sections,gaps}
  const [findings, setFindings] = useState([]);
  const [draft, setDraft] = useState("");
  const [grade, setGrade] = useState(null);

  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (stage === "reviewing") {
      startRef.current = Date.now();
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
        1000
      );
    }
    return () => clearInterval(timerRef.current);
  }, [stage]);

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  async function generate() {
    setError("");
    setLoading(true);
    setLoadMsg("Drafting a flawed policy…");
    try {
      const out = await callModel(
        GEN_SYS,
        `Scenario: ${scenario}. Difficulty: ${difficulty.key}. Number of gaps: ${difficulty.gaps}.`
      );
      if (!Array.isArray(out.sections) || !Array.isArray(out.gaps)) {
        throw new Error("Bad shape");
      }
      setPolicy(out);
      setFindings([]);
      setDraft("");
      setGrade(null);
      setElapsed(0);
      setStage("reviewing");
    } catch (e) {
      setError("Generation failed — try again. (" + e.message + ")");
    } finally {
      setLoading(false);
    }
  }

  function addFinding() {
    const t = draft.trim();
    if (!t) return;
    setFindings((f) => [...f, t]);
    setDraft("");
  }

  async function submit() {
    clearInterval(timerRef.current);
    setError("");
    setLoading(true);
    setLoadMsg("The examiner is reviewing your findings…");
    try {
      const out = await callModel(
        GRADE_SYS,
        JSON.stringify({ policy: policyToText(policy), key: policy.gaps, findings })
      );
      setGrade(out);
      setStage("results");
    } catch (e) {
      setError("Grading failed — try again. (" + e.message + ")");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStage("setup");
    setPolicy(null);
    setGrade(null);
    setFindings([]);
  }

  return (
    <div className="pgh-root">
      <style>{CSS}</style>

      <header className="pgh-head">
        <div className="pgh-mark">:)</div>
        <div>
          <h1>Observation Noted</h1>
          <p className="pgh-sub">Read. Find. Get judged (and better).</p>
        </div>
        {stage === "reviewing" && (
          <div className="pgh-timer" title="Time is context, not your score">
            <span className="pgh-mono">{fmtTime(elapsed)}</span>
            <small>elapsed</small>
          </div>
        )}
      </header>

      {error && <div className="pgh-error">{error}</div>}

      {/* ---------------- SETUP ---------------- */}
      {stage === "setup" && (
        <div className="pgh-card">
          <div className="pgh-field">
            <label>Policy type</label>
            <div className="pgh-chips">
              {SCENARIOS.map((s) => (
                <button
                  key={s.key}
                  className={"pgh-chip" + (scenario === s.key ? " on" : "")}
                  onClick={() => setScenario(s.key)}
                >
                  <strong>{s.key}</strong>
                  <span>{s.blurb}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="pgh-field">
            <label>Difficulty</label>
            <div className="pgh-chips row">
              {DIFFICULTY.map((d) => (
                <button
                  key={d.key}
                  className={"pgh-chip sm" + (difficulty.key === d.key ? " on" : "")}
                  onClick={() => setDifficulty(d)}
                >
                  <strong>{d.key}</strong>
                  <span>{d.gaps} gaps · {d.note}</span>
                </button>
              ))}
            </div>
          </div>

          <button className="pgh-go" disabled={loading} onClick={generate}>
            {loading ? loadMsg : "Generate policy →"}
          </button>
        </div>
      )}

      {/* ---------------- REVIEWING ---------------- */}
      {stage === "reviewing" && policy && (
        <div className="pgh-grid">
          <article className="pgh-doc">
            <div className="pgh-doc-tag">CONFIDENTIAL · DRAFT FOR REVIEW</div>

            <div className="pgh-doc-company">{policy.company}</div>
            <h2 className="pgh-doc-title">{policy.title}</h2>

            <div className="pgh-doc-meta">
              <Meta label="Document ID" value={policy.docId} />
              <Meta label="Version" value={policy.version} />
              <Meta label="Effective" value={policy.effectiveDate} />
              <Meta label="Owner" value={policy.owner} />
              <Meta label="Classification" value={policy.classification} />
            </div>

            <div className="pgh-doc-body">
              {policy.sections.map((s, i) => (
                <section className="pgh-section" key={i}>
                  <h3>
                    {/* <span className="pgh-section-num">{i + 1}</span> */}
                    {s.heading}
                  </h3>
                  <div className="pgh-section-body">{s.body}</div>
                </section>
              ))}
            </div>
          </article>

          <aside className="pgh-panel">
            <h3>Your findings</h3>
            <p className="pgh-hint">
              List each gap as its own line. Be specific — "no review cadence" beats "vague".
            </p>
            <div className="pgh-input">
              <input
                value={draft}
                placeholder="e.g. No owner assigned for access revocation"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFinding()}
              />
              <button onClick={addFinding}>Add</button>
            </div>
            <ul className="pgh-findings">
              {findings.map((f, i) => (
                <li key={i}>
                  <span>{f}</span>
                  <button
                    className="pgh-x"
                    onClick={() => setFindings((arr) => arr.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
              {findings.length === 0 && <li className="pgh-empty">No findings yet.</li>}
            </ul>
            <button
              className="pgh-go"
              disabled={loading || findings.length === 0}
              onClick={submit}
            >
              {loading ? loadMsg : `Submit ${findings.length} finding${findings.length === 1 ? "" : "s"} for grading`}
            </button>
          </aside>
        </div>
      )}

      {/* ---------------- RESULTS ---------------- */}
      {stage === "results" && grade && policy && (
        <div className="pgh-results">
          <div className="pgh-scores">
            <Score label="Severity-weighted" pct={grade.severity_weighted_pct} primary />
            <Score label="Recall" pct={grade.recall_pct} />
            <Score label="Precision" pct={grade.precision_pct} />
            <div className="pgh-score time">
              <div className="pgh-mono big">{fmtTime(elapsed)}</div>
              <div className="pgh-score-label">time (context only)</div>
            </div>
          </div>

          <p className="pgh-verdict">“{grade.verdict_line}”</p>

          <div className="pgh-cols">
            <section>
              <h4>Your findings</h4>
              {grade.findings.map((f, i) => (
                <div key={i} className={"pgh-row v-" + f.verdict}>
                  <span className="pgh-badge">
                    {f.verdict === "matched" ? "✓ caught" : f.verdict === "novel" ? "✦ valid (bonus)" : "✗ not a gap"}
                  </span>
                  <div>
                    <strong>{f.text}</strong>
                    {f.note && <em>{f.note}</em>}
                  </div>
                </div>
              ))}
            </section>

            <section>
              <h4>Gaps you missed</h4>
              {grade.missed.length === 0 && <p className="pgh-clean">Nothing missed. Clean sweep.</p>}
              {grade.missed.map((m, i) => (
                <div key={i} className="pgh-row missed">
                  <span className="pgh-sev" style={{ background: (SEV[m.severity] || SEV.LOW).color }}>
                    {(SEV[m.severity] || SEV.LOW).label}
                  </span>
                  <strong>{m.summary}</strong>
                </div>
              ))}
            </section>
          </div>

          <details className="pgh-key">
            <summary>Reveal full answer key ({policy.gaps.length} gaps)</summary>
            {policy.gaps.map((g) => (
              <div key={g.id} className="pgh-row">
                <span className="pgh-sev" style={{ background: (SEV[g.severity] || SEV.LOW).color }}>
                  {(SEV[g.severity] || SEV.LOW).label}
                </span>
                <div>
                  <strong>{g.summary}</strong>
                  <em>{g.explanation}</em>
                </div>
              </div>
            ))}
          </details>

          <button className="pgh-go ghost" onClick={reset}>↺ New policy</button>
        </div>
      )}

     <footer className="pgh-foot">
      <span>Built with AI &amp; a deep distrust of the word "periodically."</span>
      <span className="pgh-foot-links">
        <a href="https://github.com/RushX" target="_blank" rel="noopener noreferrer">GitHub/RushX</a>
        <a href="https://www.linkedin.com/in/muleyrushikesh/" target="_blank" rel="noopener noreferrer">LinkedIn/muleyrushikesh</a>
      </span>
</footer>
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div className="pgh-meta-item">
      <span className="pgh-meta-label">{label}</span>
      <span className="pgh-meta-value">{value || "—"}</span>
    </div>
  );
}

function Score({ label, pct, primary }) {
  const v = typeof pct === "number" ? pct : 0;
  return (
    <div className={"pgh-score" + (primary ? " primary" : "")}>
      <div className="pgh-ring" style={{ "--p": v }}>
        <span className="pgh-mono big">{v}</span>
      </div>
      <div className="pgh-score-label">{label}</div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@500;600;700&family=Spline+Sans:wght@400;500;600;700&display=swap');
.pgh-root{
  --paper:#ffffff; --bg:#ffffff;
  --ink:#0d0d0d; --ink-soft:#2b2b2b; --dim:#7a786f;
  --soft-line:#e2e0d8;
  --accent:#e6fb45;            /* highlighter acid */
  --high:#d32f2f; --med:#b26a00; --low:#2e7d4f;
  font-family:'Spline Sans',sans-serif; background:var(--bg); color:var(--ink);
  min-height:100%; padding:34px 26px; max-width:1080px; margin:0 auto;
}
.pgh-mono{font-family:'JetBrains Mono',monospace;}
.pgh-head{display:flex; align-items:center; gap:16px; margin-bottom:28px; padding-bottom:16px; border-bottom:3px solid var(--ink);}
.pgh-mark{font-family:'Bricolage Grotesque',sans-serif; font-weight:800; font-size:38px; line-height:1; color:var(--ink);
  width:60px; height:60px; display:grid; place-items:center; border:2px solid var(--ink); border-radius:3px; background:var(--accent); box-shadow:4px 4px 0 var(--ink);}
.pgh-head h1{font-family:'Bricolage Grotesque',sans-serif; font-weight:800; font-size:34px; margin:0; letter-spacing:-1px; line-height:1;}
.pgh-sub{margin:6px 0 0; color:var(--dim); font-size:14px;}
.pgh-timer{margin-left:auto; text-align:right;}
.pgh-timer span{font-family:'JetBrains Mono',monospace; font-size:23px; color:var(--ink); background:var(--accent); padding:2px 8px; border:2px solid var(--ink);}
.pgh-timer small{display:block; color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-top:5px;}
.pgh-error{background:#fff; border:2px solid var(--high); color:var(--high); padding:12px 14px; border-radius:2px; margin-bottom:16px; font-size:14px; box-shadow:4px 4px 0 var(--high); font-weight:500;}
.pgh-card{border:2px solid var(--ink); border-radius:3px; padding:28px; background:var(--paper); box-shadow:6px 6px 0 var(--ink);}
.pgh-field{margin-bottom:26px;}
.pgh-field label{display:block; font-family:'JetBrains Mono',monospace; font-size:11px; text-transform:uppercase; letter-spacing:2px; color:var(--ink); margin-bottom:13px; font-weight:600;}
.pgh-chips{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
.pgh-chips.row{grid-template-columns:repeat(3,1fr);}
.pgh-chip{text-align:left; background:var(--paper); border:2px solid var(--ink); border-radius:3px; padding:14px 16px; color:var(--ink); cursor:pointer; transition:.12s; display:flex; flex-direction:column; gap:4px; box-shadow:3px 3px 0 var(--ink);}
.pgh-chip:hover{transform:translate(-1px,-1px); box-shadow:4px 4px 0 var(--ink);}
.pgh-chip.on{background:var(--accent); transform:translate(2px,2px); box-shadow:1px 1px 0 var(--ink);}
.pgh-chip strong{font-size:15px; font-weight:600;} .pgh-chip span{font-size:12px; color:var(--dim);}
.pgh-chip.on span{color:var(--ink-soft);}
.pgh-chip.sm strong{font-size:14px;}
.pgh-go{width:100%; background:var(--ink); color:var(--paper); border:2px solid var(--ink); border-radius:3px; padding:15px; font-size:15px; font-weight:600; font-family:inherit; cursor:pointer; transition:.12s; box-shadow:4px 4px 0 rgba(13,13,13,.22); letter-spacing:.2px;}
.pgh-go:hover{background:var(--accent); color:var(--ink); box-shadow:4px 4px 0 var(--ink);}
.pgh-go:disabled{opacity:.35; cursor:wait; box-shadow:none;}
.pgh-go.ghost{background:var(--paper); color:var(--ink); box-shadow:4px 4px 0 var(--ink);}
.pgh-go.ghost:hover{background:var(--accent);}
.pgh-grid{display:grid; grid-template-columns:1.45fr 1fr; gap:22px; align-items:start;}

/* ---- realistic policy document ---- */
.pgh-doc{background:#fff; color:var(--ink); border:2px solid var(--ink); border-radius:3px; padding:30px 34px 34px; box-shadow:6px 6px 0 var(--ink);}
.pgh-doc-tag{display:inline-block; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:2px; color:var(--paper); background:var(--ink); padding:4px 8px; margin-bottom:18px;}
.pgh-doc-company{font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:var(--ink); margin-bottom:6px;}
.pgh-doc-title{font-family:'Bricolage Grotesque',sans-serif; font-weight:700; font-size:27px; margin:0; letter-spacing:-.6px; line-height:1.25;
  display:inline; }
.pgh-doc-meta{display:flex; flex-wrap:wrap; gap:18px 26px; border-top:2px solid var(--ink); border-bottom:2px solid var(--ink); padding:12px 0; margin:18px 0 0;}
.pgh-meta-item{display:flex; flex-direction:column; gap:3px;}
.pgh-meta-label{font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:1.5px; text-transform:uppercase; color:var(--dim);}
.pgh-meta-value{font-family:'JetBrains Mono',monospace; font-size:12.5px; color:var(--ink);}
.pgh-doc-body{margin-top:24px;}
.pgh-section{margin-bottom:20px;}
.pgh-section h3{font-family:'Bricolage Grotesque',sans-serif; font-weight:700; font-size:16px; margin:0 0 8px; display:flex; align-items:center; gap:10px; letter-spacing:-.2px;}
.pgh-section-num{font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:600; min-width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; background:var(--accent); border:1.5px solid var(--ink); border-radius:2px;}
.pgh-section-body{font-family:'Spline Sans',sans-serif; white-space:pre-wrap; font-size:14px; line-height:1.7; color:var(--ink-soft); padding-left:34px;}

.pgh-panel{position:sticky; top:20px; border:2px solid var(--ink); border-radius:3px; padding:22px; background:var(--paper); box-shadow:6px 6px 0 var(--ink);}
.pgh-panel h3{font-family:'Bricolage Grotesque',sans-serif; font-weight:700; margin:0 0 6px; font-size:19px; letter-spacing:-.3px;}
.pgh-hint{color:var(--dim); font-size:12.5px; margin:0 0 14px; line-height:1.5;}
.pgh-input{display:flex; gap:8px; margin-bottom:12px;}
.pgh-input input{flex:1; background:#fff; border:2px solid var(--ink); border-radius:2px; padding:11px 12px; color:var(--ink); font-family:inherit; font-size:13.5px;}
.pgh-input input::placeholder{color:#a8a69c;}
.pgh-input input:focus{outline:none; background:var(--accent);}
.pgh-input button{background:var(--ink); color:var(--paper); border:2px solid var(--ink); border-radius:2px; padding:0 16px; cursor:pointer; font-family:inherit; font-weight:600;}
.pgh-input button:hover{background:var(--accent); color:var(--ink);}
.pgh-findings{list-style:none; padding:0; margin:0 0 16px; display:flex; flex-direction:column; gap:8px;}
.pgh-findings li{display:flex; justify-content:space-between; gap:10px; background:#fff; border:1.5px solid var(--ink); border-radius:2px; padding:9px 11px; font-size:13px;}
.pgh-findings li.pgh-empty{justify-content:center; color:var(--dim); border-style:dashed; font-style:italic;}
.pgh-x{background:none; border:none; color:var(--dim); cursor:pointer; font-size:18px; line-height:1;}
.pgh-x:hover{color:var(--high);}
.pgh-results{animation:fade .35s ease;}
@keyframes fade{from{opacity:0; transform:translateY(6px);}to{opacity:1;}}
.pgh-scores{display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:20px;}
.pgh-score{border:2px solid var(--ink); border-radius:3px; padding:18px; text-align:center; background:var(--paper); box-shadow:4px 4px 0 var(--ink);}
.pgh-score.primary{background:var(--accent);}
.pgh-ring{width:84px; height:84px; border-radius:50%; margin:0 auto 10px; display:grid; place-items:center; border:2px solid var(--ink);
  background:conic-gradient(var(--ink) calc(var(--p)*1%), #fff 0);}
.pgh-ring span{width:60px; height:60px; border-radius:50%; background:var(--paper); display:grid; place-items:center; font-size:21px; color:var(--ink); border:1px solid var(--ink);}
.pgh-mono.big{font-size:21px;}
.pgh-score.time .big{margin-top:20px; color:var(--ink);}
.pgh-score-label{font-family:'JetBrains Mono',monospace; font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--dim);}
.pgh-score.primary .pgh-score-label{color:var(--ink-soft);}
.pgh-verdict{font-family:'Bricolage Grotesque',sans-serif; font-weight:700; font-size:22px; text-align:center; color:var(--ink); margin:8px auto 28px; max-width:640px; line-height:1.3; letter-spacing:-.3px;}
.pgh-cols{display:grid; grid-template-columns:1fr 1fr; gap:22px;}
.pgh-cols h4{font-family:'Bricolage Grotesque',sans-serif; font-weight:700; font-size:17px; margin:0 0 12px; padding-bottom:8px; border-bottom:3px solid var(--ink);}
.pgh-row{display:flex; gap:11px; align-items:flex-start; padding:11px 0; border-bottom:1px solid var(--soft-line);}
.pgh-row strong{font-size:13.5px; font-weight:600; display:block;}
.pgh-row em{font-size:12px; color:var(--dim); font-style:normal; display:block; margin-top:3px;}
.pgh-badge{font-family:'JetBrains Mono',monospace; font-size:10px; padding:3px 7px; border-radius:2px; white-space:nowrap; border:1.5px solid var(--ink); background:#fff; font-weight:600;}
.v-matched .pgh-badge{background:var(--accent); color:var(--ink);}
.v-novel .pgh-badge{background:var(--ink); color:var(--paper);}
.v-false_positive .pgh-badge{color:var(--dim); border-color:var(--soft-line);}
.v-false_positive strong{color:var(--dim); text-decoration:line-through;}
.pgh-sev{font-family:'JetBrains Mono',monospace; font-size:10px; color:#fff; padding:3px 7px; border-radius:2px; font-weight:700; white-space:nowrap; border:1.5px solid var(--ink);}
.pgh-clean{color:var(--low); font-size:14px; font-weight:500;}
.pgh-key{margin-top:24px; border:2px solid var(--ink); border-radius:3px; padding:6px 18px 14px; background:var(--paper); box-shadow:4px 4px 0 var(--ink);}
.pgh-key summary{cursor:pointer; padding:12px 0; font-family:'Bricolage Grotesque',sans-serif; font-weight:700; font-size:16px; color:var(--ink);}
.pgh-foot{margin-top:30px; text-align:center; color:var(--dim); font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.5px; text-transform:uppercase;}
.pgh-foot{display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:6px 16px;}
.pgh-foot a{color:var(--ink); text-decoration:none; border-bottom:2px solid var(--accent); padding-bottom:1px; text-transform:uppercase;}
.pgh-foot a:hover{background:var(--accent);}
.pgh-foot-links{display:inline-flex; gap:16px;}
@media (max-width:760px){ .pgh-grid,.pgh-cols{grid-template-columns:1fr;} .pgh-scores{grid-template-columns:1fr 1fr;} .pgh-chips{grid-template-columns:1fr;} }
`;