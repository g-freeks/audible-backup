import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { routes } from "./src/web/routes.ts";

const app = new Hono();

app.use("/static/*", serveStatic({ root: "src/web/" }));
app.route("/", routes);

const port = parseInt(process.env.WEB_PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `Audible Backup Tool running at http://localhost:${info.port}`,
  );
});
