import { writeFileSync } from "node:fs";

const { SUPABASE_URL, SUPABASE_ANON_KEY, PRIVACY_CONTACT } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
const url = new URL(SUPABASE_URL);
if (url.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS");
writeFileSync(
	"web/config.js",
	`window.CONFIG = ${JSON.stringify({
		supabaseUrl: url.href.replace(/\/$/, ""),
		supabaseAnonKey: SUPABASE_ANON_KEY,
		privacyContact: PRIVACY_CONTACT?.trim() || undefined,
	})};\n`,
);
