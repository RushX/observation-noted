import React, { useState, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Policy Gap Hunt — a GRC judgment trainer.
// AI generates an intentionally flawed policy + a hidden answer key.
// You read it and list the gaps. An AI "examiner" grades your findings on
// substance: recall (did you catch the real gaps, weighted by severity) and
// precision (were your findings genuine). Time is shown as context, not score.
// ---------------------------------------------------------------------------

// Calls go to YOUR backend proxy (see gemini-proxy.js), which holds the API key
// server-side. Never put the Gemini key in this file — it ships to the browser.
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
  { key: "Auditor", gaps: 6, note: "Subtle & subtle" },
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
  // Gemini returns clean JSON when responseMimeType=application/json,
  // but we guard-parse anyway in case of stray fences/prose.
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in response");
  return JSON.parse(clean.slice(start, end + 1));
}

const GEN_SYS = `You are a GRC training content generator. Produce a realistic but INTENTIONALLY FLAWED internal policy for a fictional mid-size company. It must read as plausible and professional, yet contain EXACTLY the requested number of distinct, defensible gaps a skilled reviewer should catch (missing elements, vague/unenforceable language, missing owners or timeframes, scope holes, no review cadence, undefined terms, etc.). Do NOT signpost the gaps in the policy text. Return ONLY valid JSON, no markdown fences, shape: {"title":string,"policy":string (plain text, simple SECTION headers + newlines, <=350 words),"gaps":[{"id":"G1","summary":string <=12 words,"severity":"HIGH"|"MEDIUM"|"LOW","explanation":string <=25 words}]}.`;

const GRADE_SYS = `You are a strict but fair GRC examiner grading a policy-gap-review exercise. You receive the policy, the official gap key, and the candidate's findings.
Rules: (1) Match each finding to a key gap if it captures the same issue (semantic, not wording). (2) If a finding is a VALID gap NOT in the key, mark it "novel" and give credit. (3) If it is not a real gap, mark "false_positive". (4) List key gaps the candidate missed. Be generous on phrasing, strict on substance.
Return ONLY valid JSON, no fences: {"findings":[{"text":string,"verdict":"matched"|"novel"|"false_positive","gapId":string|null,"note":string <=18 words}],"missed":[{"id":string,"summary":string,"severity":string}],"recall_pct":int,"precision_pct":int,"severity_weighted_pct":int,"verdict_line":string <=20 words}.
recall_pct = % of key gaps caught. severity_weighted_pct = same but weight HIGH=3, MED=2, LOW=1. precision_pct = valid findings / total findings.`;

