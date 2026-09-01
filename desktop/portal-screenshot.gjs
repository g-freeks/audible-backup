#!/usr/bin/env gjs
//
// Requests a screenshot through the xdg-desktop-portal Screenshot interface
// and prints the resulting file:// URI to stdout.
//
//   gjs portal-screenshot.gjs <interactive: true|false> [timeout seconds]
//
// The portal's Response signal is delivered only to the exact D-Bus
// connection that made the Screenshot() call — a separate process (even one
// subscribed to the same signal/path) never sees it. So the call and the
// listener have to share one Gio.DBusConnection, which is what this does;
// desktop/screenshot-window.sh cannot do this itself with plain gdbus.

const { Gio, GLib } = imports.gi;

const interactive = ARGV[0] === "true";
const timeoutSeconds = parseInt(ARGV[1] || "30", 10);

const loop = GLib.MainLoop.new(null, false);
let outcome = null; // {uri} on success, null on timeout/denial/error

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

let requestPath;
try {
  const reply = bus.call_sync(
    "org.freedesktop.portal.Desktop",
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.Screenshot",
    "Screenshot",
    new GLib.Variant("(sa{sv})", [
      "",
      { interactive: GLib.Variant.new_boolean(interactive) },
    ]),
    new GLib.VariantType("(o)"),
    Gio.DBusCallFlags.NONE,
    -1,
    null,
  );
  [requestPath] = reply.deep_unpack();
} catch (e) {
  printerr(`portal call failed: ${e.message}`);
  imports.system.exit(1);
}

const subscriptionId = bus.signal_subscribe(
  null,
  "org.freedesktop.portal.Request",
  "Response",
  requestPath,
  null,
  Gio.DBusSignalFlags.NONE,
  (_conn, _sender, _path, _iface, _signal, params) => {
    const [code, results] = params.deep_unpack();
    if (code === 0 && results.uri) {
      outcome = { uri: results.uri.deep_unpack() };
    }
    loop.quit();
  },
);

const timeoutId = GLib.timeout_add_seconds(
  GLib.PRIORITY_DEFAULT,
  timeoutSeconds,
  () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
  },
);

loop.run();
bus.signal_unsubscribe(subscriptionId);
GLib.source_remove(timeoutId);

if (outcome) {
  print(outcome.uri);
} else {
  printerr("no response — dialog was not approved, or timed out");
  imports.system.exit(1);
}
