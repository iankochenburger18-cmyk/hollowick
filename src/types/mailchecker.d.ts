// `mailchecker` (https://github.com/FGRibreau/mailchecker) ships no official
// TypeScript types — @types/mailchecker doesn't exist — so this is a minimal
// ambient declaration covering the one function actually used
// (src/lib/abuse-prevention.ts). Its CommonJS export is the checker object
// itself (not a named export), hence `export = `.
declare module "mailchecker" {
  interface MailChecker {
    // Returns false for malformed addresses AND for addresses on its
    // disposable/throwaway-domain blocklist; true otherwise. Synchronous —
    // the blocklist ships bundled with the package, no network call.
    isValid(email: string): boolean;
  }

  const MailChecker: MailChecker;
  export = MailChecker;
}