export default function PolicyGapHunt() {
  const [stage, setStage] = useState("setup"); // setup | reviewing | results
  const [scenario, setScenario] = useState(SCENARIOS[0].key);
  const [difficulty, setDifficulty] = useState(DIFFICULTY[1]);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState("");

  const [policy, setPolicy] = useState(null); // {title, policy, gaps}
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
      if (!out.policy || !Array.isArray(out.gaps)) throw new Error("Bad shape");
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
        JSON.stringify({ policy: policy.policy, key: policy.gaps, findings })
      );
      setGrade(out);
      setStage("results");
    } catch (e) {
      setError("Grading failed — try again. (" + e.message + ")");
      setLoading(false);
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
            <h2>{policy.title}</h2>
            <pre className="pgh-policy">{policy.policy}</pre>
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
        Prototype · grades on substance, not speed · powered by Gemini
      </footer>
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
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');
.pgh-root{
  --bg:#14130e; --ink:#ece6d6; --dim:#9a937f; --line:#2c2a22;
  --paper:#efe9da; --paper-ink:#26231b;
  --accent:#d8a657; --high:#c44536; --med:#c98a1e; --low:#5b7a6b;
  font-family:'IBM Plex Sans',sans-serif; background:var(--bg); color:var(--ink);
  min-height:100%; padding:28px; max-width:1080px; margin:0 auto;
  background-image:radial-gradient(circle at 18% 0%, #211d14 0%, transparent 55%);
}
.pgh-mono{font-family:'IBM Plex Mono',monospace;}
.pgh-head{display:flex; align-items:center; gap:16px; margin-bottom:22px;}
.pgh-mark{font-family:'Fraunces',serif; font-size:46px; line-height:1; color:var(--accent);
  border:1px solid var(--line); width:64px; height:64px; display:grid; place-items:center; border-radius:10px; background:#1b1810;}
.pgh-head h1{font-family:'Fraunces',serif; font-weight:600; font-size:30px; margin:0; letter-spacing:.3px;}
.pgh-sub{margin:2px 0 0; color:var(--dim); font-size:14px;}
.pgh-timer{margin-left:auto; text-align:right;}
.pgh-timer span{font-size:26px; color:var(--accent);}
.pgh-timer small{display:block; color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:1px;}
.pgh-error{background:#3a1b16; border:1px solid var(--high); color:#f3c9c2; padding:12px 14px; border-radius:8px; margin-bottom:16px; font-size:14px;}
.pgh-card{border:1px solid var(--line); border-radius:14px; padding:26px; background:#1a1710;}
.pgh-field{margin-bottom:24px;}
.pgh-field label{display:block; font-size:12px; text-transform:uppercase; letter-spacing:1.5px; color:var(--dim); margin-bottom:12px;}
.pgh-chips{display:grid; grid-template-columns:1fr 1fr; gap:10px;}
.pgh-chips.row{grid-template-columns:repeat(3,1fr);}
.pgh-chip{text-align:left; background:#211d14; border:1px solid var(--line); border-radius:10px; padding:14px 16px; color:var(--ink); cursor:pointer; transition:.15s; display:flex; flex-direction:column; gap:4px;}
.pgh-chip:hover{border-color:var(--accent);}
.pgh-chip.on{border-color:var(--accent); background:#2a2415; box-shadow:inset 0 0 0 1px var(--accent);}
.pgh-chip strong{font-size:15px;} .pgh-chip span{font-size:12px; color:var(--dim);}
.pgh-chip.sm strong{font-size:14px;}
.pgh-go{width:100%; background:var(--accent); color:#1b1505; border:none; border-radius:10px; padding:15px; font-size:15px; font-weight:600; font-family:inherit; cursor:pointer; transition:.15s;}
.pgh-go:hover{filter:brightness(1.08);}
.pgh-go:disabled{opacity:.55; cursor:wait;}
.pgh-go.ghost{background:transparent; color:var(--accent); border:1px solid var(--line); margin-top:18px;}
.pgh-grid{display:grid; grid-template-columns:1.4fr 1fr; gap:20px; align-items:start;}
.pgh-doc{background:var(--paper); color:var(--paper-ink); border-radius:12px; padding:30px 32px; box-shadow:0 18px 40px rgba(0,0,0,.4);}
.pgh-doc-tag{font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:2px; color:#9a3b30; border-bottom:1px dashed #c9bfa6; padding-bottom:10px; margin-bottom:16px;}
.pgh-doc h2{font-family:'Fraunces',serif; font-weight:600; font-size:23px; margin:0 0 14px;}
.pgh-policy{font-family:'IBM Plex Sans',sans-serif; white-space:pre-wrap; font-size:14px; line-height:1.65; margin:0;}
.pgh-panel{position:sticky; top:20px; border:1px solid var(--line); border-radius:12px; padding:20px; background:#1a1710;}
.pgh-panel h3{font-family:'Fraunces',serif; margin:0 0 6px; font-size:18px;}
.pgh-hint{color:var(--dim); font-size:12.5px; margin:0 0 14px; line-height:1.5;}
.pgh-input{display:flex; gap:8px; margin-bottom:12px;}
.pgh-input input{flex:1; background:#120f0a; border:1px solid var(--line); border-radius:8px; padding:11px 12px; color:var(--ink); font-family:inherit; font-size:13.5px;}
.pgh-input input:focus{outline:none; border-color:var(--accent);}
.pgh-input button{background:#2a2415; color:var(--accent); border:1px solid var(--line); border-radius:8px; padding:0 16px; cursor:pointer; font-family:inherit;}
.pgh-findings{list-style:none; padding:0; margin:0 0 16px; display:flex; flex-direction:column; gap:7px;}
.pgh-findings li{display:flex; justify-content:space-between; gap:10px; background:#211d14; border:1px solid var(--line); border-radius:8px; padding:9px 11px; font-size:13px;}
.pgh-findings li.pgh-empty{justify-content:center; color:var(--dim); border-style:dashed; font-style:italic;}
.pgh-x{background:none; border:none; color:var(--dim); cursor:pointer; font-size:18px; line-height:1;}
.pgh-x:hover{color:var(--high);}
.pgh-results{animation:fade .4s ease;}
@keyframes fade{from{opacity:0; transform:translateY(6px);}to{opacity:1;}}
.pgh-scores{display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:18px;}
.pgh-score{border:1px solid var(--line); border-radius:12px; padding:18px; text-align:center; background:#1a1710;}
.pgh-score.primary{border-color:var(--accent); background:#221d12;}
.pgh-ring{width:84px; height:84px; border-radius:50%; margin:0 auto 10px; display:grid; place-items:center;
  background:conic-gradient(var(--accent) calc(var(--p)*1%), #2c2820 0);}
.pgh-ring span{width:62px; height:62px; border-radius:50%; background:#1a1710; display:grid; place-items:center; font-size:22px; color:var(--accent);}
.pgh-mono.big{font-size:22px;}
.pgh-score.time .big{margin-top:20px; color:var(--dim);}
.pgh-score-label{font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--dim);}
.pgh-verdict{font-family:'Fraunces',serif; font-size:20px; text-align:center; color:var(--ink); margin:6px 0 24px;}
.pgh-cols{display:grid; grid-template-columns:1fr 1fr; gap:20px;}
.pgh-cols h4{font-family:'Fraunces',serif; font-size:16px; margin:0 0 12px; padding-bottom:8px; border-bottom:1px solid var(--line);}
.pgh-row{display:flex; gap:11px; align-items:flex-start; padding:11px 0; border-bottom:1px solid var(--line);}
.pgh-row strong{font-size:13.5px; font-weight:500; display:block;}
.pgh-row em{font-size:12px; color:var(--dim); font-style:normal; display:block; margin-top:3px;}
.pgh-badge{font-family:'IBM Plex Mono',monospace; font-size:10px; padding:3px 7px; border-radius:5px; white-space:nowrap; border:1px solid var(--line);}
.v-matched .pgh-badge{color:var(--low); border-color:var(--low);}
.v-novel .pgh-badge{color:var(--accent); border-color:var(--accent);}
.v-false_positive .pgh-badge{color:var(--high); border-color:var(--high);}
.v-false_positive strong{color:var(--dim); text-decoration:line-through;}
.pgh-sev{font-family:'IBM Plex Mono',monospace; font-size:10px; color:#14130e; padding:3px 7px; border-radius:5px; font-weight:600; white-space:nowrap;}
.pgh-clean{color:var(--low); font-size:14px;}
.pgh-key{margin-top:24px; border:1px solid var(--line); border-radius:12px; padding:6px 18px 14px; background:#1a1710;}
.pgh-key summary{cursor:pointer; padding:12px 0; font-family:'Fraunces',serif; font-size:15px; color:var(--accent);}
.pgh-foot{margin-top:26px; text-align:center; color:var(--dim); font-size:11.5px; letter-spacing:.5px;}
@media (max-width:760px){ .pgh-grid,.pgh-cols{grid-template-columns:1fr;} .pgh-scores{grid-template-columns:1fr 1fr;} .pgh-chips{grid-template-columns:1fr;} }
`;
