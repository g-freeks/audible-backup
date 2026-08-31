import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { routes } from "./src/web/routes.ts";
import { isDesktopMode } from "./src/config.ts";
import { desktopToken } from "./src/web/desktop.ts";
import { ensureDesktopUser } from "./src/users.ts";

const app = new Hono();

const authUser = process.env.WEB_USER;
const authPassword = process.env.WEB_PASSWORD;
if (authUser && authPassword) {
  app.use("*", basicAuth({ username: authUser, password: authPassword }));
}

app.use("/static/*", serveStatic({ root: "src/web/" }));
app.route("/", routes);

// A desktop install serves only to its own machine; a server install keeps
// listening on every interface so containers and LANs still work.
const desktop = isDesktopMode();
const hostname = process.env.WEB_HOST || (desktop ? "127.0.0.1" : "0.0.0.0");
// Port 0 asks the OS for a free one — the desktop launcher reads it back below.
const port = parseInt(process.env.WEB_PORT || (desktop ? "0" : "3000"), 10);

if (desktop) ensureDesktopUser();

serve({ fetch: app.fetch, hostname, port }, (info) => {
  const token = desktopToken();
  const url = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${info.port}/`;

  if (desktop) {
    // Machine-readable, and the only place the token is disclosed: the
    // launcher parses this line to open the window.
    console.log(`AUDIBLE_BACKUP_URL=${url}?token=${token}`);
    console.log(`Audible Backup running at ${url} (desktop mode)`);
    return;
  }

  console.log(
    `Audible Backup Tool running at ${url}${
      authUser && authPassword ? " (basic auth enabled)" : " (no auth — do not expose)"
    }`,
  );
});
