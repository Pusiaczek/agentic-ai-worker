import type { Role } from "../schema/status";

export type Identity = { kind: "main" } | { kind: "role"; role: Role } | { kind: "other"; agentType: string };

/** Plugin agents report agent_type "aw:coder" (tolerate a "plugin:" prefix). No agent_type = the main session. */
const AW_AGENT = /(?:^|:)aw:(tester|reviewer|coder)$/;

export function identify(agentType: unknown): Identity {
  if (typeof agentType !== "string" || agentType === "") return { kind: "main" };
  const m = AW_AGENT.exec(agentType);
  return m ? { kind: "role", role: m[1] as Role } : { kind: "other", agentType };
}
