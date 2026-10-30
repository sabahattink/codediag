import { formatDelta } from "../core/compare.js";
import { activeIssues, inactiveCounts } from "../core/issues.js";
import {
  ANALYZER_WEIGHTS,
  DEFAULT_ANALYZER_WEIGHT,
  formatPenalty,
} from "../core/scoring.js";
import { ruleDocsUrl } from "../rules/registry.js";
import type {
  AnalyzerResult,
  ComparisonSummary,
  DiagnosticIssue,
  HistoryPoint,
  ScanResult,
  ScanScope,
  WorkspaceSummary,
} from "../types.js";

type Tone = "good" | "warn" | "bad";

const SEVERITY_ORDER: Record<DiagnosticIssue["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
/** Circumference of the score gauge's ring (r = 52). */
const GAUGE_LENGTH = 2 * Math.PI * 52;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scoreTone(score: number): Tone {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function deltaTone(delta: number): string {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

function issueLocation(issue: { file?: string; line?: number }): string {
  if (!issue.file) return "";
  return issue.line ? `${issue.file}:${issue.line}` : issue.file;
}

function renderGauge(result: ScanResult): string {
  const tone = scoreTone(result.totalScore);
  const filled =
    (Math.max(0, Math.min(100, result.totalScore)) / 100) * GAUGE_LENGTH;
  return `<div class="total ${tone}" aria-label="Total score ${result.totalScore} out of 100, grade ${escapeHtml(result.grade)}">
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="52"/><circle class="value" cx="60" cy="60" r="52" stroke-dasharray="${filled.toFixed(1)} ${GAUGE_LENGTH.toFixed(1)}"/></svg>
      <div><strong>${result.totalScore}</strong><span>${escapeHtml(result.grade)} / 100</span></div>
    </div>`;
}

function renderBreakdown(analyzer: AnalyzerResult): string {
  if (!analyzer.scoreBreakdown?.length) return "";
  const rows = analyzer.scoreBreakdown
    .map(
      (entry) =>
        `<li><code>${escapeHtml(entry.rule)}</code><span>×${entry.count}</span><strong>${formatPenalty(entry.penalty)}</strong></li>`,
    )
    .join("");
  return `
    <ul class="breakdown" aria-label="Points lost by rule">${rows}</ul>`;
}

function renderAnalyzer(
  analyzer: AnalyzerResult,
  comparison: ComparisonSummary | undefined,
): string {
  const tone = scoreTone(analyzer.score);
  const weight = ANALYZER_WEIGHTS[analyzer.name] ?? DEFAULT_ANALYZER_WEIGHT;
  const delta = comparison?.analyzers.find(
    (entry) => entry.name === analyzer.name,
  )?.delta;
  // Unchanged analyzers show no delta, as in the terminal report.
  const change =
    delta === null || delta === undefined || delta === 0
      ? ""
      : `<span class="delta ${deltaTone(delta)}" title="Change since the previous scan">${formatDelta(delta)}</span>`;
  return `<article class="analyzer ${tone}" aria-label="${escapeHtml(analyzer.name)} score ${analyzer.score} out of 100">
    <div class="analyzer-head">
      <h3>${escapeHtml(analyzer.name)}</h3>
      <span class="weight">${weight}% of total</span>
    </div>
    <div class="analyzer-score"><strong class="score">${analyzer.score}</strong>${change}</div>
    <div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${analyzer.score}">
      <span style="width:${analyzer.score}%"></span>
    </div>
    <p>${escapeHtml(analyzer.summary)}</p>${renderBreakdown(analyzer)}
  </article>`;
}

function renderIssue(issue: DiagnosticIssue, analyzerName: string): string {
  const location = issueLocation(issue);
  const search = [issue.message, issue.rule, analyzerName, location]
    .join(" ")
    .toLowerCase();
  const badges = [
    issue.isNew ? '<span class="tag new">new</span>' : "",
    issue.confidence && issue.confidence !== "high"
      ? `<span class="tag">${escapeHtml(issue.confidence)} confidence</span>`
      : "",
  ].join("");
  return `<article class="issue" data-severity="${issue.severity}"${issue.isNew ? ' data-new="true"' : ""} data-search="${escapeHtml(search)}">
    <div class="issue-main">
      <span class="severity ${issue.severity}">${issue.severity}</span>
      <div>
        <h3>${badges}${escapeHtml(issue.message)}</h3>
        <p class="rule">${escapeHtml(analyzerName)} / ${escapeHtml(issue.rule)}${issue.causedBy ? ` · caused by ${escapeHtml(issue.causedBy)}` : ""}</p>
      </div>
    </div>
    <div class="issue-meta">${location ? `<code>${escapeHtml(location)}</code>` : ""}<a href="${escapeHtml(ruleDocsUrl(issue.rule))}" target="_blank" rel="noreferrer">Rule docs</a></div>
    ${issue.fix ? `<p class="fix"><strong>Suggested fix</strong>${escapeHtml(issue.fix)}</p>` : ""}
  </article>`;
}

/** Plot area of the history chart, in viewBox units. */
const CHART = {
  width: 720,
  height: 230,
  left: 44,
  right: 676,
  top: 18,
  bottom: 196,
};
const GRADE_LINES: Array<[number, string]> = [
  [90, "A"],
  [80, "B"],
  [70, "C"],
  [60, "D"],
];

function chartY(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return CHART.bottom - (clamped / 100) * (CHART.bottom - CHART.top);
}

function renderHistoryTable(history: HistoryPoint[]): string {
  const names = [
    ...new Set(history.flatMap((point) => Object.keys(point.analyzers))),
  ];
  const head = names
    .map((name) => `<th scope="col">${escapeHtml(name)}</th>`)
    .join("");
  const rows = [...history]
    .reverse()
    .map(
      (point) =>
        `<tr><td><time datetime="${escapeHtml(point.timestamp)}">${escapeHtml(point.timestamp.slice(0, 16).replace("T", " "))}</time></td><td class="num"><strong>${point.totalScore}</strong> ${escapeHtml(point.grade)}</td>${names
          .map((name) => `<td class="num">${point.analyzers[name] ?? "—"}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<details class="history-table"><summary>Show the ${history.length} scans as a table</summary><div class="table-scroll"><table><thead><tr><th scope="col">Scan</th><th scope="col">Total</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/** The total score over recorded scans: one line, grade guides, hover readouts. */
function renderHistory(history: HistoryPoint[]): string {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || history.length < 2) {
    return `<section aria-labelledby="history-title">
    <div class="section-head"><h2 id="history-title">Score history</h2><p>First recorded scan; the trend appears after the next one.</p></div>
  </section>`;
  }
  const step = (CHART.right - CHART.left) / (history.length - 1);
  const points = history.map((point, index) => ({
    point,
    x: CHART.left + index * step,
    y: chartY(point.totalScore),
  }));
  const line = points
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const guides = GRADE_LINES.map(
    ([score, grade]) =>
      `<line class="guide" x1="${CHART.left}" x2="${CHART.right}" y1="${chartY(score)}" y2="${chartY(score)}"/><text class="guide-label" x="${CHART.right + 8}" y="${chartY(score) + 4}">${grade} ${score}</text>`,
  ).join("");
  const columns = points
    .map(({ point, x, y }, index) => {
      const date = point.timestamp.slice(0, 10);
      const label = `${date}: ${point.totalScore} (${point.grade})`;
      const half = step / 2;
      const left = index === 0 ? CHART.left - 12 : x - half;
      const right = index === points.length - 1 ? CHART.right + 12 : x + half;
      const tipX = Math.min(Math.max(x, CHART.left + 72), CHART.right - 72);
      return `<g class="point" tabindex="0" role="img" aria-label="${escapeHtml(label)}">
        <rect class="hit" x="${left.toFixed(1)}" y="${CHART.top}" width="${(right - left).toFixed(1)}" height="${CHART.bottom - CHART.top}"/>
        <line class="crosshair" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${CHART.top}" y2="${CHART.bottom}"/>
        <circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>
        <g class="tip"><rect x="${(tipX - 72).toFixed(1)}" y="${Math.max(2, y - 34).toFixed(1)}" width="144" height="24" rx="4"/><text x="${tipX.toFixed(1)}" y="${(Math.max(2, y - 34) + 16).toFixed(1)}">${escapeHtml(label)}</text></g>
      </g>`;
    })
    .join("");
  const change = last.totalScore - first.totalScore;
  return `<section aria-labelledby="history-title">
    <div class="section-head"><h2 id="history-title">Score history</h2><p>${first.totalScore} → ${last.totalScore} over ${history.length} scans since <time datetime="${escapeHtml(first.timestamp)}">${escapeHtml(first.timestamp.slice(0, 10))}</time> <span class="delta ${deltaTone(change)}">${formatDelta(change)}</span></p></div>
    <figure class="history">
      <svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="group" aria-label="Total score for each recorded scan">
        <line class="axis" x1="${CHART.left}" x2="${CHART.right}" y1="${CHART.bottom}" y2="${CHART.bottom}"/>
        ${guides}
        <text class="axis-label" x="${CHART.left - 8}" y="${CHART.bottom + 4}" text-anchor="end">0</text>
        <text class="axis-label" x="${CHART.left - 8}" y="${CHART.top + 4}" text-anchor="end">100</text>
        <polyline class="trend" points="${line}"/>
        ${columns}
        <text class="axis-label" x="${CHART.left}" y="${CHART.height - 8}">${escapeHtml(first.timestamp.slice(0, 10))}</text>
        <text class="axis-label" x="${CHART.right}" y="${CHART.height - 8}" text-anchor="end">${escapeHtml(last.timestamp.slice(0, 10))}</text>
      </svg>
    </figure>
    ${renderHistoryTable(history)}
  </section>`;
}

function renderPackages(workspace: WorkspaceSummary): string {
  const cards = workspace.packages
    .map((entry) => {
      const tone = scoreTone(entry.totalScore);
      return `<article class="package ${tone}" aria-label="${escapeHtml(entry.path)} score ${entry.totalScore} out of 100">
      <div class="package-head"><code>${escapeHtml(entry.path)}</code><span class="weight">${escapeHtml(entry.framework)}</span></div>
      ${entry.name ? `<p class="package-name">${escapeHtml(entry.name)}</p>` : ""}
      <div class="analyzer-score"><strong class="score">${entry.totalScore}</strong><span class="delta flat">${escapeHtml(entry.grade)}</span></div>
      <div class="bar" aria-hidden="true"><span style="width:${entry.totalScore}%"></span></div>
      <p>${entry.findings} finding${entry.findings === 1 ? "" : "s"}</p>
    </article>`;
    })
    .join("\n");
  return `<section aria-labelledby="packages-title">
    <div class="section-head"><h2 id="packages-title">Packages</h2><p>${workspace.packages.length} ${escapeHtml(workspace.tool)} workspace packages</p></div>
    <div class="analyzers">${cards}</div>
  </section>`;
}

function renderScope(scope: ScanScope): string {
  return `<p class="banner" role="note"><strong>Scoped scan.</strong> Only findings in the ${scope.files} file${scope.files === 1 ? "" : "s"} changed since <code>${escapeHtml(scope.changedSince)}</code> are reported and scored; ${scope.excludedFindings} finding${scope.excludedFindings === 1 ? "" : "s"} elsewhere were left out.</p>`;
}

function renderComparison(
  comparison: ComparisonSummary,
  score: number,
): string {
  const fixed = comparison.fixed
    .map((finding) => {
      const location = issueLocation(finding);
      return `<li><span class="severity ${finding.severity}">${finding.severity}</span><span>${escapeHtml(finding.message)} <code>${escapeHtml(finding.rule)}</code>${location ? ` <code>${escapeHtml(location)}</code>` : ""}</span></li>`;
    })
    .join("");
  return `<section aria-labelledby="changes-title">
    <div class="section-head"><h2 id="changes-title">Changes</h2><p>Since the scan of <time datetime="${escapeHtml(comparison.previousTimestamp)}">${escapeHtml(comparison.previousTimestamp.slice(0, 10))}</time></p></div>
    <div class="changes">
      <div class="change-score"><span>${comparison.previousScore}</span><span aria-hidden="true">→</span><strong>${score}</strong><span class="delta ${deltaTone(comparison.scoreDelta)}">${formatDelta(comparison.scoreDelta)}</span></div>
      <div class="change-count new-count"><strong>${comparison.newFindings}</strong><span>new findings</span></div>
      <div class="change-count fixed-count"><strong>${comparison.fixedFindings}</strong><span>fixed findings</span></div>
    </div>
    ${fixed ? `<details class="fixed"><summary>Show ${comparison.fixedFindings} fixed finding${comparison.fixedFindings === 1 ? "" : "s"}</summary><ul>${fixed}</ul></details>` : ""}
  </section>`;
}

function notCounted(result: ScanResult): string {
  const { suppressed, baseline } = inactiveCounts(result.analyzers);
  if (suppressed === 0 && baseline === 0) return "";
  return ` · ${suppressed} suppressed, ${baseline} in baseline`;
}

const STYLES = `
:root{color-scheme:light dark;--bg:#f4f5f1;--surface:#fffffd;--surface-2:#eceee7;--grid:rgba(23,33,43,.045);--text:#141a1f;--muted:#58636c;--border:#d6dad1;--accent:#2d4bd8;--good:#147a52;--warn:#a85a00;--bad:#c42d47;--info:#1a66ad;--new:#7a3fd1;--shadow:0 1px 0 rgba(20,26,31,.04),0 10px 30px -18px rgba(20,26,31,.35);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px;color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:40px 0 64px}
a{color:var(--accent)}
code{font-family:var(--mono)}
header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:center;border-bottom:2px solid var(--text);padding-bottom:28px}
.eyebrow{margin:0 0 10px;font:700 .72rem/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.eyebrow b{color:var(--accent)}
.title{margin:0;font-size:clamp(2rem,5vw,4.25rem);line-height:1;letter-spacing:-.03em;overflow-wrap:anywhere}
.meta{margin:12px 0 0;color:var(--muted);font-family:var(--mono);font-size:.85rem}
.stack{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.stack span{border:1px solid var(--border);background:var(--surface);padding:3px 8px;border-radius:3px;font:600 .75rem var(--mono)}
.total{position:relative;display:grid;place-items:center;width:168px;aspect-ratio:1}
.total svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.total circle{fill:none;stroke-width:9}
.total .track{stroke:var(--surface-2)}
.total .value{stroke:var(--tone);stroke-linecap:round}
.total div{text-align:center}
.total strong{display:block;font:800 3rem/1 var(--mono);letter-spacing:-.04em;color:var(--tone)}
.total span{display:block;margin-top:4px;color:var(--muted);font:700 .8rem var(--mono)}
.good{--tone:var(--good)}.warn{--tone:var(--warn)}.bad{--tone:var(--bad)}
section{margin-top:40px}
.section-head{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:14px}
.section-head h2{margin:0;font-size:1.3rem;letter-spacing:-.01em}
.section-head p{margin:0;color:var(--muted)}
.banner{margin:24px 0 0;padding:12px 16px;border:1px solid var(--accent);background:var(--surface);border-radius:4px}
.analyzers{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.analyzer,.package,.issue,.changes>div,.fixed{border:1px solid var(--border);border-radius:6px;background:var(--surface);box-shadow:var(--shadow)}
.analyzer,.package{padding:16px 18px;border-top:4px solid var(--tone)}
.package-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.package-head code{font-weight:700;font-size:.85rem;overflow-wrap:anywhere}
.package-name{margin:4px 0 0;color:var(--muted);font-size:.8rem}
.analyzer-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.analyzer h3{margin:0;font-size:.95rem}
.weight{color:var(--muted);font:600 .7rem var(--mono);white-space:nowrap}
.analyzer-score{display:flex;align-items:baseline;gap:10px;margin-top:8px}
.score{font:800 2rem/1 var(--mono);color:var(--tone);letter-spacing:-.03em}
.delta{font:700 .8rem var(--mono);padding:2px 6px;border-radius:3px;background:var(--surface-2)}
.delta.up{color:var(--good)}.delta.down{color:var(--bad)}.delta.flat{color:var(--muted)}
.bar{height:6px;margin:12px 0;background:var(--surface-2);border-radius:3px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--tone)}
.analyzer p,.package p{margin:0;color:var(--muted);font-size:.85rem}
.breakdown{display:grid;gap:4px;margin:12px 0 0;padding:10px 0 0;border-top:1px dashed var(--border);list-style:none;font-size:.8rem}
.breakdown li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:baseline}
.breakdown code{font-size:.74rem;overflow-wrap:anywhere}
.breakdown span{color:var(--muted)}
.breakdown strong{color:var(--bad);font-family:var(--mono);white-space:nowrap}
.changes{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}
.changes>div{padding:16px 18px}
.change-score{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-family:var(--mono)}
.change-score span:first-child{font-size:1.4rem;color:var(--muted)}
.change-score strong{font-size:2rem;line-height:1}
.change-count strong{display:block;font:800 1.6rem/1.1 var(--mono)}
.change-count span{color:var(--muted);font-size:.85rem}
.new-count strong{color:var(--new)}.fixed-count strong{color:var(--good)}
.fixed{margin-top:12px;padding:12px 16px}
.fixed summary{cursor:pointer;font-weight:700}
.fixed ul{display:grid;gap:8px;margin:12px 0 0;padding:0;list-style:none}
.fixed li{display:flex;gap:10px;align-items:baseline}
.fixed li>span:last-child{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--border)}
.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.summary div{border-top:3px solid var(--tone);background:var(--surface);padding:12px 15px}
.summary strong{display:block;font:800 1.3rem var(--mono)}
.summary span{color:var(--muted);font-size:.82rem}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;margin:14px 0}
.filters{display:flex;flex-wrap:wrap;gap:6px}
.filters button,.toolbar input{border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);padding:7px 11px;font:inherit;font-size:.85rem}
.filters button{font-weight:700;cursor:pointer}
.filters button[aria-pressed="true"]{border-color:var(--text);background:var(--text);color:var(--surface)}
.toolbar input{min-width:min(280px,100%);font-family:var(--mono)}
button:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.issues{display:grid;gap:10px}
.issue{padding:16px 18px}
.issue[hidden]{display:none}
.issue-main{display:flex;gap:12px;align-items:flex-start}
.issue h3{margin:0;font-size:1rem}
.severity{flex:0 0 auto;border:1px solid currentColor;border-radius:3px;padding:1px 6px;font:800 .68rem var(--mono);text-transform:uppercase}
.critical{color:var(--bad)}.warning{color:var(--warn)}.info{color:var(--info)}
.tag{display:inline-block;margin-right:8px;padding:1px 6px;border-radius:3px;background:var(--surface-2);color:var(--muted);font:700 .68rem var(--mono);text-transform:uppercase;vertical-align:2px}
.tag.new{background:var(--new);color:#fff}
.rule{margin:3px 0 0;color:var(--muted);font:500 .78rem var(--mono)}
.issue-meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:12px;font-size:.82rem}
.issue-meta code{padding:4px 7px;background:var(--surface-2);border-radius:3px;overflow-wrap:anywhere}
.fix{display:grid;gap:2px;margin:12px 0 0;padding-top:12px;border-top:1px dashed var(--border);color:var(--muted)}
.fix strong{color:var(--text);font:700 .72rem var(--mono);letter-spacing:.08em;text-transform:uppercase}
.empty{border:1px dashed var(--border);padding:28px;text-align:center;color:var(--muted);background:var(--surface)}
footer{margin-top:42px;padding-top:18px;border-top:2px solid var(--text);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:.8rem}
.history{margin:0;padding:12px 8px 4px;overflow-x:auto;border:1px solid var(--border);border-radius:6px;background:var(--surface);box-shadow:var(--shadow)}
.history svg{display:block;width:100%;min-width:600px;height:auto;overflow:visible}
.history .axis{stroke:var(--muted);stroke-width:1}
.history .guide{stroke:var(--border);stroke-width:1;stroke-dasharray:3 4}
.history .guide-label,.history .axis-label{fill:var(--muted);font:600 12px var(--mono)}
.history .trend{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.history .dot{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.history .hit{fill:transparent}
.history .crosshair{stroke:var(--muted);stroke-width:1;opacity:0}
.history .tip{opacity:0;pointer-events:none}
.history .tip rect{fill:var(--text)}
.history .tip text{fill:var(--surface);font:700 12px var(--mono);text-anchor:middle}
.history .point{outline:none}
.history .point:hover .crosshair,.history .point:focus-visible .crosshair,.history .point:hover .tip,.history .point:focus-visible .tip{opacity:1}
.history .point:focus-visible .dot{stroke:var(--accent);stroke-width:3;r:6}
.history-table{margin-top:10px}
.history-table summary{cursor:pointer;font-weight:700}
.table-scroll{overflow-x:auto}
.history-table table{width:100%;margin-top:10px;border-collapse:collapse;font-size:.85rem}
.history-table th,.history-table td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
.history-table .num{text-align:right;font-family:var(--mono)}
@media(max-width:680px){main{width:calc(100% - 24px);padding-top:24px}header{grid-template-columns:1fr}.total{width:132px}.section-head{align-items:start;flex-direction:column}.summary,.changes{grid-template-columns:1fr}.issue-main{flex-direction:column}footer{flex-direction:column}}
@media(prefers-color-scheme:dark){:root{--bg:#0e1214;--surface:#151b1e;--surface-2:#222a2e;--grid:rgba(240,243,246,.035);--text:#eef2f3;--muted:#9aa6ad;--border:#2c363b;--accent:#8c9cff;--good:#4cc493;--warn:#f0a44b;--bad:#ff6b81;--info:#66aef5;--new:#b48cff;--shadow:none}}
@media print{body{background:#fff}.toolbar{display:none}.issue[hidden]{display:block}.analyzer,.issue,.changes>div{box-shadow:none;break-inside:avoid}}
`;

const SCRIPT = `
const buttons = document.querySelectorAll('[data-filter]');
const findings = document.querySelectorAll('[data-severity]');
const search = document.querySelector('#finding-search');
const shown = document.querySelector('#shown-count');
let filter = 'all';
function apply() {
  const query = (search && search.value || '').trim().toLowerCase();
  let count = 0;
  for (const finding of findings) {
    const matchesFilter = filter === 'all' || (filter === 'new' ? finding.dataset.new === 'true' : finding.dataset.severity === filter);
    const visible = matchesFilter && (!query || finding.dataset.search.includes(query));
    finding.hidden = !visible;
    if (visible) count += 1;
  }
  if (shown) shown.textContent = String(count);
}
for (const button of buttons) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const candidate of buttons) candidate.setAttribute('aria-pressed', String(candidate === button));
  apply();
});
if (search) search.addEventListener('input', apply);
`;

export function renderHtml(result: ScanResult): string {
  const analyzers = result.analyzers
    .map((analyzer) => renderAnalyzer(analyzer, result.comparison))
    .join("\n");
  const ordered = result.analyzers
    .flatMap((analyzer) =>
      activeIssues(analyzer).map((issue) => ({ issue, name: analyzer.name })),
    )
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.issue.severity] -
        SEVERITY_ORDER[right.issue.severity],
    );
  const issues = ordered.map(({ issue, name }) => renderIssue(issue, name));
  const counts = { critical: 0, warning: 0, info: 0, new: 0 };
  for (const { issue } of ordered) {
    counts[issue.severity] += 1;
    if (issue.isNew) counts.new += 1;
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(result.project)} · CodeDiag report</title>
  <style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <div>
      <p class="eyebrow"><b>CodeDiag</b> · project health report</p>
      <h1 class="title">${escapeHtml(result.project)}</h1>
      <p class="meta">Generated <time datetime="${generated}">${generated.slice(0, 16).replace("T", " ")} UTC</time>${result.scoringVersion ? ` · scoring v${result.scoringVersion}` : ""}</p>
      <div class="stack" aria-label="Detected stack">${stack}</div>
    </div>
    ${renderGauge(result)}
  </header>
  ${result.scope ? renderScope(result.scope) : ""}
  ${result.comparison ? renderComparison(result.comparison, result.totalScore) : ""}
  ${result.history ? renderHistory(result.history) : ""}
  ${result.workspace ? renderPackages(result.workspace) : ""}

  <section aria-labelledby="scores-title">
    <div class="section-head"><h2 id="scores-title">Analyzer scores</h2><p>${result.analyzers.length} analyzers completed</p></div>
    <div class="analyzers">${analyzers}</div>
  </section>

  <section aria-labelledby="issues-title">
    <div class="section-head">
      <div><h2 id="issues-title">Findings</h2><p>${issues.length} issues require review${notCounted(result)}</p></div>
    </div>
    <div class="summary" aria-label="Finding counts">
      <div class="bad"><strong>${counts.critical}</strong><span>critical</span></div>
      <div class="warn"><strong>${counts.warning}</strong><span>warnings</span></div>
      <div style="--tone:var(--info)"><strong>${counts.info}</strong><span>information</span></div>
    </div>
    <div class="toolbar">
      <div class="filters" role="group" aria-label="Filter findings by severity">
        <button type="button" data-filter="all" aria-pressed="true">All ${issues.length}</button>
        <button type="button" data-filter="critical" aria-pressed="false">Critical ${counts.critical}</button>
        <button type="button" data-filter="warning" aria-pressed="false">Warning ${counts.warning}</button>
        <button type="button" data-filter="info" aria-pressed="false">Info ${counts.info}</button>${result.comparison ? `\n        <button type="button" data-filter="new" aria-pressed="false">New ${counts.new}</button>` : ""}
      </div>
      <input id="finding-search" type="search" placeholder="Filter by text, rule, or file" aria-label="Filter findings by text, rule, or file" aria-describedby="shown-status">
    </div>
    <p id="shown-status" class="meta" aria-live="polite"><span id="shown-count">${issues.length}</span> shown</p>
    <div class="issues">
      ${issues.length > 0 ? issues.join("\n") : '<p class="empty">No findings. All enabled checks passed.</p>'}
    </div>
  </section>

  <footer><span>Generated locally. No source code was uploaded.</span><a href="https://github.com/sabahattink/codediag">CodeDiag on GitHub</a></footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
