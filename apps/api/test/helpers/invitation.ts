import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { hashAccountPassword } from "../../src/accounts.js";
export async function seedInvitation(db: PGlite, phone: string) {
  const code = randomBytes(12).toString("hex");
  await db.query(
    "INSERT INTO accounts(id,phone,invitation_hash) VALUES($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET invitation_hash=$3",
    [randomUUID(), phone, createHash("sha256").update(code).digest("hex")],
  );
  await db.query("UPDATE accounts SET password_hash=$1 WHERE phone=$2", [
    await hashAccountPassword(code),
    phone,
  ]);
  return code;
}
