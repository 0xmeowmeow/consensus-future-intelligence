export const $ = (id) => document.getElementById(id);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function api(path, body) {
  const r = await fetch(
    "/api" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok)
    throw new Error(data.error || data.detail || "The request failed.");
  return data;
}
export function download(name, data) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const kinds = {
  agreement: "PROPOSED AGREEMENT",
  direction: "CHANGE OF DIRECTION",
  disagreement: "UNRESOLVED DIFFERENCE",
  question: "OPEN QUESTION",
  round: "ROUND CHECKPOINT",
};
export const name = (room, id) =>
  id ? room?.participants[id]?.name || id : "RECORDER";
export const when = (t) =>
  new Date(t * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export function scope(room, node) {
  window.CFIViews?.room(room);
  if (node) window.CFIViews?.focus(room.id, node);
}
