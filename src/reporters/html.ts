import type { AnalyzerResult, DiagnosticIssue, ScanResult } from "../types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scoreTone(score: number): "good" | "warn" | "bad" {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function issueLocation(issue: DiagnosticIssue): string {
  if (!issue.file) return "";
  return issue.line ? `${issue.file}:${issue.line}` : issue.file;
}

function renderAnalyzer(analyzer: AnalyzerResult): string {
  const tone = scoreTone(analyzer.score);
  return `<article class="analyzer" aria-label="${escapeHtml(analyzer.name)} score ${analyzer.score} out of 100">
    <div class="analyzer-head">
      <h3>${escapeHtml(analyzer.name)}</h3>
      <strong class="score ${tone}">${analyzer.score}</strong>
    </div>
    <div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${analyzer.score}">
      <span class="${tone}" style="width:${analyzer.score}%"></span>
    </div>
    <p>${escapeHtml(analyzer.summary)}</p>
  </article>`;
}

function renderIssue(issue: DiagnosticIssue, analyzerName: string): string {
  const location = issueLocation(issue);
  return `<article class="issue" data-severity="${issue.severity}">
    <div class="issue-main">
      <span class="severity ${issue.severity}">${issue.severity}</span>
      <div>
        <h3>${escapeHtml(issue.message)}</h3>
        <p class="rule">${escapeHtml(analyzerName)} / ${escapeHtml(issue.rule)}</p>
      </div>
    </div>
    ${location ? `<code>${escapeHtml(location)}</code>` : ""}
    ${issue.fix ? `<p class="fix"><strong>Suggested fix</strong>${escapeHtml(issue.fix)}</p>` : ""}
  </article>`;
}

