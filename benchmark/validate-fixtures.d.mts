export const DEFAULT_MANIFEST: string

export function validateSyntheticFixtureSet(options?: {
  fixtureDir?: string
  manifestPath?: string
}): Promise<{
  documents: number
  cases: number
  queryClasses: number
  parsedById: Map<string, string>
}>
