/** Phase-0 verification gate (design §8). A *checker* is the build+test command
 *  the dev Loop's `tester` agent runs to produce an objective green/red verdict
 *  for the triple-judgment (design §7.3). This module is the single source of
 *  truth mapping a target repository alias to its checker commands.
 *
 *  Pure (no I/O): resolution is data-driven so both LOOP.md (the contract) and
 *  the `tester` subagent (runtime) read the same commands. The map was verified
 *  against the cxin workspace's real repositories (cargoware multi-module Maven,
 *  cargoware-h5 Vue+Jest, cargo-report-server-haichuang single-module Maven).
 *
 *  Repositories without a usable build/test gate (cargoapi: no root pom; cargo-h5-mp:
 *  no confirmed test script) return null — the Phase-0 finding — so the dev Loop
 *  never selects them as a checker-backed target. */

export interface CheckerCommands {
  /** Whether the command is scoped to one Maven module (`mvn -pl <module>`). When
   *  true, `resolveChecker` requires a non-empty `module` and substitutes `{module}`. */
  readonly moduleScoped: boolean;
  /** Build command (compile-only gate). Omitted for repos where the test command
   *  is already self-contained (e.g. `npm run test:ci` lints+tests). */
  readonly build?: readonly string[];
  /** Test command (the green/red teeth). */
  readonly test: readonly string[];
}

/** Shell-tokenized checker commands after `{module}` substitution, ready to run. */
export interface ResolvedChecker {
  readonly build?: readonly string[];
  readonly test: readonly string[];
}

const CARGOWARE: CheckerCommands = {
  moduleScoped: true,
  build: ["mvn", "-pl", "{module}", "-am", "compile", "-q"],
  test: ["mvn", "-pl", "{module}", "test"],
};

const CARGOWARE_H5: CheckerCommands = {
  moduleScoped: false,
  // test:ci = "npm run lint && npm run test:unit" — lint + Vue/Jest unit tests.
  test: ["npm", "run", "test:ci"],
};

const CARGO_REPORT_SERVER: CheckerCommands = {
  moduleScoped: false,
  test: ["mvn", "test"],
};

/** Ordered registry. The first alias match wins. */
const REGISTRY: ReadonlyArray<{ aliases: readonly string[]; commands: CheckerCommands }> = [
  { aliases: ["cargoware"], commands: CARGOWARE },
  { aliases: ["cargoware-h5"], commands: CARGOWARE_H5 },
  { aliases: ["cargo-report-server-haichuang"], commands: CARGO_REPORT_SERVER },
];

/** Look up the checker commands for a repository alias. Returns null for aliases
 *  with no usable build/test gate (cargoapi, cargo-h5-mp) — the Phase-0 finding. */
export function repoCheckerCommands(alias: string): CheckerCommands | null {
  const entry = REGISTRY.find((row) => row.aliases.includes(alias));
  return entry ? entry.commands : null;
}

/** Resolve a checker to shell-tokenized commands, substituting the Maven module
 *  when the repo is module-scoped. Returns null when the alias has no checker,
 *  or when a module-scoped alias is invoked without a module. */
export function resolveChecker(alias: string, module?: string): ResolvedChecker | null {
  const commands = repoCheckerCommands(alias);
  if (!commands) return null;
  if (commands.moduleScoped) {
    const normalized = module?.trim();
    if (!normalized) return null;
    const substitute = (tokens: readonly string[]) =>
      tokens.map((token) => token.replace(/\{module\}/g, normalized));
    return {
      ...(commands.build ? { build: substitute(commands.build) } : {}),
      test: substitute(commands.test),
    };
  }
  return {
    ...(commands.build ? { build: [...commands.build] } : {}),
    test: [...commands.test],
  };
}

/** Whether an alias is a valid checker-backed target at all (used by the
 *  dev Loop's orient step to short-circuit unsupported repos). */
export function hasChecker(alias: string): boolean {
  return repoCheckerCommands(alias) !== null;
}