export function renderHtml(result: ScanResult): string {
  const analyzers = result.analyzers.map(renderAnalyzer).join("\n");
  const issues = result.analyzers.flatMap((analyzer) =>
    analyzer.issues.map((issue) => renderIssue(issue, analyzer.name)),
  );
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const analyzer of result.analyzers) {
    for (const issue of analyzer.issues) counts[issue.severity] += 1;
  }
  const stack = [
    result.stack.framework,
    result.stack.language,
    result.stack.orm,
    result.stack.packageManager,
  ]
    .filter((value): value is string => Boolean(value) && value !== "unknown")
    .map((value) => `<span>${escapeHtml(value)}</span>`)
    .join("");
  const generated = new Date(result.timestamp).toISOString();
  const totalTone = scoreTone(result.totalScore);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(result.project)} · CodeDiag report</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f7fa;--surface:#fff;--surface-2:#eef2f6;--text:#17212b;--muted:#5d6b78;--border:#d7dee5;--accent:#3451db;--good:#16845b;--warn:#b26000;--bad:#c9364f;--info:#176bb3;--shadow:0 8px 24px rgba(28,39,49,.08)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:40px 0 64px}header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end;border-bottom:1px solid var(--border);padding-bottom:28px}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:.78rem;font-weight:800;text-transform:uppercase}.title{margin:0;font-size:clamp(2rem,5vw,4.5rem);line-height:1.02;overflow-wrap:anywhere}.meta{margin:12px 0 0;color:var(--muted)}.stack{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.stack span{border:1px solid var(--border);background:var(--surface);padding:5px 9px;border-radius:4px;font:600 .78rem ui-monospace,SFMono-Regular,Consolas,monospace}.total{display:grid;place-items:center;width:154px;aspect-ratio:1;border:12px solid var(--surface-2);border-top-color:var(--tone);border-right-color:var(--tone);border-radius:50%;background:var(--surface);box-shadow:var(--shadow)}.total strong{display:block;font-size:2.6rem;line-height:1;text-align:center}.total span{display:block;color:var(--muted);font-weight:700;text-align:center}.good{--tone:var(--good);color:var(--good)}.warn{--tone:var(--warn);color:var(--warn)}.bad{--tone:var(--bad);color:var(--bad)}section{margin-top:38px}.section-head{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:14px}.section-head h2{margin:0;font-size:1.35rem}.section-head p{margin:0;color:var(--muted)}.analyzers{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.analyzer,.issue{border:1px solid var(--border);border-radius:7px;background:var(--surface);box-shadow:var(--shadow)}.analyzer{padding:18px}.analyzer-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.analyzer h3{margin:0;font-size:1rem}.score{font-size:1.45rem}.bar{height:7px;margin:14px 0;background:var(--surface-2);border-radius:2px;overflow:hidden}.bar span{display:block;height:100%;background:var(--tone)}.analyzer p{margin:0;color:var(--muted);font-size:.88rem}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.summary div{border-left:3px solid var(--tone);background:var(--surface);padding:12px 15px}.summary strong{display:block;font-size:1.25rem}.summary span{color:var(--muted);font-size:.82rem}.filters{display:flex;flex-wrap:wrap;gap:6px}.filters button{border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);padding:7px 11px;font:inherit;font-size:.85rem;font-weight:700;cursor:pointer}.filters button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent);color:#fff}.issues{display:grid;gap:10px}.issue{padding:17px 18px}.issue[hidden]{display:none}.issue-main{display:flex;gap:12px;align-items:flex-start}.issue h3{margin:0;font-size:1rem}.severity{flex:0 0 auto;border:1px solid currentColor;border-radius:3px;padding:2px 6px;font-size:.7rem;font-weight:800;text-transform:uppercase}.critical{color:var(--bad)}.warning{color:var(--warn)}.info{color:var(--info)}.rule{margin:3px 0 0;color:var(--muted);font:500 .78rem ui-monospace,SFMono-Regular,Consolas,monospace}.issue code{display:block;width:max-content;max-width:100%;margin-top:12px;padding:5px 7px;background:var(--surface-2);border-radius:3px;overflow-wrap:anywhere;white-space:normal}.fix{display:grid;gap:2px;margin:13px 0 0;padding-top:12px;border-top:1px solid var(--border);color:var(--muted)}.fix strong{color:var(--text);font-size:.78rem;text-transform:uppercase}.empty{border:1px dashed var(--border);padding:28px;text-align:center;color:var(--muted)}footer{margin-top:42px;padding-top:18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:.8rem}footer a{color:var(--accent)}
    @media(max-width:680px){main{width:min(100% - 24px,1180px);padding-top:24px}header{grid-template-columns:1fr;align-items:start}.total{width:120px}.section-head{align-items:start;flex-direction:column}.summary{grid-template-columns:1fr}.issue-main{flex-direction:column}footer{flex-direction:column}}
    @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#151b23;--surface-2:#202833;--text:#f0f3f6;--muted:#9da9b5;--border:#303a46;--accent:#7c8cff;--good:#4ac18e;--warn:#f0a44b;--bad:#ff6b81;--info:#63aaf2;--shadow:none}}
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <p class="eyebrow">CodeDiag project health</p>
      <h1 class="title">${escapeHtml(result.project)}</h1>
      <p class="meta">Generated <time datetime="${generated}">${generated.replace("T", " ").replace(".000Z", " UTC")}</time></p>
      <div class="stack" aria-label="Detected stack">${stack}</div>
    </div>
    <div class="total ${totalTone}" aria-label="Total score ${result.totalScore} out of 100, grade ${escapeHtml(result.grade)}">
      <div><strong>${result.totalScore}</strong><span>${escapeHtml(result.grade)} / 100</span></div>
    </div>
  </header>

  <section aria-labelledby="scores-title">
    <div class="section-head"><h2 id="scores-title">Analyzer scores</h2><p>${result.analyzers.length} analyzers completed</p></div>
    <div class="analyzers">${analyzers}</div>
  </section>

  <section aria-labelledby="issues-title">
    <div class="section-head">
      <div><h2 id="issues-title">Findings</h2><p>${issues.length} issues require review</p></div>
      <div class="filters" role="group" aria-label="Filter findings by severity">
        <button type="button" data-filter="all" aria-pressed="true">All ${issues.length}</button>
        <button type="button" data-filter="critical" aria-pressed="false">Critical ${counts.critical}</button>
        <button type="button" data-filter="warning" aria-pressed="false">Warning ${counts.warning}</button>
        <button type="button" data-filter="info" aria-pressed="false">Info ${counts.info}</button>
      </div>
    </div>
    <div class="summary" aria-label="Finding counts">
      <div class="bad"><strong>${counts.critical}</strong><span>critical</span></div>
      <div class="warn"><strong>${counts.warning}</strong><span>warnings</span></div>
      <div style="--tone:var(--info)"><strong>${counts.info}</strong><span>information</span></div>
    </div>
    <div class="issues" style="margin-top:14px">
      ${issues.length > 0 ? issues.join("\n") : '<p class="empty">No findings. All enabled checks passed.</p>'}
    </div>
  </section>

  <footer><span>Generated locally. No source code was uploaded.</span><a href="https://github.com/sabahattink/codediag">CodeDiag on GitHub</a></footer>
</main>
<script>
  const buttons = document.querySelectorAll('[data-filter]');
  const findings = document.querySelectorAll('[data-severity]');
  for (const button of buttons) button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    for (const candidate of buttons) candidate.setAttribute('aria-pressed', String(candidate === button));
    for (const finding of findings) finding.hidden = filter !== 'all' && finding.dataset.severity !== filter;
  });
</script>
</body>
</html>`;
}
