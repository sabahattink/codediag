import { writeFileSync } from "node:fs";
import { renderRulesMarkdown } from "../src/rules/docs.js";

writeFileSync(
  new URL("../docs/rules.md", import.meta.url),
  renderRulesMarkdown(),
  "utf8",
);
