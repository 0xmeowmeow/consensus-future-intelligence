/* One browser tab, several views of the same encounter. Never casts a vote. */
(() => {
  const nav = document.querySelector(".view-switcher");
  if (nav) {
    for (const [view, label, description] of [
      ["record", "THE RECORD", "Follow changes"],
      ["workshop", "THE WORKSHOP", "Take it apart"],
    ]) {
      if (!nav.querySelector('[data-view-link="' + view + '"]')) {
        const link = document.createElement("a");
        link.href = view + ".html";
        link.dataset.viewLink = view;
        const title = document.createElement("span");
        title.textContent = label;
        const sub = document.createElement("small");
        sub.textContent = description;
        title.append(sub);
        link.append(title);
        nav.append(link);
      }
    }
    nav.querySelector(".view-location")?.remove();
    for (const a of nav.querySelectorAll("[data-view-link]")) {
      if (a.dataset.viewLink === document.body.dataset.view)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }
  const enabled = !window.CFI_PREVIEW && !window.CFI_GLASS_PREVIEW;
  const memory = {};
  const key = (name) => "cfi.views.v1." + name;
  function read(name) {
    if (!enabled) return null;
    try {
      return (
        JSON.parse(sessionStorage.getItem(key(name))) ?? memory[name] ?? null
      );
    } catch {
      return memory[name] ?? null;
    }
  }
  function write(name, value) {
    if (!enabled) return;
    memory[name] = value;
    try {
      if (value === null) sessionStorage.removeItem(key(name));
      else sessionStorage.setItem(key(name), JSON.stringify(value));
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  }
  function room(room) {
    if (!room) return;
    const previous = read("encounter");
    write("encounter", {
      id: room.id,
      question: room.question,
      node: previous?.id === room.id ? previous.node : null,
    });
    for (const view of ["record", "workshop"]) {
      const link = document.querySelector('[data-view-link="' + view + '"]');
      if (link)
        link.href =
          view +
          ".html?room=" +
          encodeURIComponent(room.id) +
          (previous?.id === room.id && previous.node
            ? "&node=" + encodeURIComponent(previous.node)
            : "");
    }
    const link = document.querySelector('[data-view-link="glass"]');
    if (link)
      link.href =
        "glass.html?room=" +
        encodeURIComponent(room.id) +
        "&question=" +
        encodeURIComponent(room.question);
  }
  function focus(roomId, node) {
    const context = read("encounter");
    if (context?.id === roomId) {
      write("encounter", { ...context, node });
      const link = document.querySelector('[data-view-link="workshop"]');
      if (link)
        link.href =
          "workshop.html?room=" +
          encodeURIComponent(roomId) +
          "&node=" +
          encodeURIComponent(node);
    }
  }
  function selected(roomId) {
    const context = read("encounter");
    return context && context.id === roomId ? context.node : null;
  }
  window.CFIViews = { read, write, room, focus, selected };
  const context = read("encounter");
  if (context) room(context);
})();
