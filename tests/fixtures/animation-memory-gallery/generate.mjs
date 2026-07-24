import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { animationCases } from "./cases.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const flows = join(root, "polymux");
await mkdir(flows, { recursive: true });

for (const animationCase of animationCases) {
  const common = `version: 1
platforms: [web]
baseUrl: http://127.0.0.1:4190
timeoutMs: 2000
`;
  const timeline = `${common}name: ${animationCase.name} timeline memory
description: ${animationCase.description}

steps:
  - launch: { app: animation-memory-gallery }
  - clock: { action: install }
  - clock: { action: pause, ms: 1893456000000 }
  - navigate: /scenario/${animationCase.id}
  - activate: { role: button, name: Start animation }
  - clock: { action: advance, ms: 120 }
  - expect: { target: { role: status }, text: "Animation midpoint" }
  - visual: { name: midpoint-frame, target: { css: "${animationCase.target}" }, threshold: 0.005 }
  - clock: { action: advance, ms: 180 }
  - expect: { target: { role: status }, text: "Animation complete" }
  - visual: { name: final-frame, target: { css: "${animationCase.target}" }, threshold: 0.005 }
`;
  const finalOnly = `${common}name: ${animationCase.name} final frame only
description: Control showing that the accidental midpoint defect has the same final frame.

steps:
  - launch: { app: animation-memory-gallery }
  - clock: { action: install }
  - clock: { action: pause, ms: 1893456000000 }
  - navigate: /scenario/${animationCase.id}
  - activate: { role: button, name: Start animation }
  - clock: { action: advance, ms: 300 }
  - expect: { target: { role: status }, text: "Animation complete" }
  - visual: { name: final-frame, target: { css: "${animationCase.target}" }, threshold: 0.005 }
`;
  await writeFile(join(flows, `${animationCase.id}-timeline.flow.yaml`), timeline);
  await writeFile(join(flows, `${animationCase.id}-final-only.flow.yaml`), finalOnly);
}

process.stdout.write(`Generated ${animationCases.length * 2} animation-memory flows.\n`);
