document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.pick");
  if (!btn || btn.disabled) return;

  const row = btn.closest(".game");
  const before = row.querySelector(".pick.chosen");
  row.querySelectorAll(".pick").forEach(b => b.classList.remove("chosen"));
  btn.classList.add("chosen");

  try {
    const r = await fetch("/tipp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: +btn.dataset.game, choice: btn.dataset.choice })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      btn.classList.remove("chosen");
      if (before) before.classList.add("chosen");
      note(row, d.grund || "Tipp konnte nicht gespeichert werden.");
      return;
    }
    const chip = row.querySelector(".chip." + (document.body.dataset.me || ""));
    if (chip && chip.classList.contains("none")) {
      chip.classList.remove("none");
      chip.textContent = chip.textContent.replace(" offen", " getippt");
    }
  } catch {
    btn.classList.remove("chosen");
    if (before) before.classList.add("chosen");
    note(row, "Keine Verbindung. Tipp ist nicht gespeichert.");
  }
});

function note(row, text) {
  let p = row.querySelector(".rownote");
  if (!p) {
    p = document.createElement("p");
    p.className = "meta rownote";
    row.appendChild(p);
  }
  p.textContent = text;
  p.style.color = "var(--anni)";
}

// Laufen Spiele, holt die Seite jede Minute den neuen Stand.
setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  if (!document.querySelector(".game.running")) return;
  try {
    const r = await fetch(location.href, { cache: "no-store" });
    if (!r.ok || r.redirected) return;
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const fresh = doc.querySelector(".wrap");
    if (fresh) document.querySelector(".wrap").innerHTML = fresh.innerHTML;
  } catch { /* nächster Versuch in einer Minute */ }
}, 60000);
