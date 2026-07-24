import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scenarios } from "./scenarios.mjs";

const directory = new URL("./polymux/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const scenario of scenarios) {
  const flow = `version: 1
name: ${scenario.name}
description: Regression category - ${scenario.category}.
platforms: [web]
baseUrl: http://127.0.0.1:4180
timeoutMs: 2000

steps:
  - launch: { app: regression-gallery }
${scenario.steps}
`;
  await writeFile(join(directory.pathname, `${scenario.id}.flow.yaml`), flow, "utf8");
}
process.stdout.write(`Generated ${scenarios.length} Polymux regression flows.\n`);
