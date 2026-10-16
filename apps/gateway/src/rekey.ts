import { SQL } from "bun";
import { decryptSecret, encryptSecret } from "./crypto.ts";

// Re-encrypts every stored upstream credential under CREDENTIAL_KEY. Run it after setting CREDENTIAL_KEY to the
// new key and CREDENTIAL_KEY_PREVIOUS to the old one:
//   kubectl -n platform exec deploy/gateway -c gateway -- bun apps/gateway/src/rekey.ts
// Rows already under the new key are rewritten with a fresh IV, which is harmless. Safe to rerun.
export async function rekey(sql: SQL, current: string, previous?: string): Promise<number> {
  const rows = await sql`select id, credential_ciphertext from mcp_servers where credential_ciphertext is not null`;
  for (const row of rows as Array<{ id: string; credential_ciphertext: string }>) {
    const plain = await decryptSecret(row.credential_ciphertext, current, previous);
    await sql`update mcp_servers set credential_ciphertext = ${await encryptSecret(plain, current)}, updated_at = now() where id = ${row.id}::uuid`;
  }
  return rows.length;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  const current = process.env.CREDENTIAL_KEY;
  if (!url || !current) throw new Error("DATABASE_URL and CREDENTIAL_KEY are required");
  const sql = new SQL(url);
  console.log(`re-encrypted ${await rekey(sql, current, process.env.CREDENTIAL_KEY_PREVIOUS || undefined)} credential(s)`);
  await sql.end();
}
