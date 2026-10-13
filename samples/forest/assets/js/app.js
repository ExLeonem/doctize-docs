/* Page behaviour: colour scheme, collapsible navigation, navigation drawer and tabs, code copy buttons, code tabs, table of contents. */
(function () {
  "use strict";

  const root = document.documentElement;
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } },
  };

  /* ---- Colour scheme ---- */
  const themeToggle = document.querySelector("[data-theme-toggle]");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const isDark = root.getAttribute("data-theme") === "dark" ||
        (!root.hasAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const next = isDark ? "light" : "dark";
      root.setAttribute("data-theme", next);
      storage.set("doctize-theme", next);
    });
  }

  /* ---- Collapsing the navigation (large screens); remembered across pages ---- */
  const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
  function showSidebarState() {
    const collapsed = root.classList.contains("sidebar-collapsed");
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.setAttribute("aria-label", collapsed ? "Show the navigation" : "Hide the navigation");
  }
  if (sidebarToggle) {
    showSidebarState();
    sidebarToggle.addEventListener("click", () => {
      const collapsed = root.classList.toggle("sidebar-collapsed");
      storage.set("doctize-sidebar", collapsed ? "collapsed" : "open");
      showSidebarState();
    });
  }
  /* Moves the button clear of the sidebar's scrollbar while the navigation overflows. */
  const sidebar = document.getElementById("sidebar");
  if (sidebarToggle && sidebar && "ResizeObserver" in window) {
    const observer = new ResizeObserver(() => {
      root.classList.toggle("sidebar-scrolls", sidebar.scrollHeight > sidebar.clientHeight);
    });
    observer.observe(sidebar);
    for (const child of sidebar.children) observer.observe(child);
  }

  /* ---- Navigation drawer (small screens) ---- */
  const navToggle = document.querySelector("[data-nav-toggle]");
  function setNavOpen(open) {
    document.body.classList.toggle("nav-open", open);
    if (navToggle) navToggle.setAttribute("aria-expanded", String(open));
  }
  if (navToggle) navToggle.addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
  document.querySelectorAll("[data-nav-close]").forEach((el) => el.addEventListener("click", () => setNavOpen(false)));
  document.addEventListener("keydown", (event) => event.key === "Escape" && setNavOpen(false));

  /* ---- Navigation tabs: guides or API reference, like the "Pages" and "Modules" of HexDocs ---- */
  const sections = [...document.querySelectorAll(".sidebar .nav-section")];
  const navTabs = document.querySelector(".nav-tabs");
  const tabButtons = navTabs ? [...navTabs.querySelectorAll("[data-nav-tab]")] : [];
  function showArea(area) {
    tabButtons.forEach((button) => button.setAttribute("aria-selected", String(button.dataset.navTab === area)));
    sections.forEach((section) => (section.hidden = section.dataset.area !== area));
  }
  if (tabButtons.length) {
    navTabs.hidden = false;
    tabButtons.forEach((button) => button.addEventListener("click", () => showArea(button.dataset.navTab)));
    const initial = tabButtons.find((button) => button.getAttribute("aria-selected") === "true") || tabButtons[0];
    showArea(initial.dataset.navTab);
  }

  /* ---- Keep the current page visible in the sidebar ---- */
  const current = document.querySelector(".sidebar a.is-current");
  if (current) current.scrollIntoView({ block: "center" });

  /* ---- Copy buttons ---- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); } finally { area.remove(); }
    });
  }
  document.querySelectorAll(".code-block").forEach((block) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      const code = block.querySelector("code");
      copyText(code.innerText).then(
        () => { button.textContent = "Copied"; },
        () => { button.textContent = "Press Ctrl+C"; }
      );
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    });
    block.appendChild(button);
  });

  /* ---- Code tabs; the chosen tab is remembered and shared by all tab groups with that label ---- */
  const tabGroups = [...document.querySelectorAll(".tabs")];
  function selectTab(label) {
    tabGroups.forEach((group) => {
      const panels = [...group.querySelectorAll(":scope > .tab-panel")];
      if (!panels.some((panel) => panel.dataset.tab === label)) return;
      panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.tab === label));
      group.querySelectorAll(".tab-btn").forEach((btn) => btn.setAttribute("aria-selected", String(btn.textContent === label)));
    });
  }
  tabGroups.forEach((group) => {
    const panels = [...group.querySelectorAll(":scope > .tab-panel")];
    const list = document.createElement("div");
    list.className = "tab-list";
    list.setAttribute("role", "tablist");
    panels.forEach((panel) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab-btn";
      button.setAttribute("role", "tab");
      button.textContent = panel.dataset.tab;
      button.addEventListener("click", () => {
        selectTab(panel.dataset.tab);
        storage.set("doctize-tab", panel.dataset.tab);
      });
      list.appendChild(button);
    });
    group.insertBefore(list, group.firstChild);
    group.setAttribute("data-ready", "");
    const remembered = storage.get("doctize-tab");
    const initial = panels.some((p) => p.dataset.tab === remembered) ? remembered : panels[0].dataset.tab;
    selectTab(initial);
  });

  /* ---- Table of contents: highlight the section being read ---- */
  const tocLinks = new Map([...document.querySelectorAll(".toc a[href^='#']")].map((a) => [decodeURIComponent(a.getAttribute("href").slice(1)), a]));
  if (tocLinks.size && "IntersectionObserver" in window) {
    const visible = new Set();
    const headings = [...tocLinks.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        });
        const first = headings.find((heading) => visible.has(heading));
        if (first) {
          tocLinks.forEach((link) => link.classList.remove("is-active"));
          const link = tocLinks.get(first.id);
          link.classList.add("is-active");
          link.scrollIntoView({ block: "nearest" });
        }
      },
      { rootMargin: "-72px 0px -70% 0px" }
    );
    headings.forEach((heading) => observer.observe(heading));
  }
})();
