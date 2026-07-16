import type { ScanResult } from "../types.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function scoreColor(score: number): string {
  if (score >= 90) return "#2ea043";
  if (score >= 80) return "#3fb950";
  if (score >= 70) return "#d29922";
  if (score >= 60) return "#db6d28";
  return "#d1242f";
}

export function renderSvg(result: ScanResult): string {
  const label = "codediag";
  const value = `${result.totalScore}/100 ${result.grade}`;
  const labelWidth = 68;
  const valueWidth = Math.max(70, value.length * 7 + 14);
  const width = labelWidth + valueWidth;
  const labelCenter = labelWidth / 2;
  const valueCenter = labelWidth + valueWidth / 2;
  const title = escapeXml(
    `codediag: ${result.project} ${result.totalScore}/100 (${result.grade})`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}: ${escapeXml(value)}" width="${width}" height="20">`,
    `  <title>${title}</title>`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#fff" stop-opacity=".12"/>`,
    `    <stop offset="1" stop-opacity=".12"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${labelWidth}" height="20" fill="#24292f"/>`,
    `    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${scoreColor(result.totalScore)}"/>`,
    `    <rect width="${width}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `    <text x="${labelCenter}" y="15" fill="#010101" fill-opacity=".3">${label}</text>`,
    `    <text x="${labelCenter}" y="14">${label}</text>`,
    `    <text x="${valueCenter}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>`,
    `    <text x="${valueCenter}" y="14">${escapeXml(value)}</text>`,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}
