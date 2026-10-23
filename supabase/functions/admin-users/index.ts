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

async function must(query: PromiseLike<{ error: unknown }>) {
	const { error } = await query;
	if (error) throw error;
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
				const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
				if (error) throw error;
				const { data: profiles, error: profilesError } = await db.from('profiles').select('id, display_name, is_admin');
				if (profilesError) throw profilesError;
				const byId = new Map(profiles.map((p) => [p.id, p]));
				const users = data.users
					.map((u) => ({ id: u.id, email: u.email, ...byId.get(u.id) }))
					.sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
				return json(users);
			}
			case 'create': {
				const { data, error } = await db.auth.admin.createUser({
					email,
					password,
					email_confirm: true,
					user_metadata: { display_name },
				});
				if (error) throw error;
				if (is_admin) await must(db.from('profiles').update({ is_admin: true }).eq('id', data.user.id));
				return json({ id: data.user.id });
			}
			case 'update': {
				if (self && is_admin === false) return json({ error: 'You cannot remove your own admin role' }, 400);
				if (password) {
					const { error } = await db.auth.admin.updateUserById(id, { password });
					if (error) throw error;
				}
				if (typeof is_admin === 'boolean') await must(db.from('profiles').update({ is_admin }).eq('id', id));
				return json({ ok: true });
			}
			case 'delete': {
				if (self) return json({ error: 'You cannot delete yourself' }, 400);
				const { error } = await db.auth.admin.deleteUser(id);
				if (error) throw error;
				return json({ ok: true });
			}
			default:
				return json({ error: `Unknown action: ${action}` }, 400);
		}
	} catch (err) {
		return json({ error: (err as { message?: string }).message ?? String(err) }, 400);
	}
});
