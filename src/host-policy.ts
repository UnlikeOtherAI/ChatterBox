import { z } from "zod";

export const hostProvider = z.enum(["codex", "claude-code"]);
export const hostModel = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,119}$/);
export const reasoningEffort = z.enum(["low", "medium", "high", "xhigh"]);
const repository = z.string().trim().min(1).max(120);
export const coordinatorGrant = z
  .object({
    coordinator: z.string().min(1).max(200),
    repositories: z.array(repository).min(1).max(20),
    providers: z
      .array(
        z
          .object({
            provider: hostProvider,
            models: z.array(hostModel).min(1).max(16),
            reasoning_efforts: z.array(reasoningEffort).max(4).default([]),
          })
          .strict()
          .refine(
            (v) => v.provider === "codex" || v.reasoning_efforts.length === 0,
            "Explicit reasoning effort is supported only for Codex",
          ),
      )
      .min(1)
      .max(2),
  })
  .strict();
export const coordinatorPolicy = {
  coordinators: z.array(z.string().min(1).max(200)).max(16).default([]),
  coordinator_grants: z.array(coordinatorGrant).max(16).default([]),
};
export type CoordinatorPolicy = {
  coordinators: string[];
  coordinator_grants: z.infer<typeof coordinatorGrant>[];
};
export type LaunchSelection = {
  repository: string;
  provider: string;
  model?: string | null;
  reasoning_effort?: string | null;
};

export function validGrantReferences(
  policy: CoordinatorPolicy,
  repositories: string[],
  providers: string[],
) {
  return policy.coordinator_grants.every(
    (grant) =>
      grant.repositories.every((repository) =>
        repositories.includes(repository),
      ) &&
      grant.providers.every((provider) =>
        providers.includes(provider.provider),
      ),
  );
}

/** Legacy grants preserve provider defaults; explicit selections require an exact scoped grant. */
export function permitsLaunch(
  policy: CoordinatorPolicy,
  coordinator: string,
  request: LaunchSelection,
) {
  if (!request.model)
    return (
      !request.reasoning_effort && policy.coordinators.includes(coordinator)
    );
  return policy.coordinator_grants.some(
    (grant) =>
      grant.coordinator === coordinator &&
      grant.repositories.includes(request.repository) &&
      grant.providers.some(
        (provider) =>
          provider.provider === request.provider &&
          provider.models.includes(request.model!) &&
          (provider.reasoning_efforts.length === 0
            ? !request.reasoning_effort
            : !!request.reasoning_effort &&
              provider.reasoning_efforts.includes(
                request.reasoning_effort as z.infer<typeof reasoningEffort>,
              )),
      ),
  );
}
