import type { Role, ToolAnnotations } from "./types.ts";

export type Effect = "allow" | "deny";
export type Grant = {
  id: string;
  subjectType: "role" | "user";
  subject: string; // a role name, or a user id
  serverSlug: string; // "*" or a slug
  toolName: string; // "*" or an upstream tool name; exact only when serverSlug is exact
  effect: Effect;
};

export type Decision = { allowed: boolean; reason: string; grantId?: string };

type Subject = { id: string; role: Role };
type Target = { serverSlug: string; toolName: string; annotations: ToolAnnotations };

// Most specific matching grant wins. Specificity is the subject first (a user rule beats a role rule),
// then the target (a tool rule beats a server rule beats a global rule). At equal specificity a deny
// beats an allow. With no matching grant: admins may do anything, members may call tools the upstream
// marks readOnlyHint=true. A tool with no annotation is treated as a write, which is the MCP default.
export function decide(subject: Subject, target: Target, grants: Grant[]): Decision {
  let best: { score: number; grant: Grant } | null = null;
  for (const grant of grants) {
    const subjectRank = grant.subjectType === "user" ? (grant.subject === subject.id ? 2 : -1) : grant.subject === subject.role ? 1 : -1;
    if (subjectRank < 0) continue;
    if (grant.serverSlug !== "*" && grant.serverSlug !== target.serverSlug) continue;
    if (grant.toolName !== "*" && (grant.serverSlug === "*" || grant.toolName !== target.toolName)) continue;
    const targetRank = grant.toolName !== "*" ? 2 : grant.serverSlug !== "*" ? 1 : 0;
    const score = subjectRank * 10 + targetRank;
    if (!best || score > best.score || (score === best.score && grant.effect === "deny" && best.grant.effect === "allow")) {
      best = { score, grant };
    }
  }
  if (best) return { allowed: best.grant.effect === "allow", reason: `rule ${best.grant.id}`, grantId: best.grant.id };
  if (subject.role === "admin") return { allowed: true, reason: "admin default" };
  if (target.annotations.readOnlyHint === true) return { allowed: true, reason: "read-only tool" };
  return { allowed: false, reason: "members may call read-only tools only" };
}
