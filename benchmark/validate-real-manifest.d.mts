export function validateRealManifest(manifestInput: string | undefined): Promise<{
  manifestPath: string
  documents: number
  cases: number
}>
