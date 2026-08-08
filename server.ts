import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { routes } from "./src/web/routes.ts";

const app = new Hono();

const authUser = process.env.WEB_USER;
const authPassword = process.env.WEB_PASSWORD;
if (authUser && authPassword) {
  app.use("*", basicAuth({ username: authUser, password: authPassword }));
}

app.use("/static/*", serveStatic({ root: "src/web/" }));
app.route("/", routes);

const port = parseInt(process.env.WEB_PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `Audible Backup Tool running at http://localhost:${info.port}${
      authUser && authPassword ? " (basic auth enabled)" : " (no auth — do not expose)"
    }`,
  );
});
