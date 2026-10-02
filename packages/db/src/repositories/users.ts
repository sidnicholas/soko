import { getDb } from "../pool";

export class UserProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserProvisionError";
  }
}

export function findUserById(id: string) {
  return getDb().selectFrom("users").select(["id", "email", "display_name", "role", "status"]).where("id", "=", id).executeTakeFirst();
}

export interface ProvisionUserInput {
  /** The identity provider's subject — becomes `users.id` so every FK is the verified identity. */
  id: string;
  email: string;
  displayName: string;
  role: string;
}

/**
 * §22 — first sign-in creates the application-owned user row. Idempotent on
 * `id` (concurrent first requests race safely). An email already held by a
 * DIFFERENT id is refused rather than linked: the email claim is only as
 * trustworthy as the provider's confirmation setting, so adopting an existing
 * row by email would be an account-takeover path.
 */
export async function provisionUser(input: ProvisionUserInput) {
  try {
    await getDb()
      .insertInto("users")
      .values({ id: input.id, email: input.email, display_name: input.displayName, role: input.role })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new UserProvisionError(`Email ${input.email} is already registered to another account`);
    }
    throw err;
  }
  const user = await findUserById(input.id);
  if (!user) throw new UserProvisionError(`User ${input.id} could not be provisioned`);
  return user;
}
