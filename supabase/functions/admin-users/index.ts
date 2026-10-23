// Gestione utenti riservata agli admin: list, create, update, delete.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
	auth: { persistSession: false },
});

/** Attende una chiamata Supabase e restituisce `data`, oppure lancia l'errore. */
async function must<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
	const { data, error } = await query;
	if (error) throw error;
	return data;
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	const token = req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
	const { data: { user } } = await db.auth.getUser(token);
	if (!user) return json({ error: 'Unauthorized' }, 401);

	const { data: caller } = await db.from('profiles').select('is_admin').eq('id', user.id).single();
	if (!caller?.is_admin) return json({ error: 'Forbidden' }, 403);

	try {
		const { action, id, email, password, display_name, is_admin } = await req.json();
		const self = id === user.id;

		switch (action) {
			case 'list': {
				const { users } = await must(db.auth.admin.listUsers({ perPage: 1000 }));
				const profiles = await must(db.from('profiles').select('id, display_name, is_admin'));
				const byId = new Map(profiles.map((p) => [p.id, p]));
				return json(
					users
						.map((u) => ({ id: u.id, email: u.email, ...byId.get(u.id) }))
						.sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '')),
				);
			}
			case 'create': {
				const { user: created } = await must(
					db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name } }),
				);
				if (is_admin) await must(db.from('profiles').update({ is_admin: true }).eq('id', created.id));
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
		return json({ error: (err as { message?: string }).message ?? String(err) }, 400);
	}
});
