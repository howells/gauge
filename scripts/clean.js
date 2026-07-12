import fs from "node:fs";
import path from "node:path";

for (const directory of ["dist", ".package-smoke", "coverage"]) {
  fs.rmSync(path.resolve(directory), { force: true, recursive: true });
}
