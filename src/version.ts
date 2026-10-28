// Injected at build time from package.json (tsup `define`; vitest `define` in tests).
declare const __CODEDIAG_VERSION__: string;

export const VERSION: string = __CODEDIAG_VERSION__;
