import { readFileSync, writeFileSync } from "node:fs";

const legalNoticePath = new URL("../dist/action.cjs.LEGAL.txt", import.meta.url);
const legalNotice = readFileSync(legalNoticePath, "utf8");

writeFileSync(legalNoticePath, legalNotice.replace(/[\t ]+$/gm, ""), "utf8");
