import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Versions the static assets of a deployment: `node scripts/stamp-assets.mjs <version> [webDir]`.
 * index.html gets `?v=<version>` on its stylesheet and scripts, plus an import map that does the same for
 * every module, so browsers never mix cached files from two deployments. Sources stay unversioned.
 */
const [version, web = "web"] = process.argv.slice(2);
if (!/^[\w.-]+$/.test(version ?? "")) throw new Error("Usage: stamp-assets.mjs <version> [webDir]");
const query = `?v=${version}`;

const modules = ["js", "locales", "vendor"].flatMap((dir) =>
	readdirSync(path.join(web, dir))
		.filter((file) => /\.(js|json)$/.test(file))
		.map((file) => `./${dir}/${file}`),
);
const importMap = JSON.stringify({ imports: Object.fromEntries(modules.map((url) => [url, url + query])) });

const file = path.join(web, "index.html");
let html = readFileSync(file, "utf8");
let stamped = 0;
html = html.replace(/(href|src)="(style\.css|config\.js|js\/app\.js)"/g, (_, attr, asset) => {
	stamped++;
	return `${attr}="${asset}${query}"`;
});
html = html.replace(/(\s*)<script type="module"/, (match, indent) => {
	stamped++;
	return `${indent}<script type="importmap">${importMap}</script>${match}`;
});
if (stamped !== 4) throw new Error(`index.html changed: expected 4 asset references, versioned ${stamped}`);
writeFileSync(file, html);
