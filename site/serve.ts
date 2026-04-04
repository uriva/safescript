import { serveDir } from "jsr:@std/http/file-server";

Deno.serve((req) =>
  serveDir(req, {
    fsRoot: "out",
    quiet: true,
  })
);
