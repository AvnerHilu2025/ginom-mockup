const screenCache = new Map();

export async function loadScreen(screenName) {
  if (screenCache.has(screenName)) return screenCache.get(screenName);

  const base = `./screens/${screenName}`;
  const [viewRes, mod] = await Promise.all([
    fetch(`${base}/view.html`),
    import(`${base}/screen.js`)
  ]);

  if (!viewRes.ok) throw new Error(`Missing view.html for screen ${screenName}`);

  const html = await viewRes.text();
  const screen = { html, ...mod };
  screenCache.set(screenName, screen);
  return screen;
}

export async function navigate(screenName, appCtx) {
  const host = document.getElementById("centerHost");
  const title = document.getElementById("screenTitle");

  const screen = await loadScreen(screenName);
  host.innerHTML = screen.html;

  if (typeof screen.mount === "function") {
    await screen.mount(appCtx);
  }

  appCtx.currentScreen = screenName;
  if (title) title.textContent = screenName;
}
