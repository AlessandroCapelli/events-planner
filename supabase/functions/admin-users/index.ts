import { createClient, type User } from 'npm:@supabase/supabase-js@2';

const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
	auth: { persistSession: false },
});

/** Awaits a Supabase query and returns its `data`, throwing its `error` if set. */
async function must<T extends { data: unknown; error: unknown }>(query: PromiseLike<T>): Promise<T['data']> {
	const { data, error } = await query;
	if (error) throw error;
	return data;
}

/**
 * Admin-only user management. The POST body selects an `action`:
 * `list`, `create`, `update` or `delete`. Errors carry a `code`
 * (e.g. `email_exists`, `weak_password`) that the client translates.
 */
Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
	if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

	try {
		const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
		if (!token) return json({ error: 'Unauthorized' }, 401);
		const { data: { user }, error: authError } = await db.auth.getUser(token);
		if (authError || !user) return json({ error: 'Unauthorized' }, 401);
		const caller = await must(db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle());
		if (!caller?.is_admin) return json({ error: 'Forbidden' }, 403);

		const { action, id, email, password, display_name, is_admin } = await req.json();
		const self = id === user.id;

		switch (action) {
			case 'list': {
				const users: User[] = [];
				for (let page = 1; ; page++) {
					const batch = await must(db.auth.admin.listUsers({ page, perPage: 200 }));
					if (!batch.users.length) break;
					users.push(...batch.users);
				}
				const profiles: { id: string; display_name: string; is_admin: boolean }[] = [];
				for (; ;) {
					const batch = await must(db.from('profiles').select('id, display_name, is_admin').order('id').range(profiles.length, profiles.length + 199));
					if (!batch?.length) break;
					profiles.push(...batch);
				}
				const byId = new Map(profiles.map((p) => [p.id, p]));
				return json(
					users
						.map((u) => ({ id: u.id, email: u.email, ...byId.get(u.id) }))
						.sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '')),
				);
			}
			case 'create': {
				const { user: created } = await must(
					db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name }, app_metadata: { initial_admin: is_admin === true } }),
				);
				if (!created) throw new Error('User creation returned no user');
				return json({ id: created.id });
			}
			case 'update': {
				if (self && is_admin === false) return json({ error: 'You cannot remove your own admin role' }, 400);
				if (password) await must(db.auth.admin.updateUserById(id, { password }));
				if (typeof is_admin === 'boolean') await must(db.from('profiles').update({ is_admin }).eq('id', id));
				return json({ ok: true });
			}
			case 'delete': {
				if (self) return json({ error: 'You cannot delete yourself' }, 400);
				await must(db.auth.admin.deleteUser(id));
				return json({ ok: true });
			}
			default:
				return json({ error: `Unknown action: ${action}` }, 400);
		}
	} catch (err) {
		const { message, code } = err as { message?: string; code?: string };
		return json({ error: message ?? String(err), code }, 400);
	}
});
