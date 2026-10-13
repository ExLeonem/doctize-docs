/*
 * Draws the Mermaid diagrams of a page (<pre class="mermaid">). The Mermaid library is large, so it is only loaded on pages that
 * have a diagram, from assets/vendor/, which works from a web server and from the file system. The diagrams follow the light and
 * dark mode of the site, and are drawn again when it changes.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root.document) {
    api.start(root);
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCRIPT = "assets/vendor/mermaid.min.js";

  function isDark(win) {
    var attribute = win.document.documentElement.getAttribute("data-theme");
    if (attribute) {
      return attribute === "dark";
    }
    return !!(win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function start(win) {
    var doc = win.document;
    var nodes = Array.prototype.slice.call(doc.querySelectorAll("pre.mermaid"));
    if (nodes.length === 0) {
      return null;
    }
    var sources = nodes.map(function (node) { return node.textContent; });
    var base = (win.DOCTIZE && win.DOCTIZE.basePath) || "";
    var state = { nodes: nodes, rendered: 0, failed: false };

    function render() {
      win.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark(win) ? "dark" : "default" });
      nodes.forEach(function (node, index) {
        node.removeAttribute("data-processed");
        node.textContent = sources[index];
      });
      state.rendered += 1;
      return win.mermaid.run({ nodes: nodes });
    }

    function loaded() {
      render();
      // The mode of the site is switched with an attribute on <html>.
      if (win.MutationObserver) {
        new win.MutationObserver(render).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      }
    }

    function failed() {
      state.failed = true;
      nodes.forEach(function (node) { node.classList.add("mermaid-failed"); });
    }

    if (win.mermaid) {
      loaded();
    } else {
      var script = doc.createElement("script");
      script.src = base + SCRIPT;
      script.onload = loaded;
      script.onerror = failed;
      doc.head.appendChild(script);
    }
    return state;
  }

  return { start: start, isDark: isDark };
});
