// The part of apps.mjs that TypeScript callers import: the lane e2e specs
// read their app's catalog version with `appVersion`. The rest of apps.mjs
// is only imported from plain JavaScript; declare an export here before
// importing it from TypeScript.
export function appVersion(id: string, base?: string): string;
