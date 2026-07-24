import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CompiledFlow, CompiledSingleActorFlow } from "@polymux/protocol";
import { compileFlowFile, compileSingleActorFlowFile } from "./compiler.js";

export interface BuildResult {
  plan: CompiledFlow;
  outputPath: string;
}

export async function buildFlowFiles(
  files: string[],
  projectDir: string,
): Promise<BuildResult[]> {
  const outputDir = resolve(projectDir, ".polymux/cache");
  await mkdir(outputDir, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const plan = await compileFlowFile(file);
      const name = basename(file).replace(/\.flow\.ya?ml$/i, "");
      const outputPath = join(outputDir, `${name}.pmx`);
      await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      return { plan, outputPath };
    }),
  );
}

export async function buildSingleActorFlowFiles(
  files: string[],
  projectDir: string,
): Promise<Array<{ plan: CompiledSingleActorFlow; outputPath: string }>> {
  const outputDir = resolve(projectDir, ".polymux/cache");
  await mkdir(outputDir, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const plan = await compileSingleActorFlowFile(file);
      const name = basename(file).replace(/\.flow\.ya?ml$/i, "");
      const outputPath = join(outputDir, `${name}.pmx`);
      await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      return { plan, outputPath };
    }),
  );
}
