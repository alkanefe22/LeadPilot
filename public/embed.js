/*!
 * LeadPilot embeddable lead form.
 * <div data-leadpilot-form="WORKSPACE_ID"></div>
 * <script src="https://YOUR-APP/embed.js" async></script>
 */
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : "";
  var nodes = document.querySelectorAll("[data-leadpilot-form]");
  nodes.forEach(function (node) {
    if (node.getAttribute("data-leadpilot-mounted")) return;
    node.setAttribute("data-leadpilot-mounted", "1");
    var iframe = document.createElement("iframe");
    iframe.src =
      origin + "/f/" + encodeURIComponent(node.getAttribute("data-leadpilot-form")) + "?embed=1";
    iframe.title = "Contact form";
    iframe.loading = "lazy";
    iframe.style.cssText = "width:100%;border:0;min-height:420px;background:transparent;";
    node.appendChild(iframe);
    window.addEventListener("message", function (e) {
      if (e.origin !== origin || e.source !== iframe.contentWindow) return;
      if (e.data && e.data.type === "leadpilot:resize" && typeof e.data.height === "number") {
        iframe.style.height = Math.min(Math.max(e.data.height, 200), 2000) + "px";
      }
    });
  });
})();
