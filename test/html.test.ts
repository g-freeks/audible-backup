import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { html, raw, escapeHtml } from "../src/web/templates/html.ts";
import { badge, statusBadge, queuedSwap } from "../src/web/templates/components.ts";

describe("html tagged template", () => {
  it("escapes interpolated values by default", () => {
    const evil = '<script>alert("x")</script>';
    assert.equal(
      html`<div>${evil}</div>`,
      "<div>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</div>",
    );
  });

  it("passes raw() values through verbatim", () => {
    assert.equal(html`<div>${raw("<b>bold</b>")}</div>`, "<div><b>bold</b></div>");
  });

  it("joins arrays, escaping each element", () => {
    assert.equal(html`<ul>${["<a>", "b"]}</ul>`, "<ul>&lt;a&gt;b</ul>");
    assert.equal(html`<ul>${[raw("<li>x</li>")]}</ul>`, "<ul><li>x</li></ul>");
  });

  it("renders null and undefined as empty strings", () => {
    assert.equal(html`<p>${null}${undefined}</p>`, "<p></p>");
  });

  it("escapeHtml handles all special characters", () => {
    assert.equal(escapeHtml(`&<>"`), "&amp;&lt;&gt;&quot;");
  });
});

describe("shared components", () => {
  it("badge escapes its label", () => {
    assert.equal(
      badge("warn", "<50%>"),
      '<span class="badge badge-warn">&lt;50%&gt;</span>',
    );
  });

  it("statusBadge maps statuses to badges", () => {
    assert.match(statusBadge("converted"), /badge-success/);
    assert.match(statusBadge("ignored"), /badge-danger/);
    assert.equal(statusBadge("bogus"), "");
  });

  it("queuedSwap produces an OOB status fragment", () => {
    const swap = queuedSwap("B000000001");
    assert.match(swap, /id="status-B000000001"/);
    assert.match(swap, /hx-swap-oob="true"/);
    assert.match(swap, /Queued/);
  });
});
