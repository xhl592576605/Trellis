export function renderWorkflowPaths(
  content: string,
  projectDir: string,
): string;
export const CONFIG_FILENAME: string;
export interface ExternalStore {
  codeRoot: string;
  storageRoot: string;
  project: string;
  projectDir: string;
  checkoutKey: string;
  runtimeDir: string;
}
export function validateProjectName(name: unknown): string;
export function canonicalPath(value: string): string;
export function checkoutKey(codeRoot: string): string;
export function gitCommonDirOf(codeRoot: string): string | null;
export function assertProjectDirectory(
  storageRoot: string,
  projectDir: string,
): void;
export function checkBinding(
  projectDir: string,
  project: string,
  codeRoot: string,
): Record<string, unknown>;
export function readExternalStore(
  codeRoot: string,
  configPath?: string,
): ExternalStore | null;
export function workflowDirOf(codeRoot: string): string;
export function runtimeDirOf(codeRoot: string): string;
export function findCodeRoot(start: string): string | null;
