// Lowercase words joined by single underscores. No "__" and no trailing "_", so
// "{slug}__{tool}" always splits at the first "__".
const SLUG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isSlug(value: string): boolean {
  return value.length >= 2 && value.length <= 32 && SLUG.test(value);
}

export function joinToolName(slug: string, tool: string): string {
  if (!isSlug(slug)) {
    throw new Error(`invalid server slug: ${slug}`);
  }
  if (!tool || tool.includes("__")) {
    throw new Error("upstream tool name must not contain __");
  }
  return `${slug}__${tool}`;
}

export function splitToolName(publicName: string): { slug: string; tool: string } | null {
  const index = publicName.indexOf("__");
  if (index <= 0) return null;
  const slug = publicName.slice(0, index);
  const tool = publicName.slice(index + 2);
  if (!isSlug(slug) || !tool || tool.includes("__")) return null;
  return { slug, tool };
}
