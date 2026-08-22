export interface ChildCapabilities {
  builtins: readonly string[];
  hostAdapters: readonly string[];
  rejected: readonly string[];
}

export const GONDOLIN_CHILD_BUILTINS: readonly string[];
export const AUDITED_CHILD_HOST_ADAPTERS: readonly string[];

export function splitChildCapabilities(
  activeTools?: readonly unknown[],
  options?: { excluded?: Iterable<string> },
): ChildCapabilities;

export function childToolCliArgs(capabilities: ChildCapabilities): string[];
