const id = "00000000-0000-4000-8000-000000000001";
const state = (window.__mock = {
	profile: { id: "me", display_name: "Mario", is_admin: true },
	members: [
		{ id: "me", display_name: "Mario" },
		{ id: "long", display_name: "X".repeat(60) },
	],
	groups: [
		{ id: "default", name: "Default", members: ["me", "long", "other"] },
		{ id: "climbing", name: "Climbing", members: ["me"] },
	],
	event: {
		id,
		group_id: "default",
		group: { name: "Default" },
		title: "Test dinner",
		starts_at: new Date(Date.now() + 3600000).toISOString(),
		location: "Square",
		description: "Description",
		created_by: "other",
		creator: { display_name: "Anna" },
		invite_only: false,
		invitations: [],
		proposals: [],
		items: [],
		responses: Array.from({ length: 5 }, (_, i) => ({
			user_id: "user" + i,
			status: "yes",
			guests: 0,
			profile: { display_name: "User " + i },
		})),
	},
	listeners: new Set(),
	visible: true,
	proposeCalls: 0,
	token: null,
	emit() {
		for (const listener of this.listeners) listener();
	},
});
const clone = (value) => structuredClone(value);
const hold = (name) =>
	new Promise((resolve, reject) => {
		state[`release${name}`] = resolve;
		state[`reject${name}`] = () => reject(new Error("Saving failed"));
	});

export const configured = true;
export function onUserChange(callback) {
	state.authChange = callback;
	queueMicrotask(() => callback({ id: "me", email: "mario@example.test" }));
}
export async function getProfile() {
	const profile = clone(state.profile);
	if (state.holdProfile) await hold("Profile");
	return profile;
}
export const listProfiles = async () => clone(state.members);
const visibleIn = (groupId) => state.visible && (!groupId || state.event.group_id === groupId);
export const listUpcoming = async (since, groupId) =>
	visibleIn(groupId) && state.event.starts_at > since ? [clone(state.event)] : [];
export const listPast = async (since, _limit, groupId) =>
	visibleIn(groupId) && state.event.starts_at <= since ? [clone(state.event)] : [];
export const listGroups = async () => {
	if (state.holdGroups) await hold("Groups");
	return clone(state.groups);
};
export const saveGroup = async () => "group";
export const deleteGroup = async () => {};
export const setUserGroups = async () => {};
export const getEvent = async () => {
	if (state.failRefresh) throw new Error("Refresh unavailable");
	return state.visible ? clone(state.event) : null;
};
export const subscribe = (_bindings, callback) => {
	state.listeners.add(callback);
	return () => state.listeners.delete(callback);
};
export async function respond(event_id, user_id, status, guests) {
	if (state.holdResponse) await hold("Response");
	state.event.responses = state.event.responses.filter((r) => r.user_id !== user_id);
	state.event.responses.push({ user_id, status, guests, profile: { display_name: "Mario" } });
}
export async function addProposal(_id, data) {
	state.proposeCalls++;
	if (state.holdProposal) await hold("Proposal");
	state.event.proposals.push({ ...data, id: "p1", votes: [], author: { display_name: "Mario" }, created_by: "me" });
}
export async function addItem(_id, label) {
	if (state.holdItem) await hold("Item");
	state.event.items.push({
		id: "item",
		label,
		created_by: "me",
		created_at: new Date().toISOString(),
		claimed_by: null,
	});
}
export const getCalendarToken = async () => state.token;
export const rotateCalendarToken = async () => {
	state.token = "a".repeat(64);
};
export const deleteCalendarToken = async () => {
	state.token = null;
};
export const calendarFeedUrl = (token) => "https://example.test/calendar?token=" + token;
export const updateProfile = async (_id, display_name) => {
	state.profile.display_name = display_name;
};
export const signOut = async () => state.authChange(null);
export const signIn = async () => {};
export const changePassword = async () => {
	if (state.holdPassword) await hold("Password");
	if (state.failPassword) throw new Error("Password not saved");
};
export async function admin(action, payload) {
	if (action === "list")
		return [clone(state.profile), { id: "other", display_name: "Anna", email: "anna@example.test" }];
	state.lastAdmin = { action, ...payload };
}
export const saveEvent = async () => id;
export const deleteEvent = async () => {};
export const vote = async () => {};
export const adoptProposal = async () => {};
export const deleteProposal = async () => {};
export const claimItem = async () => ["item"];
export const deleteItem = async () => {};
