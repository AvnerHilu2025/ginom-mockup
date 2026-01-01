import { createMap } from "../../ui/mapbox.js";
import { apiExecute } from "../../api.js";
import { navigate } from "../../router.js";

export async function mount(appCtx) {
  // Initialize map once per app lifetime
  if (!appCtx.mapApi) {
    appCtx.mapApi = createMap(appCtx.config.mapboxToken, "map");
    await waitForMapLoad(appCtx.mapApi.map);
  }

  const goConfigBtn = document.getElementById("goConfigBtn");
  const loadAssetsBtn = document.getElementById("loadAssetsBtn");
  const citySel = document.getElementById("citySel");
  const sectorSel = document.getElementById("sectorSel");

  goConfigBtn?.addEventListener("click", () => navigate("simulation_config", appCtx));

  loadAssetsBtn?.addEventListener("click", async () => {
    const city = citySel?.value || "Tel Aviv";
    const sectors = getSelectedValues(sectorSel) || ["electricity","water","gas","comms","first_responders"];

    // Execute via apiExecute (stub now, real backend later)
    const actions = [
      { type: "MAP_SET_VIEW", payload: { lat: 32.0853, lng: 34.7818, zoom: 11 } },
      { type: "MAP_SHOW_ASSETS", payload: { sectors, city } }
    ];

    // immediate UI
    appCtx.mapApi.setView(actions[0].payload);

    const exec = await apiExecute(actions);
    const assetsArt = exec?.artifacts?.find(a => a.type === "assets");
    if (assetsArt) {
      appCtx.mapApi.showAssets(assetsArt.data);
      // save last loaded assets in state
      appCtx.state.lastAssets = assetsArt.data;
    }
  });
}

function getSelectedValues(sel) {
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map(o => o.value);
}

function waitForMapLoad(map) {
  return new Promise(resolve => {
    if (map.loaded()) return resolve();
    map.on("load", () => resolve());
  });
}
