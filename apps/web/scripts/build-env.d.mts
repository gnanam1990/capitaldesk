export declare const LOCAL_DEFAULTS: Readonly<Record<string, string>>;
export declare function resolveBuildEnv(input: {
  explicit: Record<string, string | undefined>;
  loadedFiles: Record<string, string | undefined>;
}):
  | { ok: true; env: Record<string, string>; applied: string[] }
  | { ok: false; declared: string; missing: string[]; conflictsWith?: string };
