export function compositionPackages(source: string): string[]
export function owningPackage(name: string): string
export function diffSnapshot(expected: string[], actual: string[]): { added: string[]; removed: string[] }
export function officialSnapshot(
  packages: string[],
  commandEntries: Array<{ package: string; command: string }>,
  reconciliation: {
    candidatePatterns: string[]
    providerPatterns: string[]
    consumerPatterns: string[]
  },
): {
  candidatePackages: string[]
  humanCommands: string[]
  requiredProviders: string[]
  criticalConsumers: string[]
}
export function discoverHumanCommands(
  harnessRoot: string,
  composedPackages: string[],
): Promise<Array<{ package: string; command: string }>>
