/** Remove ```json fences and surrounding whitespace from a model response. */
export const stripJsonFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
