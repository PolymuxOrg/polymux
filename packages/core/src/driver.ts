import type {
  Capability,
  CompiledFlowItem,
  CompiledStep,
  CompiledSingleActorFlow,
  LocatorStrategy,
  Platform,
} from "@polymux/protocol";

export interface DriverExecutionResult {
  message?: string;
  selectedStrategy?: LocatorStrategy;
  artifacts?: string[];
}

export interface ScopedHeaderRule {
  origins: string[];
  headers: Record<string, string>;
}

export interface DriverSessionContext {
  plan: CompiledSingleActorFlow;
  runId: string;
  projectDir: string;
  artifactsDir: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  scopedHeaders?: ScopedHeaderRule[];
  containsSecrets: boolean;
  updateSnapshots: boolean;
}

export interface DriverSession {
  execute(step: CompiledStep): Promise<DriverExecutionResult | void>;
  captureFailure?(step: CompiledStep): Promise<string[]>;
  close(): Promise<string[] | void>;
}

export interface Driver {
  readonly id: string;
  readonly platform: Platform;
  readonly capabilities: ReadonlySet<Capability>;
  readonly supportsScopedHeaders?: boolean;
  createSession(context: DriverSessionContext): Promise<DriverSession>;
}

export function flattenCompiledItems(items: CompiledFlowItem[]): CompiledStep[] {
  return items.flatMap((item) =>
    item.kind === "flow"
      ? [
          ...flattenCompiledItems(item.flow.setup),
          ...flattenCompiledItems(item.flow.steps),
          ...flattenCompiledItems(item.flow.teardown),
        ]
      : [item],
  );
}

export function executableSteps(plan: CompiledSingleActorFlow): CompiledStep[] {
  return flattenCompiledItems([
    ...plan.setup,
    ...plan.steps,
    ...plan.teardown,
  ]);
}

export function missingCapabilities(
  plan: CompiledSingleActorFlow,
  driver: Driver,
): Capability[] {
  return executableSteps(plan)
    .filter((step) => {
      if (step.kind !== "platform") return true;
      return step.input.on === driver.platform;
    })
    .map((step) => step.capability)
    .filter(
      (capability, index, all) =>
        !capability.startsWith("coordination.") &&
        !capability.startsWith("messaging.") &&
        !driver.capabilities.has(capability) &&
        !(
          capability.startsWith(`extension.${driver.platform}.`) &&
          driver.capabilities.has(`extension.${driver.platform}.*`)
        ) &&
        all.indexOf(capability) === index,
    );
}
