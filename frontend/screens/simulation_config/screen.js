import { navigate } from "../../router.js";

export async function mount(appCtx) {
  const backBtn = document.getElementById("backToMapBtn");
  const applyBtn = document.getElementById("applyBtn");

  const cityEl = document.getElementById("city");
  const sectorsEl = document.getElementById("sectors");
  const scenarioEl = document.getElementById("scenario");
  const ticksEl = document.getElementById("ticks");
  const seedEl = document.getElementById("seed");
  const previewEl = document.getElementById("configPreview");

  // Load existing config or defaults
  const cfg = appCtx.state.simConfig || {
    city: "Tel Aviv",
    sectors: ["electricity","water","gas","comms","first_responders"],
    scenario: "earthquake_light",
    ticks: 6,
    seed: "demo-1"
  };
  appCtx.state.simConfig = cfg;

  // Hydrate UI
  if (cityEl) cityEl.value = cfg.city;
  if (scenarioEl) scenarioEl.value = cfg.scenario;
  if (ticksEl) ticksEl.value = cfg.ticks;
  if (seedEl) seedEl.value = cfg.seed;

  selectMultiple(sectorsEl, cfg.sectors);
  renderPreview(previewEl, cfg);

  backBtn?.addEventListener("click", () => navigate("assets_map", appCtx));

  applyBtn?.addEventListener("click", () => {
    const next = {
      city: cityEl?.value || "Tel Aviv",
      sectors: getSelectedValues(sectorsEl) || ["electricity","water","gas","comms","first_responders"],
      scenario: scenarioEl?.value || "earthquake_light",
      ticks: clampInt(Number(ticksEl?.value || 6), 1, 60),
      seed: (seedEl?.value || "demo-1").trim()
    };

    appCtx.state.simConfig = next;
    renderPreview(previewEl, next);
  });
}

function renderPreview(pre, obj) {
  if (!pre) return;
  pre.textContent = JSON.stringify(obj, null, 2);
}

function getSelectedValues(sel) {
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map(o => o.value);
}

function selectMultiple(sel, values) {
  if (!sel) return;
  const set = new Set(values || []);
  for (const opt of sel.options) opt.selected = set.has(opt.value);
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
