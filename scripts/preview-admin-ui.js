import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.UDMC_PREVIEW_PORT || 4173);
const root = path.resolve("apps/admin-desktop/ui");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"]
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(400).end("Bad request");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");

    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath)) || "application/octet-stream",
      "content-length": fileStat.size,
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`UDMC Control preview: http://${host}:${port}`);
});
