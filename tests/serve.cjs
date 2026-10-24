const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve("web");
const types = {
	".js": "text/javascript",
	".json": "application/json",
	".css": "text/css",
	".html": "text/html",
	".svg": "image/svg+xml",
};

http
	.createServer((req, res) => {
		const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
		if (!file.startsWith(root + path.sep)) return void res.writeHead(403).end();
		fs.readFile(file, (error, data) => {
			if (error) return void res.writeHead(404).end();
			res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(data);
		});
	})
	.listen(4173, "127.0.0.1");
