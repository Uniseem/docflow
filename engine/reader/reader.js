// Renders the article's TeX spans with the bundled KaTeX. A formula that
// fails keeps its source text readable instead of breaking the page.
(function () {
  function render() {
    if (!window.katex) return;
    var nodes = document.querySelectorAll(".math-inline, .math-block");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.getAttribute("data-rendered")) continue;
      try {
        window.katex.render(node.textContent || "", node, {
          displayMode: node.classList.contains("math-block"),
          throwOnError: false,
          trust: false,
          strict: "ignore",
        });
        node.setAttribute("data-rendered", "true");
      } catch (error) {
        /* keep the TeX source */
      }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
