import fs from "node:fs";
import path from "node:path";
import { renderCommandExamplesMarkdown } from "../src/commands/specs.js";

fs.writeFileSync(
  path.resolve("docs/command-examples.md"),
  renderCommandExamplesMarkdown(),
  "utf8",
);
