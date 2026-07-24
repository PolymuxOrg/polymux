export class FlowCompileError extends Error {
  readonly category = "compile";

  constructor(message: string, readonly sourcePath?: string) {
    super(message);
    this.name = "FlowCompileError";
  }
}

export class FlowFailure extends Error {
  readonly category = "assertion";

  constructor(message: string) {
    super(message);
    this.name = "FlowFailure";
  }
}

export class RuntimeFailure extends Error {
  readonly category = "runtime";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeFailure";
  }
}
