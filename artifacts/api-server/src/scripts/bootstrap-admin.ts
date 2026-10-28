import pg from "pg";

type ClerkEmail = {
  email_address: string;
  verification?: { status?: string } | null;
};

type ClerkUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmail[];
};

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error(
    "Uso: pnpm --filter @workspace/api-server run bootstrap-admin -- email@dominio.com",
  );
}

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const databaseUrl = process.env.DATABASE_URL;
if (!clerkSecretKey || !databaseUrl) {
  throw new Error("CLERK_SECRET_KEY e DATABASE_URL têm de estar configurados.");
}

async function bootstrapAdmin(): Promise<void> {
  const url = new URL("https://api.clerk.com/v1/users");
  url.searchParams.append("email_address[]", email!);
  url.searchParams.set("limit", "2");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${clerkSecretKey}` },
  });
  if (!response.ok) {
    throw new Error(`Não foi possível confirmar a conta no Clerk (${response.status}).`);
  }
  const users = (await response.json()) as ClerkUser[];
  if (users.length !== 1) {
    throw new Error(
      users.length === 0
        ? "Não existe uma conta EDUCA com este endereço. Crie-a primeiro e confirme o e-mail."
        : "Foi encontrado mais do que uma conta; a promoção foi cancelada.",
    );
  }

  const clerkUser = users[0]!;
  const emailRecord = clerkUser.email_addresses?.find(
    (item) =>
      item.email_address.toLowerCase() === email &&
      item.email_address.length > 0,
  );
  if (!emailRecord || emailRecord.verification?.status !== "verified") {
    throw new Error("O endereço da conta tem de estar verificado no Clerk.");
  }

  const name = [clerkUser.first_name, clerkUser.last_name]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .trim();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('educa-initial-admin'))",
    );
    const existingAdmins = await client.query<{ id: string }>(
      "SELECT id FROM educa_users WHERE role = 'admin' LIMIT 1",
    );
    if (
      existingAdmins.rowCount &&
      existingAdmins.rows[0]?.id !== clerkUser.id
    ) {
      throw new Error(
        "Já existe um administrador. A promoção inicial foi cancelada.",
      );
    }

    const existingUser = await client.query<{ role: string }>(
      "SELECT role FROM educa_users WHERE id = $1 FOR UPDATE",
      [clerkUser.id],
    );
    if (existingUser.rows[0]?.role !== "admin") {
      await client.query(
        `INSERT INTO educa_users (id, email, name, role)
         VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email,
             name = COALESCE(NULLIF(EXCLUDED.name, ''), educa_users.name),
             role = 'admin',
             updated_at = now()`,
        [clerkUser.id, email, name],
      );
      await client.query(
        `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'initial_admin_bootstrapped', 'user', $2, '{}'::jsonb)`,
        [crypto.randomUUID(), clerkUser.id],
      );
    }
    await client.query("COMMIT");
    process.stdout.write("Administrador EDUCA configurado com sucesso.\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrapAdmin().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Erro ao configurar administrador."}\n`,
  );
  process.exitCode = 1;
});
