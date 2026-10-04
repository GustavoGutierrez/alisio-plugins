/*
 * Page runtime for the thesis HTML (classic script, no network). Order of work: render the Mermaid
 * diagrams, let Paged.js paginate, then publish the result for the PDF driver:
 *   window.__thesisReady = true, window.__thesisPages = <number of pages>
 * or window.__thesisError = <message> when something failed. Opened directly in a browser, the same
 * file is a paginated preview of the thesis.
 */
(() => {
  function readConfig() {
    var node = document.getElementById("thesis-config");
    try {
      return node ? JSON.parse(node.textContent || "{}") : {};
    } catch (error) {
      return {};
    }
  }

  var config = readConfig();
  window.__thesisReady = false;

  function fail(error) {
    window.__thesisError = String((error && error.message) || error);
  }

  function renderDiagrams() {
    var sources = document.querySelectorAll(".mermaid-src");
    if (sources.length === 0) return Promise.resolve();
    if (!window.mermaid) return Promise.reject(new Error("The diagram library did not load"));
    var theme = config.theme || {};
    var fonts = (theme.fonts || []).map((name) => '"' + name + '"');
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: Object.assign(
        { fontFamily: fonts.concat(["sans-serif"]).join(", ") },
        theme.variables || {},
      ),
      fontFamily: fonts.concat(["sans-serif"]).join(", "),
    });
    var chain = Promise.resolve();
    Array.prototype.forEach.call(sources, (source, index) => {
      chain = chain.then(() => {
        var out = source.parentNode.querySelector(".mermaid-out");
        return window.mermaid.render("mmd-" + index, source.textContent || "").then(
          (result) => {
            out.innerHTML = result.svg;
          },
          (error) => {
            out.textContent = "Diagram error: " + String((error && error.message) || error);
            out.className += " mermaid-error";
          },
        );
      });
    });
    return chain;
  }

  // Paged.js reads this object when it loads: `before` runs ahead of pagination, `after` once every
  // page exists. The polyfill starts itself on DOMContentLoaded.
  function roman(value) {
    var table = [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ];
    var out = "";
    table.forEach((entry) => {
      while (value >= entry[0]) {
        out += entry[1];
        value -= entry[0];
      }
    });
    return out;
  }

  // Printed page label per page: the cover is never numbered; front matter and body count on their
  // own unless the profile numbers continuously from the cover.
  function labelPages(pages) {
    var settings = config.pages || {};
    var front = 0;
    var body = 0;
    return pages.map((page, index) => {
      var kind = page.classList.contains("pagedjs_cover_page")
        ? "cover"
        : page.classList.contains("pagedjs_front_page")
          ? "front"
          : "body";
      if (kind === "front") front += 1;
      if (kind === "body") body += 1;
      var number = settings.continuous ? index + 1 : kind === "front" ? front : body;
      var format = kind === "front" ? settings.front : kind === "body" ? settings.body : "none";
      if (kind === "cover" || format === "none") return "";
      return format === "roman" ? roman(number) : String(number);
    });
  }

  window.PagedConfig = {
    auto: true,
    before: () =>
      renderDiagrams()
        .then(() => document.fonts && document.fonts.ready)
        .catch(fail),
    after: () => {
      try {
        var pages = [].slice.call(document.querySelectorAll(".pagedjs_page"));
        var labels = labelPages(pages);
        pages.forEach((page, index) => {
          if (page.querySelector("h1.chapter")) page.setAttribute("data-chapter-start", "true");
          var box = page.querySelector(
            ".pagedjs_margin-bottom-" +
              ((config.pages || {}).position || "center") +
              " > .pagedjs_margin-content",
          );
          if (box && labels[index] !== "") box.setAttribute("data-folio", labels[index]);
          else if (box) box.setAttribute("data-folio", "");
        });
        // Table of contents and lists: the printed label of the page each target landed on.
        [].forEach.call(document.querySelectorAll(".toc-list a"), (link) => {
          var id = (link.getAttribute("href") || "").slice(1);
          var target = id ? document.getElementById(id) : null;
          var page = target && target.closest ? target.closest(".pagedjs_page") : null;
          var at = page ? pages.indexOf(page) : -1;
          link.setAttribute("data-page", at >= 0 ? labels[at] : "");
        });
        // Footnotes: number calls and notes in reading order (CSS counters do not survive printing).
        var numbers = {};
        [].forEach.call(document.querySelectorAll("[data-footnote-call]"), (call, index) => {
          numbers[call.getAttribute("data-footnote-call")] = String(index + 1);
          call.setAttribute("data-fn", String(index + 1));
        });
        [].forEach.call(document.querySelectorAll("[data-footnote-marker]"), (note) => {
          var number = numbers[note.getAttribute("data-ref")];
          if (number) note.setAttribute("data-fn", number);
        });
        window.__thesisPages = pages.length;
        if (!window.__thesisError) window.__thesisReady = true;
      } catch (error) {
        fail(error);
      }
    },
  };
  window.addEventListener("error", (event) => {
    fail(event.error || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    fail(event.reason);
  });
})();
