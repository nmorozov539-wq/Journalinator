import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function collectModules(directory) {
  const modules = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...collectModules(path));
    else if (entry.name.endsWith(".mjs")) modules.push(path);
  }
  return modules;
}

for (const modulePath of collectModules(join(root, "scripts"))) {
  const result = spawnSync(process.execPath, ["--check", modulePath], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

console.log("All module scripts passed syntax checks.");
